// Who is waiting for the server. A form with a server action and a link to another page each
// hold the page "waiting" from the press until the answer has been drawn; the line at the foot
// of the page (app/Waiting.tsx) reads how long that has been.
let count = 0;
let since = 0;
const listeners = new Set<() => void>();

function tell() {
  for (const t of listeners) t();
}

/** Start waiting. Returns the function that stops it; calling that twice does no harm. */
export function waiting(): () => void {
  if (count++ === 0) since = Date.now();
  tell();
  let done = false;
  return () => {
    if (done) return;
    done = true;
    if (--count === 0) since = 0;
    tell();
  };
}
/** When the page began waiting, or 0 if it is not. */
export const waitingSince = () => since;
/** Call `tell` whenever waiting starts or stops. Returns the function that stops it. */
export function onWaiting(tell: () => void) {
  listeners.add(tell);
  return () => void listeners.delete(tell);
}
