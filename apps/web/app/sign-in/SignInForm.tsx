'use client';

import { useState } from 'react';

export default function SignInForm({ next }: { next: string }) {
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'failed'>('idle');
  const [email, setEmail] = useState('');

  if (state === 'sent')
    return (
      <p role="status">
        Check <strong>{email}</strong> for a sign-in link. It works once and expires in 15 minutes.
      </p>
    );
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setState('sending');
        const res = await fetch('/api/auth/sign-in/magic-link', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email, callbackURL: next }),
        }).catch(() => null);
        setState(res?.ok ? 'sent' : 'failed');
      }}
    >
      <label>
        Email address
        <input
          type="email"
          name="email"
          required
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </label>
      <button type="submit" disabled={state === 'sending'}>
        {state === 'sending' ? 'Sending…' : 'Email me a sign-in link'}
      </button>
      {state === 'failed' && (
        <p role="alert">The link could not be sent. Check the address and try again in a minute.</p>
      )}
    </form>
  );
}
