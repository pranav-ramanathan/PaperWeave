'use client';
// Which look the page around a component is drawn in, for the few components whose DOM must
// differ between the two (a dialog, the editor's grid wrappers): they read it here and render one
// branch or the other. Everything that is only paint is done by the style sheets, not here.
// PLAN.md section 8. Every branch that reads this is listed in the pull request that adds it and
// deleted in the one that removes the old look.
import { createContext, type ReactNode, useContext } from 'react';

export type Look = 'classic' | 'next';

// "classic" when there is no provider: a component used outside a migrated page is old-look.
const Context = createContext<Look>('classic');

/** Say which look the page is in. A page passes what `ui()` (lib/ui.ts) told it, once, near its root. */
export function LookProvider(props: { look: Look; children: ReactNode }) {
  return <Context.Provider value={props.look}>{props.children}</Context.Provider>;
}

/** The look of the page this component is on. */
export function useLook(): Look {
  return useContext(Context);
}
