// Applying a merge: `merge.ts` says what a merge would do (`MergePlan`); this does it. It is
// written on `restoreRevision`'s pattern and uses its pieces, so that what holds for a restore
// holds here: the paper is kept as a revision first and nothing is erased; each file is written
// with the smallest edits (`restoreEdits`), so what is anchored in text the merge did not change
// stays; edits made ahead of time are used only for files nobody has typed in since; people
// typing meanwhile are merged in by the edit log; the editors are told after the edits (the
// `restored` channel) and hold what was typed offline for their author to decide; and undoing a
// merge is restoring the revision it kept.
//
// What a restore never does and a merge does: refuse. A restore puts the paper back to a revision
// whatever it is now; a merge was decided by a person looking at a plan, and the plan is only
// good for the paper as it was. If a file the plan changes has been typed in since, or a file was
// added, removed or renamed, the merge is refused and the person looks again.
import { encodeFile } from '@paperweave/latex';
import type pg from 'pg';
import { LIMITS, pathClash, clashMessage } from './archive.ts';
import { authorize } from './authz.ts';
import type { BlobStore } from './blobs.ts';
import { type Db, transaction } from './db.ts';
import { AppError } from './errors.ts';
import { fileMeta } from './files.ts';
import { mayRewrite, type RewriteOpts } from './limits.ts';
import {
  members,
  type MergePlan,
  type PlannedFile,
  planFromRevisions,
  noBase,
  settleFile,
  versionOf,
} from './merge.ts';
import { id } from './projects.ts';
import { type Carried, carryReview } from './merge-carry.ts';
import { compactIfDue } from './sync.ts';
import {
  announceRestore,
  blob,
  cut,
  finishWrites,
  holdPaper,
  keepPaper,
  prepareRestore,
  putEdited,
  type RevisionFile,
  writeFiles,
} from './revisions.ts';
import type { MergeChoice } from './textdiff.ts';

/** The three revisions a plan was made from: what the page keeps from the plan it showed. */
export type MergePlanRef = { target: string; source: string; base: string };

/**
 * A choice for each conflict of the plan, by the conflict's `id`; and for a root or compiler
 * changed on both sides, one under `settings.root` or `settings.compiler`: `ours` or `theirs`.
 */
export type MergeChoices = Record<string, MergeChoice>;

export const SETTING_CHOICES = ['settings.root', 'settings.compiler'] as const;

export type Merged = {
  /** The merge's revision of the target paper. */
  id: string;
  number: number;
  /** The paper as it stood just before: restoring it undoes the merge. */
  kept: { id: string; number: number };
  /** The row of `merges`. */
  merge: string;
  /** Files the merge changed (written, added, removed or renamed), and conflicts decided. */
  files: number;
  conflicts: number;
  /** Only when asked for: what was brought across from the source's open threads and proposals. */
  carried?: Carried & { failed?: true };
};

type Decision = {
  file: PlannedFile;
  remove?: true;
  add?: { path: string; digest: string };
  /** The target's file takes these bytes (a digest) or this text, under this name. */
  write?: { fileId: string; path: string; digest?: string; text?: string };
  /** Only the name changes. */
  rename?: { fileId: string; path: string };
  /** The target's file at the path this one takes goes. */
  displace?: string;
};

const refuse = (message: string) => new AppError('conflict', message);
export const STALE =
  'The paper changed while you were deciding. Look at the merge again before you apply it.';

/** Whether a file's place in its log moved: nothing is typed in a file whose log is at 0 or 1. */
const moved = (planned: string, now: unknown) => {
  const [a, b] = [Number(planned), Number(now)];
  return a !== b && (a > 1 || b > 1);
};

/** Every conflict (and the settings that changed on both sides) has a choice that may be made. */
function checkChoices(plan: MergePlan, choices: MergeChoices) {
  if (!choices || typeof choices !== 'object')
    throw new AppError('invalid_input', 'Choose what to do with each conflict.');
  const settings = SETTING_CHOICES.filter(
    (k) => plan.settings[k === 'settings.root' ? 'root' : 'compiler'].status === 'conflict',
  );
  const wanted = new Map<string, readonly string[]>([
    ...plan.conflicts.map((c) => [c.id, c.choices] as [string, readonly string[]]),
    ...settings.map((k) => [k, ['ours', 'theirs']] as [string, readonly string[]]),
  ]);
  const missing = [...wanted.keys()].filter((k) => choices[k] === undefined);
  if (missing.length)
    throw new AppError('invalid_input', `Choose what to do with: ${missing.join(', ')}.`);
  const unknown = Object.keys(choices).filter((k) => !wanted.has(k));
  if (unknown.length)
    throw new AppError(
      'invalid_input',
      `These are not conflicts of this merge: ${unknown.join(', ')}. Look at the merge again.`,
    );
  for (const [k, allowed] of wanted) {
    const c = choices[k];
    const ok =
      typeof c === 'string'
        ? allowed.includes(c)
        : allowed.includes('text') &&
          !!c &&
          typeof c === 'object' &&
          typeof (c as { text: unknown }).text === 'string' &&
          (c as { text: string }).text.length <= LIMITS.fileBytes;
    if (!ok)
      throw new AppError('invalid_input', `That is not a choice for ${k} (${allowed.join(', ')}).`);
  }
  // A text box sends line breaks as CRLF; the files hold LF.
  return Object.fromEntries(
    Object.entries(choices).map(([k, c]) => [
      k,
      typeof c === 'object' ? { text: c.text.replace(/\r\n?/g, '\n') } : c,
    ]),
  ) as MergeChoices;
}

/** What the merge does with each file of the plan, given the choices. Pure. */
function decide(plan: MergePlan, choices: MergeChoices, oursDigest: Map<string, string>) {
  const out: Decision[] = [];
  const staying = (f: PlannedFile) =>
    f.status !== 'removed' &&
    !(f.status === 'added' || (f.status === 'taken' && f.was)) &&
    !f.conflicts.some((c) => c.kind === 'path-taken');
  for (const f of plan.files) {
    const t = f.target;
    const s = f.source;
    const rename = t && f.was ? { fileId: t.fileId, path: f.path } : undefined;
    const take = (path: string): Decision => ({
      file: f,
      write: { fileId: t!.fileId, path, digest: s!.digest },
    });
    switch (f.status) {
      case 'unchanged':
      case 'kept':
        continue;
      case 'taken':
        out.push(f.content === 'theirs' ? take(f.path) : { file: f, rename });
        continue;
      case 'merged':
        out.push({ file: f, write: { fileId: t!.fileId, path: f.path, text: f.text! } });
        continue;
      case 'added':
        out.push({ file: f, add: { path: f.path, digest: s!.digest } });
        continue;
      case 'removed':
        out.push({ file: f, remove: true });
        continue;
    }
    const c = f.conflicts[0];
    const choice = choices[c.id];
    if (f.merge) {
      const mine = Object.fromEntries(f.conflicts.map((x) => [x.id, choices[x.id]]));
      out.push({
        file: f,
        write: { fileId: t!.fileId, path: f.path, text: settleFile(f, mine) },
      });
      continue;
    }
    const baseDigest = f.base?.digest ?? null;
    const oursNow = t ? oursDigest.get(t.fileId) : undefined;
    // Only the source changed the bytes: they are taken whichever name is chosen.
    const sourceChanged = !!s && !!t && oursNow === baseDigest && s.digest !== baseDigest;
    if (c.kind === 'binary' || c.kind === 'text') {
      out.push(choice === 'theirs' ? take(f.path) : { file: f, rename });
    } else if (c.kind === 'deleted-vs-changed') {
      if (choice === 'theirs')
        out.push(
          t ? { file: f, remove: true } : { file: f, add: { path: f.path, digest: s!.digest } },
        );
    } else if (c.kind === 'renamed') {
      const name = choice === 'theirs' ? s!.path : t!.path;
      const bytes =
        choice === 'theirs' ? s!.digest !== oursNow && s!.digest !== baseDigest : sourceChanged;
      if (bytes) out.push(take(name));
      else if (name !== t!.path) out.push({ file: f, rename: { fileId: t!.fileId, path: name } });
    } else {
      // path-taken: the source's file wants a path another file of the target keeps.
      if (choice !== 'theirs') {
        // The source's file stays out of that path: not added, or kept under the target's name.
        if (t && sourceChanged) out.push(take(t.path));
        continue;
      }
      const other = plan.files.find(
        (g) => g.key !== f.key && g.target?.path === f.path && staying(g),
      );
      const d: Decision = t
        ? sourceChanged
          ? take(f.path)
          : { file: f, rename: { fileId: t.fileId, path: f.path } }
        : { file: f, add: { path: f.path, digest: s!.digest } };
      out.push({ ...d, displace: other?.target?.fileId });
    }
  }
  return out;
}

/**
 * Merge `sourcePaper` into `targetPaper` (a version into its paper, or the paper into a version
 * to bring it up to date) as the plan made from `ref` said, with a choice for each conflict.
 *
 * - Owners and editors of both papers; others are refused as for the plan.
 * - The plan is made again from the three revisions, so its conflicts have the ids the person saw.
 *   Every conflict needs a choice, and only one it allows (`invalid_input`, naming the ids).
 * - Refused with `conflict` if a file the plan changes has been typed in since the plan, if a file
 *   was added, removed or renamed, if the target's root or compiler changed, or if the version was
 *   merged meanwhile. Checked with every file of the target held.
 * - The target is kept as a revision first; then each file is written, files are added, removed
 *   and renamed, the root and compiler settled, and a revision of kind `merge` cut (its
 *   `merged_from` the source's revision). The merge is recorded in `merges`, the version's base
 *   moves to the source's revision, and the editors are told on the `restored` channel after the
 *   edits. It costs the person the bytes of edits it adds, as a restore does.
 * - All or nothing. Undo: restore the kept revision.
 * - With `carry`, after the merge has committed (so it cannot change what the merge wrote), the
 *   source's open threads and proposals whose words are in the merged text are copied to the
 *   target's matching files (`merge-carry.ts`). If that fails the merge stands and `carried.failed`
 *   says so.
 */
export async function applyMerge(
  pool: pg.Pool,
  store: BlobStore,
  userId: string,
  targetPaper: string,
  sourcePaper: string,
  ref: MergePlanRef,
  choices: MergeChoices,
  budget: RewriteOpts = {},
  /** Also bring the source's open threads and proposals across, once the merge has committed. */
  carry = false,
): Promise<Merged> {
  const [target, source] = await members(
    pool,
    userId,
    [targetPaper, sourcePaper],
    'revision.write',
  );
  const version = versionOf(target, source);
  await mayRewrite(pool, userId, budget);
  const baseRow = (
    await pool.query('select base_revision_id from projects where id = $1', [version.id])
  ).rows[0];
  if (!baseRow?.base_revision_id) throw noBase();
  if (baseRow.base_revision_id !== ref.base)
    throw refuse('This version was merged since you looked. Look at the merge again.');
  const plan = await planFromRevisions(pool, store, ref);
  if (plan.target.paper !== target.id || plan.source.paper !== source.id)
    throw new AppError('invalid_input', 'These revisions are not of these papers.');
  const chosen = checkChoices(plan, choices);

  const oursDigest = new Map(
    (
      await pool.query('select file_id, digest from revision_files where revision_id = $1', [
        ref.target,
      ])
    ).rows.map((r) => [r.file_id as string, r.digest as string]),
  );
  const decisions = decide(plan, chosen, oursDigest);

  // Where every file of the target ends up, before anything is held: for the limits and clashes.
  const gone = new Set(
    decisions.flatMap((d) => [
      ...(d.remove ? [d.file.target!.fileId] : []),
      ...(d.displace ? [d.displace] : []),
    ]),
  );
  const paths = new Map(plan.target.files.map((f) => [f.fileId, f.path]));
  for (const d of decisions) {
    if (d.write) paths.set(d.write.fileId, d.write.path);
    if (d.rename) paths.set(d.rename.fileId, d.rename.path);
  }
  for (const g of gone) paths.delete(g);
  const final = [...paths.values(), ...decisions.flatMap((d) => (d.add ? [d.add.path] : []))];
  if (new Set(final).size !== final.length)
    throw refuse('Two files would have the same name after the merge. Look at the merge again.');
  if (final.length > LIMITS.files)
    throw new AppError('invalid_input', 'The merge would give this paper too many files.');
  for (const d of decisions) {
    const own = d.add?.path ?? d.write?.path ?? d.rename?.path;
    if (!own) continue;
    const clash = pathClash(
      own,
      final.filter((p) => p !== own),
    );
    if (clash) throw new AppError('invalid_input', clashMessage(clash));
  }

  // Everything that can be worked out without holding anything is, here, as a restore does:
  // the bytes of every file are read, the text each file is to hold is stored, and the edit
  // that turns each file's text into it is made. Typing waits for every round trip made while
  // the files are held.
  const ready = await putEdited(pool, store, target.id);
  const rows = new Map(
    (
      await pool.query('select id, eol, bom from files where project_id = $1', [target.id])
    ).rows.map((r) => [r.id as string, r]),
  );
  const blobs = new Map<string, Uint8Array>();
  const writes: RevisionFile[] = [];
  const adds: { path: string; digest: string; origin: string }[] = [];
  for (const d of decisions) {
    if (d.write) {
      let digest = d.write.digest;
      if (d.write.text !== undefined) {
        const row = rows.get(d.write.fileId);
        const bytes = encodeFile(d.write.text, { eol: row?.eol ?? 'lf', bom: !!row?.bom });
        digest = await store.put(bytes);
        blobs.set(digest, bytes);
      }
      writes.push({ file_id: d.write.fileId, path: d.write.path, digest: digest! });
    }
    if (d.add) adds.push({ ...d.add, origin: d.file.key });
  }
  const digests = [
    ...new Set([...writes.map((w) => w.digest), ...adds.map((a) => a.digest)]),
  ].filter((d) => !blobs.has(d));
  for (let i = 0; i < digests.length; i += 16)
    await Promise.all(
      digests.slice(i, i + 16).map(async (d) => blobs.set(d, await blob(store, d))),
    );
  const prepared = await prepareRestore(pool, target.id, writes, blobs);

  // Files whose name is set by the merge, written or not, and the files that must not have moved.
  const renamed = decisions.flatMap((d) => (d.rename ? [d.rename] : []));
  const touched = [
    ...plan.files.filter((f) => f.touches && f.target),
    ...decisions
      .flatMap((d) => (d.displace ? [d.displace] : []))
      .map((g) => plan.files.find((f) => f.target?.fileId === g)),
  ].filter((f): f is PlannedFile => !!f);

  // Settings: what changes if the source's root or compiler are taken.
  const choiceFor = (which: 'root' | 'compiler') => {
    const s = plan.settings[which];
    return s.status === 'taken'
      ? 'theirs'
      : s.status === 'conflict'
        ? chosen[`settings.${which}`]
        : 'ours';
  };
  const takeRoot = choiceFor('root') === 'theirs';
  const takeCompiler = choiceFor('compiler') === 'theirs';
  const theirsRoot = plan.settings.root.theirs;
  const rootPath = !takeRoot
    ? null
    : theirsRoot === null
      ? null
      : (plan.files.find((f) => f.source?.path === theirsRoot)?.path ?? theirsRoot);

  let appendedTo: string[] = [];
  const made = await transaction(pool, async (db: Db) => {
    const locked = await holdPaper(db, target.id);
    // Asked again with the files held: a role lowered while this waited is in force.
    await authorize(db, userId, id(target.id), 'revision.write');
    const live = (
      await db.query('select id, path, digest, eol, bom from files where project_id = $1', [
        target.id,
      ])
    ).rows;
    // The paper must still be the paper the plan was made of.
    const was = new Map(plan.target.files.map((f) => [f.fileId, f]));
    if (
      live.length !== was.size ||
      live.some((f) => was.get(f.id)?.path !== f.path) ||
      touched.some((f) => moved(f.target!.headSeq, locked.get(f.target!.fileId)?.head_seq))
    )
      throw refuse(STALE);
    const now = (
      await db.query(
        `select p.compiler, r.path as root from projects p
         left join files r on r.id = p.root_file_id where p.id = $1`,
        [target.id],
      )
    ).rows[0];
    if (
      (now?.compiler ?? null) !== plan.settings.compiler.ours ||
      (now?.root ?? null) !== plan.settings.root.ours
    )
      throw refuse(STALE);

    const kept = await keepPaper(db, store, userId, target.id, ready);
    if (gone.size) {
      await db.query(
        'update all_files set deleted_at = now() where project_id = $1 and id = any($2::uuid[])',
        [target.id, [...gone]],
      );
      // Open connections to the files are re-checked, find them gone, and are closed.
      await db.query("select pg_notify('acl', $1), pg_notify('files', $1)", [target.id]);
    }
    // Files whose name must change step aside first, so that two files can swap names.
    const moving = live.filter(
      (f) =>
        !gone.has(f.id) &&
        (writes.some((w) => w.file_id === f.id && w.path !== f.path) ||
          renamed.some((r) => r.fileId === f.id)),
    );
    if (moving.length)
      await db.query("update files set path = id::text || '.renaming' where id = any($1::uuid[])", [
        moving.map((f) => f.id),
      ]);
    if (adds.length) {
      const meta = adds.map((a) => fileMeta(a.path, blobs.get(a.digest)!));
      await db
        .query(
          `insert into files (project_id, path, digest, size, eol, bom, readonly_reason, origin_id)
           select $1::uuid, c.* from unnest($2::text[], $3::text[], $4::int[], $5::text[], $6::bool[],
             $7::text[], $8::uuid[]) as c(path, digest, size, eol, bom, readonly, origin)`,
          [
            target.id,
            adds.map((a) => a.path),
            adds.map((a) => a.digest),
            adds.map((a) => blobs.get(a.digest)!.length),
            meta.map((m) => m.eol),
            meta.map((m) => m.bom),
            meta.map((m) => m.readonly),
            adds.map((a) => a.origin),
          ],
        )
        .catch((err) => {
          if (err.code === '23505') throw refuse(STALE);
          throw err;
        });
    }
    const written = await writeFiles(db, store, userId, writes, {
      live: live.filter((f) => !gone.has(f.id)),
      blobs,
      prepared,
      locked,
    });
    for (const r of renamed) written.renames.push({ id: r.fileId, path: r.path });
    appendedTo = await finishWrites(db, target.id, userId, written, ready, budget);

    const root = rootPath !== null ? 'path' : takeRoot ? 'none' : 'keep';
    const set = (
      await db.query(
        `update projects set manifest_version = manifest_version + 1,
           compiler = case when $2::bool then $3::text else compiler end,
           root_file_id = case $4::text when 'keep' then root_file_id when 'none' then null
             else (select id from files where project_id = $1 and path = $5::text) end
         where id = $1
         returning root_file_id as root,
           exists (select 1 from files f where f.id = projects.root_file_id) as live`,
        [target.id, takeCompiler, plan.settings.compiler.theirs, root, rootPath],
      )
    ).rows[0];
    if ((root === 'path' && !set.root) || (set.root && !set.live))
      throw refuse('The merge would leave the paper without its root file.');

    const result = await cut(db, store, userId, target.id, {
      kind: 'merge',
      mergedFrom: ref.source,
      ready,
    });
    const changed = decisions.length;
    const row = (
      await db.query(
        `insert into merges (target_id, source_id, source_revision, kept_revision, result_revision,
           base_revision, files, conflicts, by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
        [
          target.id,
          source.id,
          ref.source,
          kept.id,
          result.id,
          ref.base,
          changed,
          plan.conflicts.length,
          userId,
        ],
      )
    ).rows[0];
    // The two papers had the source's revision in common now.
    await db.query('update projects set base_revision_id = $2 where id = $1', [
      version.id,
      ref.source,
    ]);
    await announceRestore(db, target.id, result.number);
    return {
      ...result,
      kept,
      merge: row.id as string,
      files: changed,
      conflicts: plan.conflicts.length,
    };
  });
  // The files appended to while held did not read their logs; each is looked at now, once the
  // merge has committed. The merge stands whatever this does.
  for (const fileId of appendedTo) await compactIfDue(pool, fileId).catch(() => undefined);
  const carried = carry
    ? await carryReview(pool, store, userId, target.id, source.id).catch(
        (): Carried & { failed: true } => ({
          threads: 0,
          proposals: 0,
          notCarried: 0,
          left: ['Comments and proposals could not be brought across. The merge itself is done.'],
          failed: true,
        }),
      )
    : undefined;
  return {
    id: made.id,
    number: made.number,
    kept: made.kept,
    merge: made.merge,
    files: made.files,
    conflicts: made.conflicts,
    ...(carried ? { carried } : {}),
  };
}
