// Asking the server something again and again, but only while someone can see the answer.

/**
 * Do `work` now and every `ms` after, while the page is showing, and at once when it is shown
 * again. A tab left open behind others asks the server for nothing: each open editor would
 * otherwise go on asking how the builds stand every two seconds for as long as it was open.
 * Returns how to stop.
 */
export function whileShown(work: () => void, ms: number): () => void {
  const turn = () => {
    if (!document.hidden) work();
  };
  turn();
  const timer = setInterval(turn, ms);
  document.addEventListener('visibilitychange', turn);
  return () => {
    clearInterval(timer);
    document.removeEventListener('visibilitychange', turn);
  };
}
