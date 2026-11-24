// What the list of papers says about review that is waiting in one of them.

const some = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * "2 proposed changes waiting, 1 open thread", or nothing when nothing waits. Proposed changes
 * come first, as on the paper's own page: they are what someone is waiting to have decided.
 */
export function reviewWaiting(paper: { threads: number; proposals: number }): string {
  const said: string[] = [];
  if (paper.proposals > 0)
    said.push(`${some(paper.proposals, 'proposed change', 'proposed changes')} waiting`);
  if (paper.threads > 0) said.push(some(paper.threads, 'open thread', 'open threads'));
  return said.join(', ');
}
