import { listProjects, TEMPLATES } from '@paperweave/server';
import Link from 'next/link';
import { db, requireUser } from '../../lib/server';
import SignOut from '../SignOut';
import { createAction } from './actions';

export const dynamic = 'force-dynamic';

export default async function Projects({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; imported?: string }>;
}) {
  const user = await requireUser('/projects');
  const projects = await listProjects(db(), user.id);
  const { error, imported } = await searchParams;
  return (
    <main className="page">
      <header className="bar">
        <h1>Your papers</h1>
        <span>{user.email}</span>
        <SignOut />
      </header>
      {error && <p role="alert">{error}</p>}
      {imported && <p role="status">Imported {imported} papers from the archive.</p>}
      {projects.length ? (
        <ul className="list">
          {projects.map((p) => (
            <li key={p.id}>
              <Link href={`/projects/${p.id}`}>{p.name}</Link>{' '}
              <span className="role">{p.role}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p>You are not in any paper yet. Start one below, or open an invitation link.</p>
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
        <button type="submit">Create paper</button>
        <small id="template-help">{TEMPLATES.map((t) => `${t.name}: ${t.about}`).join(' ')}</small>
      </form>
      <form action="/api/projects/import" method="post" encType="multipart/form-data">
        <label>
          Or import a ZIP of a LaTeX project
          <input type="file" name="zip" accept=".zip,application/zip" required />
        </label>
        <button type="submit">Import ZIP</button>
      </form>
    </main>
  );
}
