// Needs the services in infra/compose.yaml. Run: pnpm test:sandbox
import { afterAll, beforeAll, expect, test } from 'vitest';
import { type Action, ACTIONS, authorize, type Role, ROLES } from './authz.ts';
import { createAuth, forgetSignInLink, maySendSignInLink } from './auth.ts';
import { migrate } from './migrate.ts';
import {
  acceptInvitation,
  cancelInvitation,
  createProject,
  findInvitation,
  invite,
  listInvitations,
  listMembers,
  listProjects,
  removeMember,
  setRole,
  withdrawInvitation,
} from './projects.ts';
import { TEST_ENV, testDb } from './testing.ts';

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
  // A link that could not be sent is not counted.
  await forgetSignInLink(t.pool, 'Victim@example.org');
  expect(await sends('victim@example.org')).toBe(true);
  expect(await sends('victim@example.org')).toBe(false);
  // An hour on there is room again, and after a day the record is gone.
  await t.pool.query("update sign_in_links set sent_at = sent_at - interval '61 minutes'");
  expect(await sends('victim@example.org')).toBe(true);
  await t.pool.query("update sign_in_links set sent_at = sent_at - interval '25 hours'");
  expect(await sends('victim@example.org')).toBe(true);
  expect((await t.pool.query('select 1 from sign_in_links')).rowCount).toBe(1);
});

test('with the mail down, a sign-in link is not counted and an invitation is not left behind', async () => {
  // Sign-in: the request fails, and the address has nothing on record against it.
  const down = createAuth(
    t.pool,
    async () => {
      throw new Error('the mail server did not answer');
    },
    TEST_ENV,
  );
  const asked = await down.handler(
    new Request(`${TEST_ENV.BETTER_AUTH_URL}/api/auth/sign-in/magic-link`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'mail-down@example.org' }),
    }),
  );
  expect(asked.ok).toBe(false);
  for (let i = 0; i < 3; i++)
    expect(await maySendSignInLink(t.pool, 'mail-down@example.org', 3)).toBe(true);

  // An invitation whose email could not be sent is taken back: its link is nowhere else, and
  // it does not count against how many its sender may send.
  const sender = await t.signIn('mail-down-sender@example.org');
  const paper = await createProject(t.pool, sender.id, 'Mail down');
  const made = await invite(t.pool, sender.id, paper.id, 'nobody@example.org', 'viewer', 1);
  expect(await findInvitation(t.pool, made.token)).toMatchObject({ email: 'nobody@example.org' });
  await withdrawInvitation(t.pool, made.token);
  expect(await findInvitation(t.pool, made.token)).toBeNull();
  await invite(t.pool, sender.id, paper.id, 'nobody@example.org', 'viewer', 1);
  // One that was accepted is not undone by it.
  const guest = await t.signIn('guest@example.org');
  const kept = await invite(t.pool, sender.id, paper.id, guest.email, 'viewer', 10);
  await acceptInvitation(t.pool, guest.id, kept.token);
  await withdrawInvitation(t.pool, kept.token);
  expect((await listMembers(t.pool, sender.id, paper.id)).map((m) => m.email)).toContain(
    guest.email,
  );
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

/** A link kept live behind the API's back, as one made by an older version would be. */
const heldLink = (paper: string, email: string, token: string) =>
  t.pool.query(
    `insert into invitations (project_id, email, role, token_hash, invited_by, expires_at)
     values ($1, $2, 'editor', encode(sha256($3::bytea), 'hex'), $4, now() + interval '14 days')`,
    [paper, email, token, users.owner.id],
  );

test('someone removed cannot come back on an invitation they still hold', async () => {
  const b = await t.signIn('held-removed@example.org');
  const paper = (await createProject(t.pool, users.owner.id, 'Held links')).id;
  const first = await invite(t.pool, users.owner.id, paper, b.email, 'editor');
  const second = await invite(t.pool, users.owner.id, paper, b.email, 'editor');
  await heldLink(paper, b.email, 'held-token-1');
  await acceptInvitation(t.pool, b.id, second.token);
  await removeMember(t.pool, users.owner.id, paper, b.id);
  expect(await code(acceptInvitation(t.pool, b.id, first.token))).toBe('not_found');
  expect(await code(acceptInvitation(t.pool, b.id, 'held-token-1'))).toBe('not_found');
  expect((await listMembers(t.pool, users.owner.id, paper)).map((m) => m.email)).not.toContain(
    b.email,
  );
});

test('someone who left cannot come back on an invitation they still hold', async () => {
  const b = await t.signIn('held-left@example.org');
  const paper = (await createProject(t.pool, users.owner.id, 'Held links 2')).id;
  const first = await invite(t.pool, users.owner.id, paper, b.email, 'editor');
  const second = await invite(t.pool, users.owner.id, paper, b.email, 'editor');
  await heldLink(paper, b.email, 'held-token-2');
  await acceptInvitation(t.pool, b.id, second.token);
  await removeMember(t.pool, b.id, paper, b.id);
  expect(await code(acceptInvitation(t.pool, b.id, first.token))).toBe('not_found');
  expect(await code(acceptInvitation(t.pool, b.id, 'held-token-2'))).toBe('not_found');
});

test('someone removed can be invited again and join', async () => {
  const b = await t.signIn('again@example.org');
  const paper = (await createProject(t.pool, users.owner.id, 'Again')).id;
  const first = await invite(t.pool, users.owner.id, paper, b.email, 'editor');
  await acceptInvitation(t.pool, b.id, first.token);
  await removeMember(t.pool, users.owner.id, paper, b.id);
  const second = await invite(t.pool, users.owner.id, paper, b.email, 'viewer');
  expect((await acceptInvitation(t.pool, b.id, second.token)).role).toBe('viewer');
});

test('a spare invitation does not raise a lowered role', async () => {
  const b = await t.signIn('lowered@example.org');
  const paper = (await createProject(t.pool, users.owner.id, 'Lowered')).id;
  const first = await invite(t.pool, users.owner.id, paper, b.email, 'editor');
  await acceptInvitation(t.pool, b.id, first.token);
  await setRole(t.pool, users.owner.id, paper, b.id, 'viewer');
  const spare = await invite(t.pool, users.owner.id, paper, b.email, 'editor');
  await acceptInvitation(t.pool, b.id, spare.token);
  expect(
    (await listMembers(t.pool, users.owner.id, paper)).find((m) => m.userId === b.id)?.role,
  ).toBe('viewer');
});

test('pending invitations can be listed and cancelled by those who may invite', async () => {
  const b = await t.signIn('pending@example.org');
  const paper = (await createProject(t.pool, users.owner.id, 'Pending')).id;
  await t.pool.query(
    'insert into project_members (project_id, user_id, role) values ($1, $2, $3)',
    [paper, users.viewer.id, 'viewer'],
  );
  const made = await invite(t.pool, users.owner.id, paper, b.email, 'reviewer');
  const list = await listInvitations(t.pool, users.owner.id, paper);
  expect(list).toHaveLength(1);
  expect(list[0]).toMatchObject({ email: b.email, role: 'reviewer' });
  expect(await code(listInvitations(t.pool, users.viewer.id, paper))).toBe('permission_denied');
  expect(await code(listInvitations(t.pool, users.outsider.id, paper))).toBe('not_found');
  expect(await code(cancelInvitation(t.pool, users.viewer.id, paper, list[0].id))).toBe(
    'permission_denied',
  );

  await cancelInvitation(t.pool, users.owner.id, paper, list[0].id);
  expect(await listInvitations(t.pool, users.owner.id, paper)).toEqual([]);
  expect(await code(acceptInvitation(t.pool, b.id, made.token))).toBe('not_found');
  expect(await findInvitation(t.pool, made.token)).toBeNull();

  const used = await invite(t.pool, users.owner.id, paper, b.email, 'viewer');
  await acceptInvitation(t.pool, b.id, used.token);
  const row = await t.pool.query(
    'select id from invitations where accepted_at is not null and project_id = $1',
    [paper],
  );
  expect(await code(cancelInvitation(t.pool, users.owner.id, paper, row.rows[0].id))).toBe(
    'not_found',
  );
});

test('a second invitation to the same address leaves one live invitation, with the later role', async () => {
  const b = await t.signIn('twice@example.org');
  const paper = (await createProject(t.pool, users.owner.id, 'Twice')).id;
  const first = await invite(t.pool, users.owner.id, paper, b.email, 'editor');
  const second = await invite(t.pool, users.owner.id, paper, b.email.toUpperCase(), 'viewer');
  const list = await listInvitations(t.pool, users.owner.id, paper);
  expect(list).toHaveLength(1);
  expect(list[0].role).toBe('viewer');
  expect(await code(acceptInvitation(t.pool, b.id, first.token))).toBe('not_found');
  expect((await acceptInvitation(t.pool, b.id, second.token)).role).toBe('viewer');
});
