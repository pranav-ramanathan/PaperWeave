import Link from '../../../Go';

/** The way to delete the paper, which asks first. */
export function Delete({ id }: { id: string }) {
  return (
    <>
      <h2 id="delete">Delete this paper</h2>
      <p>
        Takes the paper away from everyone on it, with its history. You are shown what goes, and
        asked, before anything is deleted.{' '}
        <Link prefetch={false} href={`/projects/${id}/delete`}>
          Delete this paper…
        </Link>
      </p>
    </>
  );
}
