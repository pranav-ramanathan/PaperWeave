'use server';

import {
  acceptInvitation,
  approveDataset,
  createFromTemplate,
  createProject,
  deleteFile,
  invite,
  lookUpDoi,
  proposeFileRename,
  recordEvidence,
  removeEvidence,
  removeMember,
  renameFileAndReferences,
  renameLabel,
  requestBuild,
  removeChart,
  restoreRevision,
  saveChart,
  saveRevision,
  setLanguageSettings,
  setRole,
  setRootFile,
} from '@paperweave/server';
import { act, baseUrl, blobs, db, requireUser, sendEmail } from '../../lib/server';

const text = (form: FormData, name: string) => String(form.get(name) ?? '');

export async function createAction(form: FormData) {
  const user = await requireUser('/projects');
  await act('/projects', async () => {
    const template = text(form, 'template');
    const made = template
      ? await createFromTemplate(db(), blobs(), user.id, text(form, 'name'), template)
      : await createProject(db(), user.id, text(form, 'name'));
    return `/projects/${made.id}`;
  });
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

export async function buildNowAction(projectId: string) {
  const back = `/projects/${projectId}/submit`;
  const user = await requireUser(back);
  await act(back, async () => {
    await requestBuild(db(), user.id, projectId);
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
  await act(back, async () => {
    const path = text(form, 'path');
    const proposal = await proposeFileRename(db(), blobs(), user.id, projectId, fileId, path);
    // Lines in other files name this one: show what would change before anything does.
    if (proposal.changes.length)
      return `${back}/files/${fileId}/rename?to=${encodeURIComponent(path)}`;
    await renameFileAndReferences(db(), blobs(), user.id, projectId, fileId, path, proposal.digest);
  });
}

/** Carry out a file rename from the page that showed its changes. */
export async function renameFileAction(projectId: string, fileId: string, form: FormData) {
  const to = text(form, 'to');
  const back = `/projects/${projectId}/files/${fileId}/rename?to=${encodeURIComponent(to)}`;
  const user = await requireUser(back);
  await act(back, async () => {
    // "Rename only" sends no digest: the lines that name the file are left as they are.
    const digest = form.get('how') === 'only' ? undefined : text(form, 'digest');
    const { places } = await renameFileAndReferences(
      db(),
      blobs(),
      user.id,
      projectId,
      fileId,
      to,
      digest,
    );
    return `/projects/${projectId}?moved=${encodeURIComponent(to)}&places=${places}`;
  });
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

export async function renameLabelAction(projectId: string, form: FormData) {
  const [from, to] = [text(form, 'from'), text(form, 'to')];
  // A refusal goes back to the list of changes, made afresh, with the reason above it.
  const back = `/projects/${projectId}/labels/rename?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  const user = await requireUser(back);
  await act(back, async () => {
    const digest = text(form, 'digest');
    const { places } = await renameLabel(db(), blobs(), user.id, projectId, from, to, digest);
    return `/projects/${projectId}?relabelled=${encodeURIComponent(to)}&places=${places}#labels`;
  });
}

export async function lookUpDoiAction(projectId: string, key: string) {
  const back = `/projects/${projectId}`;
  const user = await requireUser(back);
  await act(back, async () => {
    await lookUpDoi(db(), blobs(), user.id, projectId, key);
    return `${back}?looked=${encodeURIComponent(key)}#bibliography`;
  });
}

export async function recordEvidenceAction(projectId: string, key: string, form: FormData) {
  const back = `/projects/${projectId}`;
  const user = await requireUser(back);
  await act(back, async () => {
    await recordEvidence(db(), blobs(), user.id, projectId, key, {
      claim: text(form, 'claim'),
      verdict: text(form, 'verdict'),
      note: text(form, 'note'),
    });
    return `${back}?checked=${encodeURIComponent(key)}#bibliography`;
  });
}

export async function removeEvidenceAction(projectId: string, checkId: string) {
  const back = `/projects/${projectId}`;
  const user = await requireUser(back);
  await act(back, async () => {
    await removeEvidence(db(), user.id, projectId, checkId);
    return `${back}#bibliography`;
  });
}

export async function approveDatasetAction(projectId: string, fileId: string, form: FormData) {
  const back = `/projects/${projectId}/data/${fileId}`;
  const user = await requireUser(back);
  await act(back, async () => {
    const all = (name: string) => form.getAll(name).map(String);
    const [names, types, units] = [all('name'), all('type'), all('unit')];
    const others = text(form, 'otherMissing')
      .split(',')
      .map((m) => m.trim())
      .filter(Boolean);
    await approveDataset(db(), blobs(), user.id, projectId, fileId, {
      version: text(form, 'version'),
      columns: names.map((name, i) => ({ name, type: types[i], unit: units[i] ?? '' })),
      missing: [...all('missing'), ...others],
      attribution: text(form, 'attribution'),
      exported: form.get('exported') === 'on',
    });
    return `/projects/${projectId}?described=${encodeURIComponent(fileId)}#data`;
  });
}

export async function saveChartAction(
  projectId: string,
  chartId: string | null,
  dataset: string,
  form: FormData,
) {
  const back = chartId
    ? `/projects/${projectId}/charts/${chartId}`
    : `/projects/${projectId}/charts/new?data=${encodeURIComponent(dataset)}`;
  const user = await requireUser(back);
  await act(back, async () => {
    const fields = Object.fromEntries(
      ['name', 'kind', 'x', 'y', 'series', 'combine', 'gaps', 'title', 'caption', 'alt'].map(
        (n) => [n, text(form, n)],
      ),
    );
    const id = await saveChart(db(), blobs(), user.id, projectId, {
      ...fields,
      dataset,
      ...(chartId ? { id: chartId } : {}),
    });
    return `/projects/${projectId}/charts/${id}`;
  });
}

export async function removeChartAction(projectId: string, chartId: string) {
  const back = `/projects/${projectId}/charts/${chartId}`;
  const user = await requireUser(back);
  await act(back, async () => {
    await removeChart(db(), user.id, projectId, chartId);
    return `/projects/${projectId}#data`;
  });
}

export async function languageAction(projectId: string, form: FormData) {
  const back = `/projects/${projectId}`;
  const user = await requireUser(back);
  await act(back, async () => {
    await setLanguageSettings(db(), user.id, projectId, {
      language: text(form, 'language'),
      // One word to a line, or several with spaces between.
      glossary: text(form, 'glossary').split(/\s+/).filter(Boolean),
      // The rules still ticked stay off.
      off: form.getAll('off').map(String),
    });
    return `${back}?language=1#language`;
  });
}
