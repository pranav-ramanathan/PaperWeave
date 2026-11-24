import type { Proposal } from '@paperweave/server';

/** The most plain proposals one press accepts. */
export const MOST_AT_ONCE = 50;

/**
 * Whether a proposal is plain: open, still where it was made, with nothing to check before it is
 * accepted, and written by a person. `revising` is the id of the proposal being changed now, if
 * any: someone part-way through changing it has not finished with it.
 */
export function plain(p: Proposal, revising: string | null = null): boolean {
  return (
    p.status === 'open' &&
    !p.stale &&
    !p.placeLost &&
    p.flags.length === 0 &&
    p.latex.length === 0 &&
    p.origin !== 'critique' &&
    p.id !== revising
  );
}
