'use client';
import NextLink, { useLinkStatus } from 'next/link';
import { type ComponentProps, useEffect } from 'react';
import { waiting } from '../lib/waiting';

// Inside a Link: is the page it leads to still on its way?
function Told() {
  const { pending } = useLinkStatus();
  useEffect(() => {
    if (pending) return waiting();
  }, [pending]);
  return null;
}

/** A link to another page of the app, which says (see Waiting.tsx) when the page is slow to come. */
export default function Link({ children, ...props }: ComponentProps<typeof NextLink>) {
  return (
    <NextLink prefetch={false} {...props}>
      {children}
      <Told />
    </NextLink>
  );
}
