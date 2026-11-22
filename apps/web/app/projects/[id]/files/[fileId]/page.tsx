import {
  AppError,
  withScope,
  can,
  importReport,
  listMembers,
  modelProcessing,
  openFile,
  paperMacros,
  paperProse,
} from '@paperweave/server';
import Link from '../../../../Go';
import { notFound } from 'next/navigation';
import { blobs, db, filesOf, forTitle, paperOf, requireUser } from '../../../../../lib/server';
import BuildPane from './BuildPane';
import FileEditor from './FileEditor';

export const dynamic = 'force-dynamic';

async function FilePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; fileId: string }>;
  searchParams: Promise<{ thread?: string }>;
}) {
  const { id, fileId } = await params;
  const { thread } = await searchParams;
  // The thread an email's link names comes through sign-in with the rest of the address.
  const named = typeof thread === 'string' && /^[0-9a-f-]{36}$/i.test(thread) ? thread : null;
  const user = await requireUser(
    `/projects/${id}/files/${fileId}${named ? `?thread=${named}` : ''}`,
  );
  const loaded = await Promise.all([
    paperOf(user.id, id),
    filesOf(user.id, id),
    openFile(db(), user.id, fileId),
    importReport(db(), user.id, id),
    paperMacros(db(), blobs(), user.id, id),
    paperProse(db(), blobs(), user.id, id),
    listMembers(db(), user.id, id),
    modelProcessing(db(), user.id, id),
  ]).catch((err) => {
    if (err instanceof AppError && err.code !== 'permission_denied') notFound();
    throw err;
  });
  const [project, files, file, report, macros, prose, members, canReview] = loaded;
  // A file ID from another paper must not open under this paper's address.
  if (file.projectId !== project.id) notFound();
  return (
    <main className="editor">
      <a className="skip" href="#text">
        Skip to the text
      </a>
      <header className="bar">
        <h1>{project.name}</h1>
        <Link prefetch={false} href={`/projects/${id}`}>
          Paper overview
        </Link>
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
                    prefetch={false}
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
          prose={prose}
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

// What this page reads about the paper, it reads once.
/** The file's path and the paper's name; a file that is not in this paper is not found. */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string; fileId: string }>;
}) {
  const { id, fileId } = await params;
  const found = await forTitle(async (userId) => {
    const [project, files] = await Promise.all([paperOf(userId, id), filesOf(userId, id)]);
    return { project, file: files.find((f) => f.id === fileId) };
  });
  if (!found) return { title: 'File' };
  if (!found.file) notFound();
  return { title: `${found.file.path} · ${found.project.name}` };
}

export default function Scoped(props: Parameters<typeof FilePage>[0]) {
  return withScope(() => FilePage(props));
}
