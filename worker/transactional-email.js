// Transactional email boundary. Auth logic calls `sendTransactionalEmail` only; the provider (ZeptoMail, EU data
// center) is an implementation detail of this file. The API key comes only from the `ZEPTOMAIL_API_KEY` Worker secret
// and is never logged or returned; neither is the message body (it can contain a reset link).
const ZEPTOMAIL_SEND_URL = 'https://cpaas.zoho.eu/v1.1/email';
const SENDER = { address: 'no-reply@mail.reptrio.com', name: 'Reptrio' };
const SEND_TIMEOUT_MS = 10_000;
const AUTH_PREFIX = 'Zoho-enczapikey ';

// Returns { ok: true } or { ok: false, status } where status is an HTTP status or a fixed code. Never throws.
export async function sendTransactionalEmail(env, { to, subject, text, html, reference }, fetchImpl = fetch) {
  const key = String(env.ZEPTOMAIL_API_KEY || '').trim();
  if (!key) return { ok: false, status: 'not_configured' };
  const payload = {
    from: SENDER,
    to: [{ email_address: { address: to } }],
    subject,
    textbody: text,
    htmlbody: html,
    // Click tracking would rewrite links through the provider's redirector and expose the reset token to it.
    track_clicks: false,
    track_opens: false,
    ...(reference ? { client_reference: reference } : {}),
  };
  try {
    const response = await fetchImpl(ZEPTOMAIL_SEND_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: key.startsWith(AUTH_PREFIX) ? key : `${AUTH_PREFIX}${key}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    return response.ok ? { ok: true } : { ok: false, status: response.status };
  } catch {
    return { ok: false, status: 'unreachable' };
  }
}
