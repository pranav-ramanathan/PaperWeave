import type { ReactNode } from 'react';
import { Notice, type NoticeKind } from './notice';
import { SmallPage } from './small-page';

/**
 * The frame of a page that shows what a form would do and asks before it does it: rename or
 * delete a file, rename a label, hand a paper over, delete it, describe a data file, draw a chart,
 * the checks before submitting, two revisions side by side. The <main className="page">
 * and <header className="bar"> (heading, then the way back), on one sheet (components/small-page.tsx),
 * styled by `.form-sheet` in app/next/pages.css.
 *
 * `danger`: the page asks "are you sure" of something that cannot be undone, so its submit button
 * is the one place a solid red button is allowed (PLAN.md section 4).
 */
export function FormPage({
  title,
  back,
  children,
  wide = false,
  danger = false,
  before,
}: {
  title: ReactNode;
  back: ReactNode;
  children?: ReactNode;
  wide?: boolean;
  danger?: boolean;
  /** Drawn first, ahead of the header (a page that looks again by itself). */
  before?: ReactNode;
}) {
  return (
    <SmallPage wide={wide} className={`form-sheet${danger ? ' danger' : ''}`}>
      {before}
      <header className="bar flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h1 className="min-w-0 flex-[1_1_14rem]">{title}</h1>
        {back}
      </header>
      {children}
    </SmallPage>
  );
}

/**
 * What the page says about itself when something is wrong or has changed: the app's notice (the
 * words keep the role, so the tests and "Problem: " find them). `tone` is only the colour of the
 * edge and the icon.
 */
export function Say({
  role,
  tone,
  children,
}: {
  role: 'alert' | 'status';
  tone?: NoticeKind;
  children: ReactNode;
}) {
  return (
    <Notice kind={tone ?? (role === 'alert' ? 'error' : 'info')} live={role}>
      {children}
    </Notice>
  );
}
