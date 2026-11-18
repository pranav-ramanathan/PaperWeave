import { listProjects } from '@paperweave/server';
import Link from 'next/link';
import { db, requireUser } from '../../lib/server';
import SignOut from '../SignOut';
import { createAction } from './actions';

export const dynamic = 'force-dynamic';

export default async function Projects({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const user = await requireUser('/projects');
  const projects = await listProjects(db(), user.id);
  const { error } = await searchParams;
  return (
    <main className="page">
      <header className="bar">
        <h1>Your papers</h1>
        <span>{user.email}</span>
        <SignOut />
      </header>
      {error && <p role="alert">{error}</p>}
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
        <button type="submit">Create paper</button>
      </form>
    </main>
  );
}
