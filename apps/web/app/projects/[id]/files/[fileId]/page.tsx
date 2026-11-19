import {
  AppError,
  can,
  getProject,
  importReport,
  listFiles,
  listMembers,
  modelProcessing,
  openFile,
  paperMacros,
} from '@paperweave/server';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { blobs, db, requireUser } from '../../../../../lib/server';
import BuildPane from './BuildPane';
import FileEditor from './FileEditor';

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
    importReport(db(), user.id, id),
    paperMacros(db(), blobs(), user.id, id),
    listMembers(db(), user.id, id),
    modelProcessing(db(), user.id, id),
  ]).catch((err) => {
    if (err instanceof AppError && err.code !== 'permission_denied') notFound();
    throw err;
  });
  const [project, files, file, report, macros, members, canReview] = loaded;
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
        <FileEditor
          key={fileId}
          projectId={id}
          fileId={fileId}
          visual={/\.(tex|ltx)$/i.test(file.path)}
          macros={macros}
          sourceOnly={!!report?.files.find((f) => f.path === file.path)?.sourceOnly}
          path={file.path}
          canWrite={file.canWrite}
          role={project.role}
          canComment={can(project.role, 'comment.write')}
          canReview={canReview}
          members={members
            .filter((m) => m.userId !== user.id)
            .map((m) => ({ userId: m.userId, email: m.email }))}
          user={user.email}
          syncUrl={process.env.SYNC_URL ?? 'ws://localhost:4100'}
        />
        <BuildPane projectId={id} canBuild={can(project.role, 'build.run')} />
      </div>
    </main>
  );
}
