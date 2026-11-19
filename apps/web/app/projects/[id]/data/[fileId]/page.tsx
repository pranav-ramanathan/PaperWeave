import { Wide } from '../../../../Wide';
import { AppError, can, COLUMN_TYPES, datasetProposal, getProject } from '@paperweave/server';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { blobs, db, requireUser } from '../../../../../lib/server';
import { approveDatasetAction } from '../../../actions';

export const dynamic = 'force-dynamic';
const HOLDS = { number: 'numbers', date: 'dates', text: 'text' } as const;

/** A CSV file as the service reads it, for its author to check and describe. */
export default async function Describe({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; fileId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { id, fileId } = await params;
  const { error } = await searchParams;
  const user = await requireUser(`/projects/${id}/data/${fileId}`);
  const loaded = await Promise.all([
    getProject(db(), user.id, id),
    datasetProposal(db(), blobs(), user.id, id, fileId),
  ]).catch((err) => {
    if (!(err instanceof AppError)) throw err;
    if (err.code === 'not_found') notFound();
    return err.message;
  });
  const back = <Link href={`/projects/${id}#data`}>Back to the paper</Link>;
  if (typeof loaded === 'string')
    return (
      <main className="page">
        <header className="bar">
          <h1>Describe a data file</h1>
          {back}
        </header>
        <p role="alert">{loaded}</p>
      </main>
    );
  const [project, { path, version, guess, approved }] = loaded;
  const writer = can(project.role, 'file.write');
  // What was approved before is the starting point; for a new file, the guess.
  const start = (name: string) =>
    approved?.columns.find((c) => c.name === name) ?? guess.columns.find((c) => c.name === name)!;
  const spellings = [...new Set([...guess.missing, ...(approved?.missing ?? [])])];
  return (
    <main className="page">
      <header className="bar">
        <h1>
          Describe <code>{path}</code>
        </h1>
        {back}
      </header>
      {error && <p role="alert">{error}</p>}
      <p>
        {guess.rows} {guess.rows === 1 ? 'row' : 'rows'}, {guess.columns.length}{' '}
        {guess.columns.length === 1 ? 'column' : 'columns'}. Below is a guess at what each column
        holds. Check it and put it right: charts are drawn from what you approve here, and only from
        this version of the file.
      </p>
      {approved?.changed && (
        <p role="status">
          The file has changed since its description was approved on{' '}
          {approved.approvedAt.slice(0, 10)}. Look at it again and approve this version.
        </p>
      )}
      <form action={approveDatasetAction.bind(null, id, fileId)}>
        <input type="hidden" name="version" value={version} />
        <Wide label="Table of columns">
          <table>
            <thead>
              <tr>
                <th scope="col">Column</th>
                <th scope="col">First values</th>
                <th scope="col">With no value</th>
                <th scope="col">Holds</th>
                <th scope="col">Unit</th>
              </tr>
            </thead>
            <tbody>
              {guess.columns.map((c, i) => (
                <tr key={c.name}>
                  <th scope="row">
                    <code>{c.name}</code>
                    <input type="hidden" name="name" value={c.name} />
                  </th>
                  <td>{c.examples.join(', ') || 'none'}</td>
                  <td>{c.missing}</td>
                  <td>
                    <select
                      name="type"
                      defaultValue={start(c.name).type}
                      aria-label={`What ${c.name} holds`}
                      disabled={!writer}
                    >
                      {COLUMN_TYPES.map((t) => (
                        <option key={t} value={t}>
                          {HOLDS[t]}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <input
                      name="unit"
                      defaultValue={start(c.name).unit}
                      maxLength={40}
                      size={8}
                      aria-label={`Unit of ${c.name}`}
                      disabled={!writer}
                      // One per column, in order: an empty one must still be sent.
                      data-column={i}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Wide>
        <fieldset>
          <legend>Spellings that mean &quot;no value&quot;</legend>
          {spellings.map((m) => (
            <label key={m}>
              <input
                type="checkbox"
                name="missing"
                value={m}
                defaultChecked={(approved?.missing ?? guess.missing).includes(m)}
                disabled={!writer}
              />{' '}
              {m === '' ? 'an empty field' : <code>{m}</code>}{' '}
            </label>
          ))}
          <label>
            Others, separated by commas
            <input name="otherMissing" disabled={!writer} />
          </label>
        </fieldset>
        <label>
          Where the data came from
          <textarea
            name="attribution"
            rows={2}
            maxLength={2000}
            defaultValue={approved?.attribution ?? ''}
            disabled={!writer}
          />
        </label>
        <label>
          <input
            type="checkbox"
            name="exported"
            defaultChecked={approved?.exported ?? false}
            disabled={!writer}
          />{' '}
          Include this file in downloads of the paper. Left unticked, the charts drawn from it are
          in the download and the data itself is not.
        </label>
        {writer && <button type="submit">Approve this description</button>}
      </form>
    </main>
  );
}
