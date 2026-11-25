'use client';
import type { LucideIcon } from 'lucide-react';
import { type KeyboardEvent, type ReactNode, useLayoutEffect, useRef } from 'react';
import { Icon } from '../../../../../components/icon';
import { useLook } from '../../../../../components/look';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '../../../../../components/ui/tooltip';

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
  const look = useLook();
  const row = (
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
  // Tooltips (the new look's icon buttons) share one provider; it draws nothing itself.
  return look === 'next' ? <TooltipProvider>{row}</TooltipProvider> : row;
}

/**
 * One button of the toolbar. In the old look it is the text button it always was. In the new look
 * it is an icon button: the same words stay in it as hidden text (so the accessible name is
 * unchanged), and a tooltip says the name and the shortcut on hover and on keyboard focus.
 * `shortcut` is what the old look shows as the button's title (for example "Ctrl+B").
 */
export function Tool(props: {
  name: string;
  icon: LucideIcon;
  onClick: () => void;
  keys?: string;
  shortcut?: string;
}) {
  const look = useLook();
  if (look !== 'next') {
    return (
      <button
        type="button"
        onClick={props.onClick}
        aria-keyshortcuts={props.keys}
        title={props.shortcut}
      >
        {props.name}
      </button>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" onClick={props.onClick} aria-keyshortcuts={props.keys}>
          <Icon icon={props.icon} />
          <span className="sr-only">{props.name}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent>
        {props.name}
        {props.shortcut && <kbd>{props.shortcut}</kbd>}
      </TooltipContent>
    </Tooltip>
  );
}
