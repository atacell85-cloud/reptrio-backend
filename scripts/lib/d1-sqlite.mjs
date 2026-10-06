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
  const check = sql => { if (failOn && failOn.test(sql)) throw new Error(`D1_INJECTED_FAILURE: ${sql}`); };
  const statement = (sql, values = []) => ({
    sql,
    values,
    bind: (...next) => statement(sql, next),
    async first() { check(sql); return sqlite.prepare(sql).get(...values) ?? null; },
    async all() { check(sql); return { results: sqlite.prepare(sql).all(...values), success: true }; },
    async run() { check(sql); const info = sqlite.prepare(sql).run(...values); return { success: true, meta: { changes: Number(info.changes) } }; },
  });
  return {
    prepare: sql => statement(sql),
    async batch(statements) {
      sqlite.exec('BEGIN');
      try {
        const results = [];
        for (const item of statements) { check(item.sql); const info = sqlite.prepare(item.sql).run(...item.values); results.push({ success: true, meta: { changes: Number(info.changes) } }); }
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
  };
}

export function migrationFiles() {
  return readdirSync(new URL('../../migrations/', import.meta.url)).filter(file => file.endsWith('.sql')).sort();
}
