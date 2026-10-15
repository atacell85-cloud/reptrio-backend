import worker, { normalizeImportedPreview } from '../worker/index.js';

const baseEnv = {
  ASSETS: { fetch: async () => new Response('<!doctype html><title>A2</title>', { headers: { 'Content-Type': 'text/html' } }) },
  OPENAI_IMPORT_MODEL: 'gpt-4.1-mini', OPENAI_IMPORT_TIMEOUT_MS: '1000', OPENAI_IMPORT_MAX_RETRIES: '0', OPENAI_IMPORT_RETRY_BASE_MS: '1', OPENAI_IMPORT_MAX_INPUT_BYTES: '180000'
};

const health = await worker.fetch(new Request('https://a2.example/api/health'), baseEnv);
const providersMissing = await worker.fetch(new Request('https://a2.example/api/auth/providers'), baseEnv);
const providersReady = await worker.fetch(new Request('https://a2.example/api/auth/providers'), {
  ...baseEnv,
  GOOGLE_OAUTH_CLIENT_ID: 'google-client',
  GOOGLE_OAUTH_CLIENT_SECRET: 'google-secret',
  APPLE_OAUTH_CLIENT_ID: 'com.reptrio.signin',
  APPLE_OAUTH_TEAM_ID: 'TEAM123456',
  APPLE_OAUTH_KEY_ID: 'KEY1234567',
  APPLE_OAUTH_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\nMIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAChRANCAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n-----END PRIVATE KEY-----'
});
const staticAsset = await worker.fetch(new Request('https://a2.example/'), baseEnv);
const invalidMethod = await worker.fetch(new Request('https://a2.example/api/import/parse'), baseEnv);
const invalidContentType = await worker.fetch(new Request('https://a2.example/api/import/parse', { method: 'POST', body: '{}' }), baseEnv);
const missingSecret = await worker.fetch(new Request('https://a2.example/api/import/parse', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ importId: 'fixture', normalizedDocument: { blocks: [{ type: 'paragraph', text: 'Lat Pulldown 3x10' }] } }) }), baseEnv);
const oversized = await worker.fetch(new Request('https://a2.example/api/import/parse', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ importId: 'fixture', normalizedDocument: { blocks: [{ type: 'paragraph', text: 'x'.repeat(180001) }] } }) }), { ...baseEnv, OPENAI_API_KEY: 'test' });
const limited = await worker.fetch(new Request('https://a2.example/api/import/parse', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ importId: 'fixture', normalizedDocument: { blocks: [{ type: 'paragraph', text: 'Lat Pulldown 3x10' }] } }) }), { ...baseEnv, OPENAI_API_KEY: 'test', AI_IMPORT_LIMITER: { limit: async () => ({ success: false }) } });
const youtubeMissingSecret = await worker.fetch(new Request('https://a2.example/api/youtube/search?q=lat%20pulldown'), baseEnv);
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => new Response(JSON.stringify({ items: [{ id: { videoId: 'abc123' }, snippet: { title: 'Lat Pulldown Form', channelTitle: 'Coach', thumbnails: { medium: { url: 'https://img.example/lat.jpg' } } } }] }), { headers: { 'Content-Type': 'application/json' } });
const youtubeOk = await worker.fetch(new Request('https://a2.example/api/youtube/search?q=lat%20pulldown'), { ...baseEnv, YOUTUBE_API_KEY: 'test' });
globalThis.fetch = originalFetch;
const googleOauthUnconfigured = await worker.fetch(new Request('https://a2.example/api/auth/oauth/google/start'), baseEnv);
const appleOauthUnconfigured = await worker.fetch(new Request('https://a2.example/api/auth/oauth/apple/start'), baseEnv);
const youtubeOkBody = await youtubeOk.json();
const providersMissingBody = await providersMissing.json();
const providersReadyBody = await providersReady.json();
const mobileDb = mockAccountDb();
const mobileRegister = await worker.fetch(new Request('https://a2.example/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Reptrio-Client': 'mobile' }, body: JSON.stringify({ email: 'mobile@example.test', password: 'password123' }) }), { ...baseEnv, DB: mobileDb });
const mobileRegisterBody = await mobileRegister.json();
if (mobileRegisterBody.user.onboardingEligible !== false) throw new Error('Legacy auth schema must expose false eligibility');
const mobileMe = await worker.fetch(new Request('https://a2.example/api/me', { headers: { Authorization: `Bearer ${mobileRegisterBody.sessionToken || ''}` } }), { ...baseEnv, DB: mobileDb });
const mobileMeBody = await mobileMe.json();
const sourceReference = { page: null, sheet: null, cellRange: null, text: null };
const normalizedImport = normalizeImportedPreview({
  schemaVersion: '1.1',
  importId: 'fixture',
  importedAt: '2026-08-25T00:00:00.000Z',
  source: { fileName: 'fixture.pdf', fileType: 'pdf', language: 'tr', documentTitle: null },
  program: {
    id: null,
    name: 'Fixture',
    description: 'ignore me',
    sourceType: 'pdf-import',
    notes: 'ignore me',
    days: [{
      name: 'Alt',
      order: 1,
      notes: 'ignore me',
      sourceReference,
      sections: [{
        title: 'Anything',
        sectionType: 'strength',
        order: 1,
        notes: 'ignore me',
        sourceReference,
        items: [
          {
            itemType: 'exercise',
            order: 1,
            sourceExerciseName: 'Hip Abd',
            normalizedExerciseName: 'Hip Abd',
            exerciseMatch: null,
            notes: 'Dış bacakta ayal',
            sourceReference,
            prescription: { sets: 3, setsText: '3', repsMin: null, repsMax: null, repsText: '3x15', weight: null, weightUnit: null, weightText: null, rir: null, rirText: null, rpe: null, rpeText: null, restSeconds: null, restText: null, tempo: null, tempoText: null, durationSeconds: null, durationText: null, distance: null, distanceUnit: null, distanceText: null, individualSets: [{ setNumber: 1, setType: 'working', reps: null, repsText: '15', weight: null, weightUnit: null, weightText: null, rir: null, rirText: null, rpe: null, rpeText: null, restSeconds: null, restText: null, notes: 'ignore me' }] }
          },
          {
            itemType: 'exercise',
            order: 2,
            sourceExerciseName: 'Plank',
            normalizedExerciseName: 'Plank',
            exerciseMatch: null,
            notes: 'ignore me',
            sourceReference,
            prescription: { sets: null, setsText: '4 set 30-40 sn', repsMin: null, repsMax: null, repsText: null, weight: null, weightUnit: null, weightText: null, rir: null, rirText: null, rpe: null, rpeText: null, restSeconds: null, restText: null, tempo: null, tempoText: null, durationSeconds: null, durationText: null, distance: null, distanceUnit: null, distanceText: null, individualSets: [] }
          }
        ]
      }]
    }]
  },
  warnings: [{ code: 'x', message: 'ignore me' }],
  unparsedContent: [{ text: 'ignore me' }]
});
const normalizedItems = normalizedImport.program.days[0].sections[0].items;
const importNormalizationOk = normalizedImport.program.description === null
  && normalizedImport.program.notes === null
  && normalizedImport.program.days[0].notes === null
  && normalizedItems[0].notes === null
  && normalizedItems[0].prescription.sets === 3
  && normalizedItems[0].prescription.setsText === '3'
  && normalizedItems[0].prescription.repsText === '15'
  && normalizedItems[0].prescription.repsMin === 15
  && normalizedItems[0].prescription.repsMax === 15
  && normalizedItems[0].prescription.individualSets[0].notes === null
  && normalizedItems[1].prescription.sets === 4
  && normalizedItems[1].prescription.setsText === '4'
  && normalizedItems[1].prescription.repsText === '30-40sn'
  && normalizedImport.warnings.length === 0
  && normalizedImport.unparsedContent.length === 0;

const result = {
  ok: health.ok && providersMissingBody.providers?.google === false && providersMissingBody.providers?.apple === false && providersReadyBody.providers?.google === true && providersReadyBody.providers?.apple === true && staticAsset.ok && invalidMethod.status === 405 && invalidContentType.status === 415 && missingSecret.status === 401 && oversized.status === 401 && limited.status === 401 && youtubeMissingSecret.status === 503 && youtubeOk.ok && youtubeOkBody.videos?.[0]?.videoId === 'abc123' && googleOauthUnconfigured.status === 303 && appleOauthUnconfigured.status === 303 && importNormalizationOk && mobileRegister.ok && Boolean(mobileRegisterBody.sessionToken) && mobileMe.ok && mobileMeBody.user?.email === 'mobile@example.test',
  health: await health.json(), providersMissing: providersMissingBody.providers, providersReady: providersReadyBody.providers, staticAsset: staticAsset.headers.get('content-type'), invalidMethod: invalidMethod.status, invalidContentType: invalidContentType.status, missingSecret: (await missingSecret.json()).code, oversized: (await oversized.json()).code, limited: (await limited.json()).code, youtubeMissingSecret: (await youtubeMissingSecret.json()).code, youtubeOk: youtubeOkBody.videos?.length || 0, googleOauthUnconfigured: googleOauthUnconfigured.headers.get('location'), appleOauthUnconfigured: appleOauthUnconfigured.headers.get('location'), importNormalizationOk, mobileTokenAuthOk: Boolean(mobileRegisterBody.sessionToken) && mobileMeBody.user?.email === 'mobile@example.test'
};
console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exitCode = 1;

function mockAccountDb() {
  const state = { users: [], sessions: [] };
  return {
    prepare(sql) {
      if (sql === 'PRAGMA table_info(users)') return { all: async () => ({ results: [{ name: 'id' }, { name: 'email' }] }) };
      return {
        bind(...values) {
          return {
            async first() {
              if (sql.includes('SELECT id FROM users WHERE email = ?')) return state.users.find(user => user.email === values[0] && !user.deleted_at) || null;
              if (sql.includes('SELECT users.id, users.email FROM auth_sessions JOIN users')) {
                const session = state.sessions.find(item => item.token_hash === values[0] && item.expires_at > values[1]);
                const user = session && state.users.find(item => item.id === session.user_id && !item.deleted_at);
                return user ? { id: user.id, email: user.email } : null;
              }
              return null;
            },
            async run() {
              if (sql.startsWith('INSERT INTO users')) state.users.push({ id: values[0], email: values[1], password_hash: values[2], password_salt: values[3], created_at: values[4], deleted_at: null });
              if (sql.startsWith('INSERT INTO auth_sessions')) state.sessions.push({ id: values[0],user_id:values[4],token_hash:values[1],created_at:values[2],expires_at:values[3] });
              if (sql.startsWith('DELETE FROM auth_sessions WHERE token_hash')) state.sessions = state.sessions.filter(item => item.token_hash !== values[0]);
              return { success: true,meta:{changes:1} };
            }
          };
        }
      };
    },
    async batch(items) { return Promise.all(items.map(item => item.run())); }
  };
}
