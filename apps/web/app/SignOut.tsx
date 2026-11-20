'use client';

export default function SignOut({ next }: { next?: string }) {
  return (
    <button
      type="button"
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
