'use server';

import { AppError, applyMerge, type MergeChoices } from '@paperweave/server';
import { act, blobs, db, requireUser } from '../../../../../../lib/server';

// The merge page's one action: apply the merge the person decided. Every check is the service's
// (`applyMerge` asks `authorize` for both papers, and for the roles again with the files held);
// the page only decides what to offer. Anything wrong comes back to the page as a message, with
// the choices that were made, so the person does not decide twice.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHOICES = new Set(['ours', 'theirs', 'both', 'base', 'text']);

/**
 * Merge a version into main (`up` false), or main into the version (`up` true), as the three
 * revisions in the form said, with a choice for each conflict: a radio named `choice:<id>`, and for
 * "write it myself" the text in `text:<id>`.
 */
export async function mergeAction(main: string, version: string, up: boolean, form: FormData) {
  const page = `/projects/${main}/versions/${version}/merge`;
  const here = up ? `${page}?direction=up` : page;
  const user = await requireUser(here);
  const choices: MergeChoices = {};
  const picks: string[] = [];
  for (const [key, value] of form.entries()) {
    if (!key.startsWith('choice:') || typeof value !== 'string' || !CHOICES.has(value)) continue;
    const id = key.slice('choice:'.length);
    if (value === 'text') choices[id] = { text: String(form.get(`text:${id}`) ?? '') };
    else choices[id] = value as 'ours';
    picks.push(`pick=${encodeURIComponent(`${id}~${value}`)}`);
  }
  // Where an error leaves the person: the same page, with what they chose still chosen.
  const back = [here, ...picks].join(here.includes('?') ? '&' : '?');
  await act(back, async () => {
    const ref = {
      target: String(form.get('target') ?? ''),
      source: String(form.get('source') ?? ''),
      base: String(form.get('base') ?? ''),
    };
    if (![ref.target, ref.source, ref.base].every((r) => UUID.test(r)))
      throw new AppError('invalid_input', 'Look at the merge again before you apply it.');
    const [target, source] = up ? [version, main] : [main, version];
    const made = await applyMerge(db(), blobs(), user.id, target, source, ref, choices);
    const said = [
      ...(up ? ['direction=up'] : []),
      `merged=${made.number}`,
      `kept=${made.kept.number}`,
      `files=${made.files}`,
      `decided=${made.conflicts}`,
    ];
    return `${page}?${said.join('&')}`;
  });
}
