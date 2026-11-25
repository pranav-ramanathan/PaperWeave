import { TEMPLATES, type listProjects } from '@paperweave/server';
import { AppBar } from '../../components/app-bar';
import { Icon, MessageSquare } from '../../components/icon';
import { LookProvider } from '../../components/look';
import { ThemeSwitch } from '../../components/theme-switch';
import { Badge } from '../../components/ui/badge';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { NativeSelect } from '../../components/ui/native-select';
import { reviewWaiting } from '../../lib/review';
import type { Look } from '../../lib/ui';
import DirectUpload from '../DirectUpload';
import Link from '../Go';
import Once from '../Once';
import Result from '../Result';
import SignOut from '../SignOut';
import { createAction } from './actions';
import { lookAction } from './look-action';

/**
 * The papers list in the new look (PLAN.md section 4, mock: after/papers-1440-light.png). The same
 * words, links, labels and buttons as the classic page, in the same order in the page: the list on
 * the left of a wide window and the forms beside it are placed by the grid, not by moving them, and
 * the switch for the look stays the last thing, so that nothing before it has moved.
 *
 * Only what the page has is drawn: no search, no sorting, no counts of people or of builds. The
 * classic page's own markup stays in page.tsx until the old look is removed.
 */
export default function NextPapers(props: {
  email: string;
  projects: Awaited<ReturnType<typeof listProjects>>;
  said: { error?: string; imported?: string; left?: string; deleted?: string };
  choice: Look;
}) {
  const { email, projects, said, choice } = props;
  const { error, imported, left, deleted } = said;
  return (
    // `page` keeps the "Problem: " that functional.css puts before an alert.
    <main data-ui="next" className="page">
      <LookProvider look="next">
        <div className="min-h-dvh">
          <AppBar home={null}>
            <span className="text-muted-foreground [overflow-wrap:anywhere]">{email}</span>
            <SignOut variant="ghost" />
            <ThemeSwitch />
          </AppBar>
          <div className="mx-auto grid max-w-6xl grid-cols-[minmax(0,1fr)] content-start gap-x-10 gap-y-8 px-4 py-8 lg:grid-cols-[minmax(0,1fr)_21rem] lg:py-12">
            <div className="min-w-0">
              <h1 className="font-heading text-4xl leading-tight font-semibold tracking-tight text-balance">
                Your papers
              </h1>
              {(error || imported || left || deleted) && (
                <div className="mt-4 grid gap-2">
                  {error && <Result alert>{error}</Result>}
                  {imported && <Result>Imported {imported} papers from the archive.</Result>}
                  {left && <Result>You left {left}.</Result>}
                  {deleted && (
                    <Result>Deleted “{deleted}”. It is gone for everyone who was on it.</Result>
                  )}
                </div>
              )}
              {projects.length ? (
                <ul className="list mt-6 border-y">
                  {projects.map((p) => (
                    <li
                      key={p.id}
                      className="relative grid grid-cols-[minmax(0,1fr)] gap-x-4 gap-y-1.5 border-b py-4 pl-4 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_auto]"
                    >
                      <span
                        aria-hidden="true"
                        className={`absolute inset-y-3 left-0 w-[3px] rounded-full ${
                          reviewWaiting(p) ? 'bg-primary' : 'bg-border'
                        }`}
                      />
                      <Link
                        prefetch={false}
                        href={`/projects/${p.id}`}
                        className="rounded-sm font-heading text-[1.375rem] [overflow-wrap:anywhere] leading-snug font-semibold underline-offset-4 hover:underline"
                      >
                        {p.name}
                      </Link>
                      <Badge variant="secondary" className="role self-start sm:justify-self-end">
                        {p.role}
                      </Badge>
                      {reviewWaiting(p) && (
                        <Link
                          prefetch={false}
                          href={`/projects/${p.id}#review`}
                          className="inline-flex w-fit items-center gap-1 rounded-sm text-[0.8125rem] font-medium text-comment underline-offset-4 hover:underline sm:col-span-2"
                        >
                          <Icon icon={MessageSquare} className="size-3.5" />
                          {reviewWaiting(p)}
                        </Link>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <section aria-labelledby="welcome" className="mt-6 grid gap-3">
                  <h2 id="welcome" className="font-heading text-[1.375rem] font-semibold">
                    Start your first paper
                  </h2>
                  <p>
                    A paper here is a LaTeX project you write with others. There are three ways to
                    begin:
                  </p>
                  <ul className="report grid list-disc gap-2 pl-5">
                    <li>
                      <strong>From a template.</strong> A short, complete paper of its kind that
                      builds as it is. Give it a name and choose one under &quot;Start from&quot;.
                    </li>
                    <li>
                      <strong>From a ZIP or a tar.</strong> A project from Overleaf, arXiv, a Git
                      host or your own machine, as a ZIP, .tar.gz, .tgz or .tar. You get a report of
                      what was found and what can be edited visually.
                    </li>
                    <li>
                      <strong>From nothing.</strong> An empty paper, to which you add files.
                    </li>
                  </ul>
                  <p>
                    If someone has invited you to their paper, open the link in their email instead.
                  </p>
                </section>
              )}
            </div>
            <div className="grid content-start gap-6">
              <form
                action={createAction}
                className="grid gap-4 rounded-xl border bg-card p-6 shadow-rest"
              >
                <h2 className="font-heading text-lg font-semibold">New paper</h2>
                <div className="grid gap-1.5">
                  <Label htmlFor="name">Name of a new paper</Label>
                  <Input id="name" name="name" required maxLength={200} />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="template">Start from</Label>
                  <NativeSelect
                    id="template"
                    name="template"
                    defaultValue=""
                    aria-describedby="template-help"
                    wrapperClassName="w-full"
                  >
                    <option value="">An empty paper</option>
                    {TEMPLATES.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </NativeSelect>
                  <small id="template-help" className="text-[0.8125rem] text-muted-foreground">
                    {TEMPLATES.map((t) => `${t.name}: ${t.about}`).join(' ')}
                  </small>
                </div>
                <Once className="w-full">Create paper</Once>
              </form>
              <DirectUpload
                action="/api/projects/import"
                kind="zip"
                field="zip"
                className="grid gap-3 rounded-xl border border-dashed border-line-strong p-6"
              >
                <h2 className="font-heading text-lg font-semibold">Import a project</h2>
                <Label htmlFor="zip" className="leading-snug font-normal text-muted-foreground">
                  Or import a ZIP of a LaTeX project, or a .tar.gz, .tgz or .tar of one
                </Label>
                <Input
                  id="zip"
                  type="file"
                  name="zip"
                  accept=".zip,.tar.gz,.tgz,.tar,application/zip,application/gzip,application/x-gzip,application/x-tar"
                  required
                />
                <Once variant="outline" className="w-full border-input">
                  Import ZIP or tar
                </Once>
              </DirectUpload>
              {/* Last in the page, after every form above (see lib/ui.ts and look.spec.ts). */}
              <form action={lookAction} aria-label="Look of the pages" className="flex">
                <input type="hidden" name="look" value={choice === 'next' ? 'classic' : 'next'} />
                <Once variant="outline" className="border-input">
                  {choice === 'next' ? 'Use the old look' : 'Try the new look'}
                </Once>
              </form>
            </div>
          </div>
        </div>
      </LookProvider>
    </main>
  );
}
