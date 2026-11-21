'use client';
import { type KeyboardEvent, type ReactNode, useLayoutEffect, useRef } from 'react';

/**
 * A row of buttons that is one Tab stop (the WAI-ARIA toolbar pattern): Left and Right move
 * along it and go round at the ends, Home and End go to its ends, and Tab comes back to the
 * button that was left.
 */
export default function Toolbar(props: { label: string; children: ReactNode }) {
  const bar = useRef<HTMLDivElement>(null);
  const stop = useRef<HTMLButtonElement | null>(null);
  const buttons = () => [
    ...(bar.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []),
  ];
  /** Exactly one button is a Tab stop: the last one used, or the first if that one has gone. */
  const settle = (now?: HTMLButtonElement) => {
    const all = buttons();
    if (now) stop.current = now;
    if (!stop.current || !all.includes(stop.current)) stop.current = all[0] ?? null;
    for (const b of all) b.tabIndex = b === stop.current ? 0 : -1;
  };
  // After every draw: buttons come and go with the view and with what the person may do.
  useLayoutEffect(() => settle());
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const all = buttons();
    const at = all.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    const to = {
      ArrowRight: (at + 1) % all.length,
      ArrowLeft: (at - 1 + all.length) % all.length,
      Home: 0,
      End: all.length - 1,
    }[e.key];
    if (to === undefined) return;
    e.preventDefault(); // or the page scrolls
    all[to].focus(); // the focus handler makes it the stop
  };
  return (
    <div
      className="toolbar"
      role="toolbar"
      aria-label={props.label}
      ref={bar}
      onKeyDown={onKeyDown}
      onFocus={(e) => e.target instanceof HTMLButtonElement && settle(e.target)}
    >
      {props.children}
    </div>
  );
}
