'use client';

// Shown when a page could not be made: something the service depends on did not answer, or
// there is a fault in the service. (The framework's own page for this brings a style sheet
// that the pages' content policy refuses.) What went wrong is in the server's log, not here.
export default function Failed() {
  return (
    <main>
      <h1>This page could not be shown</h1>
      <p>
        Something went wrong on the service&apos;s side, not yours. What was already saved is still
        saved.
      </p>
      <p>
        {/* The page is asked for again from the server. The framework's own way of trying again
            draws the same failure again without asking. */}
        <button type="button" onClick={() => location.reload()}>
          Try again
        </button>{' '}
        <a href="/projects">All papers</a>
      </p>
    </main>
  );
}
