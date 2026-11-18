'use server';

import { acceptInvitation, createProject, invite, removeMember, setRole } from '@paperweave/server';
import { act, baseUrl, db, requireUser, sendEmail } from '../../lib/server';

const text = (form: FormData, name: string) => String(form.get(name) ?? '');

export async function createAction(form: FormData) {
  const user = await requireUser('/projects');
  await act(
    '/projects',
    async () => `/projects/${(await createProject(db(), user.id, text(form, 'name'))).id}`,
  );
}

export async function inviteAction(projectId: string, form: FormData) {
  const back = `/projects/${projectId}`;
  const user = await requireUser(back);
  await act(back, async () => {
    const { token, email, role } = await invite(
      db(),
      user.id,
      projectId,
      text(form, 'email'),
      text(form, 'role'),
    );
    await sendEmail(
      email,
      'You have been invited to a paper on PaperWeave',
      `${user.email} invited you to work on a paper as ${role === 'editor' ? 'an' : 'a'} ${role}.\n\nOpen this link to join:\n\n${baseUrl()}/invitations/${token}\n\nThe link works once, for this email address, for 14 days.`,
    );
    return `${back}?invited=${encodeURIComponent(email)}`;
  });
}

export async function roleAction(projectId: string, memberId: string, form: FormData) {
  const back = `/projects/${projectId}`;
  const user = await requireUser(back);
  await act(back, async () => {
    await setRole(db(), user.id, projectId, memberId, text(form, 'role'));
    return `${back}?saved=1`;
  });
}

export async function removeAction(projectId: string, memberId: string) {
  const back = `/projects/${projectId}`;
  const user = await requireUser(back);
  await act(back, async () => {
    await removeMember(db(), user.id, projectId, memberId);
    // Someone who just left has nothing more to see here.
    return memberId === user.id ? '/projects' : back;
  });
}

export async function joinAction(token: string) {
  const back = `/invitations/${token}`;
  const user = await requireUser(back);
  await act(back, async () => `/projects/${(await acceptInvitation(db(), user.id, token)).id}`);
}
