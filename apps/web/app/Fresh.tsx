'use client';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
// Reads the page's number before any refresh can change it, on every page: otherwise only the editors import it.
import '../lib/nonce';

/** A page come back to with Back or Forward is asked for again: it may be minutes old. */
export default function Fresh() {
  const router = useRouter();
  useEffect(() => {
    // Not on a file's editor page, which keeps words not yet saved and is told of changes by
    // the sync server; and not with no connection (this covers the network interface only), when
    // a refresh that fails makes the browser load the page afresh, which would lose them too.
    const ask = () => {
      if (navigator.onLine && !/\/files\/[^/]+$/.test(location.pathname)) router.refresh();
    };
    // After the router has put the kept page back.
    const again = () => setTimeout(ask);
    const shown = (e: PageTransitionEvent) => {
      if (e.persisted) ask();
    };
    window.addEventListener('popstate', again);
    window.addEventListener('pageshow', shown);
    return () => {
      window.removeEventListener('popstate', again);
      window.removeEventListener('pageshow', shown);
    };
  }, [router]);
  return null;
}
