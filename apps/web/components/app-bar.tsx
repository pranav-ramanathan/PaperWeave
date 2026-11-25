import type { ReactNode } from 'react';
import { cn } from '../lib/utils';
import { ChevronRight } from './icon';
import { Mark } from './mark';

export type Crumb = { label: string; href?: string };

/**
 * The app bar of the new look: 48 px, sheet colour, a hairline below. The mark and the word, then
 * where the person is (`crumbs`), then on the right whatever the page puts in `children` (save
 * status, who else is here, one link out, the theme).
 *
 * Where it goes (PLAN.md section 6, rule 3): inside the page's own <main data-ui='next'>, AFTER
 * the skip link, never in the layout. The bar is several tab stops (the home link, each crumb
 * that is a link, what is in `children`); nothing may come before "Skip to the text", so a page
 * that has that link renders it first and the bar after it. The bar is not a banner landmark (a
 * <header> inside <main> is not), and it has no `position: sticky`: the page scrolls it away.
 *
 * Links are plain anchors, not the framework's: a link in view would be fetched ahead of time,
 * and the tests refuse that (refusals() in tests/e2e/helpers.ts). A crumb that is not a link is
 * where the person is now (`aria-current="page"`).
 *
 * Before a page adds a link here, grep tests/e2e for its name: a second "All papers" link or a
 * second "main.tex" breaks the strict locators.
 */
export function AppBar(props: {
  /** Where the mark and the word lead. */
  home?: string;
  crumbs?: Crumb[];
  /** The right side. */
  children?: ReactNode;
  className?: string;
}) {
  const { home = '/', crumbs, children, className } = props;
  return (
    <header
      className={cn(
        'flex min-h-12 flex-wrap items-center gap-x-3 gap-y-1 border-b bg-card px-4 py-1.5',
        className,
      )}
    >
      <a
        href={home}
        className="flex items-center gap-2 rounded-sm font-heading text-[1.0625rem] font-semibold tracking-tight"
      >
        <Mark />
        PaperWeave
      </a>
      {crumbs && crumbs.length > 0 && (
        <nav aria-label="Where you are" className="min-w-0">
          <ol className="flex min-w-0 flex-wrap items-center gap-1">
            {crumbs.map((c) => (
              <li key={c.label} className="flex min-w-0 items-center gap-1 text-muted-foreground">
                <ChevronRight className="size-3.5 shrink-0" aria-hidden="true" />
                {c.href ? (
                  <a href={c.href} className="rounded-sm underline-offset-4 hover:underline">
                    {c.label}
                  </a>
                ) : (
                  <span aria-current="page" className="truncate font-medium text-foreground">
                    {c.label}
                  </span>
                )}
              </li>
            ))}
          </ol>
        </nav>
      )}
      {children && <div className="ml-auto flex flex-wrap items-center gap-2">{children}</div>}
    </header>
  );
}
