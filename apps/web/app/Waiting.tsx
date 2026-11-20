'use client';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { onWaiting, waitingSince } from '../lib/waiting';

const SECOND = 1000;
const LONG = 8 * SECOND; // as the editor's "No answer yet"

/**
 * Says that the page is waiting for the server: after a second, that it is working; after eight,
 * that there is no answer yet. Not role="status": the pages already have one, and a second would
 * be found by every strict lookup of it.
 */
export default function Waiting() {
  const since = useSyncExternalStore(onWaiting, waitingSince, () => 0);
  const [stage, setStage] = useState(0);
  useEffect(() => {
    setStage(0);
    if (!since) return;
    const a = setTimeout(() => setStage(1), SECOND);
    const b = setTimeout(() => setStage(2), LONG);
    return () => {
      clearTimeout(a);
      clearTimeout(b);
    };
  }, [since]);
  return (
    <p id="waiting" className="waiting" aria-live="polite" aria-atomic="true">
      {stage === 1 && 'Working…'}
      {stage === 2 &&
        'No answer from the server yet. Still waiting: there is no need to press again.'}
    </p>
  );
}
