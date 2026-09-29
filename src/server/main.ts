import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { getDb } from '../db.js';
import { startLocalServer } from './app.js';

const dbPath = process.env.LIFETABLE_DB
  ? resolve(process.env.LIFETABLE_DB)
  : resolve('data/lifetable.sqlite');

const db = getDb(dbPath);
const { port } = await startLocalServer({ db, clock: () => new Date() });
mkdirSync('data', { recursive: true });
writeFileSync('data/server.port', String(port), 'utf8');

console.log(JSON.stringify({ status: 'listening', host: '127.0.0.1', port, db: dbPath }));

const shutdown = (): void => {
  db.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
