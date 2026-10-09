import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

// Minimal Cloudflare D1 binding over Node's built-in SQLite, with the repository migrations applied, for tests that
// must exercise real SQL (constraints, foreign keys, atomic batches). `failOn` makes any statement whose SQL matches
// the pattern throw, to test partial failures. D1 runs a batch as one transaction; so does this adapter. D1 enforces
// foreign keys; `foreignKeys: false` turns them off to prove explicit deletes do not rely on ON DELETE CASCADE.
export function createD1(options = {}) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`PRAGMA foreign_keys = ${options.foreignKeys === false ? 'OFF' : 'ON'};`);
  const migrations = migrationFiles();
  const upTo = options.migrationsUpTo ? migrations.filter(file => file <= options.migrationsUpTo) : migrations;
  for (const file of upTo) sqlite.exec(readFileSync(new URL(`../../migrations/${file}`, import.meta.url), 'utf8'));
  let failOn = options.failOn || null;
  let beforeBatch = null;
  const metrics = { queries: 0, writes: 0, batches: 0, maxParams: 0, maxSqlBytes: 0, maxBoundBytes: 0 };
  const measure = (sql, values, write = false) => {
    const sqlBytes = Buffer.byteLength(sql);
    const boundBytes = Math.max(0, ...values.filter(value => typeof value === 'string').map(value => Buffer.byteLength(value)));
    if (values.length > 100 || sqlBytes > 100_000 || boundBytes > 2_000_000) throw new Error('D1_LIMIT_EXCEEDED');
    metrics.queries++; if (write) metrics.writes++;
    metrics.maxParams = Math.max(metrics.maxParams, values.length);
    metrics.maxSqlBytes = Math.max(metrics.maxSqlBytes, sqlBytes);
    metrics.maxBoundBytes = Math.max(metrics.maxBoundBytes, boundBytes);
  };
  const check = sql => { if (failOn && failOn.test(sql)) throw new Error(`D1_INJECTED_FAILURE: ${sql}`); };
  const statement = (sql, values = []) => ({
    sql,
    values,
    bind: (...next) => statement(sql, next),
    async first() { measure(sql, values); check(sql); return sqlite.prepare(sql).get(...values) ?? null; },
    async all() { measure(sql, values); check(sql); return { results: sqlite.prepare(sql).all(...values), success: true }; },
    async run() { measure(sql, values, true); check(sql); const info = sqlite.prepare(sql).run(...values); return { success: true, meta: { changes: Number(info.changes) } }; },
  });
  return {
    prepare: sql => statement(sql),
    async batch(statements) {
      if (beforeBatch) await beforeBatch(statements);
      metrics.batches++;
      sqlite.exec('BEGIN');
      try {
        const results = [];
        for (const item of statements) { measure(item.sql, item.values, true); check(item.sql); const info = sqlite.prepare(item.sql).run(...item.values); results.push({ success: true, meta: { changes: Number(info.changes) } }); }
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
    // Test helpers (not part of D1).
    raw: sqlite,
    exec: sql => sqlite.exec(sql),
    rows: (sql, ...values) => sqlite.prepare(sql).all(...values),
    setFailOn: pattern => { failOn = pattern; },
    setBeforeBatch: callback => { beforeBatch = callback; },
    metrics,
    resetMetrics: () => { for (const key of Object.keys(metrics)) metrics[key] = 0; },
  };
}

export function migrationFiles() {
  return readdirSync(new URL('../../migrations/', import.meta.url)).filter(file => file.endsWith('.sql')).sort();
}
