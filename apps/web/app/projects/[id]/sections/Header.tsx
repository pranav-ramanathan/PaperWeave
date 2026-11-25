import { ChevronRight } from '../../../../components/icon';
import { Mark } from '../../../../components/mark';
import Link from '../../../Go';
import Once from '../../../Once';
import Result from '../../../Result';
import { renamePaperAction } from '../../actions';

/** The paper's name and the reader's role in it. `next` is the new look's top: a bar, then the title. */
export function Header({
  name,
  role,
  next = false,
}: {
  name: string;
  role: string;
  next?: boolean;
}) {
  // The text is cut into the same pieces as before the page was split into sections
  // (the HTML keeps a marker between pieces), so it is kept as written.
  // prettier-ignore
  const who = (
    <span>
      You are{' '}
      {role === 'viewer' || role === 'reviewer'
        ? 'a'
        : role === 'owner'
          ? 'the'
          : 'an'}{' '}
      {role}
    </span>
  );
  if (next)
    return (
      <>
        {/* The mark and the word are not a link here: a link before "All papers" would be a new
            stop for the keyboard before the ones the page has. */}
        <header className="paper-bar">
          <span className="paper-brand">
            <Mark />
            PaperWeave
          </span>
          <nav aria-label="Where you are">
            <ol>
              <li>
                <ChevronRight aria-hidden="true" />
                <Link prefetch={false} href="/projects">
                  All papers
                </Link>
              </li>
            </ol>
          </nav>
        </header>
        <div className="paper-title">
          <h1>{name}</h1>
          {who}
        </div>
      </>
    );
  return (
    <header className="bar">
      <h1>{name}</h1>
      {who}
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
