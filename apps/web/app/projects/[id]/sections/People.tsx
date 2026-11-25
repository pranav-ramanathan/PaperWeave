import type { listMembers } from '@paperweave/server';
import Once from '../../../Once';
import { Wide } from '../../../Wide';
import Link from '../../../Go';
import Result from '../../../Result';
import { removeAction, roleAction } from '../../actions';
import { INVITABLE } from './roles';

type Members = Awaited<ReturnType<typeof listMembers>>;

/** The people on the paper: their roles, changing a role, leaving or removing. */
export function People({
  id,
  userId,
  members,
  owner,
  saved,
  cancelled,
  removed,
  newOwner,
}: {
  id: string;
  /** Who is reading the page. */
  userId: string;
  members: Members;
  owner: boolean;
  /** The `saved` parameter: set after a role was changed. */
  saved?: string;
  cancelled?: string;
  removed?: string;
  /** The `owner` parameter: the new owner after a hand-over. */
  newOwner?: string;
}) {
  return (
    <>
      <h2 id="people" tabIndex={-1}>
        People
      </h2>
      {saved && <Result>Role changed.</Result>}
      {cancelled && <Result>Invitation to {cancelled} cancelled.</Result>}
      {removed && <Result>Removed {removed} from this paper.</Result>}
      {newOwner && <Result>{newOwner} is now the owner of this paper. You are an editor.</Result>}
      <Wide label="Table of people">
        <table>
          <thead>
            <tr>
              <th scope="col">Email</th>
              <th scope="col">Role</th>
              <th scope="col">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.userId}>
                <th scope="row">{m.email}</th>
                <td>
                  {owner && m.role !== 'owner' ? (
                    <form action={roleAction.bind(null, id, m.userId)} className="inline">
                      <select name="role" defaultValue={m.role} aria-label={`Role of ${m.email}`}>
                        {INVITABLE.map((r) => (
                          <option key={r}>{r}</option>
                        ))}
                      </select>
                      <Once type="submit">Change</Once>
                    </form>
                  ) : (
                    m.role
                  )}
                </td>
                <td className="actions">
                  {m.role !== 'owner' && (owner || m.userId === userId) && (
                    <form action={removeAction.bind(null, id, m.userId)} className="inline">
                      <Once
                        aria-label={m.userId === userId ? 'Leave this paper' : `Remove ${m.email}`}
                      >
                        {m.userId === userId ? 'Leave' : 'Remove'}
                      </Once>
                    </form>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Wide>
    </>
  );
}

/** The owner's link to hand the paper to someone else. */
export function HandOver({ id }: { id: string }) {
  return (
    <p>
      <Link prefetch={false} href={`/projects/${id}/owner`}>
        Hand this paper to someone else…
      </Link>
    </p>
  );
}
