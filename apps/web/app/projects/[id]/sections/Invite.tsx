import type { listInvitations } from '@paperweave/server';
import Once from '../../../Once';
import Result from '../../../Result';
import { cancelInvitationAction, inviteAction } from '../../actions';
import { INVITABLE } from './roles';

type Pending = Awaited<ReturnType<typeof listInvitations>>;

const day = (iso: string) => iso.slice(0, 10);

/** Invitations sent and not yet taken up, each with a way to cancel. */
export function PendingInvitations({ id, pending }: { id: string; pending: Pending }) {
  return (
    <>
      {pending.length > 0 && (
        <section aria-labelledby="pending-heading">
          <h2 id="pending-heading">Invited, not yet joined</h2>
          <ul>
            {pending.map((i) =>
              // The text is cut into the same pieces as before the page was split into sections
              // (the HTML keeps a marker between pieces), so it is kept as written.
              // prettier-ignore
              <li key={i.id}>
                {i.email}, as {i.role === 'editor' ? 'an' : 'a'} {i.role}, until{' '}
                {day(i.expiresAt)}{' '}
                <form
                  action={cancelInvitationAction.bind(null, id, i.id, i.email)}
                  className="inline"
                >
                  <Once>Cancel the invitation to {i.email}</Once>
                </form>
              </li>,
            )}
          </ul>
        </section>
      )}
    </>
  );
}

/** The form for inviting someone. */
export function Invite({ id, invited }: { id: string; invited?: string }) {
  return (
    <>
      <h2 id="invite" tabIndex={-1}>
        Invite someone
      </h2>
      {invited && <Result>Invitation sent to {invited}.</Result>}
      <form action={inviteAction.bind(null, id)}>
        <label>
          Their email address
          <input type="email" name="email" required />
        </label>
        <label>
          Their role
          <select name="role" defaultValue="editor">
            {INVITABLE.map((r) => (
              <option key={r}>{r}</option>
            ))}
          </select>
        </label>
        <Once>Send invitation</Once>
      </form>
    </>
  );
}
