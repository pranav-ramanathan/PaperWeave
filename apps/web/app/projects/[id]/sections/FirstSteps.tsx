import type { firstSteps } from '@paperweave/server';

type Steps = Awaited<ReturnType<typeof firstSteps>>;

/** What a new paper usually needs, shown to the owner until all of it is done. */
export function FirstSteps({ steps, owner }: { steps: Steps; owner: boolean }) {
  return (
    <>
      {owner && !(steps.written && steps.built && steps.shared && steps.downloaded) && (
        <section aria-labelledby="first-steps">
          <h2 id="first-steps">First steps</h2>
          <p>What a new paper usually needs, and how far this one has come.</p>
          <ol className="report first-steps">
            {(
              [
                [
                  steps.hasFiles,
                  'Give it something to hold',
                  'Add a file below, or start again from a template or a ZIP on the list of papers.',
                ],
                [
                  steps.written,
                  'Write in it',
                  'Open a .tex file under Files. It opens as the paper reads; "Source" shows the LaTeX.',
                ],
                [
                  steps.built,
                  'See the PDF',
                  'It is built beside the text when a file is open, and again whenever you stop typing.',
                ],
                [
                  steps.shared,
                  'Bring in a co-author',
                  'Under People, invite someone as an editor to write with you, or as a reviewer to comment and propose changes.',
                ],
                [
                  steps.downloaded,
                  'Take it away',
                  '"Check before submitting" says what is still wrong and gives the ZIP and PDF of one revision.',
                ],
              ] as const
            ).map(([done, what, how]) => (
              <li key={what}>
                <strong>{done ? 'Done' : 'To do'}:</strong> {what}.{!done && ` ${how}`}
              </li>
            ))}
          </ol>
        </section>
      )}
    </>
  );
}
