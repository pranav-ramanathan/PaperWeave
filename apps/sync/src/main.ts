import { blobStore, connect, onlyOne } from '@paperweave/server';
import { startSync } from './server.ts';

const need = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
};

// One sync server to a database, and no more. Each keeps the files people have open in its own
// memory: what is typed through one would be saved, and never reach the people on another. A
// second one waits here until the first has stopped, which is also how one takes over from
// another when a new version is put in its place.
await onlyOne(
  need('DATABASE_URL'),
  'sync-server',
  () => {
    console.error('another sync server has taken over this database: stopping');
    process.exit(1);
  },
  () => console.log('another sync server is serving this database: waiting for it to stop'),
);

const sync = await startSync({
  pool: connect(),
  store: blobStore(),
  secret: need('BETTER_AUTH_SECRET'),
  port: Number(process.env.SYNC_PORT ?? 4100),
  databaseUrl: need('DATABASE_URL'),
  compactEvery: Number(process.env.SYNC_COMPACT_EVERY ?? 500),
  metricsToken: process.env.METRICS_TOKEN,
});
console.log(`sync server listening on ${sync.port}`);
