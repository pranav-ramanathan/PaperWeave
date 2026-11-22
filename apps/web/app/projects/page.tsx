import { listProjects, TEMPLATES } from '@paperweave/server';
import Link from '../Go';
import { db, requireUser } from '../../lib/server';
import DirectUpload from '../DirectUpload';
import Once from '../Once';
import Result from '../Result';
import SignOut from '../SignOut';
import { createAction } from './actions';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Papers' };

export default async function Projects({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; imported?: string; left?: string }>;
}) {
  const user = await requireUser('/projects');
  const projects = await listProjects(db(), user.id);
  const { error, imported, left } = await searchParams;
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
      {projects.length ? (
        <ul className="list">
          {projects.map((p) => (
            <li key={p.id}>
              <Link prefetch={false} href={`/projects/${p.id}`}>
                {p.name}
              </Link>{' '}
              <span className="role">{p.role}</span>
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
              <strong>From a ZIP.</strong> A project from Overleaf or your own machine. You get a
              report of what was found and what can be edited visually.
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
          Or import a ZIP of a LaTeX project
          <input type="file" name="zip" accept=".zip,application/zip" required />
        </label>
        <Once>Import ZIP</Once>
      </DirectUpload>
    </main>
  );
}
