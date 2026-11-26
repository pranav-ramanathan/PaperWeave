import type { ReactNode } from 'react';
import { KitProvider } from './kit';
import { Mark } from './mark';
import { Card, CardContent } from './ui/card';

/**
 * The frame of a one-form page: sign-in, the page the emailed link leads to, an invitation, "nothing
 * here": the page's own <main data-ui='next'>, the word and mark centred above a sheet that holds
 * the page's content (PLAN.md sections 2 and 4).
 *
 * The word and mark are not a link and not read out (the heading says where this is): a link here
 * would be a tab stop before the page's own, and the tests press Tab from the top of the page.
 * `className` is for the sheet's content.
 */
export function SmallPage({
  children,
  className,
  wide = false,
}: {
  children: ReactNode;
  className?: string;
  /** A wider sheet, for a page that shows lines of text or a table (48rem, not 28rem). */
  wide?: boolean;
}) {
  return (
    // `page` keeps the "Problem: " that functional.css puts before an alert.
    // The utilities need an element inside the scope element: they do not match the <main> itself.
    <main data-ui="next" className="page">
      <KitProvider>
        <div className="flex min-h-dvh flex-col items-center gap-6 px-4 py-12 sm:justify-center">
          <p
            aria-hidden="true"
            className="flex items-center gap-2 font-heading text-[1.375rem] font-semibold tracking-tight"
          >
            <Mark />
            PaperWeave
          </p>
          <Card
            className={(wide ? 'max-w-3xl' : 'max-w-md') + ' w-full [--card-spacing:--spacing(6)]'}
          >
            {/* One column no wider than the sheet, and text that breaks inside a word that does
                not fit (a paper's name, an email address). An `auto` column takes the width of
                the longest word, and the heading's `break-word` does not narrow that: at twice
                the text size, the last word of "Join “Dark mwwom4frw0”" made the column 421 px
                where the sheet has 398, and the sheet hides what sticks out (how much went by the
                letters of the name). */}
            <CardContent
              className={
                'grid grid-cols-[minmax(0,1fr)] gap-4 [overflow-wrap:break-word] [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-4 [&_a:hover]:no-underline [&_h1]:font-heading [&_h1]:text-[1.375rem] sm:[&_h1]:text-[1.75rem] [&_h1]:leading-tight [&_h1]:font-semibold [&_h1]:tracking-tight [&_h1]:text-balance' +
                (className ? ` ${className}` : '')
              }
            >
              {children}
            </CardContent>
          </Card>
        </div>
      </KitProvider>
    </main>
  );
}
