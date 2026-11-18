import { connect, migrate } from './db.ts';

const pool = connect();
const applied = await migrate(pool);
console.log(applied.length ? `applied ${applied.join(', ')}` : 'database is up to date');
await pool.end();
