const endpoint = path => `/api${path}`;
const REMEMBERED_USER_KEY = 'aks.remembered-user.v1';

export const authService = {
  async me() {
    try { const response = await fetch(endpoint('/me'), { credentials: 'same-origin' }); if (!response.ok) return null; const result = await response.json(); remember(result.user); return result.user; }
    catch { return rememberedUser(); }
  },
  async register(email, password) { const result = await request('/auth/register', { email, password }); remember(result.user); return result; },
  async login(email, password) { const result = await request('/auth/login', { email, password }); remember(result.user); return result; },
  startOAuth(provider, mode = 'login') { window.location.assign(endpoint(`/auth/oauth/${encodeURIComponent(provider)}/start?mode=${encodeURIComponent(mode)}`)); },
  async logout() { try { await fetch(endpoint('/auth/logout'), { method: 'POST', credentials: 'same-origin' }); } finally { forget(); } },
  // Issue #6: what deletion needs (password only for user-chosen passwords; Apple re-authorization when needed).
  async deletionInfo() { const response = await fetch(endpoint('/auth/delete'), { credentials: 'same-origin' }); const payload = await response.json().catch(() => ({})); if (!response.ok) throw Object.assign(new Error(payload.code || 'AUTH_REQUEST_FAILED'), { code: payload.code || 'AUTH_REQUEST_FAILED' }); return payload; },
  async deleteAccount(password) { const result = await request('/auth/delete', { confirm: 'DELETE', ...(password ? { password } : {}) }); forget(); return result; }
};

function remember(user) { if (user?.id && user?.email) localStorage.setItem(REMEMBERED_USER_KEY, JSON.stringify({ id: user.id, email: user.email })); }
function rememberedUser() { try { const user = JSON.parse(localStorage.getItem(REMEMBERED_USER_KEY)); return user?.id && user?.email ? user : null; } catch { return null; } }
function forget() { localStorage.removeItem(REMEMBERED_USER_KEY); }

async function request(path, body) {
  const response = await fetch(endpoint(path), { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(payload.code || 'AUTH_REQUEST_FAILED'), { code: payload.code || 'AUTH_REQUEST_FAILED' });
  return payload;
}
