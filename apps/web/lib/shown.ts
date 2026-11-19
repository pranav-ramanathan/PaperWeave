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
 * Do `work` now and every `ms` after, while the page is showing, and at once when it is shown
 * again. A tab left open behind others asks the server for nothing: each open editor would
 * otherwise go on asking how the builds stand every two seconds for as long as it was open.
 * When `work` gives back `STOP`, it is not done again: a page left open by someone taken off
 * the paper would otherwise ask, and be told "not found", for as long as it stayed open.
 * Returns how to stop.
 */
export function whileShown(work: () => unknown, ms: number): () => void {
  let done = false;
  const off = () => {
    done = true;
    clearInterval(timer);
    document.removeEventListener('visibilitychange', turn);
  };
  const turn = () => {
    if (done || document.hidden) return;
    void Promise.resolve(work()).then((said) => said === STOP && off());
  };
  const timer = setInterval(turn, ms);
  document.addEventListener('visibilitychange', turn);
  turn();
  return off;
}
