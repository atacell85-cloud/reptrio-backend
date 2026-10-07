import { body, error, isJsonPost, json, methodOrTypeError, normalizeEmail, passwordDigest, randomToken, sameOrigin, tokenDigest, validPassword } from './account-api.js';
import { sendTransactionalEmail } from './transactional-email.js';

// ---- Password reset (Build 43 G).
// Request: always the same 202 for any syntactically valid email; the account lookup, token issue and mail run after
// the response (ctx.waitUntil), so neither the body nor the timing depends on whether the account exists.
// Token: 256-bit CSPRNG value, only its SHA-256 digest is stored, 30 minutes, single use; a new request revokes the
// user's earlier active links. Completion: one D1 batch (a transaction) changes the password, deletes every session,
// voids pending mobile OAuth codes and the user's other links, and consumes the token — every statement guarded by
// the same "token still valid" predicate, the consume last, so a concurrent or stale submit changes nothing.
// Eligibility: only accounts with a user-chosen password. An account created by Google / Apple sign-in has a generated
// password nobody knows (same predicate as account deletion's `deletionContext`); a reset would create a new password
// login surface for it, so it gets no link and no mail (the response is unchanged).
const RESET_TTL_MINUTES = 30;
const THROTTLE_MIN_INTERVAL_MS = 60_000;
const THROTTLE_MAX_PER_HOUR = 3;
const RETAIN_ROWS_MS = 24 * 3_600_000;
// Fixed link origin: never derived from the request Host header or configuration.
const RESET_LINK_ORIGIN = 'https://api.reptrio.com';
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const HAS_OWN_PASSWORD = 'NOT EXISTS (SELECT 1 FROM oauth_accounts WHERE oauth_accounts.user_id = users.id AND oauth_accounts.created_at = users.created_at)';

export async function handlePasswordResetRequest(request, env, ctx, pathname) {
  if (pathname === '/api/auth/password/forgot') return forgotPassword(request, env, ctx);
  if (pathname === '/api/auth/password/reset') return resetPassword(request, env, ctx);
  if (pathname === '/reset-password') return resetPage(request);
  return null;
}

async function forgotPassword(request, env, ctx) {
  if (!isJsonPost(request)) return methodOrTypeError(request);
  if (!sameOrigin(request)) return error('AUTH_ORIGIN_INVALID', 403);
  if (!(await withinRateLimit(request, env, 'forgot'))) return error('PASSWORD_RESET_RATE_LIMITED', 429);
  const { email } = await body(request);
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) return error('AUTH_INVALID_EMAIL', 400);
  await background(ctx, issueReset(env, normalizedEmail).catch(cause => logEvent('password_reset_request_failed', { stage: 'issue', cause })));
  return json({ ok: true }, 202);
}

async function issueReset(env, email) {
  const user = await env.DB.prepare(`SELECT id, email FROM users WHERE email = ? AND deleted_at IS NULL AND ${HAS_OWN_PASSWORD}`).bind(email).first();
  if (!user) return;
  const now = new Date();
  const token = randomToken(32);
  const id = crypto.randomUUID();
  const issuedAt = now.toISOString();
  // The per-account throttle is part of the insert itself (one transaction), so parallel requests cannot all pass a
  // separate read. Earlier links are revoked only when the new one was actually written.
  const results = await env.DB.batch([
    env.DB.prepare(`INSERT INTO password_reset_tokens (id, user_id, token_hash, created_at, expires_at)
      SELECT ?, ?, ?, ?, ?
      WHERE (SELECT COUNT(*) FROM password_reset_tokens WHERE user_id = ? AND created_at > ?) < ?
        AND NOT EXISTS (SELECT 1 FROM password_reset_tokens WHERE user_id = ? AND created_at > ?)`)
      .bind(id, user.id, await tokenDigest(token), issuedAt, new Date(now.getTime() + RESET_TTL_MINUTES * 60_000).toISOString(),
        user.id, new Date(now.getTime() - 3_600_000).toISOString(), THROTTLE_MAX_PER_HOUR,
        user.id, new Date(now.getTime() - THROTTLE_MIN_INTERVAL_MS).toISOString()),
    env.DB.prepare('UPDATE password_reset_tokens SET revoked_at = ? WHERE user_id = ? AND id <> ? AND used_at IS NULL AND revoked_at IS NULL AND EXISTS (SELECT 1 FROM password_reset_tokens AS issued WHERE issued.id = ?)').bind(issuedAt, user.id, id, id),
    env.DB.prepare('DELETE FROM password_reset_tokens WHERE user_id = ? AND created_at < ?').bind(user.id, new Date(now.getTime() - RETAIN_ROWS_MS).toISOString()),
  ]);
  if (results[0]?.meta?.changes !== 1) {
    logEvent('password_reset_throttled');
    return;
  }
  const link = `${RESET_LINK_ORIGIN}/reset-password#token=${token}`;
  const result = await sendTransactionalEmail(env, { to: user.email, reference: id, ...resetMail(link) });
  logEvent(result.ok ? 'password_reset_mail_sent' : 'password_reset_mail_failed', result.ok ? {} : { status: result.status });
}

async function resetPassword(request, env, ctx) {
  if (!isJsonPost(request)) return methodOrTypeError(request);
  if (!sameOrigin(request)) return error('AUTH_ORIGIN_INVALID', 403);
  if (!(await withinRateLimit(request, env, 'reset'))) return error('PASSWORD_RESET_RATE_LIMITED', 429);
  const { token, password } = await body(request);
  // The password is checked before the token, so a rejected password never consumes the link.
  if (!validPassword(password)) return error('AUTH_PASSWORD_TOO_SHORT', 400);
  if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) return error('PASSWORD_RESET_INVALID', 400);
  const tokenHash = await tokenDigest(token);
  const now = new Date().toISOString();
  const row = await env.DB.prepare(`SELECT password_reset_tokens.id, password_reset_tokens.user_id, users.email
    FROM password_reset_tokens
    JOIN users ON users.id = password_reset_tokens.user_id
    WHERE password_reset_tokens.token_hash = ?
      AND password_reset_tokens.used_at IS NULL
      AND password_reset_tokens.revoked_at IS NULL
      AND password_reset_tokens.expires_at > ?
      AND users.deleted_at IS NULL
      AND ${HAS_OWN_PASSWORD}`).bind(tokenHash, now).first();
  if (!row) return error('PASSWORD_RESET_INVALID', 400);

  const salt = randomToken(16);
  const passwordHash = await passwordDigest(password, salt);
  // One predicate guards every statement: the link is still valid AND its account still exists and still has its own
  // password. If it stops holding between the read above and this batch, every statement is a no-op.
  const valid = `EXISTS (SELECT 1 FROM password_reset_tokens AS current JOIN users AS owner ON owner.id = current.user_id
    WHERE current.id = ? AND current.user_id = ? AND current.used_at IS NULL AND current.revoked_at IS NULL AND current.expires_at > ?
      AND owner.deleted_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM oauth_accounts WHERE oauth_accounts.user_id = owner.id AND oauth_accounts.created_at = owner.created_at))`;
  const guard = [row.id, row.user_id, now];
  let results;
  try {
    results = await env.DB.batch([
      env.DB.prepare(`UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ? AND ${valid}`).bind(passwordHash, salt, row.user_id, ...guard),
      env.DB.prepare(`DELETE FROM auth_sessions WHERE user_id = ? AND ${valid}`).bind(row.user_id, ...guard),
      env.DB.prepare(`UPDATE mobile_oauth_codes SET used_at = ? WHERE user_id = ? AND used_at IS NULL AND ${valid}`).bind(now, row.user_id, ...guard),
      env.DB.prepare(`UPDATE password_reset_tokens SET revoked_at = ? WHERE user_id = ? AND id <> ? AND used_at IS NULL AND revoked_at IS NULL AND ${valid}`).bind(now, row.user_id, row.id, ...guard),
      env.DB.prepare(`UPDATE password_reset_tokens SET used_at = ? WHERE id = ? AND ${valid}`).bind(now, row.id, ...guard),
    ]);
  } catch (cause) {
    logEvent('password_reset_failed', { stage: 'database', cause });
    return error('PASSWORD_RESET_FAILED', 500);
  }
  if (results[0]?.meta?.changes !== 1 || results[4]?.meta?.changes !== 1) return error('PASSWORD_RESET_INVALID', 400);
  logEvent('password_reset_completed', { sessionsRevoked: Number(results[1]?.meta?.changes || 0) });
  await background(ctx, sendTransactionalEmail(env, { to: row.email, reference: `${row.id}-done`, ...changedMail() })
    .then(result => { if (!result.ok) logEvent('password_changed_mail_failed', { status: result.status }); }));
  return json({ ok: true });
}

async function withinRateLimit(request, env, action) {
  if (!env.PASSWORD_RESET_LIMITER) return true;
  try {
    const result = await env.PASSWORD_RESET_LIMITER.limit({ key: `${action}:${request.headers.get('cf-connecting-ip') || 'unknown'}` });
    return result?.success !== false;
  } catch {
    return true;
  }
}

async function background(ctx, task) {
  if (typeof ctx?.waitUntil === 'function') ctx.waitUntil(task);
  else await task;
}

// Logs carry an event name and fixed fields only — never an email, token, digest, link or key. A database error
// message is reduced to its class name.
function logEvent(event, fields = {}) {
  const { cause, ...rest } = fields;
  const entry = { event, ...rest, ...(cause ? { error: cause?.name || 'Error' } : {}) };
  (event.endsWith('_failed') ? console.warn : console.log)(JSON.stringify(entry));
}

function resetMail(link) {
  return {
    subject: 'Reptrio şifre sıfırlama',
    text: [
      'Merhaba,',
      '',
      'Reptrio hesabın için bir şifre sıfırlama isteği aldık. Yeni şifreni belirlemek için bu bağlantıyı aç:',
      link,
      '',
      `Bağlantı ${RESET_TTL_MINUTES} dakika geçerlidir ve yalnızca bir kez kullanılabilir.`,
      'Bu isteği sen yapmadıysan bu e-postayı yok sayabilirsin; şifren değişmez.',
      '',
      'Reptrio',
    ].join('\n'),
    html: `<!doctype html><html lang="tr"><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#111;line-height:1.5">
<p>Merhaba,</p>
<p>Reptrio hesabın için bir şifre sıfırlama isteği aldık. Yeni şifreni belirlemek için aşağıdaki düğmeye dokun.</p>
<p><a href="${link}" style="display:inline-block;padding:12px 20px;background:#111;color:#fff;text-decoration:none;border-radius:8px">Şifreni sıfırla</a></p>
<p>Düğme çalışmazsa bu bağlantıyı tarayıcına yapıştır:<br><span style="word-break:break-all">${link}</span></p>
<p>Bağlantı ${RESET_TTL_MINUTES} dakika geçerlidir ve yalnızca bir kez kullanılabilir.</p>
<p>Bu isteği sen yapmadıysan bu e-postayı yok sayabilirsin; şifren değişmez.</p>
<p>Reptrio</p>
</body></html>`,
  };
}

function changedMail() {
  const text = 'Reptrio hesabının şifresi az önce değiştirildi ve tüm cihazlardaki oturumlar kapatıldı. Bu değişikliği sen yapmadıysan hemen giriş ekranından "Şifremi unuttum?" ile yeni bir şifre belirle.';
  return {
    subject: 'Reptrio şifren değiştirildi',
    text: `Merhaba,\n\n${text}\n\nReptrio`,
    html: `<!doctype html><html lang="tr"><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#111;line-height:1.5"><p>Merhaba,</p><p>${text}</p><p>Reptrio</p></body></html>`,
  };
}

// ---- Reset page (the HTTPS target of the emailed link). The token travels in the URL fragment, which browsers never
// send to the server or in Referer; the page reads it, removes it from the address bar, and offers the app handoff
// (reptrio://reset-password?token=…) or a same-origin form. The server-rendered HTML never contains a token.
function resetPage(request) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return error('METHOD_NOT_ALLOWED', 405, { Allow: 'GET, HEAD' });
  const nonce = randomToken(16);
  const headers = {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Robots-Tag': 'noindex, nofollow',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'`,
  };
  return new Response(request.method === 'HEAD' ? null : resetPageHtml(nonce), { status: 200, headers });
}

function resetPageHtml(nonce) {
  return `<!doctype html>
<html lang="tr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Reptrio şifre sıfırlama</title>
<style nonce="${nonce}">
  :root { color-scheme: light dark; --bg: #f5f5f4; --card: #fff; --text: #111; --muted: #555; --accent: #111; --on-accent: #fff; --danger: #b42318; --ok: #067647; }
  @media (prefers-color-scheme: dark) { :root { --bg: #0c0c0d; --card: #1a1a1c; --text: #f4f4f5; --muted: #a1a1aa; --accent: #f4f4f5; --on-accent: #111; --danger: #f97066; --ok: #47cd89; } }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 16px/1.5 -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { max-width: 420px; margin: 0 auto; padding: 40px 16px; }
  .card { background: var(--card); border-radius: 14px; padding: 24px; display: grid; gap: 14px; }
  h1 { font-size: 22px; margin: 0; }
  p { margin: 0; color: var(--muted); }
  label { display: grid; gap: 6px; font-weight: 600; }
  input { font: inherit; padding: 12px; border-radius: 10px; border: 1px solid #8884; background: transparent; color: var(--text); }
  .button { display: block; width: 100%; text-align: center; font: inherit; font-weight: 700; padding: 13px; border-radius: 10px; border: 0; background: var(--accent); color: var(--on-accent); text-decoration: none; cursor: pointer; }
  .button.secondary { background: transparent; color: var(--text); border: 1px solid #8886; }
  .button:disabled { opacity: .5; }
  .error { color: var(--danger); font-weight: 600; }
  .ok { color: var(--ok); font-weight: 600; }
  .stack { display: grid; gap: 14px; }
  .stack.tight { gap: 12px; }
  [hidden] { display: none !important; }
</style>
</head>
<body>
<main>
  <div class="card">
    <h1>Yeni şifre belirle</h1>
    <div id="invalid" hidden><p class="error">Bu bağlantı geçersiz ya da süresi dolmuş. Reptrio uygulamasındaki giriş ekranından “Şifremi unuttum?” ile yeni bir bağlantı iste.</p></div>
    <div id="ready" hidden>
      <div class="stack">
        <a id="open-app" class="button" href="#">Reptrio uygulamasında aç</a>
        <p>Ya da yeni şifreni burada belirle:</p>
        <form id="form" class="stack tight" novalidate>
          <label>Yeni şifre<input id="password" type="password" autocomplete="new-password" minlength="8" maxlength="200" required></label>
          <label>Yeni şifre (tekrar)<input id="confirm" type="password" autocomplete="new-password" minlength="8" maxlength="200" required></label>
          <p id="form-error" class="error" hidden></p>
          <button id="submit" class="button secondary" type="submit">Şifreyi güncelle</button>
        </form>
      </div>
    </div>
    <div id="done" hidden><p class="ok">Şifren güncellendi ve tüm oturumlar kapatıldı. Reptrio uygulamasında yeni şifrenle giriş yap.</p></div>
  </div>
</main>
<script nonce="${nonce}">
(function () {
  var match = /^#token=([A-Za-z0-9_-]{43})$/.exec(location.hash || '');
  var token = match ? match[1] : null;
  if (location.hash) history.replaceState(null, '', location.pathname);
  var show = function (id) { ['invalid', 'ready', 'done'].forEach(function (name) { document.getElementById(name).hidden = name !== id; }); };
  if (!token) { show('invalid'); return; }
  document.getElementById('open-app').href = 'reptrio://reset-password?token=' + token;
  show('ready');
  var form = document.getElementById('form');
  var errorText = document.getElementById('form-error');
  var submit = document.getElementById('submit');
  var fail = function (text) { errorText.textContent = text; errorText.hidden = false; };
  form.addEventListener('submit', function (event) {
    event.preventDefault();
    errorText.hidden = true;
    var password = document.getElementById('password').value;
    var confirm = document.getElementById('confirm').value;
    if (password.length < 8 || password.length > 200) return fail('Şifre 8–200 karakter olmalı.');
    if (password !== confirm) return fail('Şifreler eşleşmiyor.');
    submit.disabled = true;
    fetch('/api/auth/password/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: token, password: password }) })
      .then(function (response) { return response.json().catch(function () { return {}; }).then(function (body) { return { status: response.status, body: body }; }); })
      .then(function (result) {
        if (result.status === 200) { token = null; show('done'); return; }
        if (result.body.code === 'PASSWORD_RESET_INVALID') { token = null; show('invalid'); return; }
        if (result.body.code === 'AUTH_PASSWORD_TOO_SHORT') return fail('Şifre 8–200 karakter olmalı.');
        if (result.body.code === 'PASSWORD_RESET_RATE_LIMITED') return fail('Çok fazla deneme yapıldı. Biraz sonra tekrar dene.');
        fail('Şifre güncellenemedi. Tekrar dene.');
      })
      .catch(function () { fail('Bağlantı kurulamadı. Tekrar dene.'); })
      .then(function () { submit.disabled = false; });
  });
})();
</script>
</body>
</html>`;
}
