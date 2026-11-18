// Shown for an address that leads nowhere, and for a paper or file that is not this person's
// to see: the two are not told apart. (The framework's own page for this brings a style sheet
// that the pages' content policy refuses.)
import Link from 'next/link';

export default function NotFound() {
  return (
    <main>
      <h1>Nothing here</h1>
      <p>There is no such page, or it is not yours to see.</p>
      <p>
        <Link href="/projects">All papers</Link>
      </p>
    </main>
  );
}
