import Link from '../../../Go';
import Once from '../../../Once';
import Result from '../../../Result';
import { renamePaperAction } from '../../actions';

/** The paper's name and the reader's role in it. */
export function Header({ name, role }: { name: string; role: string }) {
  return (
    <header className="bar">
      <h1>{name}</h1>
      {/* The text is cut into the same pieces as before the page was split into sections
          (the HTML keeps a marker between pieces), so it is kept as written. */}
      {/* prettier-ignore */}
      <span>
        You are{' '}
        {role === 'viewer' || role === 'reviewer'
          ? 'a'
          : role === 'owner'
            ? 'the'
            : 'an'}{' '}
        {role}
      </span>
      <Link prefetch={false} href="/projects">
        All papers
      </Link>
    </header>
  );
}

/** The error a failed action sent back, if any. */
export function ErrorNotice({ error }: { error?: string }) {
  return <>{error && <Result alert>{error}</Result>}</>;
}

/** Shown after the paper was renamed. */
export function RenamedNotice({ renamed, name }: { renamed?: string; name: string }) {
  return <>{renamed && <Result>This paper is now called “{name}”.</Result>}</>;
}

/** The owner's form for renaming the paper. */
export function Rename({ id, name, owner }: { id: string; name: string; owner: boolean }) {
  return (
    <>
      {owner && (
        <details>
          <summary>Rename this paper</summary>
          <form action={renamePaperAction.bind(null, id)}>
            <label>
              New name for this paper
              <input name="name" defaultValue={name} required maxLength={200} />
            </label>
            <Once type="submit">Rename paper</Once>
          </form>
        </details>
      )}
    </>
  );
}
