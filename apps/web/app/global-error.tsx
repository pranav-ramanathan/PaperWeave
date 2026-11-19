'use client';

// The same, for a failure in the frame every page shares: this one has to bring its own
// document, and nothing in it may need a style sheet or script of the service's.
export default function FailedEverywhere() {
  return (
    <html lang="en">
      <body>
        <main>
          <h1>This page could not be shown</h1>
          <p>
            Something went wrong on the service&apos;s side, not yours. What was already saved is
            still saved.
          </p>
          <p>
            <button type="button" onClick={() => location.reload()}>
              Try again
            </button>
          </p>
        </main>
      </body>
    </html>
  );
}
