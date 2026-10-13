import { currentUser, sameOrigin } from './account-api.js';

// This permission is for user-selected PDF/DOCX/XLSX program analysis ONLY.
// It never authorizes access to HealthKit, the full workout history, or other user data.
export const AI_IMPORT_POLICY_VERSION = 'ai_import_openai_document_v1';

const consentPath = '/api/privacy/ai-import';
const decisionPath = '/api/privacy/ai-import/consent';
const unavailableCode = 'AI_CONSENT_UNAVAILABLE';

function answer(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
}

/** Auth and current-server-policy only; missing table, failed DB reads, revoked or stale decisions DENY. */
export async function hasAiImportConsent(env, userId) {
  if (!env?.DB || !userId) return false;
  try {
    const consent = await env.DB.prepare(`SELECT c.granted_at, c.revoked_at, c.policy_version
      FROM ai_import_consents c
      JOIN users u ON u.id = c.user_id
      WHERE c.user_id = ? AND u.deleted_at IS NULL`).bind(userId).first();
    return Boolean(consent?.granted_at && !consent?.revoked_at && consent?.policy_version === AI_IMPORT_POLICY_VERSION);
  } catch {
    // Old production D1 schema must never fall back to permitting AI egress.
    return false;
  }
}

export async function assertAiImportConsent(env, userId) {
  if (!(await hasAiImportConsent(env, userId))) {
    throw Object.assign(new Error('AI_CONSENT_REQUIRED'), { code: 'AI_CONSENT_REQUIRED', status: 403 });
  }
}

/** Account status is a server concern. Neither client flags nor login identity imply consent. */
export async function handleAiConsentRequest(request, env, pathname) {
  if (pathname !== consentPath && pathname !== decisionPath) return null;
  const statusRead = pathname === consentPath;
  if (request.method !== (statusRead ? 'GET' : 'POST'))
    return answer({ code: 'METHOD_NOT_ALLOWED' }, 405);
  if (!env?.DB) return answer({ code: 'AUTH_REQUIRED' }, 401);

  let user;
  try { user = await currentUser(request, env); }
  catch { return answer({ code: 'AUTH_UNAVAILABLE' }, 503); }
  if (!user) return answer({ code: 'AUTH_REQUIRED' }, 401);

  if (statusRead) return answer({
    policyVersion: AI_IMPORT_POLICY_VERSION,
    granted: await hasAiImportConsent(env, user.id),
  });

  if (!sameOrigin(request)) return answer({ code: 'AUTH_ORIGIN_INVALID' }, 403);
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json'))
    return answer({ code: 'UNSUPPORTED_CONTENT_TYPE' }, 415);

  // Explicit, positive intent; do not accept arbitrary signup/provider flags or unknown policy.
  let payload;
  try {
    const raw = await request.text();
    if (raw.length > 1024) return answer({ code: 'INVALID_CONSENT_REQUEST' }, 400);
    payload = JSON.parse(raw);
  } catch { return answer({ code: 'INVALID_CONSENT_REQUEST' }, 400); }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
      || Object.keys(payload).sort().join(',') !== 'action,policyVersion'
      || !['grant', 'revoke'].includes(payload.action)
      || payload.policyVersion !== AI_IMPORT_POLICY_VERSION)
    return answer({ code: 'INVALID_CONSENT_REQUEST' }, 400);

  const now = new Date().toISOString();
  // Both the effective decision and audit are one transaction. No document or session secrets in the audit.
  // The conditional user SELECT fails closed if the account was removed during the request.
  try {
    const accepted = await env.DB.prepare('SELECT id FROM users WHERE id = ? AND deleted_at IS NULL').bind(user.id).first();
    if (!accepted) return answer({ code: 'AUTH_REQUIRED' }, 401);
    const granting = payload.action === 'grant';
    const active = granting ? now : null, withdrawn = granting ? null : now;
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO ai_import_consents (user_id, policy_version, granted_at, revoked_at, updated_at)
        SELECT id, ?, ?, ?, ? FROM users WHERE id = ? AND deleted_at IS NULL
        ON CONFLICT(user_id) DO UPDATE SET policy_version = excluded.policy_version,
          granted_at = excluded.granted_at, revoked_at = excluded.revoked_at, updated_at = excluded.updated_at`)
        .bind(AI_IMPORT_POLICY_VERSION, active, withdrawn, now, user.id),
      env.DB.prepare(`INSERT INTO ai_import_consent_events (id, user_id, action, policy_version, created_at)
        SELECT ?, id, ?, ?, ? FROM users WHERE id = ? AND deleted_at IS NULL`)
        .bind(crypto.randomUUID(), payload.action, AI_IMPORT_POLICY_VERSION, now, user.id),
    ]);
    return answer({ policyVersion: AI_IMPORT_POLICY_VERSION, granted: await hasAiImportConsent(env, user.id) });
  } catch {
    // Schema missing, partial schema, D1 failure: NEVER claim the user's preference was stored.
    return answer({ code: unavailableCode }, 503);
  }
}

/** Deletion code must not leave consent/audit rows on installations using FK OFF. */
export async function aiConsentDeletionTables(env) {
  const rows = (await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('ai_import_consents','ai_import_consent_events')").all()).results || [];
  const found = new Set(rows.map(row => row.name));
  if (found.size === 0) return [];
  if (found.size !== 2) throw Object.assign(new Error(unavailableCode), { code: unavailableCode, status: 503 });
  return ['ai_import_consent_events', 'ai_import_consents'];
}
