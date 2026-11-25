import type { ComponentProps, ReactNode } from 'react';
import { cn } from '../lib/utils';
import { CircleCheck, Icon, Info, TriangleAlert } from './icon';

export type NoticeKind = 'info' | 'warning' | 'error' | 'success';

/**
 * How the words are announced, as the app does today:
 *  - `status` and `alert`: the words are the live region (`Result`, app/Result.tsx). An alert is
 *    said at once; on a page (`main.page`) functional.css puts "Problem: " before it, which is
 *    why the role is on the words and not on the box (the prefix would land before the icon).
 *  - `polite`: the words are a polite live region, as the editor's notice has it
 *    (`.editor-notice`): the region is always there, so that a screen reader hears words that
 *    arrive in it. Keep it mounted; draw the box's edge only while there is something to say.
 *  - `off`: a note in the flow, not announced.
 * Default: `alert` for an error, `status` for the others.
 */
export type NoticeLive = 'alert' | 'status' | 'polite' | 'off';

const KINDS = {
  info: { icon: Info, edge: 'border-l-proposal-line', wash: 'bg-card' },
  warning: { icon: TriangleAlert, edge: 'border-l-comment-line', wash: 'bg-comment-wash' },
  error: { icon: TriangleAlert, edge: 'border-l-finding-line', wash: 'bg-finding-wash' },
  success: { icon: CircleCheck, edge: 'border-l-ok-line', wash: 'bg-ok-wash' },
} as const;

/**
 * A notice in the new look: sheet or wash fill, a 4 px coloured edge, an icon, and always the
 * words (the colour is never the message). `actions` are the things a person can do about it, in
 * a group named `actionsLabel`.
 */
export function Notice({
  kind = 'info',
  live,
  children,
  actions,
  actionsLabel,
  className,
  ...rest
}: {
  kind?: NoticeKind;
  live?: NoticeLive;
  children?: ReactNode;
  actions?: ReactNode;
  actionsLabel?: string;
} & Omit<ComponentProps<'div'>, 'role' | 'aria-live'>) {
  const how = live ?? (kind === 'error' ? 'alert' : 'status');
  const k = KINDS[kind];
  return (
    <div
      {...rest}
      className={cn(
        'flex flex-wrap items-baseline gap-x-4 gap-y-1 rounded-md border border-l-4 px-3 py-2 text-foreground shadow-rest [overflow-wrap:anywhere]',
        k.wash,
        k.edge,
        className,
      )}
    >
      <Icon icon={k.icon} className="relative top-0.5 self-start" />
      <span
        className="min-w-0 flex-1"
        role={how === 'alert' || how === 'status' ? how : undefined}
        aria-live={how === 'polite' ? 'polite' : undefined}
      >
        {children}
      </span>
      {actions && (
        <span
          role="group"
          aria-label={actionsLabel}
          className="flex flex-wrap items-baseline gap-x-4 gap-y-1"
        >
          {actions}
        </span>
      )}
    </div>
  );
}
