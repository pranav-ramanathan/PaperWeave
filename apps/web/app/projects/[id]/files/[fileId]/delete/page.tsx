import { AppError, fileUses } from '@paperweave/server';
import Result from '../../../../../Result';
import Link from '../../../../../Go';
import Once from '../../../../../Once';
import { notFound } from 'next/navigation';
import { blobs, db, requireUser } from '../../../../../../lib/server';
import { FormPage, Say } from '../../../../../../components/form-page';
import { deleteFileAction } from '../../../../actions';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Delete a file' };

/** The lines that name a file, shown before it is deleted. Nothing is deleted until the button. */
export default async function DeleteFile({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; fileId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { id, fileId } = await params;
  const { error } = await searchParams;
  const user = await requireUser(`/projects/${id}/files/${fileId}/delete`);
  const uses = await fileUses(db(), blobs(), user.id, id, fileId).catch((err) => {
    if (!(err instanceof AppError)) throw err;
    if (err.code === 'not_found') notFound();
    return err.message;
  });
  const back = (
    <Link prefetch={false} href={`/projects/${id}`}>
      Back to the paper
    </Link>
  );
  if (typeof uses === 'string')
    return (
      <FormPage title="Delete a file" back={back}>
        <Say role="alert">{uses}</Say>
      </FormPage>
    );
  const files = [...new Set(uses.lines.map((l) => l.path))];
  const count = uses.lines.length;
  const one = count === 1;
  return (
    <FormPage
      wide
      danger
      title={
        <>
          Delete <code>{uses.path}</code>
        </>
      }
      back={back}
    >
      {error && <Result alert>{error}</Result>}
      {uses.root ? (
        <Say role="alert">This is the root file. Make another file the root first.</Say>
      ) : (
        <>
          {count === 0 ? (
            <p>
              No line that this page can see names <em>{uses.path}</em>. Nothing has been deleted
              yet.
            </p>
          ) : (
            <p>
              {count} {one ? 'line names' : 'lines name'} this file. Deleting it leaves{' '}
              {one ? 'that line' : 'those lines'} as {one ? 'it is' : 'they are'}: the paper will
              not build, or will lose that part, until {one ? 'it is' : 'they are'} changed. Nothing
              has been deleted yet.
            </p>
          )}
          {files.map((path) => (
            <section key={path} aria-label={path}>
              <h2>
                <code>{path}</code>
              </h2>
              <pre className="diff">
                {uses.lines
                  .filter((l) => l.path === path)
                  .map((l) => (
                    <span key={l.line}>
                      {l.line}: {l.text}
                      {'\n'}
                    </span>
                  ))}
              </pre>
            </section>
          ))}
          <form action={deleteFileAction.bind(null, id, fileId)}>
            <input type="hidden" name="sure" value="1" />
            <Once type="submit">
              {count === 0 ? `Delete ${uses.path}` : `Delete ${uses.path} anyway`}
            </Once>
          </form>
        </>
      )}
    </FormPage>
  );
}
