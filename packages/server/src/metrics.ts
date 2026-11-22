// How papers fare, in counts: where they started, whether they were downloaded, whether more
// than one person wrote them, and what became of the changes that were proposed. Nothing here
// reads a paper's text.
import { authorize } from './authz.ts';
import type { Db } from './db.ts';
import { AppError } from './errors.ts';
import { id } from './projects.ts';

export type ProductMetrics = {
  /** By how a paper began: a template's name, `imported`, or `empty`. */
  papers: { origin: string; papers: number; downloadedZip: number; downloadedPdf: number }[];
  /** Papers at least one person has edited, and those at least two have. */
  edited: number;
  twoAuthors: number;
  /** Proposed changes by where they came from and what became of them. */
  proposals: { origin: string; status: string; count: number }[];
  /** What became of the grammar checker's findings, by kind, summed across papers. */
  grammar: { kind: string; outcome: string; count: number }[];
};

export const GRAMMAR_KINDS = ['spelling', 'grammar', 'style'] as const;
export const GRAMMAR_OUTCOMES = ['changed', 'proposed', 'word', 'rule_off'] as const;

/**
 * Note what was done with a finding of the grammar checker. Only the kind and the outcome are
 * kept: never the words, and never the rule.
 */
export async function recordGrammarOutcome(
  db: Db,
  userId: string,
  projectId: string,
  kind: unknown,
  outcome: unknown,
): Promise<void> {
  if (!GRAMMAR_KINDS.includes(kind as never) || !GRAMMAR_OUTCOMES.includes(outcome as never))
    throw new AppError('invalid_input', 'Name a kind and an outcome of a finding.');
  await authorize(
    db,
    userId,
    id(projectId),
    outcome === 'proposed' ? 'proposal.create' : 'file.write',
  );
  await db.query(
    `insert into grammar_outcomes (project_id, kind, outcome, count) values ($1, $2, $3, 1)
     on conflict (project_id, kind, outcome) do update set count = grammar_outcomes.count + 1`,
    [id(projectId), kind, outcome],
  );
}

/** Note that a paper was downloaded. */
export const recordDownload = (db: Db, projectId: string, kind: 'zip' | 'pdf') =>
  db.query('insert into downloads (project_id, kind) values ($1, $2)', [projectId, kind]);

export async function productMetrics(db: Db): Promise<ProductMetrics> {
  const papers = (
    await db.query(
      `select coalesce(p.template, case when r.project_id is null then 'empty' else 'imported' end)
                as origin,
              count(*)::int as papers,
              count(*) filter (where exists (
                select 1 from downloads d where d.project_id = p.id and d.kind = 'zip'))::int
                as "downloadedZip",
              count(*) filter (where exists (
                select 1 from downloads d where d.project_id = p.id and d.kind = 'pdf'))::int
                as "downloadedPdf"
       from projects p left join import_reports r on r.project_id = p.id
       group by 1 order by 1`,
    )
  ).rows;
  // Whoever is in the edit log now, and whoever was before it was last compacted.
  const authors = (
    await db.query(
      `with wrote as (
         select f.project_id, u.user_id from file_updates u join all_files f on f.id = u.file_id
         where u.user_id is not null
         union select project_id, user_id from project_authors
       ), per as (select project_id, count(distinct user_id) as n from wrote group by 1)
       select count(*)::int as edited, count(*) filter (where n >= 2)::int as "twoAuthors" from per`,
    )
  ).rows[0];
  const proposals = (
    await db.query(
      `select origin, status, count(*)::int as count from proposals group by 1, 2 order by 1, 2`,
    )
  ).rows;
  const grammar = (
    await db.query(
      `select kind, outcome, sum(count)::int as count from grammar_outcomes
       group by 1, 2 order by 1, 2`,
    )
  ).rows;
  return { papers, ...authors, proposals, grammar };
}
