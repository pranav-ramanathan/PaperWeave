'use client';

import { useLook } from '../components/look';
import { buttonVariants } from '../components/ui/button';
import { cn } from '../lib/utils';

export default function SignOut({
  next,
  variant = 'outline',
}: {
  next?: string;
  /** In the new look: a button with an edge (on a page's sheet), or quiet (in the app bar). */
  variant?: 'outline' | 'ghost';
}) {
  const nextLook = useLook() === 'next';
  return (
    <button
      type="button"
      className={
        nextLook
          ? cn(buttonVariants({ variant }), variant === 'outline' && 'border-input')
          : undefined
      }
      onClick={async () => {
        await fetch('/api/auth/sign-out', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        });
        window.location.href = next ? `/sign-in?next=${encodeURIComponent(next)}` : '/sign-in';
      }}
    >
      Sign out
    </button>
  );
}
