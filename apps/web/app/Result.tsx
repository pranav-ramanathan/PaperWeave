'use client';
import { type ReactNode, useEffect, useRef } from 'react';
import { CircleCheck, Icon, TriangleAlert } from '../components/icon';
import { useKit } from '../components/kit';
import { cn } from '../lib/utils';

/**
 * What a form on the page said, taken from the address. It has the keyboard when it appears or
 * says something new, so the next Tab goes on from the form that was sent. Next leaves focus alone
 * on a navigation. Where the page has the kit it is drawn as a notice (components/notice.tsx): the words are
 * still the live region, and the one that has the keyboard.
 */
export default function Result(props: { children: ReactNode; alert?: boolean }) {
  const line = useRef<HTMLParagraphElement>(null);
  const last = useRef('');
  const next = useKit();
  useEffect(() => {
    const text = line.current?.textContent ?? '';
    if (text !== last.current) line.current?.focus();
    last.current = text;
  });
  return (
    <p
      role={props.alert ? 'alert' : 'status'}
      tabIndex={-1}
      ref={line}
      className={
        next
          ? cn(
              'rounded-md border border-l-4 px-3 py-2 text-foreground shadow-rest [overflow-wrap:anywhere]',
              props.alert ? 'border-l-finding-line bg-finding-wash' : 'border-l-ok-line bg-ok-wash',
            )
          : undefined
      }
    >
      {next && (
        <Icon
          icon={props.alert ? TriangleAlert : CircleCheck}
          className="mr-2 inline align-text-bottom"
        />
      )}
      {props.children}
    </p>
  );
}
