'use client';
import { type ReactNode, useEffect, useRef } from 'react';

/**
 * What a form on the page said, taken from the address. It has the keyboard when it appears or
 * says something new, so the next Tab goes on from the form that was sent. Next leaves focus alone
 * on a navigation.
 */
export default function Result(props: { children: ReactNode; alert?: boolean }) {
  const line = useRef<HTMLParagraphElement>(null);
  const last = useRef('');
  useEffect(() => {
    const text = line.current?.textContent ?? '';
    if (text !== last.current) line.current?.focus();
    last.current = text;
  });
  return (
    <p role={props.alert ? 'alert' : 'status'} tabIndex={-1} ref={line}>
      {props.children}
    </p>
  );
}
