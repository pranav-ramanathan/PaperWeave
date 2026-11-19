// Needs the services in infra/compose.yaml. Run: pnpm test:sandbox
import { afterAll, beforeAll, expect, test } from 'vitest';
import { type Action, ACTIONS, authorize, type Role, ROLES } from './authz.ts';
import { maySendSignInLink } from './auth.ts';
import { migrate } from './migrate.ts';
import {
  acceptInvitation,
  createProject,
  invite,
  listMembers,
  listProjects,
  removeMember,
  setRole,
} from './projects.ts';
import { testDb } from './testing.ts';

let t: Awaited<ReturnType<typeof testDb>>;
type User = { id: string; email: string; cookie: string };
const users = {} as Record<Role | 'outsider', User>;
let project: string;

beforeAll(async () => {
  t = await testDb();
  users.owner = await t.signIn('owner@example.org');
  project = (await createProject(t.pool, users.owner.id, 'Merge latency')).id;
  for (const role of ['editor', 'reviewer', 'viewer'] as const) {
    users[role] = await t.signIn(`${role}@example.org`);
    const { token } = await invite(t.pool, users.owner.id, project, `${role}@example.org`, role);
    await acceptInvitation(t.pool, users[role].id, token);
  }
  users.outsider = await t.signIn('outsider@example.org');
});
afterAll(() => t.close());

const code = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e) => e.code ?? `unexpected: ${e.message}`,
  );

test('migrating twice changes nothing the second time', async () => {
  expect(await migrate(t.pool)).toEqual([]);
});

test('a magic link signs a person in', () => {
  expect(users.owner.cookie).toContain('session_token=');
  expect(t.links.every((l) => l.url.includes('/api/auth/magic-link/verify?token='))).toBe(true);
});

test('one address is sent only so many sign-in links in an hour, whoever asks', async () => {
  const sends = async (email: string) => maySendSignInLink(t.pool, email, 3);
  expect([await sends('Victim@Example.org'), await sends('victim@example.org')]).toEqual([
    true,
    true,
  ]);
  expect(await sends(' victim@example.org ')).toBe(true);
  // The fourth is not sent, however the address is written. Someone else's still is.
  expect(await sends('VICTIM@example.org')).toBe(false);
  expect(await sends('someone-else@example.org')).toBe(true);
  // The address is not kept, only a hash of it.
  const kept = await t.pool.query('select email_hash from sign_in_links');
  expect(kept.rows.every((r) => /^[0-9a-f]{64}$/.test(r.email_hash))).toBe(true);
  expect(JSON.stringify(kept.rows)).not.toContain('victim');
  // An hour on there is room again, and after a day the record is gone.
  await t.pool.query("update sign_in_links set sent_at = sent_at - interval '61 minutes'");
  expect(await sends('victim@example.org')).toBe(true);
  await t.pool.query("update sign_in_links set sent_at = sent_at - interval '25 hours'");
  expect(await sends('victim@example.org')).toBe(true);
  expect((await t.pool.query('select 1 from sign_in_links')).rowCount).toBe(1);
});

test('every role against every action', async () => {
  // Written out by hand on purpose: this is the policy, checked against the code.
  const allowed: Record<Action, Role[]> = {
    'project.read': ['owner', 'editor', 'reviewer', 'viewer'],
    'comment.write': ['owner', 'editor', 'reviewer'],
    'proposal.create': ['owner', 'editor', 'reviewer'],
    'proposal.decide': ['owner', 'editor'],
    'file.write': ['owner', 'editor'],
    'revision.write': ['owner', 'editor'],
    'build.run': ['owner', 'editor'],
    'project.export': ['owner', 'editor'],
    'members.manage': ['owner'],
    'project.settings': ['owner'],
  };
  expect(Object.keys(allowed).sort()).toEqual([...ACTIONS].sort());
  for (const action of ACTIONS) {
    for (const role of ROLES) {
      const want = allowed[action].includes(role) ? 'ok' : 'permission_denied';
      expect(
        await code(authorize(t.pool, users[role].id, project, action)),
        `${role} ${action}`,
      ).toBe(want);
    }
    // Someone outside the project cannot even learn that it exists.
    expect(
      await code(authorize(t.pool, users.outsider.id, project, action)),
      `outsider ${action}`,
    ).toBe('not_found');
  }
});

test('one project is invisible from another', async () => {
  const other = (await createProject(t.pool, users.outsider.id, 'Unrelated')).id;
  expect((await listProjects(t.pool, users.outsider.id)).map((p) => p.id)).toEqual([other]);
  expect((await listProjects(t.pool, users.editor.id)).map((p) => p.id)).toEqual([project]);
  for (const role of ROLES) {
    expect(await code(listMembers(t.pool, users[role].id, other)), role).toBe('not_found');
    expect(await code(invite(t.pool, users[role].id, other, 'x@example.org', 'viewer')), role).toBe(
      'not_found',
    );
  }
  expect(await code(listMembers(t.pool, users.owner.id, 'not-an-id'))).toBe('not_found');
  expect(await code(listMembers(t.pool, users.owner.id, "' or 1=1 --"))).toBe('not_found');
});

test('an invitation works once, only for its address, and only until it expires', async () => {
  const fresh = await t.signIn('late@example.org');
  const { token } = await invite(t.pool, users.owner.id, project, 'Late@Example.org', 'viewer');
  expect(await code(acceptInvitation(t.pool, users.outsider.id, token))).toBe('permission_denied');
  expect(await code(acceptInvitation(t.pool, fresh.id, token + 'x'))).toBe('not_found');
  expect((await acceptInvitation(t.pool, fresh.id, token)).role).toBe('viewer');
  expect(await code(acceptInvitation(t.pool, fresh.id, token))).toBe('not_found');

  const expired = await invite(t.pool, users.owner.id, project, 'outsider@example.org', 'editor');
  await t.pool.query(
    "update invitations set expires_at = now() - interval '1 minute' where accepted_at is null",
  );
  expect(await code(acceptInvitation(t.pool, users.outsider.id, expired.token))).toBe('not_found');
  // The token itself is never stored.
  const stored = await t.pool.query('select token_hash from invitations');
  expect(stored.rows.some((r) => r.token_hash === token || r.token_hash === expired.token)).toBe(
    false,
  );
});

test('one person can send only so many invitations in an hour', async () => {
  // Each is an email to an address its sender chose.
  const sender = await t.signIn('sender@example.org');
  const first = await createProject(t.pool, sender.id, 'First');
  const second = await createProject(t.pool, sender.id, 'Second');
  await invite(t.pool, sender.id, first.id, 'a@example.org', 'viewer', 3);
  await invite(t.pool, sender.id, first.id, 'a@example.org', 'viewer', 3);
  await invite(t.pool, sender.id, second.id, 'b@example.org', 'editor', 3);
  // Counted over all their papers, not for each.
  expect(await code(invite(t.pool, sender.id, second.id, 'c@example.org', 'viewer', 3))).toBe(
    'conflict',
  );
  expect(
    (await t.pool.query('select 1 from invitations where invited_by = $1', [sender.id])).rowCount,
  ).toBe(3);
  // Someone else's are their own, and an hour later there is room again.
  const other = await t.signIn('another-sender@example.org');
  const theirs = await createProject(t.pool, other.id, 'Theirs');
  await invite(t.pool, other.id, theirs.id, 'd@example.org', 'viewer', 3);
  await t.pool.query(
    "update invitations set created_at = now() - interval '61 minutes' where invited_by = $1",
    [sender.id],
  );
  await invite(t.pool, sender.id, first.id, 'c@example.org', 'viewer', 3);
});

test('only the owner manages people, and the owner cannot be displaced', async () => {
  for (const role of ['editor', 'reviewer', 'viewer'] as const) {
    expect(
      await code(invite(t.pool, users[role].id, project, 'x@example.org', 'viewer')),
      role,
    ).toBe('permission_denied');
    expect(
      await code(setRole(t.pool, users[role].id, project, users.viewer.id, 'editor')),
      role,
    ).toBe('permission_denied');
  }
  expect(await code(invite(t.pool, users.owner.id, project, 'x@example.org', 'owner'))).toBe(
    'invalid_input',
  );
  expect(await code(invite(t.pool, users.owner.id, project, 'not an email', 'viewer'))).toBe(
    'invalid_input',
  );
  expect(await code(setRole(t.pool, users.owner.id, project, users.owner.id, 'viewer'))).toBe(
    'invalid_input',
  );
  expect(await code(setRole(t.pool, users.owner.id, project, users.editor.id, 'owner'))).toBe(
    'invalid_input',
  );
  expect(await code(removeMember(t.pool, users.owner.id, project, users.owner.id))).toBe(
    'invalid_input',
  );
  expect(await code(removeMember(t.pool, users.editor.id, project, users.viewer.id))).toBe(
    'permission_denied',
  );
  // An invitation to someone already in the project never changes their role.
  const { token } = await invite(t.pool, users.owner.id, project, 'owner@example.org', 'viewer');
  expect((await acceptInvitation(t.pool, users.owner.id, token)).role).toBe('owner');
});

test('a changed role and a removal take effect at once', async () => {
  const who = await t.signIn('mover@example.org');
  const { token } = await invite(t.pool, users.owner.id, project, who.email, 'editor');
  await acceptInvitation(t.pool, who.id, token);
  expect(await code(authorize(t.pool, who.id, project, 'file.write'))).toBe('ok');
  await setRole(t.pool, users.owner.id, project, who.id, 'reviewer');
  expect(await code(authorize(t.pool, who.id, project, 'file.write'))).toBe('permission_denied');
  expect(await code(authorize(t.pool, who.id, project, 'proposal.create'))).toBe('ok');
  // Anyone but the owner may leave.
  await removeMember(t.pool, who.id, project, who.id);
  expect(await code(authorize(t.pool, who.id, project, 'project.read'))).toBe('not_found');
  expect(
    (await listMembers(t.pool, users.owner.id, project)).some((m) => m.userId === who.id),
  ).toBe(false);
});
