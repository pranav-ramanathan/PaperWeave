'use client';

// The same, for a failure in the frame every page shares: this one has to bring its own
// document, and nothing in it may need a style sheet or script of the service's.
export default function FailedEverywhere() {
  return (
    <html lang="en">
      <head>
        <title>This page could not be shown — PaperWeave</title>
      </head>
      <body>
        <main>
          <h1>This page could not be shown</h1>
          <p>
            Something went wrong on the service&apos;s side, not yours. What was already saved is
            still saved. If you were making a change, it may or may not have been made: look before
            making it again.
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
