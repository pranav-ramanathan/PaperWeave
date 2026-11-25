'use client';

import { useEffect, useState } from 'react';
import { useLook } from '../../components/look';
import { Notice } from '../../components/notice';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';

export default function SignInForm({ next }: { next: string }) {
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'refused' | 'unsent'>('idle');
  // What the server said when it refused for want of room (429): said as it was said.
  const [why, setWhy] = useState('');
  const [email, setEmail] = useState('');
  // Before the page's script has started the form would be sent as a plain GET, and nothing
  // would read the field: the button waits for the script.
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  // The new look draws the same words in the components of components/ui; the classic markup is
  // left exactly as it was.
  const fresh = useLook() === 'next';

  const words = (
    <>
      Check <strong>{email}</strong> for a sign-in link: it leads to a page where you press
      &ldquo;Sign in&rdquo;. It works once and expires in 15 minutes.
    </>
  );
  if (state === 'sent')
    return fresh ? <Notice kind="success">{words}</Notice> : <p role="status">{words}</p>;
  const unsent =
    'The link could not be sent: the email service did not answer. Try again in a few minutes.';
  const refused = why || 'The link could not be sent. Check the address and try again in a minute.';
  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    // The field itself, not state: text typed or filled before the script started is in it.
    const address = String(new FormData(e.currentTarget).get('email') ?? '');
    setEmail(address);
    setState('sending');
    const res = await fetch('/api/auth/sign-in/magic-link', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // A link that is used again, or has expired, comes back to this page with a message.
      body: JSON.stringify({
        email: address,
        callbackURL: next,
        errorCallbackURL: `/sign-in?next=${encodeURIComponent(next)}`,
      }),
      // Above the server's own limit, so that normally its answer comes first.
      signal: AbortSignal.timeout(40_000),
    }).catch(() => null);
    // A refusal (too many links to one address, or not an address) says so with a 4xx. The mail
    // service not answering is the server's fault, and is said to be.
    setWhy(
      res?.status === 429
        ? String(((await res.json().catch(() => null)) as { message?: unknown })?.message ?? '')
        : '',
    );
    setState(res?.ok ? 'sent' : res && res.status < 500 ? 'refused' : 'unsent');
  };
  if (fresh)
    return (
      <form onSubmit={submit} className="grid gap-4">
        <div className="grid gap-1.5">
          <Label htmlFor="email">Email address</Label>
          <Input id="email" type="email" name="email" required autoComplete="email" />
        </div>
        <Button type="submit" disabled={!ready || state === 'sending'}>
          {state === 'sending' ? 'Sending…' : 'Email me a sign-in link'}
        </Button>
        {state === 'unsent' && <Notice kind="error">{unsent}</Notice>}
        {state === 'refused' && <Notice kind="error">{refused}</Notice>}
      </form>
    );
  return (
    <form onSubmit={submit}>
      <label>
        Email address
        <input type="email" name="email" required autoComplete="email" />
      </label>
      <button type="submit" disabled={!ready || state === 'sending'}>
        {state === 'sending' ? 'Sending…' : 'Email me a sign-in link'}
      </button>
      {state === 'unsent' && <p role="alert">{unsent}</p>}
      {state === 'refused' && <p role="alert">{refused}</p>}
    </form>
  );
}
