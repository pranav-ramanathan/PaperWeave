// Spelling and grammar. The prose of a file is sent to a LanguageTool server we run ourselves
// (GRAMMAR_URL); nothing goes to anyone else. Formulas, references, citations, commands and
// code are sent as markup the checker skips, and a finding that touches any of them is dropped.
import { DEFAULT_TRANSPARENT, escape, inProse, placed, prose, readAs } from '@paperweave/latex';
import type pg from 'pg';
import * as Y from 'yjs';
import { authorize } from './authz.ts';
import { type BlobStore, sha256 } from './blobs.ts';
import { type Db, transaction } from './db.ts';
import { AppError } from './errors.ts';
import { envCount } from './limits.ts';
import { boundedJson } from './outbound.ts';
import { id } from './projects.ts';
import { proseOf, textMacrosOf } from './labels.ts';
import { loadUpdates, TEXT } from './sync.ts';

export const LANGUAGES = ['en-GB', 'en-US'] as const;
export type Language = (typeof LANGUAGES)[number];
export type LanguageSettings = {
  language: Language;
  /** The paper's own words: never reported as misspelt. */
  glossary: string[];
  /** Rules switched off for this paper, by the checker's name for them. */
  off: string[];
};
export type LanguageFinding = {
  /** The stretch as two encoded Yjs positions, base64, as for threads and proposals. */
  from: string;
  to: string;
  /** What the stretch says. */
  words: string;
  /** The stretch as the checker read it: \'e as é, \% as %. What the glossary holds. */
  reads: string;
  message: string;
  /** What it could say instead, best first, as LaTeX source: ready to put in the text. May be empty. */
  replacements: string[];
  /** Whether `words` can be one of the paper's own words. */
  addable: boolean;
  /** The checker's name for the rule, to switch it off by. */
  rule: string;
  kind: 'spelling' | 'grammar' | 'style';
};

/**
 * Rules that do not fit LaTeX source: its quotation marks are `` and '', and the stand-ins for
 * formulas leave spaces a checker would count. Oxford -ize is a house style, not an error.
 */
export const NEVER = [
  ...['EN_QUOTES', 'EN_UNPAIRED_QUOTES', 'WHITESPACE_RULE', 'CONSECUTIVE_SPACES'],
  'OXFORD_SPELLING_Z_NOT_S',
];
/**
 * Whether a word the checker does not know is written as an abbreviation or a made-up name, not
 * as an ordinary word: `QNLI`, `ResNet`, `mAP`, `RMSProp`, `word2vec`, `GPUs`. The checker
 * knows no such name and answers with a guess (`ResNet`: "Reset"); half of what it calls
 * misspelt in a paper is one. Each part between hyphens or spaces must be written so (a single
 * character aside), so an ordinary word joined to a name is still checked: `GPU-acelerated`.
 * `THe` and `ANd` are ordinary words typed with a slip, and are not names.
 */
export function coined(word: string): boolean {
  const parts = word.split(/[\s\-–—/]+/).filter((part) => [...part].length > 1);
  return (
    parts.length > 0 &&
    parts.every((part) => {
      const capitals = part.match(/\p{Lu}/gu)?.length ?? 0;
      return (
        /\p{N}/u.test(part) ||
        // A capital after a small letter: ResNet, mAP, arXiv.
        /\p{Ll}\p{Lu}/u.test(part) ||
        capitals >= 3 ||
        // All capitals, with or without a plural s: QA, NNs.
        (capitals >= 2 && !/\p{Ll}/u.test(part.replace(/['’]?s$/, '')))
      );
    })
  );
}
/** A word: letters, digits, and the marks that join them. No spaces. */
const WORD = /^[\p{L}\p{N}'’.-]+$/u;
const fits = (s: string) => s.length <= 60 && WORD.test(s);
const RULE = /^[A-Z0-9_]{1,80}$/;
const bad = (why: string) => new AppError('invalid_input', why);

export async function languageSettings(
  db: Db,
  userId: string,
  projectId: string,
): Promise<LanguageSettings> {
  await authorize(db, userId, id(projectId), 'project.read');
  const { rows } = await db.query(
    'select language, glossary, grammar_off as off from projects where id = $1',
    [projectId],
  );
  return rows[0];
}

const sorted = (items: Iterable<string>) => [...new Set(items)].sort((a, b) => a.localeCompare(b));
/** A list of strings, trimmed and unique, of which every one must be `ok`. */
function list(v: unknown, what: string, ok: (s: string) => boolean) {
  if (!Array.isArray(v) || v.length > 2000) throw bad(`Give ${what} as a list.`);
  const items = [...new Set(v.map((s) => (typeof s === 'string' ? s.trim() : '')))].filter(Boolean);
  if (!items.every(ok)) throw bad(`One of ${what} cannot be used.`);
  return items.sort((a, b) => a.localeCompare(b));
}

/** Change how a paper's prose is checked. Only what is given is changed. */
export async function setLanguageSettings(
  pool: pg.Pool,
  userId: string,
  projectId: string,
  input: { language?: unknown; glossary?: unknown; off?: unknown },
): Promise<void> {
  await authorize(pool, userId, id(projectId), 'file.write');
  if (input.language !== undefined && !LANGUAGES.includes(input.language as Language))
    throw bad('Choose British or American English.');
  const glossary =
    input.glossary === undefined ? undefined : list(input.glossary, 'the words', fits);
  const off =
    input.off === undefined ? undefined : list(input.off, 'the rules', (s) => RULE.test(s));
  await transaction(pool, async (tx) => {
    const now = (
      await tx.query(
        'select language, glossary, grammar_off as off from projects where id = $1 for update',
        [projectId],
      )
    ).rows[0] as LanguageSettings;
    await tx.query(
      'update projects set language = $2, glossary = $3, grammar_off = $4 where id = $1',
      [
        projectId,
        input.language ?? now.language,
        JSON.stringify(glossary ?? now.glossary),
        JSON.stringify(off ?? now.off),
      ],
    );
  });
}

/**
 * What a saved language form changes: the difference between what the page showed when it was
 * drawn and what was sent back. Only that is applied, so what others changed meanwhile stays.
 */
export function languageChange(
  shown: { language: string; glossary: string[]; off: string[] },
  sent: { language: string; glossary: string[]; off: string[] },
) {
  const minus = (a: string[], b: string[]) => {
    const gone = new Set(b);
    return a.filter((x) => !gone.has(x));
  };
  return {
    ...(sent.language !== shown.language ? { language: sent.language } : {}),
    addWords: minus(sent.glossary, shown.glossary),
    dropWords: minus(shown.glossary, sent.glossary),
    rulesOn: minus(shown.off, sent.off),
  };
}

/**
 * Add and remove words and rules one by one, on what the paper holds now, so that changes made
 * at the same moment or since a page was drawn are kept. Never logs a word.
 */
export async function changeLanguageSettings(
  pool: pg.Pool,
  userId: string,
  projectId: string,
  change: {
    language?: unknown;
    addWords?: unknown;
    dropWords?: unknown;
    rulesOff?: unknown;
    rulesOn?: unknown;
  },
): Promise<void> {
  await authorize(pool, userId, id(projectId), 'file.write');
  if (change.language !== undefined && !LANGUAGES.includes(change.language as Language))
    throw bad('Choose British or American English.');
  const given = (v: unknown, what: string, ok: (s: string) => boolean) =>
    v === undefined ? [] : list(v, what, ok);
  const addWords = given(change.addWords, 'the words', fits);
  const dropWords = given(change.dropWords, 'the words', (s) => s.length <= 2000);
  const rulesOff = given(change.rulesOff, 'the rules', (s) => RULE.test(s));
  const rulesOn = given(change.rulesOn, 'the rules', (s) => s.length <= 2000);
  await transaction(pool, async (tx) => {
    const now = (
      await tx.query(
        'select language, glossary, grammar_off as off from projects where id = $1 for update',
        [projectId],
      )
    ).rows[0] as LanguageSettings;
    const drop = new Set(dropWords);
    const on = new Set(rulesOn);
    const glossary = sorted([...now.glossary.filter((w) => !drop.has(w)), ...addWords]);
    const off = sorted([...now.off.filter((r) => !on.has(r)), ...rulesOff]);
    if (glossary.length > 2000) throw bad('A paper keeps at most 2,000 words of its own.');
    await tx.query(
      'update projects set language = $2, glossary = $3, grammar_off = $4 where id = $1',
      [projectId, change.language ?? now.language, JSON.stringify(glossary), JSON.stringify(off)],
    );
  });
}

type Match = {
  offset: number;
  length: number;
  message: string;
  replacements: { value: string }[];
  rule: { id: string; category: { id: string } };
};
/** Answers kept for a while: several people with a file open ask about the same text. */
const answers = new Map<string, Match[]>();
/** Questions being asked of the checker now: the same one asked again waits for that answer. */
const asking = new Map<string, Promise<Match[]>>();
/** Requests to the checker one person may cause in a minute (a kept or shared answer is not one). */
export const GRAMMAR_CHECKS_PER_USER = 60;

/**
 * The spelling and grammar findings in a file's saved text. `unavailable` when no checker is
 * set up or it does not answer.
 */
export async function checkGrammar(
  pool: pg.Pool,
  store: BlobStore,
  userId: string,
  projectId: string,
  fileId: string,
  opts: { url?: string; fetcher?: typeof fetch; perMinute?: number } = {},
): Promise<LanguageFinding[]> {
  const settings = await languageSettings(pool, userId, projectId);
  const file = (
    await pool.query(
      `select head_seq from files where id = $1 and project_id = $2 and eol is not null
         and path ~* '\\.(tex|ltx)$'`,
      [id(fileId), projectId],
    )
  ).rows[0];
  if (!file) throw new AppError('not_found', 'No such file to check.');
  const url = opts.url ?? process.env.GRAMMAR_URL;
  if (!url) throw new AppError('unavailable', 'Spelling and grammar checking is not set up.');
  const doc = new Y.Doc();
  for (const update of await loadUpdates(pool, store, fileId)) Y.applyUpdate(doc, update);
  const text = doc.getText(TEXT);
  const src = text.toString();
  // The paper's own theorem environments are prose here as in the editor. At most 64 names.
  const own = await proseOf(pool, store, projectId);
  // So are the paper's macros that only print words: the checker reads what they print.
  const words = await textMacrosOf(pool, store, projectId);
  const { annotation, segments, asides } = prose(
    src,
    new Set([...DEFAULT_TRANSPARENT, ...own]),
    words,
  );
  const disabled = [...NEVER, ...settings.off].join(',');
  // The same annotation, language and rules give the same answer: the annotation holds the text,
  // and what every macro and environment of the paper makes of it. Only its hash is kept.
  const key = `${sha256(Buffer.from(JSON.stringify(annotation)))}:${settings.language}:${disabled}`;
  let matches = answers.get(key);
  if (!matches) {
    let pending = asking.get(key);
    if (!pending) {
      pending = (async () => {
        // Only a request that goes to the checker is counted, before it is made so that one that
        // fails still counts. An answer already kept, or one being waited for, costs the checker
        // nothing. Viewers may check (they can read everything the check reads); nobody may make
        // the checker work without bound.
        const perMinute =
          opts.perMinute ?? envCount('GRAMMAR_CHECKS_PER_USER', GRAMMAR_CHECKS_PER_USER);
        await pool.query(
          "delete from grammar_requests where user_id = $1 and created_at < now() - interval '1 hour'",
          [userId],
        );
        const recent = (
          await pool.query(
            "select count(*)::int as n from grammar_requests where user_id = $1 and created_at > now() - interval '1 minute'",
            [userId],
          )
        ).rows[0].n as number;
        if (recent >= perMinute)
          throw new AppError('conflict', 'Checking is paused for a moment. Try again shortly.');
        await pool.query('insert into grammar_requests (user_id) values ($1)', [userId]);
        const res = await (opts.fetcher ?? fetch)(`${url.replace(/\/$/, '')}/v2/check`, {
          method: 'POST',
          body: new URLSearchParams({
            data: JSON.stringify({ annotation }),
            language: settings.language,
            disabledRules: disabled,
          }),
          redirect: 'manual',
          signal: AbortSignal.timeout(20_000),
        }).catch(() => null);
        if (!res?.ok)
          throw new AppError('unavailable', 'The spelling and grammar checker did not answer.');
        const body = (await boundedJson(res, 8_000_000)) as { matches?: Match[] } | null;
        if (!Array.isArray(body?.matches))
          throw new AppError('unavailable', 'The spelling and grammar checker did not answer.');
        // shortcut: a few answers kept per process, the oldest dropped. Share them between
        // processes if checking ever shows up in timings.
        if (answers.size >= 32) answers.delete(answers.keys().next().value!);
        answers.set(key, body.matches);
        return body.matches;
      })().finally(() => asking.delete(key));
      asking.set(key, pending);
    }
    matches = await pending;
  }

  const known = new Set(settings.glossary.map((w) => w.normalize('NFC').toLowerCase()));
  const place = (index: number, side: number) =>
    Buffer.from(
      Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, index, side)),
    ).toString('base64');
  const findings: LanguageFinding[] = [];
  for (const m of matches) {
    // A caption's and a footnote's words are read after the text: back to where they are written.
    const at = placed(src, asides, m.offset, m.length);
    if (!at) continue;
    const [from, to] = at;
    // Never in a formula, a unit, code, a path or a citation: only where all of it is prose.
    if (to <= from || !inProse(segments, from, to)) continue;
    const words = src.slice(from, to);
    const reads = readAs(src, segments, from, to).normalize('NFC');
    const spelling = m.rule.category.id === 'TYPOS';
    if (spelling && (known.has(reads.toLowerCase()) || known.has(words.toLowerCase()))) continue;
    // An abbreviation or a made-up name is not a misspelt word.
    if (spelling && coined(reads)) continue;
    findings.push({
      from: place(from, 0),
      to: place(to, -1),
      words,
      reads,
      message: m.message,
      // The checker sees plain text: "R&D", "50%". The source needs \& and \%.
      replacements: m.replacements.slice(0, 5).map((r) => escape(r.value)),
      addable: fits(reads),
      rule: m.rule.id,
      kind: spelling
        ? 'spelling'
        : ['STYLE', 'REDUNDANCY', 'PLAIN_ENGLISH', 'TYPOGRAPHY'].includes(m.rule.category.id)
          ? 'style'
          : 'grammar',
    });
  }
  return findings;
}
