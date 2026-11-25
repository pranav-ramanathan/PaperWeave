import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { AppBar } from '../../../../components/app-bar';
import { Icon, MessageSquare, Moon, Sparkles, Sun } from '../../../../components/icon';
import { LookProvider } from '../../../../components/look';
import { Mark } from '../../../../components/mark';
import { Notice } from '../../../../components/notice';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '../../../../components/ui/tooltip';
import Readout from './Readout';

// The new look's app parts, one of each, for developers and for tests/e2e/specimen-parts.spec.ts.
// Behind SPIKE like /spike: off wherever people use the service. No existing page is touched.
// `?theme=dark` puts the dark tokens on the page (the real switch is a later task's).
export const metadata: Metadata = { title: 'App parts' };
export const dynamic = 'force-dynamic';

// A plain button with classes: the shared primitives (components/ui/button) are another task's.
const ICON_BUTTON =
  'inline-flex size-8 items-center justify-center rounded-md text-foreground hover:bg-accent hover:text-accent-foreground [@media(pointer:coarse)]:size-10';

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ theme?: string }>;
}) {
  if (process.env.SPIKE !== '1') notFound();
  const dark = (await searchParams).theme === 'dark';
  return (
    <main
      className="page min-h-screen bg-background text-foreground"
      data-ui="next"
      data-theme={dark ? 'dark' : undefined}
    >
      <LookProvider look="next">
        <TooltipProvider>
          <AppBar
            home="/spike/ui/parts"
            crumbs={[{ label: 'Specimens', href: '/spike/ui/parts' }, { label: 'App parts' }]}
          >
            <span className="text-muted-foreground">All edits saved</span>
            <Tooltip>
              <TooltipTrigger asChild>
                <a
                  href={dark ? '/spike/ui/parts' : '/spike/ui/parts?theme=dark'}
                  aria-label={dark ? 'Use the light theme' : 'Use the dark theme'}
                  className={ICON_BUTTON}
                >
                  <Icon icon={dark ? Sun : Moon} />
                </a>
              </TooltipTrigger>
              <TooltipContent>{dark ? 'Light theme' : 'Dark theme'}</TooltipContent>
            </Tooltip>
          </AppBar>

          <div className="mx-auto grid max-w-3xl gap-8 px-4 py-8">
            <h1 className="font-heading text-3xl font-semibold tracking-tight">App parts</h1>

            <section aria-labelledby="mark" className="grid gap-3">
              <h2 id="mark" className="font-heading text-xl font-semibold">
                The mark
              </h2>
              <p className="flex items-end gap-6">
                <Mark className="size-4" />
                <Mark className="size-6" />
                <Mark className="size-12" />
              </p>
            </section>

            <section aria-labelledby="notices" className="grid gap-3">
              <h2 id="notices" className="font-heading text-xl font-semibold">
                Notices
              </h2>
              <Notice kind="info">The PDF is up to date.</Notice>
              <Notice kind="success">The paper was saved.</Notice>
              <Notice
                kind="warning"
                live="polite"
                actionsLabel="About the restore"
                actions={
                  <>
                    <a href="#notices">Show what the restore changed (opens a new tab)</a>
                    <button type="button" className="underline underline-offset-4">
                      Dismiss
                    </button>
                  </>
                }
              >
                You restored a copy from 10:42. Your later edits are in the history.
              </Notice>
              <Notice kind="error">The title cannot be empty.</Notice>
              <Notice kind="warning" live="off">
                A wide line of text that has to wrap inside a narrow window: Latency stays below
                forty milliseconds in every region measured, supercalifragilisticexpialidocious
                supercalifragilisticexpialidocious.
              </Notice>
            </section>

            <section aria-labelledby="tooltips" className="grid gap-3">
              <h2 id="tooltips" className="font-heading text-xl font-semibold">
                Tooltips
              </h2>
              <p>
                A tooltip names an icon button and its shortcut. It opens on hover and on focus.
              </p>
              <p className="flex gap-2">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button type="button" aria-label="Add a comment" className={ICON_BUTTON}>
                      <Icon icon={MessageSquare} />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>Add a comment</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      aria-label="Ask for a model review"
                      className={ICON_BUTTON}
                    >
                      <Icon icon={Sparkles} />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>Ask for a model review</TooltipContent>
                </Tooltip>
              </p>
            </section>

            <section aria-labelledby="look" className="grid gap-3">
              <h2 id="look" className="font-heading text-xl font-semibold">
                The look context
              </h2>
              <Readout />
            </section>
          </div>
        </TooltipProvider>
      </LookProvider>
    </main>
  );
}
