// Whether this page's editor holds edits the server has not confirmed. The editor says so here
// and the build pane beside it listens: a paper is built soon after its own author stops typing,
// without waiting for a poll to find out that somebody typed.
const listeners = new Set<(unsaved: boolean) => void>();

/** The editor: `true` at each change made here, `false` once the server has all of them. */
export function setTyping(unsaved: boolean) {
  for (const tell of listeners) tell(unsaved);
}
/** Be told. Returns how to stop. */
export function onTyping(tell: (unsaved: boolean) => void) {
  listeners.add(tell);
  return () => void listeners.delete(tell);
}
