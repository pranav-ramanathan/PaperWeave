// Projects, members and invitations. Every function takes the acting user and checks first.
import { createHash, randomBytes } from 'node:crypto';
import type pg from 'pg';
import { authorize, type Role, ROLES } from './authz.ts';
import { type Db, transaction } from './db.ts';
import { AppError } from './errors.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Reject anything that is not an ID before it reaches a query that expects one. */
const id = (value: unknown) => {
  if (typeof value !== 'string' || !UUID.test(value))
    throw new AppError('not_found', 'No such project.');
  return value;
};
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
const INVITE_DAYS = 14;

export type Project = { id: string; name: string; role: Role };
export type Member = { userId: string; email: string; name: string; role: Role };

export async function createProject(
  pool: pg.Pool,
  userId: string,
  name: unknown,
): Promise<Project> {
  if (typeof name !== 'string' || !name.trim() || name.length > 200)
    throw new AppError('invalid_input', 'A project needs a name of at most 200 characters.');
  return transaction(pool, async (db) => {
    const { rows } = await db.query('insert into projects (name) values ($1) returning id, name', [
      name.trim(),
    ]);
    await db.query(
      "insert into project_members (project_id, user_id, role) values ($1, $2, 'owner')",
      [rows[0].id, userId],
    );
    return { ...rows[0], role: 'owner' as const };
  });
}

export async function listProjects(db: Db, userId: string): Promise<Project[]> {
  const { rows } = await db.query(
    `select p.id, p.name, m.role from projects p join project_members m on m.project_id = p.id
     where m.user_id = $1 order by p.created_at desc`,
    [userId],
  );
  return rows;
}

export async function getProject(db: Db, userId: string, projectId: string): Promise<Project> {
  const role = await authorize(db, userId, id(projectId), 'project.read');
  const { rows } = await db.query('select id, name from projects where id = $1', [projectId]);
  return { ...rows[0], role };
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

/** Invite someone by email. Returns the token to put in their link; it is not stored. */
export async function invite(
  db: Db,
  userId: string,
  projectId: string,
  email: unknown,
  role: unknown,
) {
  await authorize(db, userId, id(projectId), 'members.manage');
  if (typeof email !== 'string' || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 254)
    throw new AppError('invalid_input', 'That is not an email address.');
  if (role !== 'editor' && role !== 'reviewer' && role !== 'viewer')
    throw new AppError('invalid_input', 'Invite someone as an editor, a reviewer or a viewer.');
  const token = randomBytes(32).toString('base64url');
  await db.query(
    `insert into invitations (project_id, email, role, token_hash, invited_by, expires_at)
     values ($1, $2, $3, $4, $5, now() + make_interval(days => $6))`,
    [projectId, email.toLowerCase(), role, hash(token), userId, INVITE_DAYS],
  );
  return { token, email: email.toLowerCase(), role };
}

/** What a still-valid invitation offers, for showing before it is accepted. */
export async function findInvitation(db: Db, token: unknown) {
  if (typeof token !== 'string') return null;
  const { rows } = await db.query(
    `select p.name as project, i.role, i.email from invitations i join projects p on p.id = i.project_id
     where i.token_hash = $1 and i.accepted_at is null and i.expires_at > now()`,
    [hash(token)],
  );
  return (rows[0] as { project: string; role: Role; email: string } | undefined) ?? null;
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
    // Someone already in the project keeps their role: an invitation never demotes or replaces an owner.
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
}

/** The owner may remove anyone else; anyone else may remove themselves. The owner cannot leave. */
export async function removeMember(db: Db, userId: string, projectId: string, memberId: string) {
  const role = await authorize(db, userId, id(projectId), 'project.read');
  if (memberId !== userId && role !== 'owner')
    throw new AppError('permission_denied', 'Only the owner can remove other people.');
  const { rowCount } = await db.query(
    "delete from project_members where project_id = $1 and user_id = $2 and role <> 'owner'",
    [projectId, id(memberId)],
  );
  if (!rowCount)
    throw new AppError('invalid_input', 'That person is the owner or is not in the project.');
}
