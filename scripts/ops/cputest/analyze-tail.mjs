// Summarises `wrangler tail a2-workout-cputest --format json > .tmp-cputest/tail.jsonl` per trigger (cpuTime, outcome).
// Usage: node scripts/ops/cputest/analyze-tail.mjs [.tmp-cputest/tail.jsonl] [rows]
import { readFileSync } from 'node:fs';
const text = readFileSync(process.argv[2] && process.argv[2] !== 'rows' ? process.argv[2] : '.tmp-cputest/tail.jsonl', 'utf8');
// wrangler tail --format json prints pretty JSON objects back to back.
const events = []; let depth = 0, start = -1, inStr = false, esc = false;
for (let i = 0; i < text.length; i++) { const c = text[i];
  if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
  if (c === '"') inStr = true; else if (c === '{') { if (!depth++) start = i; } else if (c === '}') { if (!--depth) events.push(JSON.parse(text.slice(start, i + 1))); } }
const ALIAS = { '*/5 * * * *': 'maintenance', '*/10 * * * *': 'digest', '* * * * *': 'purge' };
const rows = events.filter(e => e.event?.cron && e.scriptName === 'a2-workout-cputest').map(e => {
  const logs = e.logs.flatMap(l => l.message).map(m => { try { return JSON.parse(m); } catch { return { raw: String(m).slice(0, 80) }; } });
  return { at: new Date(e.eventTimestamp).toISOString().slice(11, 19), trigger: ALIAS[e.event.cron], cpu: e.cpuTime, wall: e.wallTime, outcome: e.outcome, ver: e.scriptVersion?.id?.slice(0, 8), log: logs.map(l => [l.event, l.code || l.step || l.count || ''].filter(Boolean).join(':')).join(' '), exc: e.exceptions.map(x => x.message).join(';') };
});
if (process.argv.includes('rows')) for (const r of rows) console.log(JSON.stringify(r));
const by = {};
for (const r of rows) (by[r.trigger] ||= []).push(r);
for (const [t, rs] of Object.entries(by)) { const c = rs.map(r => r.cpu).sort((a, b) => a - b);
  console.log(t, JSON.stringify({ n: rs.length, cpuMin: c[0], cpuMedian: c[Math.floor(c.length / 2)], cpuMax: c.at(-1), outcomes: [...new Set(rs.map(r => r.outcome))], exceededCpu: rs.filter(r => r.outcome === 'exceededCpu').length })); }
console.log('non-cron events:', events.filter(e => !e.event?.cron).length);
