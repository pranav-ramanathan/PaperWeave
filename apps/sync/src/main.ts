import { blobStore, connect } from '@paperweave/server';
import { startSync } from './server.ts';

const need = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
};

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
