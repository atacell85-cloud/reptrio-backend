// Build 44 release safety: daily operational digest for account deletion and AI upstream reconciliation.
// Runs from its own daily trigger (OPS_DIGEST_CRON) so it never shares the purge or maintenance query budget. Reports counts and opaque work ids only: no emails, user ids or document content.
import { sendTransactionalEmail } from './transactional-email.js';

export const OPS_DIGEST_CRON = '0 6 * * *';
const HOUR = 3600000;
// One owner purge per minute is at most 1440/day; a larger due backlog cannot clear within a day.
const DAILY_PURGE_CAPACITY = 1440;

export async function collectOperationalFindings(env, now = Date.now()) {
  const iso = new Date(now).toISOString(), overdueBefore = new Date(now - HOUR).toISOString(), stuckBefore = new Date(now - 15 * 60000).toISOString();
  const purge = await env.DB.prepare(`SELECT
    SUM(CASE WHEN purge_at<=? THEN 1 ELSE 0 END) AS due,
    SUM(CASE WHEN purge_at<=? THEN 1 ELSE 0 END) AS overdue,
    MIN(CASE WHEN purge_at<=? THEN purge_at END) AS oldest_overdue,
    GROUP_CONCAT(DISTINCT purge_error) AS errors
    FROM users WHERE account_status IN ('PENDING_DELETION','PURGING') AND deleted_at IS NULL`).bind(iso, overdueBefore, overdueBefore).first();
  const open = `state='UNKNOWN' OR (state='RUNNING' AND created_at<=?) OR (state='RETURNED' AND last_error IS NOT NULL AND last_error NOT LIKE 'OPERATOR_FOUND:%')`;
  // Exact counts per state; at most 50 opaque ids are listed per alert.
  const totals = Object.fromEntries(((await env.DB.prepare(`SELECT state,COUNT(*) AS n FROM account_lifecycle_work WHERE ${open} GROUP BY state`).bind(stuckBefore).all()).results || []).map(row => [row.state, Number(row.n)]));
  const work = (await env.DB.prepare(`SELECT id,state,created_at,last_error FROM account_lifecycle_work WHERE ${open} ORDER BY created_at LIMIT 50`).bind(stuckBefore).all()).results || [];
  const findings = [];
  if (Number(purge?.overdue) > 0) findings.push({ code: 'ACCOUNT_PURGE_OVERDUE', count: Number(purge.overdue), oldest: purge.oldest_overdue, errors: String(purge.errors || '').split(',').filter(Boolean) });
  if (Number(purge?.due) > DAILY_PURGE_CAPACITY) findings.push({ code: 'ACCOUNT_PURGE_CAPACITY', count: Number(purge.due), capacityPerDay: DAILY_PURGE_CAPACITY });
  const byState = state => work.filter(row => row.state === state);
  if (totals.UNKNOWN) findings.push({ code: 'AI_WORK_UNKNOWN', count: totals.UNKNOWN, workIds: byState('UNKNOWN').map(row => row.id), oldest: byState('UNKNOWN')[0]?.created_at ?? null });
  if (totals.RUNNING) findings.push({ code: 'AI_WORK_STUCK_RUNNING', count: totals.RUNNING, workIds: byState('RUNNING').map(row => row.id) });
  if (totals.RETURNED) findings.push({ code: 'AI_CLEANUP_FAILED', count: totals.RETURNED, workIds: byState('RETURNED').map(row => row.id) });
  return findings;
}

export async function runOperationalDigest(env, scheduledTime, send = sendTransactionalEmail) {
  const now = Number.isFinite(scheduledTime) ? scheduledTime : Date.now();
  let findings;
  try { findings = await collectOperationalFindings(env, now); }
  catch (cause) { console.error(JSON.stringify({ event: 'ops_digest_unavailable', code: cause.code || 'DATABASE_UNAVAILABLE' })); return { ok: false, routed: false }; }
  if (!findings.length) { console.log(JSON.stringify({ event: 'ops_digest_clear' })); return { ok: true, routed: false, findings }; }
  console.error(JSON.stringify({ event: 'ops_digest_alert', findings }));
  const to = String(env.OPS_ALERT_EMAIL || '').trim();
  if (!to) { console.error(JSON.stringify({ event: 'ops_alert_unrouted', reason: 'OPS_ALERT_EMAIL_MISSING' })); return { ok: false, routed: false, findings }; }
  const text = ['Reptrio operasyon uyarısı (otomatik, günlük).', '', ...findings.map(f => `- ${f.code}: ${JSON.stringify(f)}`), '', 'Runbook: docs/BUILD_44_OPERATIONS_RUNBOOK.md'].join('\n');
  const sent = await send(env, { to, subject: `Reptrio ops: ${findings.map(f => f.code).join(', ')}`, text, reference: `ops-digest-${new Date(now).toISOString().slice(0, 10)}` });
  if (!sent.ok) console.error(JSON.stringify({ event: 'ops_alert_delivery_failed', status: sent.status }));
  return { ok: sent.ok, routed: sent.ok, findings };
}
