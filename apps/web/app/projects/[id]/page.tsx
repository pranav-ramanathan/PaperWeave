import { AppError, getProject, listMembers } from '@paperweave/server';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { db, requireUser } from '../../../lib/server';
import { inviteAction, removeAction, roleAction } from '../actions';

export const dynamic = 'force-dynamic';
const INVITABLE = ['editor', 'reviewer', 'viewer'] as const;

export default async function Project({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; invited?: string }>;
}) {
  const { id } = await params;
  const user = await requireUser(`/projects/${id}`);
  const loaded = await Promise.all([
    getProject(db(), user.id, id),
    listMembers(db(), user.id, id),
  ]).catch((err) => {
    // Not a member, or no such paper: the two look the same from outside.
    if (err instanceof AppError && err.code === 'not_found') notFound();
    throw err;
  });
  const [project, members] = loaded;
  const { error, invited } = await searchParams;
  const owner = project.role === 'owner';
  return (
    <main className="page">
      <header className="bar">
        <h1>{project.name}</h1>
        <span>
          You are{' '}
          {project.role === 'viewer' || project.role === 'reviewer'
            ? 'a'
            : project.role === 'owner'
              ? 'the'
              : 'an'}{' '}
          {project.role}
        </span>
        <Link href="/projects">All papers</Link>
      </header>
      {error && <p role="alert">{error}</p>}
      {invited && <p role="status">Invitation sent to {invited}.</p>}

      <h2>People</h2>
      <table>
        <thead>
          <tr>
            <th scope="col">Email</th>
            <th scope="col">Role</th>
            <th scope="col">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {members.map((m) => (
            <tr key={m.userId}>
              <th scope="row">{m.email}</th>
              <td>
                {owner && m.role !== 'owner' ? (
                  <form action={roleAction.bind(null, id, m.userId)} className="inline">
                    <select name="role" defaultValue={m.role} aria-label={`Role of ${m.email}`}>
                      {INVITABLE.map((r) => (
                        <option key={r}>{r}</option>
                      ))}
                    </select>
                    <button type="submit">Change</button>
                  </form>
                ) : (
                  m.role
                )}
              </td>
              <td>
                {m.role !== 'owner' && (owner || m.userId === user.id) && (
                  <form action={removeAction.bind(null, id, m.userId)} className="inline">
                    <button
                      type="submit"
                      aria-label={m.userId === user.id ? 'Leave this paper' : `Remove ${m.email}`}
                    >
                      {m.userId === user.id ? 'Leave' : 'Remove'}
                    </button>
                  </form>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {owner && (
        <>
          <h2>Invite someone</h2>
          <form action={inviteAction.bind(null, id)}>
            <label>
              Their email address
              <input type="email" name="email" required />
            </label>
            <label>
              Their role
              <select name="role" defaultValue="editor">
                {INVITABLE.map((r) => (
                  <option key={r}>{r}</option>
                ))}
              </select>
            </label>
            <button type="submit">Send invitation</button>
          </form>
        </>
      )}
    </main>
  );
}
