'use client';

export default function SignOut() {
  return (
    <button
      type="button"
      onClick={async () => {
        await fetch('/api/auth/sign-out', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        });
        window.location.href = '/sign-in';
      }}
    >
      Sign out
    </button>
  );
}
