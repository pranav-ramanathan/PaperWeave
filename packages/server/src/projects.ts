// Projects, members and invitations. Every function takes the acting user and checks first.
import { createHash, randomBytes } from 'node:crypto';
import type pg from 'pg';
import { LIMITS } from './archive.ts';
import { hiddenAddress } from './auth.ts';
import { authorize, type Role, ROLES } from './authz.ts';
import { type Db, transaction } from './db.ts';
import { AppError } from './errors.ts';
import { envCount } from './limits.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Reject anything that is not an ID before it reaches a query that expects one. */
export const id = (value: unknown) => {
  if (typeof value !== 'string' || !UUID.test(value))
    throw new AppError('not_found', 'No such project.');
  return value;
};
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
const INVITE_DAYS = 14;

export type Project = { id: string; name: string; role: Role };
/** A paper as the list of papers shows it: with how much review is waiting in it. */
export type ListedProject = Project & { threads: number; proposals: number };
export type ProjectDetail = Project & { compiler: string; root: string | null };
export type Member = { userId: string; email: string; name: string; role: Role };

/**
 * Refuses when starting this many more papers would take the person past what one person may
 * start in an hour. Each paper can hold 300 MB, so this is what bounds how fast one account
 * can fill the store.
 */
export async function mayStartPapers(
  db: Db,
  userId: string,
  more = 1,
  perHour = LIMITS.papersPerHour,
) {
  const { rows } = await db.query(
    `select count(*)::int as n from projects p
     join project_members m on m.project_id = p.id and m.user_id = $1 and m.role = 'owner'
     where p.created_at > now() - interval '1 hour'`,
    [userId],
  );
  if (rows[0].n + more > perHour)
    throw new AppError(
      'conflict',
      `One person can start ${perHour} papers in an hour, and you have started ${rows[0].n}. Try again in a little while.`,
    );
}

/**
 * A paper's name: one line of at most 200 characters, with no control characters. The name goes
 * into emails, where a line break would let a name add lines of its own to the message.
 * Names made before this check are as they were; where one goes into an email it is put on one
 * line (see `oneLine`).
 */
export function paperName(name: unknown): string {
  if (typeof name !== 'string' || !name.trim() || name.length > 200)
    throw new AppError('invalid_input', 'A project needs a name of at most 200 characters.');
  if (/\p{Cc}|\u2028|\u2029/u.test(name))
    throw new AppError(
      'invalid_input',
      "A paper's name must be on one line, without line breaks or other control characters.",
    );
  return name.trim();
}

/** Text for an email's body or subject: runs of whitespace, line breaks included, made one space. */
export const oneLine = (text: string) => text.replace(/[\s\u2028\u2029]+/gu, ' ').trim();

export async function createProject(
  pool: pg.Pool,
  userId: string,
  name: unknown,
  perHour = LIMITS.papersPerHour,
): Promise<Project> {
  const named = paperName(name);
  await mayStartPapers(pool, userId, 1, perHour);
  return transaction(pool, async (db) => {
    const { rows } = await db.query('insert into projects (name) values ($1) returning id, name', [
      named,
    ]);
    await db.query(
      "insert into project_members (project_id, user_id, role) values ($1, $2, 'owner')",
      [rows[0].id, userId],
    );
    return { ...rows[0], role: 'owner' as const };
  });
}

/**
 * Review that is waiting in a paper, counted one way wherever it is said (the list of papers,
 * the checks before submitting): threads still open that have a comment left in them, and
 * proposed changes nobody has decided, in files that have not been deleted. `paper` is SQL for
 * the paper's id (a parameter or a column), never anything a person typed.
 */
export const openThreadsSql = (paper: string) =>
  `(select count(*)::int from threads rt join files rf on rf.id = rt.file_id
     where rt.project_id = ${paper} and rt.status = 'open'
       and exists (select 1 from thread_comments rc
                   where rc.thread_id = rt.id and rc.deleted_at is null))`;
export const openProposalsSql = (paper: string) =>
  `(select count(*)::int from proposals rp join files rf on rf.id = rp.file_id
     where rp.project_id = ${paper} and rp.status = 'open')`;

export async function listProjects(db: Db, userId: string): Promise<ListedProject[]> {
  const { rows } = await db.query(
    `select p.id, p.name, m.role, ${openThreadsSql('p.id')} as threads,
            ${openProposalsSql('p.id')} as proposals
     from projects p join project_members m on m.project_id = p.id
     where m.user_id = $1 order by p.created_at desc`,
    [userId],
  );
  return rows;
}

export async function getProject(
  db: Db,
  userId: string,
  projectId: string,
): Promise<ProjectDetail> {
  const role = await authorize(db, userId, id(projectId), 'project.read');
  const { rows } = await db.query(
    `select p.id, p.name, p.compiler, f.path as root from projects p left join files f on f.id = p.root_file_id
     where p.id = $1`,
    [projectId],
  );
  return { ...rows[0], role };
}

/** The TeX engines a paper may be built with: what the `projects.compiler` check allows. */
export const COMPILERS = ['pdflatex', 'xelatex', 'lualatex'] as const;

/** Choose the engine the paper is built with. The next revision and build carry it. */
export async function setCompiler(db: Db, userId: string, projectId: string, compiler: string) {
  await authorize(db, userId, id(projectId), 'file.write');
  if (!(COMPILERS as readonly string[]).includes(compiler))
    throw new AppError('invalid_input', `The compiler is one of ${COMPILERS.join(', ')}.`);
  await db.query(
    `update projects set compiler = $2, manifest_version = manifest_version + 1
     where id = $1 and compiler <> $2`,
    [projectId, compiler],
  );
}

/** Give the paper another name. The owner's decision alone. Every page, email and download reads the name as it is now. */
export async function renameProject(
  db: Db,
  userId: string,
  projectId: string,
  name: unknown,
): Promise<{ name: string }> {
  await authorize(db, userId, id(projectId), 'project.settings');
  const named = paperName(name);
  await db.query('update projects set name = $2 where id = $1', [projectId, named]);
  return { name: named };
}

export async function listMembers(db: Db, userId: string, projectId: string): Promise<Member[]> {
  await authorize(db, userId, id(projectId), 'project.read');
  const { rows } = await db.query(
    `select u.id as "userId", u.email, u.name, m.role from project_members m join "user" u on u.id = m.user_id
     where m.project_id = $1 order by m.created_at`,
    [projectId],
  );
  return rows;
}

/** How many invitations one person can send in an hour, over all their papers. */
export const INVITATIONS_PER_PERSON_HOUR = 30;
/** How many invitations the whole service sends in an hour (`INVITATIONS_PER_HOUR` changes it). */
export const INVITATIONS_PER_HOUR = 200;
/** Invitations to one address, from anyone: a burst of this many, then one more each hour. */
export const INVITATION_BURST = 3;
export const INVITATION_SPACING_MINUTES = 60;

/** Invite someone by email. Returns the token to put in their link; it is not stored. */
export async function invite(
  db: Db,
  userId: string,
  projectId: string,
  email: unknown,
  role: unknown,
  perHour = INVITATIONS_PER_PERSON_HOUR,
  opts: { burst?: number; service?: number } = {},
) {
  await authorize(db, userId, id(projectId), 'members.manage');
  if (typeof email !== 'string' || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 254)
    throw new AppError('invalid_input', 'That is not an email address.');
  if (role !== 'editor' && role !== 'reviewer' && role !== 'viewer')
    throw new AppError('invalid_input', 'Invite someone as an editor, a reviewer or a viewer.');
  const address = email.toLowerCase();
  // Someone already on the paper is not invited: the email would promise a role the link cannot give. Roles change under People.
  const member = (
    await db.query(
      `select m.role from project_members m join "user" u on u.id = m.user_id
       where m.project_id = $1 and lower(u.email) = $2`,
      [projectId, address],
    )
  ).rows[0];
  if (member)
    throw new AppError(
      'conflict',
      member.role === 'owner'
        ? 'That is your own address: you are already on this paper as its owner.'
        : `${address} is already on this paper as ${member.role === 'editor' ? 'an' : 'a'} ${member.role}. To change that, choose a role beside their address under People and press Change.`,
    );
  // Each invitation is an email to an address its sender chose. Without a limit, anyone with
  // an account could have the service write to any number of strangers.
  const sent = await db.query(
    "select count(*)::int as n from invitations where invited_by = $1 and created_at > now() - interval '1 hour'",
    [userId],
  );
  if (sent.rows[0].n >= perHour)
    throw new AppError(
      'conflict',
      `One person can send ${perHour} invitations in an hour, and you have sent that many. Try again in a little while.`,
    );
  // And an address is not written to more than a burst, then one an hour, whoever sends: nobody
  // can use the service to fill a stranger's inbox, even with many accounts. Counted from the
  // invitations, which stay as rows when cancelled or replaced. Then the service as a whole.
  const earlier = (
    await db.query(
      `select extract(epoch from created_at)::float8 as at, extract(epoch from now())::float8 as now
       from invitations where email = $1 and created_at > now() - interval '1 day' order by created_at`,
      [address],
    )
  ).rows as { at: number; now: number }[];
  const spacing = INVITATION_SPACING_MINUTES * 60;
  const burst = opts.burst ?? envCount('INVITATIONS_PER_ADDRESS_BURST', INVITATION_BURST);
  let tokens = burst;
  let last = earlier[0]?.at ?? 0;
  for (const { at } of earlier) {
    tokens = Math.min(burst, tokens + (at - last) / spacing) - 1;
    last = at;
  }
  if (earlier.length && Math.min(burst, tokens + (earlier[0].now - last) / spacing) < 1)
    throw new AppError(
      'conflict',
      'This address has been invited a few times lately. Try again in an hour.',
    );
  const service = opts.service ?? envCount('INVITATIONS_PER_HOUR', INVITATIONS_PER_HOUR);
  const all = await db.query(
    "select count(*)::int as n from invitations where created_at > now() - interval '1 hour'",
  );
  if (all.rows[0].n >= service)
    throw new AppError(
      'conflict',
      'Invitations are being sent at the most this service allows for the hour. Try again in a little while.',
    );
  // One live link per address: an earlier, unused one is ended, so the newest role stands. It
  // is ended rather than deleted so that it still counts against the hourly limit above.
  await db.query(
    `update invitations set expires_at = now()
     where project_id = $1 and email = $2 and accepted_at is null and expires_at > now()`,
    [projectId, address],
  );
  const token = randomBytes(32).toString('base64url');
  await db.query(
    `insert into invitations (project_id, email, role, token_hash, invited_by, expires_at)
     values ($1, $2, $3, $4, $5, now() + make_interval(days => $6))`,
    [projectId, address, role, hash(token), userId, INVITE_DAYS],
  );
  return { token, email: email.toLowerCase(), role };
}

export type PendingInvitation = {
  id: string;
  email: string;
  role: Role;
  createdAt: string;
  expiresAt: string;
};

/** Invitations sent for this paper that nobody has used yet, newest first. For those who may invite. */
export async function listInvitations(
  db: Db,
  userId: string,
  projectId: string,
): Promise<PendingInvitation[]> {
  await authorize(db, userId, id(projectId), 'members.manage');
  const { rows } = await db.query(
    `select id, email, role, created_at as "createdAt", expires_at as "expiresAt" from invitations
     where project_id = $1 and accepted_at is null and expires_at > now() order by created_at desc`,
    [projectId],
  );
  return rows.map((r) => ({
    ...r,
    createdAt: new Date(r.createdAt).toISOString(),
    expiresAt: new Date(r.expiresAt).toISOString(),
  }));
}

/**
 * Cancel an invitation nobody has used. Its link stops working at once. The row is kept but
 * ended, so that it still counts against the hourly limit on sending.
 */
export async function cancelInvitation(
  db: Db,
  userId: string,
  projectId: string,
  invitationId: string,
) {
  await authorize(db, userId, id(projectId), 'members.manage');
  if (!UUID.test(String(invitationId)))
    throw new AppError('not_found', 'There is no such invitation.');
  const { rowCount } = await db.query(
    `update invitations set expires_at = now()
     where id = $1 and project_id = $2 and accepted_at is null and expires_at > now()`,
    [invitationId, projectId],
  );
  if (!rowCount)
    throw new AppError(
      'not_found',
      'That invitation has been used, has expired or was already cancelled.',
    );
}

/**
 * Take back an invitation that was just made and could not be delivered. Its link exists only
 * in the email: unsent, it is no use to anyone, and it would count against how many its
 * sender may send. Nothing is done to one that has been accepted.
 */
export async function withdrawInvitation(db: Db, token: string): Promise<void> {
  await db.query('delete from invitations where token_hash = $1 and accepted_at is null', [
    hash(token),
  ]);
}

/**
 * What a still-valid invitation offers, for showing before it is accepted. Given the person
 * looking, it also says what part they already have in the paper, if any.
 */
export async function findInvitation(db: Db, token: unknown, userId?: string) {
  if (typeof token !== 'string') return null;
  const { rows } = await db.query(
    `select i.project_id as "projectId", p.name as project, i.role, i.email, m.role as "memberRole"
     from invitations i join projects p on p.id = i.project_id
     left join project_members m on m.project_id = i.project_id and m.user_id = $2
     where i.token_hash = $1 and i.accepted_at is null and i.expires_at > now()`,
    [hash(token), userId ?? null],
  );
  return (
    (rows[0] as
      | { projectId: string; project: string; role: Role; email: string; memberRole: Role | null }
      | undefined) ?? null
  );
}

/**
 * For the sign-in page, which anyone can open: whom a still-valid invitation is for, partly
 * hidden, or null if the token is not one that can be used. The token is the permission, as for
 * `findInvitation`. Nothing of the paper is returned: its name, the role and who invited are
 * shown once the invited person has signed in. Only reads.
 */
export async function invitedAddress(db: Db, token: unknown): Promise<string | null> {
  if (typeof token !== 'string') return null;
  const { rows } = await db.query(
    'select email from invitations where token_hash = $1 and accepted_at is null and expires_at > now()',
    [hash(token)],
  );
  return rows[0] ? hiddenAddress(rows[0].email) : null;
}

/** Join the project an invitation was for. Only the invited address may use it, and only once. */
export async function acceptInvitation(
  pool: pg.Pool,
  userId: string,
  token: unknown,
): Promise<Project> {
  const gone = new AppError('not_found', 'This invitation is not valid any more.');
  if (typeof token !== 'string') throw gone;
  return transaction(pool, async (db) => {
    const { rows } = await db.query(
      `select i.id, i.project_id, i.role, i.email, p.name from invitations i join projects p on p.id = i.project_id
       where i.token_hash = $1 and i.accepted_at is null and i.expires_at > now() for update of i`,
      [hash(token)],
    );
    const inv = rows[0];
    if (!inv) throw gone;
    const user = (await db.query('select email from "user" where id = $1', [userId])).rows[0];
    if (user?.email.toLowerCase() !== inv.email)
      throw new AppError(
        'permission_denied',
        'This invitation was sent to a different email address.',
      );
    // Someone already in the project keeps their role: a link made before they joined never raises, lowers or replaces it.
    await db.query(
      'insert into project_members (project_id, user_id, role) values ($1, $2, $3) on conflict do nothing',
      [inv.project_id, userId, inv.role],
    );
    await db.query('update invitations set accepted_at = now() where id = $1', [inv.id]);
    const role = (
      await db.query('select role from project_members where project_id = $1 and user_id = $2', [
        inv.project_id,
        userId,
      ])
    ).rows[0].role;
    return { id: inv.project_id, name: inv.name, role };
  });
}

export async function setRole(
  db: Db,
  userId: string,
  projectId: string,
  memberId: string,
  role: unknown,
) {
  await authorize(db, userId, id(projectId), 'members.manage');
  if (role === 'owner' || !ROLES.includes(role as Role))
    throw new AppError('invalid_input', 'Choose editor, reviewer or viewer.');
  const { rowCount } = await db.query(
    "update project_members set role = $3 where project_id = $1 and user_id = $2 and role <> 'owner'",
    [projectId, id(memberId), role],
  );
  if (!rowCount)
    throw new AppError('invalid_input', 'That person is the owner or is not in the project.');
  // Live connections are re-checked at once rather than at their next edit.
  await db.query("select pg_notify('acl', $1)", [projectId]);
}

/** The owner may remove anyone else; anyone else may remove themselves. The owner cannot leave. */
export async function removeMember(db: Db, userId: string, projectId: string, memberId: string) {
  const role = await authorize(db, userId, id(projectId), 'project.read');
  if (memberId !== userId && role !== 'owner')
    throw new AppError('permission_denied', 'Only the owner can remove other people.');
  // In one statement: the person's unused invitations to this paper end with their place in it.
  // Otherwise a spare link they still hold would let them back in with nobody's say-so.
  const { rows } = await db.query(
    `with gone as (
       delete from project_members where project_id = $1 and user_id = $2 and role <> 'owner'
       returning user_id
     ), ended as (
       update invitations i set expires_at = now()
       from "user" u, gone
       where u.id = gone.user_id and i.project_id = $1 and lower(i.email) = lower(u.email)
         and i.accepted_at is null and i.expires_at > now()
     )
     select u.email, (select name from projects where id = $1) as name
     from gone join "user" u on u.id = gone.user_id`,
    [projectId, id(memberId)],
  );
  if (!rows[0])
    throw new AppError('invalid_input', 'That person is the owner or is not in the project.');
  // Live connections are re-checked at once rather than at their next edit.
  await db.query("select pg_notify('acl', $1)", [projectId]);
  // Said back so a page can name who was removed, and from what paper, not whoever a form claimed.
  return { email: rows[0].email as string, name: rows[0].name as string };
}

/** Whether this paper's text may be sent to a model provider. */
export async function modelProcessing(db: Db, userId: string, projectId: string) {
  await authorize(db, userId, id(projectId), 'project.read');
  const { rows } = await db.query('select model_processing from projects where id = $1', [
    projectId,
  ]);
  return rows[0].model_processing as boolean;
}

/** Allow or stop it. The owner's decision alone. */
export async function setModelProcessing(
  db: Db,
  userId: string,
  projectId: string,
  on: unknown,
): Promise<void> {
  await authorize(db, userId, id(projectId), 'project.settings');
  if (typeof on !== 'boolean') throw new AppError('invalid_input', 'Say yes or no.');
  await db.query('update projects set model_processing = $2 where id = $1', [projectId, on]);
}

/**
 * How far a paper has come along the path a new one takes: written in, built, shared, taken
 * away. For showing a new owner what to do next. Each is a fact about the paper, not a record
 * of clicks.
 */
export async function firstSteps(db: Db, userId: string, projectId: string) {
  await authorize(db, userId, id(projectId), 'project.read');
  const { rows } = await db.query(
    `select
       exists (select 1 from files where project_id = $1) as "hasFiles",
       -- The first entry of a file's log is the file as it arrived; a second is an edit.
       exists (select 1 from files where project_id = $1 and head_seq > 1) as written,
       exists (select 1 from builds where project_id = $1 and pdf_digest is not null) as built,
       (select count(*) from project_members where project_id = $1) > 1
         or exists (select 1 from invitations where project_id = $1) as shared,
       exists (select 1 from downloads where project_id = $1) as downloaded`,
    [projectId],
  );
  return rows[0] as {
    hasFiles: boolean;
    written: boolean;
    built: boolean;
    shared: boolean;
    downloaded: boolean;
  };
}
