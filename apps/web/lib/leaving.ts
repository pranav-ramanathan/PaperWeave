/**
 * Whether opening another page would lose what has been typed here. The only copy of an edit the
 * sync service has not confirmed is in this tab, and a client-side navigation throws it away
 * without the browser's own "leave this page?" prompt.
 */

/** Typed this long ago, a connected tab has put the edit on the socket; any sooner is not at risk. */
const SETTLE_MS = 2000;

export function atRisk(s: { unsaved: boolean; connected: boolean; sinceChange: number }): boolean {
  return s.unsaved && (!s.connected || s.sinceChange > SETTLE_MS);
}

/** Whether a click on a link would take this tab to another page of the app. */
export function leavesPage(
  click: { button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean },
  link: { href: string; target: string; download: boolean },
  here: string,
): boolean {
  if (click.button !== 0 || click.metaKey || click.ctrlKey || click.shiftKey || click.altKey) {
    return false;
  }
  if ((link.target !== '' && link.target !== '_self') || link.download) return false;
  try {
    const from = new URL(here);
    const to = new URL(link.href, from);
    return (
      to.origin === from.origin && (to.pathname !== from.pathname || to.search !== from.search)
    );
  } catch {
    return false;
  }
}

/** Whether two addresses are one page of the app: the same but for what follows a `#`. */
export function samePage(a: string, b: string): boolean {
  const [x, y] = [new URL(a), new URL(b)];
  return x.origin === y.origin && x.pathname === y.pathname && x.search === y.search;
}

/**
 * Where the tab is: its address, what the router keeps with the history entry, and how far along
 * the tab's history the entry is, in a browser that says (the Navigation API).
 */
export function place(): { href: string; state: unknown; index: number | undefined } {
  const entries = (window as { navigation?: { currentEntry?: { index: number } | null } })
    .navigation;
  const index = entries?.currentEntry?.index;
  return {
    href: location.href,
    state: history.state,
    index: typeof index === 'number' && index >= 0 ? index : undefined,
  };
}

/** How many steps of the history lead from entry `now` back to entry `was`; 0 when not known. */
export function stepsBack(was: number | undefined, now: number | undefined): number {
  return was === undefined || now === undefined ? 0 : was - now;
}

/**
 * The name under which the page's first `popstate` listener (WENT in app/layout.tsx) looks for
 * whoever is to be asked before the router. One at a time: the open file's editor.
 */
export const WENT = '__paperweaveWent';
type Asked = (e: PopStateEvent) => void;

/** Ask `f` about Back and Forward before the router acts on them; `on` false stops asking it. */
export function wentTo(f: Asked, on = true): void {
  const w = window as unknown as Record<string, Asked | undefined>;
  if (on) w[WENT] = f;
  else if (w[WENT] === f) w[WENT] = undefined;
}

export const LEAVE = (path: string) =>
  `What you typed in ${path} has not been saved yet. If you leave this page now it will be lost. Leave anyway?`;
