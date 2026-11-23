// Asking the server something again and again, but only while someone can see the answer.

/** What `work` gives back when there is no point asking again: the answer was "not found". */
export const STOP = 'stop';

/**
 * Whether an answer means the thing asked about is not this person's to see: they were taken
 * off the paper, or it is gone. A paper someone is not on answers "not found". Signed out is
 * not this: the page carries on once they sign in again, and so should the asking.
 */
export const notTheirs = (res: Response | null) => res?.status === 404;

/**
 * Do `work` now and again `ms` after it is done, while the page is showing, and at once when it
 * is shown again. A tab left open behind others asks the server for nothing: each open editor
 * would otherwise go on asking how the builds stand for as long as it was open. `ms` may be a
 * function, asked each time, for something that wants asking sooner when more is going on.
 * When `work` gives back `STOP`, it is not done again: a page left open by someone taken off
 * the paper would otherwise ask, and be told "not found", for as long as it stayed open.
 * Returns how to stop; its `now` does `work` at once (when shown) and counts `ms` from then.
 */
export function whileShown(
  work: () => unknown,
  ms: number | (() => number),
): (() => void) & { now: () => void } {
  let done = false;
  let running = false;
  // Asked for while `work` was under way: its answer may be from before the reason for asking.
  let again = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const off = () => {
    done = true;
    clearTimeout(timer);
    document.removeEventListener('visibilitychange', turn);
  };
  const next = () => {
    clearTimeout(timer);
    if (!done) timer = setTimeout(turn, typeof ms === 'number' ? ms : ms());
  };
  // Hidden, it does not ask again until it is shown: the visibility change starts it up.
  function turn() {
    if (done || running || document.hidden) return;
    running = true;
    clearTimeout(timer);
    void Promise.resolve()
      .then(work)
      .then(
        (said) => (said === STOP ? off() : undefined),
        () => undefined,
      )
      .finally(() => {
        running = false;
        if (again) {
          again = false;
          turn();
        } else next();
      });
  }
  document.addEventListener('visibilitychange', turn);
  turn();
  // Do it now, and count the wait from here: once more after the one under way, if one is.
  const now = () => {
    if (running) again = true;
    else turn();
  };
  return Object.assign(off, { now });
}
