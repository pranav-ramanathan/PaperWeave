'use client';
import { type ButtonHTMLAttributes, useEffect, useRef } from 'react';
import { useFormStatus } from 'react-dom';
import { waiting } from '../lib/waiting';

/**
 * A submit button whose form is sent once per press. A second submit while the first is on
 * its way is dropped: at once (a ref), since state would only be seen after the next draw.
 */
export default function Once(props: ButtonHTMLAttributes<HTMLButtonElement>) {
  const { pending } = useFormStatus();
  const going = useRef(false);
  const button = useRef<HTMLButtonElement>(null);
  // A form with a server action: free again when the action has answered, which is also when
  // it comes back to this page with an error.
  useEffect(() => {
    if (!pending) going.current = false;
  }, [pending]);
  // The page says so if the answer is slow.
  useEffect(() => {
    if (pending) return waiting();
  }, [pending]);
  useEffect(() => {
    const form = button.current?.form;
    if (!form) return;
    const sent = (e: Event) => {
      if (going.current) {
        e.preventDefault(); // a form posted to a route is not posted again
        e.stopPropagation(); // and a server action never hears of it
      } else going.current = true;
    };
    // A form posted to a route leaves the page. Coming back to it shows it as it was left.
    const back = () => {
      going.current = false;
    };
    form.addEventListener('submit', sent);
    window.addEventListener('pageshow', back);
    return () => {
      form.removeEventListener('submit', sent);
      window.removeEventListener('pageshow', back);
    };
  }, []);
  return <button type="submit" {...props} ref={button} aria-disabled={pending || undefined} />;
}
