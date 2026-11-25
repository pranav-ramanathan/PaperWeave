'use client';

import * as React from 'react';
import { pageNonce } from '../../lib/nonce';

/*
 * Where dialogs and menus mount. Radix portals go to document.body unless told otherwise, which
 * is outside <main data-ui='next'> (so outside the tokens and the new look) and outside every
 * landmark. <OverlayRoot> wraps what a page shows and puts one empty element at the end of it;
 * the overlay components (dialog.tsx, dropdown-menu.tsx) read that element from here and portal
 * into it. Put it inside <main>.
 *
 * It also hands the page's number to the scroll lock. A modal dialog locks the page's scroll
 * with react-style-singleton, which adds a <style> element as it opens, and the page's content
 * policy (proxy.ts) refuses a <style> element that has not the page's number. That library
 * reads its number from get-nonce, which falls back to the global __webpack_nonce__ when
 * setNonce was not called. get-nonce is not a dependency of this app (only of Radix), so the
 * global is the way in that needs no new package. It is set at module scope on the client: the
 * module is evaluated before any dialog can open.
 */
if (typeof window !== 'undefined') {
  const nonce = pageNonce();
  if (nonce) (window as unknown as { __webpack_nonce__?: string }).__webpack_nonce__ = nonce;
}

const OverlayContainer = React.createContext<HTMLElement | null>(null);

/** The element overlays portal into; null until the page has mounted (Radix then waits). */
export const useOverlayContainer = () => React.useContext(OverlayContainer);

export function OverlayRoot({ children }: { children: React.ReactNode }) {
  const [container, setContainer] = React.useState<HTMLElement | null>(null);
  return (
    <OverlayContainer.Provider value={container}>
      {children}
      <div ref={setContainer} data-slot="overlay-root" />
    </OverlayContainer.Provider>
  );
}
