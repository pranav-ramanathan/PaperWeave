'use client';
// Whether the page around a component has the app's kit (components/ui: buttons, notices) draw
// the few components that can also be plain elements: a submit button, a notice, a file field.
// The paper's page (app/projects/[id]/page.tsx) keeps these plain and styles them from its own
// style sheet (app/next/paper.css), so it does not provide the kit; the other pages do, once,
// near their root. Everything else is only paint, done by the style sheets, not here.
import { createContext, type ReactNode, useContext } from 'react';

// Plain when there is no provider.
const Context = createContext(false);

/** Say that the components below are drawn in the kit. */
export function KitProvider(props: { children: ReactNode }) {
  return <Context.Provider value={true}>{props.children}</Context.Provider>;
}

/** Whether the page this component is on has it drawn in the kit. */
export function useKit(): boolean {
  return useContext(Context);
}
