// What has been checked about a paper's citations. Two things, kept apart:
// whether an entry's details are right (a DOI lookup), and whether the source supports a
// particular claim the paper makes (a person's judgement, about one quoted claim).
import { createHash } from 'node:crypto';
import { type BibEntry, bibEntries, bibItems, cleanDoi, plainText } from '@paperweave/latex';
import type pg from 'pg';
import { authorize, can } from './authz.ts';
import type { BlobStore } from './blobs.ts';
import type { Db } from './db.ts';
import { AppError } from './errors.ts';
import { texFiles } from './labels.ts';
import { id } from './projects.ts';

export type Compared = { field: string; entry: string; registry: string; same: boolean };
export type DoiLookup = {
  key: string;
  doi: string;
  source: string;
  lookedUpAt: string;
  lookedUpBy: string | null;
  outcome: 'matches' | 'differs' | 'not_found';
  comparison: Compared[];
  /** The entry has been edited since: this is about what it used to say. */
  outOfDate: boolean;
};
export const VERDICTS = ['supports', 'partly', 'does_not_support'] as const;
export type EvidenceCheck = {
  id: string;
  key: string;
  claim: string;
  verdict: (typeof VERDICTS)[number];
  note: string | null;
  checkedBy: string | null;
  checkedAt: string;
  /** The claim's words are still in the paper. If not, the check is about something since rewritten. */
  stillSaid: boolean;
  /** Whether the person asking may take this check away. */
  mine: boolean;
};

/** Letters and digits of every script, lower case, accents off: what two spellings have in common. */
export const squash = (text: string) =>
  plainText(text)
    .normalize('NFKD')
    .toLowerCase()
    .replace(/\p{M}+/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, '');
/** Two squashed texts are the same only if there is something in them. */
const alike = (a: string, b: string) => {
  const x = squash(a);
  return x !== '' && x === squash(b);
};

/** A registry's string as text: tags taken out, the common entities decoded. */
const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};
const unmarked = (text: string) =>
  text
    .replace(/<[^>]*>/g, '')
    .replace(/&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([a-zA-Z]+));/g, (all, dec, hex, name) => {
      if (name) return ENTITIES[name] ?? all;
      const code = dec ? Number(dec) : Number.parseInt(hex, 16);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : all;
    })
    .replace(/\s+/g, ' ')
    .trim();

/** The first author's name as far as the family name goes: "Family" of "Family, Given", else all of it. */
const authorHead = (entry: BibEntry) => {
  const first = plainText(
    (entry.fields.author ?? entry.fields.editor ?? '').split(/\s+and\s+/i)[0],
  );
  return { head: first.split(',')[0].trim(), comma: first.includes(',') };
};
/** The entry's first author, as it reads when the registry's family name is not known. */
const firstAuthor = (entry: BibEntry) => {
  const { head, comma } = authorHead(entry);
  return comma ? head : (head.split(' ').at(-1) ?? '');
};
/** The same person: the whole names agree, or the entry's name ends with the registry's family name. */
const sameAuthor = (entry: BibEntry, registry: string) => {
  const words = (t: string) => t.split(/\s+/).filter(Boolean).map(squash).filter(Boolean);
  const theirs = words(registry);
  const mine = words(authorHead(entry).head.replace(/(?:\s+|^)(?:jr|sr|ii|iii|iv)\.?$/i, ''));
  return (
    theirs.length > 0 &&
    mine.length >= theirs.length &&
    mine.slice(-theirs.length).join(' ') === theirs.join(' ')
  );
};
/** The parts of an entry a registry can confirm, as the entry gives them. */
const comparable = (entry: BibEntry) => ({
  title: plainText(entry.fields.title ?? ''),
  year: /\d{4}/.exec(entry.fields.year ?? entry.fields.date ?? '')?.[0] ?? '',
  'first author': firstAuthor(entry),
  venue: plainText(
    entry.fields.journal ?? entry.fields.journaltitle ?? entry.fields.booktitle ?? '',
  ),
});
/** Citation numbers in brackets, and the number after Figure, Table, Section...: they follow the paper's numbering. */
const dropNumbers = (text: string) =>
  text
    .replace(/\[\s*\d+(?:\s*[,;–—-]\s*\d+)*\s*\]/g, '')
    .replace(
      /\b(Figure|Fig\.?|Table|Section|Sec\.?|Equation|Eq\.?|Appendix)(?:\s|~)*\(?\d+(?:\.\d+)*[a-z]?\)?/gi,
      '$1',
    );
/** The paper's source without its citation and reference commands, arguments and all. */
const dropReferences = (tex: string) =>
  dropNumbers(
    tex.replace(
      /\\(?:[a-zA-Z]*cite[a-zA-Z]*|[a-zA-Z]*ref|label)\*?\s*(?:\[[^\]]*\]\s*)*\{[^}]*\}/gi,
      '',
    ),
  );
/** Whether a claim's words are in the paper's (squashed) words. A claim with no words is not. */
const stillSaid = (said: string, claim: string) => {
  const words = squash(dropNumbers(claim));
  return words !== '' && said.includes(words);
};
const digestOf = (entry: BibEntry) =>
  createHash('sha256')
    .update(JSON.stringify([cleanDoi(entry), comparable(entry)]))
    .digest('hex');

/** The paper's entries by key. Of several with one key, the first: that is the one BibTeX keeps. */
async function entriesByKey(db: Db, store: BlobStore, projectId: string) {
  const out = new Map<string, BibEntry>();
  for (const file of await texFiles(db, store, projectId, false, '\\.bib$'))
    for (const e of bibEntries(file.text)) if (!out.has(e.key)) out.set(e.key, e);
  // A hand-written thebibliography: its items are entries too, with the item's text for a title.
  for (const file of await texFiles(db, store, projectId))
    for (const i of bibItems(file.text))
      if (!out.has(i.key))
        out.set(i.key, {
          key: i.key,
          type: 'bibitem',
          fields: { title: i.text },
          at: i.at,
          end: i.at,
          keyAt: i.at,
        });
  return out;
}

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Look an entry's DOI up in Crossref, set the registry's record beside the entry, and record
 * what was found, where and when. Only the DOI leaves this service. Nothing is changed in the
 * paper: a difference is reported, not corrected.
 */
export async function lookUpDoi(
  pool: pg.Pool,
  store: BlobStore,
  userId: string,
  projectId: string,
  key: string,
  opts: { fetcher?: Fetcher; registry?: string } = {},
): Promise<DoiLookup> {
  await authorize(pool, userId, id(projectId), 'comment.write');
  const entry = (await entriesByKey(pool, store, projectId)).get(key);
  if (!entry) throw new AppError('invalid_input', `The bibliography has no entry called ${key}.`);
  const doi = cleanDoi(entry);
  if (!/^10\.\d{4,9}\/\S+$/.test(doi))
    throw new AppError('invalid_input', 'That entry has no DOI that can be looked up.');
  const registry = opts.registry ?? process.env.CROSSREF_URL ?? 'https://api.crossref.org';
  const unreachable = new AppError(
    'unavailable',
    'The DOI registry did not answer. Nothing was recorded; try again later.',
  );
  const res = await (opts.fetcher ?? fetch)(`${registry}/works/${encodeURIComponent(doi)}`, {
    headers: { accept: 'application/json', 'user-agent': 'PaperWeave (DOI lookup)' },
    signal: AbortSignal.timeout(10_000),
  }).catch(() => {
    throw unreachable;
  });
  let comparison: Compared[] = [];
  if (res.status !== 404) {
    if (!res.ok) throw unreachable;
    const record = ((await res.json().catch(() => null)) as { message?: Record<string, unknown> })
      ?.message;
    if (!record) throw unreachable;
    const list = (v: unknown) => (Array.isArray(v) ? v : []);
    const texts = (v: unknown) =>
      list(v)
        .filter((x): x is string => typeof x === 'string')
        .map(unmarked);
    const years = (v: unknown) => {
      const y = (v as { 'date-parts'?: unknown[][] } | undefined)?.['date-parts']?.[0]?.[0];
      return typeof y === 'number' ? String(y) : '';
    };
    const ours = comparable(entry);
    const [title = ''] = texts(record.title);
    const [subtitle = ''] = texts(record.subtitle);
    const withSub = subtitle ? `${title}: ${subtitle}` : '';
    const author = list(record.author)[0] as { family?: string; name?: string } | undefined;
    const family = unmarked(author?.family || author?.name || '');
    const issued = years(record.issued ?? record.published);
    const dated = [issued, years(record['published-print']), years(record['published-online'])];
    const venues = [...texts(record['container-title']), ...texts(record['short-container-title'])];
    const pick = (mine: string, options: string[], fallback: string) =>
      options.find((o) => alike(mine, o)) ?? fallback;
    const theirs: Record<string, string> = {
      title: pick(ours.title, [title, withSub], title),
      year: pick(ours.year, dated.filter(Boolean), issued || dated.find(Boolean) || ''),
      'first author': family,
      venue: pick(ours.venue, venues, venues[0] ?? ''),
    };
    const same: Record<string, boolean> = {
      title: alike(ours.title, theirs.title),
      year: alike(ours.year, theirs.year),
      'first author': sameAuthor(entry, family),
      venue: alike(ours.venue, theirs.venue),
    };
    comparison = Object.entries(ours)
      // A part neither side gives cannot be compared, and is not held against the entry.
      .filter(([field, mine]) => mine || theirs[field])
      .map(([field, mine]) => ({
        field,
        // An author who is the registry's author is shown as the registry spells the family name.
        entry: field === 'first author' && same[field] ? theirs[field] : mine,
        registry: theirs[field],
        same: same[field],
      }));
  }
  const outcome =
    res.status === 404 ? 'not_found' : comparison.every((c) => c.same) ? 'matches' : 'differs';
  const { rows } = await pool.query(
    `insert into doi_lookups (project_id, key, doi, source, looked_up_by, outcome, comparison, entry_digest)
     values ($1, $2, $3, 'crossref', $4, $5, $6, $7) returning looked_up_at`,
    [projectId, key, doi, userId, outcome, JSON.stringify(comparison), digestOf(entry)],
  );
  return {
    key,
    doi,
    source: 'crossref',
    lookedUpAt: rows[0].looked_up_at.toISOString(),
    lookedUpBy: null,
    outcome,
    comparison,
    outOfDate: false,
  };
}

/** Record a person's judgement that a source does, partly does, or does not support one claim. */
export async function recordEvidence(
  pool: pg.Pool,
  store: BlobStore,
  userId: string,
  projectId: string,
  key: string,
  check: { claim: unknown; verdict: unknown; note?: unknown },
): Promise<string> {
  await authorize(pool, userId, id(projectId), 'comment.write');
  const claim = typeof check.claim === 'string' ? check.claim.replace(/\s+/g, ' ').trim() : '';
  const note = typeof check.note === 'string' ? check.note.trim() : '';
  if (!claim || claim.length > 2000)
    throw new AppError('invalid_input', 'Quote the claim, in up to 2000 characters.');
  if (!VERDICTS.includes(check.verdict as never))
    throw new AppError('invalid_input', 'Say whether the source supports the claim.');
  if (note.length > 2000) throw new AppError('invalid_input', 'The note is too long.');
  if (!(await entriesByKey(pool, store, projectId)).has(key))
    throw new AppError('invalid_input', `The bibliography has no entry called ${key}.`);
  const { rows } = await pool.query(
    `insert into evidence_checks (project_id, key, claim, verdict, note, checked_by)
     values ($1, $2, $3, $4, $5, $6) returning id`,
    [projectId, key, claim, check.verdict, note || null, userId],
  );
  return rows[0].id;
}

/** Take an evidence check away: its author may, and so may anyone who can edit the paper. */
export async function removeEvidence(db: Db, userId: string, projectId: string, checkId: string) {
  const role = await authorize(db, userId, id(projectId), 'comment.write');
  const { rowCount } = await db.query(
    `delete from evidence_checks where id = $1 and project_id = $2 and (checked_by = $3 or $4)`,
    [id(checkId), projectId, userId, can(role, 'file.write')],
  );
  if (!rowCount) throw new AppError('not_found', 'No such check, or it is not yours to remove.');
}

/** For each key: the newest lookup of its DOI, and the evidence checks made of it. */
export async function citationChecks(
  pool: pg.Pool,
  store: BlobStore,
  userId: string,
  projectId: string,
): Promise<{ lookups: Record<string, DoiLookup>; evidence: Record<string, EvidenceCheck[]> }> {
  const role = await authorize(pool, userId, id(projectId), 'project.read');
  const entries = await entriesByKey(pool, store, projectId);
  const lookups: Record<string, DoiLookup> = {};
  const found = await pool.query(
    `select distinct on (l.key) l.key, l.doi, l.source, l.looked_up_at, u.email, l.outcome,
            l.comparison, l.entry_digest
     from doi_lookups l left join "user" u on u.id = l.looked_up_by
     where l.project_id = $1 order by l.key, l.looked_up_at desc`,
    [projectId],
  );
  for (const r of found.rows) {
    const entry = entries.get(r.key);
    lookups[r.key] = {
      key: r.key,
      doi: r.doi,
      source: r.source,
      lookedUpAt: r.looked_up_at.toISOString(),
      lookedUpBy: r.email,
      outcome: r.outcome,
      comparison: r.comparison,
      outOfDate: !entry || digestOf(entry) !== r.entry_digest,
    };
  }
  // The paper's words, with LaTeX markup taken away, to see whether a quoted claim is still there.
  const said = squash(
    dropReferences((await texFiles(pool, store, projectId)).map((f) => f.text).join('\n')),
  );
  const evidence: Record<string, EvidenceCheck[]> = {};
  const checks = await pool.query(
    `select c.id, c.key, c.claim, c.verdict, c.note, c.checked_at, c.checked_by, u.email
     from evidence_checks c left join "user" u on u.id = c.checked_by
     where c.project_id = $1 order by c.checked_at`,
    [projectId],
  );
  for (const r of checks.rows)
    (evidence[r.key] ??= []).push({
      id: r.id,
      key: r.key,
      claim: r.claim,
      verdict: r.verdict,
      note: r.note,
      checkedBy: r.email,
      checkedAt: r.checked_at.toISOString(),
      stillSaid: stillSaid(said, r.claim),
      mine: r.checked_by === userId || can(role, 'file.write'),
    });
  return { lookups, evidence };
}
