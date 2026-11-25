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
  paperTextMacros,
} from '@paperweave/server';
import Link from '../../../../Go';
import { notFound } from 'next/navigation';
import { blobs, db, filesOf, forTitle, paperOf, requireUser } from '../../../../../lib/server';
import { rootDir } from '@paperweave/latex';
import BuildPane from './BuildPane';
import FileEditor from './FileEditor';
import Files, { FileName } from './Files';
import { AppBar } from '../../../../../components/app-bar';
import { LookProvider } from '../../../../../components/look';
import { buttonVariants } from '../../../../../components/ui/button';
import { ui } from '../../../../../lib/ui';

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
    paperTextMacros(db(), blobs(), user.id, id),
    listMembers(db(), user.id, id),
    modelProcessing(db(), user.id, id),
  ]).catch((err) => {
    if (err instanceof AppError && err.code !== 'permission_denied') notFound();
    throw err;
  });
  const [project, files, file, report, macros, prose, words, members, canReview] = loaded;
  // A file ID from another paper must not open under this paper's address.
  if (file.projectId !== project.id) notFound();
  const look = await ui('file');
  const tree = files.map((f) => ({ id: f.id, path: f.path, readonly: f.readonly }));
  return (
    <main className="editor" data-ui={look}>
      <LookProvider look={look}>
        <a className="skip" href="#text">
          Skip to the text
        </a>
        {look === 'next' ? (
          // The new look: the app bar holds the same two things, the paper's name (the h1) and the
          // link to its page, after the mark, the paper and the file being the way there.
          <AppBar
            home="/projects"
            crumbs={[
              { label: project.name, heading: true },
              {
                id: 'file',
                label: <FileName projectId={id} fileId={fileId} files={tree} path={file.path} />,
              },
            ]}
          >
            <Link
              prefetch={false}
              href={`/projects/${id}`}
              className={buttonVariants({ variant: 'outline', size: 'sm' })}
            >
              Paper overview
            </Link>
          </AppBar>
        ) : (
          <header className="bar">
            <h1>{project.name}</h1>
            <Link prefetch={false} href={`/projects/${id}`}>
              Paper overview
            </Link>
          </header>
        )}
        <div className="workspace">
          <Files projectId={id} fileId={fileId} files={tree} root={report?.root} />
          <FileEditor
            key={fileId}
            projectId={id}
            fileId={fileId}
            visual={/\.(tex|ltx)$/i.test(file.path)}
            macros={macros}
            prose={prose}
            words={words}
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
          <BuildPane
            projectId={id}
            canBuild={can(project.role, 'build.run')}
            files={files.map((f) => ({ id: f.id, path: f.path, readonly: f.readonly }))}
            rootDir={rootDir(report?.root ?? '')}
          />
        </div>
      </LookProvider>
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
