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

export const LEAVE = (path: string) =>
  `What you typed in ${path} has not been saved yet. If you leave this page now it will be lost. Leave anyway?`;
