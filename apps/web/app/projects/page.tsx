import { listProjects, TEMPLATES } from '@paperweave/server';
import Link from '../Go';
import { reviewWaiting } from '../../lib/review';
import { db, requireUser } from '../../lib/server';
import { chosenLook, ui } from '../../lib/ui';
import DirectUpload from '../DirectUpload';
import Once from '../Once';
import Result from '../Result';
import SignOut from '../SignOut';
import { createAction } from './actions';
import { lookAction } from './look-action';
import NextPapers from './NextPapers';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Papers' };

export default async function Projects({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; imported?: string; left?: string; deleted?: string }>;
}) {
  const user = await requireUser('/projects');
  const projects = await listProjects(db(), user.id);
  const { error, imported, left, deleted } = await searchParams;
  const choice = await chosenLook();
  if ((await ui('papers')) === 'next')
    return (
      <NextPapers
        email={user.email}
        projects={projects}
        said={{ error, imported, left, deleted }}
        choice={choice}
      />
    );
  return (
    <main className="page">
      <header className="bar">
        <h1>Your papers</h1>
        <span>{user.email}</span>
        <SignOut />
      </header>
      {error && <Result alert>{error}</Result>}
      {imported && <Result>Imported {imported} papers from the archive.</Result>}
      {left && <Result>You left {left}.</Result>}
      {deleted && <Result>Deleted “{deleted}”. It is gone for everyone who was on it.</Result>}
      {projects.length ? (
        <ul className="list">
          {projects.map((p) => (
            <li key={p.id}>
              <Link prefetch={false} href={`/projects/${p.id}`}>
                {p.name}
              </Link>{' '}
              <span className="role">{p.role}</span>
              {reviewWaiting(p) && (
                <>
                  {' '}
                  <Link prefetch={false} href={`/projects/${p.id}#review`}>
                    {reviewWaiting(p)}
                  </Link>
                </>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <section aria-labelledby="welcome">
          <h2 id="welcome">Start your first paper</h2>
          <p>
            A paper here is a LaTeX project you write with others. There are three ways to begin:
          </p>
          <ul className="report">
            <li>
              <strong>From a template.</strong> A short, complete paper of its kind that builds as
              it is. Give it a name and choose one under &quot;Start from&quot;.
            </li>
            <li>
              <strong>From a ZIP or a tar.</strong> A project from Overleaf, arXiv, a Git host or
              your own machine, as a ZIP, .tar.gz, .tgz or .tar. You get a report of what was found
              and what can be edited visually.
            </li>
            <li>
              <strong>From nothing.</strong> An empty paper, to which you add files.
            </li>
          </ul>
          <p>If someone has invited you to their paper, open the link in their email instead.</p>
        </section>
      )}
      <form action={createAction}>
        <label>
          Name of a new paper
          <input name="name" required maxLength={200} />
        </label>
        <label>
          Start from
          <select name="template" defaultValue="" aria-describedby="template-help">
            <option value="">An empty paper</option>
            {TEMPLATES.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        <Once>Create paper</Once>
        <small id="template-help">{TEMPLATES.map((t) => `${t.name}: ${t.about}`).join(' ')}</small>
      </form>
      <DirectUpload action="/api/projects/import" kind="zip" field="zip">
        <label>
          Or import a ZIP of a LaTeX project, or a .tar.gz, .tgz or .tar of one
          <input
            type="file"
            name="zip"
            accept=".zip,.tar.gz,.tgz,.tar,application/zip,application/gzip,application/x-gzip,application/x-tar"
            required
          />
        </label>
        <Once>Import ZIP or tar</Once>
      </DirectUpload>
      {/* Last in the page, after every form above, so that no Tab stop comes before an existing
          one. The new look is being built page by page: pages that are not in it yet look as
          they did, so the button is the only thing here that shows which look is chosen. */}
      <form action={lookAction} aria-label="Look of the pages">
        <input type="hidden" name="look" value={choice === 'next' ? 'classic' : 'next'} />
        <Once>{choice === 'next' ? 'Use the old look' : 'Try the new look'}</Once>
      </form>
    </main>
  );
}
