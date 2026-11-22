'use client';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

/**
 * Asks for the page again every two seconds while it is shown. A <meta http-equiv="refresh">
 * does that by loading the document anew, which starts a screen reader from the top and drops
 * the keyboard's place; router.refresh keeps both. The server stops drawing this when the wait
 * is over.
 */
export default function Again() {
  const router = useRouter();
  useEffect(() => {
    // Not with no connection: a refresh that fails makes the browser load the page afresh.
    const id = setInterval(() => {
      if (navigator.onLine) router.refresh();
    }, 2000);
    return () => clearInterval(id);
  }, [router]);
  return null;
}
