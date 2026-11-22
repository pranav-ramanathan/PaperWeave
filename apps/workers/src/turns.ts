// Which kind of job the worker does next. Builds and chart drawings take turns, so that a
// queue of builds does not keep a chart waiting, nor the other way round.
export function takeTurns(
  build: () => Promise<boolean>,
  draw: () => Promise<boolean>,
): () => Promise<boolean> {
  let last: 'build' | 'draw' = 'draw';
  return async () => {
    const order =
      last === 'build'
        ? ([
            ['draw', draw],
            ['build', build],
          ] as const)
        : ([
            ['build', build],
            ['draw', draw],
          ] as const);
    for (const [kind, job] of order)
      if (await job()) {
        last = kind;
        return true;
      }
    return false;
  };
}
