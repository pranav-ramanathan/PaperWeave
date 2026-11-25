'use server';

import {
  deleteVersion,
  nameRevision,
  renameVersion,
  startVersion,
  requestBuild,
  restoreRevision,
  revisionOfNow,
  saveRevision,
} from '@paperweave/server';
import { NOW } from '../../../../lib/compare';
import { act, blobs, db, requireUser } from '../../../../lib/server';

// The history page's own actions. Each one goes back to the history page, and each is checked by
// the service it calls (`authorize` in packages/server), not by the page that shows the button.
const text = (form: FormData, name: string) => String(form.get(name) ?? '').replace(/\r\n/g, '\n');
const at = (projectId: string) => `/projects/${projectId}/history`;

/** Save the paper as it is now under a name. */
export async function saveNamedAction(projectId: string, form: FormData) {
  const back = at(projectId);
  const user = await requireUser(back);
  await act(back, async () => {
    const { number } = await saveRevision(db(), blobs(), user.id, projectId, text(form, 'name'));
    return `${back}?saved=${number}`;
  });
}

/** Give a revision that exists a name. */
export async function nameRevisionAction(projectId: string, revisionId: string, form: FormData) {
  const back = at(projectId);
  const user = await requireUser(back);
  await act(back, async () => {
    const { number } = await nameRevision(db(), user.id, projectId, revisionId, text(form, 'name'));
    return `${back}?named=${number}`;
  });
}

/** Put the paper back to a revision; the paper as it stands is kept as a revision first. */
export async function restoreHistoryAction(projectId: string, revisionId: string) {
  const back = at(projectId);
  const user = await requireUser(back);
  await act(back, async () => {
    const { number } = await restoreRevision(db(), blobs(), user.id, projectId, revisionId);
    return `${back}?restored=${number}`;
  });
}

/** Ask for the PDF of a revision to be built. */
export async function buildHistoryAction(projectId: string, revisionId: string) {
  const back = at(projectId);
  const user = await requireUser(back);
  await act(back, async () => {
    await requestBuild(db(), user.id, projectId, { revisionId });
    return `${back}?building=1`;
  });
}

/** Show what changed between two revisions, or up to the paper as it is now, in place. */
export async function compareHistoryAction(projectId: string, form: FormData) {
  const back = at(projectId);
  const user = await requireUser(back);
  await act(back, async () => {
    const [from, to] = [text(form, 'from'), text(form, 'to')];
    const end = to === NOW ? (await revisionOfNow(db(), blobs(), user.id, projectId)).id : to;
    return `${back}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(end)}#comparison`;
  });
}

/**
 * Show what changed between a revision of this paper and a revision of another paper of the same
 * family (a version or main), in place. "The paper as it is now" is an end only for those who may
 * make revisions of that paper (`revisionOfNow` refuses the rest). Both papers are checked by the
 * service when the page asks for the comparison.
 */
export async function compareAcrossAction(projectId: string, form: FormData) {
  const back = at(projectId);
  const user = await requireUser(back);
  await act(back, async () => {
    const other = text(form, 'across');
    const end = async (paper: string, value: string) =>
      value === NOW ? (await revisionOfNow(db(), blobs(), user.id, paper)).id : value;
    const mine = await end(projectId, text(form, 'mine'));
    const theirs = await end(other, text(form, 'theirs'));
    return `${back}?across=${encodeURIComponent(other)}&mine=${encodeURIComponent(mine)}&theirs=${encodeURIComponent(theirs)}#across`;
  });
}

/**
 * Start a version of this paper at a revision (`from`: its id, or the paper as it is now). The
 * service refuses it when versions are off, to a reviewer or viewer, and past ten versions.
 */
export async function startVersionAction(projectId: string, from: string, form: FormData) {
  const back = at(projectId);
  const user = await requireUser(back);
  await act(back, async () => {
    const revision =
      from === NOW ? (await revisionOfNow(db(), blobs(), user.id, projectId)).id : from;
    const made = await startVersion(
      db(),
      blobs(),
      user.id,
      projectId,
      revision,
      text(form, 'version'),
    );
    return `${back}?started=${encodeURIComponent(made.name)}&version=${made.id}`;
  });
}

/** Give a version another name. `projectId` is the page's paper, where the person goes back to. */
export async function renameVersionAction(projectId: string, versionId: string, form: FormData) {
  const back = at(projectId);
  const user = await requireUser(back);
  await act(back, async () => {
    const { name } = await renameVersion(db(), user.id, versionId, text(form, 'version'));
    return `${back}?renamed=${encodeURIComponent(name)}`;
  });
}

/**
 * Delete a version, for good, when its exact name is typed. Afterwards the person is on `main`'s
 * history, which is `mainId`, whichever of the family they were looking at.
 */
export async function deleteVersionAction(
  projectId: string,
  versionId: string,
  mainId: string,
  form: FormData,
) {
  const back = at(projectId);
  const user = await requireUser(back);
  await act(back, async () => {
    const { name } = await deleteVersion(db(), user.id, versionId, text(form, 'typed'));
    return `${at(projectId === versionId ? mainId : projectId)}?deleted=${encodeURIComponent(name)}`;
  });
}
