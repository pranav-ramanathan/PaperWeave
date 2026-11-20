import { connect } from './db.ts';
import { migrate } from './migrate.ts';

const pool = connect(undefined, process.env, 0);
const applied = await migrate(pool);
console.log(applied.length ? `applied ${applied.join(', ')}` : 'database is up to date');
await pool.end();
