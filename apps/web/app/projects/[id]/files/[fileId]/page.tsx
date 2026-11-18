import { AppError, can, getProject, listFiles, openFile } from '@paperweave/server';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { db, requireUser } from '../../../../../lib/server';
import BuildPane from './BuildPane';
import SourceEditor from './SourceEditor';

export const dynamic = 'force-dynamic';

export default async function FilePage({
  params,
}: {
  params: Promise<{ id: string; fileId: string }>;
}) {
  const { id, fileId } = await params;
  const user = await requireUser(`/projects/${id}/files/${fileId}`);
  const loaded = await Promise.all([
    getProject(db(), user.id, id),
    listFiles(db(), user.id, id),
    openFile(db(), user.id, fileId),
  ]).catch((err) => {
    if (err instanceof AppError && err.code !== 'permission_denied') notFound();
    throw err;
  });
  const [project, files, file] = loaded;
  // A file ID from another paper must not open under this paper's address.
  if (file.projectId !== project.id) notFound();
  return (
    <main className="editor">
      <header className="bar">
        <h1>{project.name}</h1>
        <Link href={`/projects/${id}`}>Paper overview</Link>
      </header>
      <div className="workspace">
        <nav aria-label="Files">
          <ul>
            {files.map((f) => (
              <li key={f.id}>
                {f.readonly ? (
                  <span title="Cannot be edited as text">{f.path}</span>
                ) : (
                  <Link
                    href={`/projects/${id}/files/${f.id}`}
                    aria-current={f.id === fileId ? 'page' : undefined}
                  >
                    {f.path}
                  </Link>
                )}
              </li>
            ))}
          </ul>
        </nav>
        <SourceEditor
          key={fileId}
          fileId={fileId}
          path={file.path}
          canWrite={file.canWrite}
          user={user.email}
          syncUrl={process.env.SYNC_URL ?? 'ws://localhost:4100'}
        />
        <BuildPane projectId={id} canBuild={can(project.role, 'build.run')} />
      </div>
    </main>
  );
}
