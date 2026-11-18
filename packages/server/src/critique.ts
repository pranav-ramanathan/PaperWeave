// A review of a passage by a language model: contribution clarity, whether the evidence in the
// passage carries what is claimed, cohesion, and conclusions that say no more than was shown.
// What comes back becomes proposed changes (never edits) and questions for the authors.
//
// Text leaves this service only here, and only when all three hold: the deployment has named
// a provider (MODEL_PROVIDER=anthropic), it has credentials, and the paper's owner has allowed
// it. Only the passage asked about and the paper's own words are sent.
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import type pg from 'pg';
import * as Y from 'yjs';
import { z } from 'zod';
import { authorize } from './authz.ts';
import type { BlobStore } from './blobs.ts';
import { CLAIM_RULES } from './claims.ts';
import { AppError } from './errors.ts';
import { id } from './projects.ts';
import { propose } from './proposals.ts';
import { loadUpdates, TEXT } from './sync.ts';
import { startThread } from './threads.ts';

const MODEL = 'claude-opus-5-5';
/** The most that is sent in one request: a few paragraphs. */
export const MAX_PASSAGE = 6000;

const Review = z.object({
  suggestions: z.array(
    z.object({
      before: z.string().describe('The exact text to replace, copied from the passage.'),
      after: z.string().describe('What it should say instead, as LaTeX.'),
      reason: z.string().describe('Why, in one or two sentences, for the authors.'),
      evidence: z
        .array(z.string())
        .describe(
          'What in the passage the change rests on: citation keys, labels or short quotes.',
        ),
    }),
  ),
  questions: z.array(
    z.object({
      about: z.string().describe('The exact text the question is about, copied from the passage.'),
      question: z.string().describe('What the authors need to answer or show.'),
    }),
  ),
});
export type Review = z.infer<typeof Review>;
/** What is sent to the model, and what it answers. Replaceable, so that tests send nothing. */
export type Ask = (request: {
  passage: string;
  glossary: string[];
}) => Promise<{ review: Review; model: string }>;

const SYSTEM = `You review a passage of a scientific paper, written in LaTeX, for its authors.

Look for four things: whether the contribution is stated clearly; whether what is claimed is carried by the evidence the passage itself gives or cites; whether the sentences follow from one another; and whether conclusions are qualified as far as the evidence allows and no further.

Answer with suggestions and questions.

A suggestion replaces one stretch of the passage with better wording. Copy the stretch into "before" exactly, character for character, including its LaTeX, and make it long enough to occur only once in the passage. Keep suggestions small: a sentence or less where you can. A suggestion must not change what the paper claims. Leave every number, unit, formula, citation, reference and name as it is, and do not add or remove a negation, a hedge, or a claim of cause, novelty or significance. If you think one of those is wrong or unsupported, do not rewrite it: ask a question about it instead. The authors decide on every suggestion; nothing is applied for them.

A question is for when the passage does not give you enough to judge: a claim with no evidence in sight, a number whose source is unclear, a step that does not follow. Copy the text it is about into "about" exactly.

Write reasons and questions plainly, for a researcher who knows the field. If the passage is fine, return empty lists. The paper's own terms are listed with the passage; treat them as correct.`;

/** Ask Claude. Used unless a test supplies its own `ask`. */
const askClaude: Ask = async ({ passage, glossary }) => {
  const client = new Anthropic();
  const response = await client.beta.messages
    .parse({
      model: MODEL,
      max_tokens: 16000,
      // If the model declines, the same request is tried on the provider's fallback model.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: SYSTEM,
      output_config: { effort: 'medium', format: betaZodOutputFormat(Review) },
      messages: [
        {
          role: 'user',
          content: `${glossary.length ? `The paper's own terms: ${glossary.join(', ')}\n\n` : ''}The passage:\n\n${passage}`,
        },
      ],
    })
    .catch((err: unknown) => {
      // Nothing of the passage is in these messages, and nothing of the error is logged.
      if (
        err instanceof Anthropic.AuthenticationError ||
        err instanceof Anthropic.PermissionDeniedError
      )
        throw new AppError('unavailable', 'Reviews by a model are not set up.');
      if (err instanceof Anthropic.RateLimitError)
        throw new AppError('unavailable', 'The model is busy. Try again in a minute.');
      if (err instanceof Anthropic.APIError)
        throw new AppError('unavailable', 'The model did not answer. Try again.');
      throw err;
    });
  if (response.stop_reason === 'refusal')
    throw new AppError('unavailable', 'The model declined to review this passage.');
  if (response.stop_reason === 'max_tokens' || !response.parsed_output)
    throw new AppError('unavailable', 'The model did not finish. Try a shorter passage.');
  return { review: response.parsed_output, model: response.model };
};

/**
 * Review a stretch of a file. Returns how many changes were proposed and questions asked, and
 * how many of the model's suggestions were left out because they did not quote the passage.
 */
export async function reviewPassage(
  pool: pg.Pool,
  store: BlobStore,
  userId: string,
  projectId: string,
  fileId: string,
  input: { from: unknown; to: unknown },
  opts: { ask?: Ask; provider?: string } = {},
): Promise<{ proposed: number; asked: number; left: number }> {
  await authorize(pool, userId, id(projectId), 'proposal.create');
  const paper = (
    await pool.query(
      `select p.model_processing, p.glossary from projects p join files f on f.project_id = p.id
       where p.id = $1 and f.id = $2 and f.eol is not null and f.path ~* '\\.(tex|ltx)$'`,
      [projectId, id(fileId)],
    )
  ).rows[0];
  if (!paper) throw new AppError('not_found', 'No such file to review.');
  // The owner's switch comes first: with it off, nothing below is reached and nothing is sent.
  if (!paper.model_processing)
    throw new AppError(
      'permission_denied',
      'The owner of this paper has not allowed its text to be sent to a model.',
    );
  if (!opts.ask && (opts.provider ?? process.env.MODEL_PROVIDER) !== 'anthropic')
    throw new AppError('unavailable', 'Reviews by a model are not set up.');

  const place = (v: unknown) => {
    if (!(v instanceof Uint8Array) || !v.length || v.length > 100)
      throw new AppError('invalid_input', 'Select the passage to review.');
    return v;
  };
  const doc = new Y.Doc();
  for (const update of await loadUpdates(pool, store, fileId)) Y.applyUpdate(doc, update);
  const text = doc.getText(TEXT);
  const at = (encoded: Uint8Array) => {
    try {
      const found = Y.createAbsolutePositionFromRelativePosition(
        Y.decodeRelativePosition(encoded),
        doc,
      );
      return found?.type === text ? found.index : -1;
    } catch {
      return -1;
    }
  };
  const [from, to] = [at(place(input.from)), at(place(input.to))];
  if (from < 0 || to < 0)
    throw new AppError('conflict', 'That text has not been saved yet. Try again in a moment.');
  const passage = text.toString().slice(from, to);
  if (passage.trim().length < 40)
    throw new AppError('invalid_input', 'Select a sentence or more to review.');
  if (passage.length > MAX_PASSAGE)
    throw new AppError(
      'invalid_input',
      `Select less: a review takes up to ${MAX_PASSAGE} characters at a time.`,
    );

  const { review, model } = await (opts.ask ?? askClaude)({ passage, glossary: paper.glossary });
  const answer = Review.parse(review);
  /** Where a quote stands in the file, if it is in the passage exactly once. */
  const quoted = (quote: string) => {
    const first = passage.indexOf(quote);
    if (!quote || first < 0 || passage.indexOf(quote, first + 1) >= 0) return null;
    const rel = (index: number, side: number) =>
      Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, index, side));
    return { from: rel(from + first, 0), to: rel(from + first + quote.length, -1) };
  };
  const done = { proposed: 0, asked: 0, left: 0 };
  for (const s of answer.suggestions) {
    const where = quoted(s.before);
    // Not a quote of the passage, or one that would change nothing or break the file: left out.
    if (!where || s.before === s.after || s.after.includes('\r') || s.after.length > 20_000) {
      done.left++;
      continue;
    }
    const made = await propose(pool, store, userId, projectId, fileId, {
      ...where,
      replacement: s.after,
      reason: s.reason.slice(0, 1000),
    });
    await pool.query(
      "update proposals set origin = 'critique', made_by = $2, evidence = $3 where id = $1",
      [made, `${model} with ${CLAIM_RULES}`, JSON.stringify(s.evidence.slice(0, 10))],
    );
    done.proposed++;
  }
  for (const q of answer.questions) {
    // A question about text that cannot be found is still a question: about the whole passage.
    const where = quoted(q.about) ?? quoted(passage);
    if (!where || !q.question.trim()) {
      done.left++;
      continue;
    }
    await startThread(pool, store, userId, projectId, fileId, {
      ...where,
      body: `Question from the model review: ${q.question.trim()}`.slice(0, 5000),
    });
    done.asked++;
  }
  return done;
}
