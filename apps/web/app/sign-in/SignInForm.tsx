'use client';

import { useState } from 'react';

export default function SignInForm({ next }: { next: string }) {
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'refused' | 'unsent'>('idle');
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
          // A link that is used again, or has expired, comes back to this page with a message.
          body: JSON.stringify({
            email,
            callbackURL: next,
            errorCallbackURL: `/sign-in?next=${encodeURIComponent(next)}`,
          }),
          // Above the server's own limit, so that normally its answer comes first.
          signal: AbortSignal.timeout(40_000),
        }).catch(() => null);
        // A refusal (too many links to one address, or not an address) says so with a 4xx. The mail
        // service not answering is the server's fault, and is said to be.
        setState(res?.ok ? 'sent' : res && res.status < 500 ? 'refused' : 'unsent');
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
      {state === 'unsent' && (
        <p role="alert">
          The link could not be sent: the email service did not answer. Try again in a few minutes.
        </p>
      )}
      {state === 'refused' && (
        <p role="alert">
          The link could not be sent. Check the address and try again in a minute. Only so many
          links are sent to one address in an hour: if you have asked several times, use the newest
          one you were sent, or wait.
        </p>
      )}
    </form>
  );
}
