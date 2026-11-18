'use server';

import {
  acceptInvitation,
  createProject,
  deleteFile,
  invite,
  removeMember,
  renameFile,
  requestBuild,
  restoreRevision,
  saveRevision,
  setRole,
  setRootFile,
} from '@paperweave/server';
import { act, baseUrl, blobs, db, requireUser, sendEmail } from '../../lib/server';

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

export async function saveRevisionAction(projectId: string, form: FormData) {
  const back = `/projects/${projectId}`;
  const user = await requireUser(back);
  await act(back, async () => {
    const { number } = await saveRevision(db(), blobs(), user.id, projectId, text(form, 'name'));
    return `${back}?revision=${number}#revisions`;
  });
}

export async function buildRevisionAction(projectId: string, revisionId: string) {
  const back = `/projects/${projectId}`;
  const user = await requireUser(back);
  await act(back, async () => {
    await requestBuild(db(), user.id, projectId, { revisionId });
    return `${back}?building=1#revisions`;
  });
}

export async function restoreAction(projectId: string, revisionId: string) {
  const back = `/projects/${projectId}`;
  const user = await requireUser(back);
  await act(back, async () => {
    const { number } = await restoreRevision(db(), blobs(), user.id, projectId, revisionId);
    return `${back}?restored=${number}#revisions`;
  });
}

export async function renameAction(projectId: string, fileId: string, form: FormData) {
  const back = `/projects/${projectId}`;
  const user = await requireUser(back);
  await act(back, () => renameFile(db(), user.id, projectId, fileId, text(form, 'path')));
}

export async function deleteFileAction(projectId: string, fileId: string) {
  const back = `/projects/${projectId}`;
  const user = await requireUser(back);
  await act(back, async () => {
    const gone = await deleteFile(db(), blobs(), user.id, projectId, fileId);
    return `${back}?deleted=${encodeURIComponent(gone.path)}&in=${gone.revision}`;
  });
}

export async function rootAction(projectId: string, fileId: string) {
  const back = `/projects/${projectId}`;
  const user = await requireUser(back);
  await act(back, async () => {
    await setRootFile(db(), user.id, projectId, fileId);
    return `${back}?root=1`;
  });
}
