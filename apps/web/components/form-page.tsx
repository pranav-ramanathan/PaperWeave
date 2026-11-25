import type { ReactNode } from 'react';
import type { Look } from '../lib/ui';
import { Notice, type NoticeKind } from './notice';
import { SmallPage } from './small-page';

/**
 * The frame of a page that shows what a form would do and asks before it does it: rename or
 * delete a file, rename a label, hand a paper over, delete it, describe a data file, draw a chart,
 * the checks before submitting, two revisions side by side. Classic: the <main className="page">
 * and <header className="bar"> (heading, then the way back) these pages have always had. New look:
 * the same elements on one sheet (components/small-page.tsx), styled by `.form-sheet` in
 * app/next/pages.css. The heading and the way back keep their order in both.
 *
 * `danger`: the page asks "are you sure" of something that cannot be undone, so its submit button
 * is the one place a solid red button is allowed (PLAN.md section 4).
 */
export function FormPage({
  look,
  title,
  back,
  children,
  wide = false,
  danger = false,
  before,
}: {
  look: Look;
  title: ReactNode;
  back: ReactNode;
  children?: ReactNode;
  wide?: boolean;
  danger?: boolean;
  /** Drawn first, ahead of the header (a page that looks again by itself). */
  before?: ReactNode;
}) {
  const next = look === 'next';
  return (
    <SmallPage
      look={look}
      wide={wide}
      classic="page"
      className={`form-sheet grid-cols-[minmax(0,1fr)]${danger ? ' danger' : ''}`}
    >
      {before}
      <header className={next ? 'bar flex flex-wrap items-baseline gap-x-4 gap-y-1' : 'bar'}>
        {next ? <h1 className="min-w-0 flex-1">{title}</h1> : <h1>{title}</h1>}
        {back}
      </header>
      {children}
    </SmallPage>
  );
}

/**
 * What the page says about itself when something is wrong or has changed: a paragraph with the
 * role in classic, the app's notice in the new look (the words keep the role, so the tests and
 * "Problem: " find them as before). `tone` is only the colour of the edge and the icon.
 */
export function Say({
  look,
  role,
  tone,
  children,
}: {
  look: Look;
  role: 'alert' | 'status';
  tone?: NoticeKind;
  children: ReactNode;
}) {
  if (look === 'next')
    return (
      <Notice kind={tone ?? (role === 'alert' ? 'error' : 'info')} live={role}>
        {children}
      </Notice>
    );
  return <p role={role}>{children}</p>;
}
