// Who may do what. This is the only place that decides; the HTTP API and the sync server both ask it.
import type { Db } from './db.ts';
import { AppError } from './errors.ts';

export const ROLES = ['owner', 'editor', 'reviewer', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

const everyone = ROLES;
const writers = ['owner', 'editor'] as const;
const CAN = {
  'project.read': everyone,
  // Reviewers comment and propose; they never change the manuscript directly.
  'comment.write': ['owner', 'editor', 'reviewer'],
  'proposal.create': ['owner', 'editor', 'reviewer'],
  'proposal.decide': writers,
  'file.write': writers,
  'revision.write': writers,
  'build.run': writers,
  'project.export': writers,
  'members.manage': ['owner'],
  'project.settings': ['owner'],
} as const satisfies Record<string, readonly Role[]>;
export type Action = keyof typeof CAN;
export const ACTIONS = Object.keys(CAN) as Action[];

export const can = (role: Role, action: Action) => (CAN[action] as readonly Role[]).includes(role);

/**
 * The user's role in the project, or an error. Someone who is not a member gets `not_found`, the
 * same as for a project that does not exist, so project IDs cannot be probed.
 */
export async function authorize(
  db: Db,
  userId: string,
  projectId: string,
  action: Action,
): Promise<Role> {
  const { rows } = await db.query(
    'select role from project_members where project_id = $1 and user_id = $2',
    [projectId, userId],
  );
  const role = rows[0]?.role as Role | undefined;
  if (!role) throw new AppError('not_found', 'No such project.');
  if (!can(role, action)) throw new AppError('permission_denied', `A ${role} cannot do that.`);
  return role;
}
