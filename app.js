import { A2_PROGRAM, findExercise, findWorkoutDay, exercisesForDay } from './data/public-programs.js';
import { SCHEMA_VERSION, workoutRepository } from './storage.js';
import { getCanonicalExercise, loadExerciseDatabase, searchExercises } from './exercise-service.js';
import { blankDay, blankExercise, blankInstruction, blankProgram, blankSection, normalizeProgram, permanentDayToLegacy, validateProgram } from './program-service.js';
import { finalizeImport, matchImportExercises, validateImportPreview } from './import-service.js';
import { createYouTubeSearchService } from './youtube-service.js?v=english-youtube-search-v1';
import { documentExtractor } from './document-extractor.js';
import { localImportParser } from './local-import-parser.js';
import { getImportParser, IMPORT_PARSER_PROVIDER } from './import-provider.js';
import { openAIImportParser } from './openai-import-parser.js';
import { authService } from './auth-service.js';
import { createSyncService } from './sync-service.js';

const app = document.querySelector('#app');
const title = document.querySelector('#pageTitle');
let state = { view: 'home', workout: null, timer: null, timerEndsAt: null, timerExerciseId: null, timerNotified: false, executionDay: null, executionExercises: new Map(), builder: null, picker: null, video: null, user: null, syncStatus: 'saved', installPrompt: null, onboarding: null, authMode: 'login', authBusy: false, notifiedImports: new Set() };
const youtube = createYouTubeSearchService(workoutRepository);
const sync = createSyncService(workoutRepository, status => { state.syncStatus = status; const indicator = document.querySelector('#syncStatus'); if (indicator) indicator.textContent = syncLabel(status); });

function uid() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function jsString(value) {
  return JSON.stringify(String(value));
}

function toast(message) {
  const t = document.querySelector('#toast');
  t.textContent = message;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 1800);
}

function nav(view) {
  const bottomNav = document.querySelector('.bottom-nav');
  const historyButton = document.querySelector('#historyBtn');
  if (bottomNav) bottomNav.hidden = !state.user;
  if (historyButton) historyButton.hidden = true;
  document.querySelectorAll('.nav-btn').forEach(button => button.classList.toggle('active', button.dataset.nav === view));
}

function workoutCounts(workout) {
  const planned = executionExercisesFor(workout);
  const completedStrength = planned.filter(ex => ['warmup', 'working', 'core'].includes(ex.setType) && Object.values(workout.sets[ex.id] || {}).length).length;
  const completedActivities = Object.keys(workout.completedActivities || {}).length;
  return { total: planned.length, done: completedStrength + completedActivities };
}

function executionDayFor(workout) { return state.executionDay || findWorkoutDay(workout.programId, workout.workoutDayId); }
function executionExercisesFor(workout) { return state.executionDay ? state.executionDay.sections.flatMap(section => section.exercises.map(item => ({ ...item, sectionType: section.type }))) : exercisesForDay(workout.programId, workout.workoutDayId); }
function executionExercise(exerciseId) { return state.executionExercises.get(exerciseId) || findExercise(exerciseId); }
async function hydrateExecutionDay(workout) {
  if (!workout) return null;
  if (workout.programId === A2_PROGRAM.id) {
    state.executionDay = null;
    state.executionExercises = new Map();
    return findWorkoutDay(workout.programId, workout.workoutDayId);
  }
  const program = await workoutRepository.getProgram(workout.programId);
  const day = program?.days.find(item => item.id === workout.workoutDayId);
  if (!day) return null;
  const exerciseDb = await loadExerciseDatabase();
  const names = new Map(exerciseDb.map(item => [item.id, item.nameTr]));
  const images = new Map(exerciseDb.map(item => [item.id, item.media?.image || null]));
  state.executionDay = permanentDayToLegacy(day, names);
  state.executionDay.sections.forEach(section => section.exercises.forEach(exercise => { exercise.imageUrl = images.get(exercise.canonicalExerciseId) || null; }));
  state.executionExercises = new Map(state.executionDay.sections.flatMap(section => section.exercises).map(item => [item.id, item]));
  return state.executionDay;
}

async function home() {
  return todayView();
}

async function todayView() {
  state.view = 'today'; state.workout = null; state.executionDay = null; title.textContent = 'Bugün';
  const draft = await workoutRepository.getDraft();
  const data = await workoutRepository.getData();
  const programs = data.programs;
  const importNotice = importNoticeCard(data.importPreviews);
  cachedSessions = await workoutRepository.getSessions();
  const lastSession = cachedSessions.at(-1);
  const hasProgram = programs.length > 0;
  const draftDay = draft ? await hydrateExecutionDay(draft) : null;
  const lastSessionLabel = lastSession ? sessionDayLabel(lastSession, programs) : '';
  app.innerHTML = `
    <section class="sync-status" id="syncStatus">${syncLabel(state.syncStatus)}</section>
    ${importNotice}
    ${draft ? `<section class="today-hero"><div><span>Devam eden antrenman</span><h2>${escapeHtml(draftDay?.label || 'Antrenman')}</h2><p>Başladığın kaydı sürdürebilirsin.</p></div><button class="primary-btn full" data-action="resume">Devam Et</button></section>` : `<section class="today-hero"><div><span>Bugün</span><h2>${hasProgram ? 'Antrenmana hazır' : 'İlk programını oluştur'}</h2><p>${hasProgram ? 'Programlar sekmesinden bir gün seçip antrenmanı başlat.' : 'Reptrio önce programını kurar, sonra her gün sadece başlatıp kayıt alırsın.'}</p></div>${hasProgram ? '<button class="primary-btn full" data-action="programs">Programlara Git</button>' : ''}</section>`}
    ${hasProgram ? '' : `<section class="summary-card"><h2>Program yok</h2><p class="muted">PDF, Word veya Excel'den aktarabilir ya da elle oluşturabilirsin.</p><button class="primary-btn full" data-action="file-import">Dosyadan Program Oluştur</button><button class="secondary-btn full" data-action="new-program">Elle Program Oluştur</button></section>`}
    ${lastSession ? `<section class="summary-card"><h2>Son antrenman</h2>${lastSessionSummary(lastSession, lastSessionLabel)}<button class="secondary-btn full" data-action="history">Geçmişi Gör</button></section>` : '<section class="summary-card muted">Henüz tamamlanmış antrenman kaydın yok.</section>'}`;
  nav('home');
}

function importNoticeCard(importPreviews = {}) {
  const previews = Object.values(importPreviews || {}).filter(Boolean).sort((a, b) => String(b.importedAt || '').localeCompare(String(a.importedAt || '')));
  const ready = previews.find(item => item.importId && !item.parserStatus && item.program?.days?.length);
  if (ready) return `<section class="summary-card import-ready-card"><span>Program analizi tamamlandı</span><h2>${escapeHtml(ready.program?.name || ready.source?.fileName || 'Yüklenen program')}</h2><p class="muted">Önizlemeyi kontrol edip programı oluşturabilirsin.</p><button class="primary-btn full" data-resume-import="${escapeHtml(ready.importId)}">Önizlemeyi Aç</button><button class="danger-btn full" data-delete-import="${escapeHtml(ready.importId)}">Bu yüklemeyi sil</button></section>`;
  const pending = previews.find(item => item.importId && item.parserStatus === 'pending');
  if (pending) return `<section class="summary-card import-pending-card"><span>Program analizi sürüyor</span><h2>${escapeHtml(pending.program?.name || pending.source?.fileName || 'Yüklenen program')}</h2><p class="muted">Arka planda devam ediyor. Hazır olduğunda burada görünecek.</p><button class="secondary-btn full" data-resume-import="${escapeHtml(pending.importId)}">Durumu Kontrol Et</button><button class="danger-btn full" data-delete-import="${escapeHtml(pending.importId)}">Bu yüklemeyi sil</button></section>`;
  return '';
}

function dayExerciseCount(day) {
  return day.sections.reduce((sum, section) => sum + section.items.filter(item => item.itemType === 'exercise').length, 0);
}

function sessionDayLabel(session, programs = []) {
  const publicDay = findWorkoutDay(session.programId, session.workoutDayId);
  if (publicDay?.label) return publicDay.label;
  const program = programs.find(item => item.id === session.programId);
  const day = program?.days?.find(item => item.id === session.workoutDayId);
  return day?.name || 'Antrenman';
}

function lastSessionSummary(session, label = 'Antrenman') {
  const summary = session.summary || sessionSummary(session);
  return `<div class="history-metrics">${escapeHtml(label)} • ${summary.completedExercises} hareket • ${summary.setCount} set • ${Math.round(summary.volume)} kg × tekrar</div><div class="small muted">${new Date(session.startedAt).toLocaleString('tr-TR')}</div>`;
}

async function workoutHomeView() {
  state.view = 'workout-home'; state.workout = null; state.executionDay = null; title.textContent = 'Antrenman';
  const draft = await workoutRepository.getDraft();
  const draftDay = draft ? await hydrateExecutionDay(draft) : null;
  app.innerHTML = `
    <section class="workout-home">
      ${draft ? `<button class="routine-row active-draft" data-action="resume"><span>${escapeHtml(draftDay?.label || 'Devam eden antrenman')}</span><b>Devam Et</b></button>` : ''}
      <button class="routine-row" data-action="my-routines"><span>Rutinlerim</span><b>→</b></button>
      <button class="routine-row" data-action="new-routine-menu"><span>Yeni Rutin Oluştur</span><b>→</b></button>
      <button class="routine-row" data-action="discover-routines"><span>Hazır Rutinleri Keşfet</span><b>→</b></button>
    </section>`;
  nav('programs');
}

async function myRoutinesView() {
  state.view = 'my-routines'; state.workout = null; state.executionDay = null; title.textContent = 'Rutinlerim';
  const programs = await workoutRepository.getPrograms();
  const settings = await workoutRepository.getSettings();
  app.innerHTML = `
    <button class="text-btn" data-action="programs">← Antrenman</button>
    ${programs.length ? programs.map(program => `<article class="program-card ${program.id === settings.activeProgramId ? 'active-program-card' : ''}"><div><b>${escapeHtml(program.name)}</b><span>${program.id === settings.activeProgramId ? 'Aktif program · ' : ''}${program.days.length} gün · ${escapeHtml(program.sourceType)}</span></div><div class="compact-actions">${program.id === settings.activeProgramId ? '' : `<button class="secondary-btn" data-set-active-program="${program.id}">Aktif Yap</button>`}<button class="secondary-btn" data-edit-program="${program.id}">Düzenle</button><button class="primary-btn" data-open-program="${program.id}">Aç</button></div></article>`).join('') : '<div class="summary-card muted">Henüz kaydettiğin rutin yok.</div>'}`;
  nav('programs');
}

function newRoutineMenuView() {
  state.view = 'new-routine-menu'; title.textContent = 'Yeni Rutin Oluştur';
  app.innerHTML = `<button class="text-btn" data-action="programs">← Antrenman</button><section class="workout-home"><button class="routine-row" data-action="new-program"><span>Rutin oluştur</span><b>→</b></button><button class="routine-row" data-action="file-import"><span>Rutin yükle</span><b>→</b></button></section>`;
  nav('programs');
}

function discoverRoutinesView() {
  state.view = 'discover-routines'; title.textContent = 'Hazır Rutinleri Keşfet';
  app.innerHTML = `<button class="text-btn" data-action="programs">← Antrenman</button><section class="summary-card muted">Hazır rutin kütüphanesi yakında burada olacak.</section>`;
  nav('programs');
}

async function programsView() { return myRoutinesView(); }

function syncLabel(status) { return ({ saved: 'Kaydedildi', syncing: 'Senkronize ediliyor...', offline: 'Çevrimdışı — sonra senkronize edilecek', pending: 'Senkronizasyon bekliyor' })[status] || 'Kaydedildi'; }

function welcomeView() {
  state.view = 'welcome'; state.onboarding = null; title.textContent = 'Reptrio'; nav('');
  app.innerHTML = `<section class="onboarding-screen welcome-screen"><div class="onboarding-mark"><span class="brand-mark large" aria-hidden="true"><span></span><span></span><span></span></span><span>Reptrio</span></div><h2>Reptrio'ya hoş geldin</h2><p class="muted">Programını oluştur, antrenmanını takip et ve gelişimini hatırla. Hazır programını PDF, Word veya Excel'den de aktarabilirsin.</p><button class="primary-btn full" data-action="onboarding-start">Başla</button><button class="text-btn full" data-action="returning-login">Zaten hesabım var</button></section>`;
}

const onboardingSteps = [
  { key: 'goal', title: 'Şu anki hedefin ne?', options: [['muscle','Kas kazanmak'],['strength','Güçlenmek'],['fat-loss','Yağ kaybetmek'],['fitness','Genel fitness'],['performance','Performansımı artırmak'],['tracking','Sadece antrenmanlarımı takip etmek']] },
  { key: 'experience', title: 'Antrenman deneyimin nasıl?', options: [['new','Yeni başlıyorum'],['beginner','Başlangıç'],['intermediate','Orta'],['advanced','İleri']] },
  { key: 'age', title: 'Kaç yaşındasın?', input: 'number', placeholder: 'Yaş', optional: true },
  { key: 'gender', title: 'Cinsiyetini nasıl belirtmek istersin?', options: [['male','Erkek'],['female','Kadın'],['unspecified','Belirtmek istemiyorum']], optional: true },
  { key: 'height', title: 'Boyun kaç?', input: 'number', placeholder: 'cm', optional: true },
  { key: 'weight', title: 'Kilon kaç?', input: 'number', placeholder: 'kg', step: '0.1', optional: true },
  { key: 'weeklyFrequency', title: 'Haftada kaç gün antrenman yapıyorsun?', options: Array.from({ length: 7 }, (_, i) => [String(i + 1), `${i + 1} gün`]), optional: true }
];

function onboardingView() {
  const index = state.onboarding.step; const step = onboardingSteps[index]; state.view = 'onboarding'; title.textContent = 'Reptrio'; nav('');
  const selected = state.onboarding[step.key]; const progress = `${index + 1} / ${onboardingSteps.length}`;
  const body = step.options ? `<div class="choice-grid">${step.options.map(([value, label]) => `<button class="choice-card ${selected === value ? 'selected' : ''}" data-onboarding-value="${step.key}:${value}">${label}</button>`).join('')}</div>` : `<label class="onboarding-input"><span>${step.placeholder}</span><input id="onboardingInput" type="${step.input}" inputmode="decimal" step="${step.step || '1'}" value="${escapeHtml(selected || '')}" placeholder="${step.placeholder}"></label>`;
  app.innerHTML = `<section class="onboarding-screen"><div class="progress-label">${progress}</div><div class="progress"><div style="width:${((index + 1) / onboardingSteps.length) * 100}%"></div></div><h2>${step.title}</h2>${step.optional ? '<p class="small muted">Bu bilgi isteğe bağlı.</p>' : ''}${body}<div class="onboarding-actions"><button class="secondary-btn" data-action="onboarding-back">Geri</button>${step.optional ? '<button class="text-btn" data-action="onboarding-skip">Atla</button>' : ''}<button class="primary-btn" data-action="onboarding-next" ${step.options && !selected ? 'disabled' : ''}>Devam et</button></div></section>`;
}

function authView(message = '', mode = state.authMode) {
  state.view = 'auth'; state.authMode = mode; title.textContent = mode === 'register' ? 'Hesap oluştur' : 'Giriş yap'; nav('');
  app.innerHTML = `<section class="onboarding-screen auth-card"><div class="progress-label">Hesap</div><h2>${mode === 'register' ? 'Hesabını oluştur' : 'Tekrar hoş geldin'}</h2><div class="social-stack"><button class="secondary-btn full" data-provider-disabled>Apple ile devam et</button><button class="secondary-btn full" data-oauth-provider="google">Google ile devam et</button><button class="secondary-btn full" data-provider-disabled>Facebook ile devam et</button></div>${message ? `<p class="field-error" role="alert">${escapeHtml(message)}</p>` : ''}<div class="builder-actions"><button class="secondary-btn" data-action="auth-back">Geri</button></div></section>`;
}

function firstProgramView() {
  title.textContent = 'İlk programın'; nav('programs');
  app.innerHTML = `<section class="onboarding-screen"><h2>İlk programını oluştur</h2><p class="muted">Hazır programını aktar veya kendin oluşturmaya başla.</p><button class="primary-btn full" data-action="file-import">Program dosyamı yükle</button><p class="small muted center">PDF, Word veya Excel</p><button class="secondary-btn full" data-action="new-program">Kendim oluşturacağım</button><button class="text-btn full" data-action="programs">Daha sonra</button></section>`;
}

async function completeAuth(user, isNew = false) {
  state.user = user; await workoutRepository.setActiveAccount(user.id); await workoutRepository.init(); await sync.start(user); cachedSessions = await workoutRepository.getSessions();
  if (isNew && state.onboarding) { await workoutRepository.saveSettings({ profile: { goal: state.onboarding.goal || null, experience: state.onboarding.experience || null, age: state.onboarding.age || null, gender: state.onboarding.gender || null, height: state.onboarding.height || null, weight: state.onboarding.weight || null, weeklyFrequency: state.onboarding.weeklyFrequency || null } }); }
  const accountData = await workoutRepository.getData();
  const accountHasContent = Boolean(accountData.programs.length || accountData.sessions.length || accountData.draft || Object.keys(accountData.importPreviews).length);
  if (isNew) return firstProgramView();
  if (!accountHasContent && await workoutRepository.hasLegacyDeviceData()) return legacyMigrationView();
  return workoutHomeView();
}

async function submitAuth(mode) {
  if (state.authBusy) return; const email = document.querySelector('#authEmail')?.value.trim() || ''; const password = document.querySelector('#authPassword')?.value || '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return authView('E-posta adresini kontrol et.', mode);
  if (password.length < 8) return authView('Şifre en az 8 karakter olmalı.', mode);
  state.authBusy = true; const button = document.querySelector(`[data-action="${mode}"]`); if (button) { button.disabled = true; button.textContent = mode === 'register' ? 'Hesap oluşturuluyor...' : 'Giriş yapılıyor...'; }
  try { const result = mode === 'register' ? await authService.register(email, password) : await authService.login(email, password); await completeAuth(result.user, mode === 'register'); }
  catch (error) { const code = error.code; const message = code === 'AUTH_INVALID_EMAIL' ? 'E-posta adresini kontrol et.' : code === 'AUTH_PASSWORD_TOO_SHORT' ? 'Şifre en az 8 karakter olmalı.' : code === 'AUTH_EMAIL_IN_USE' ? 'Bu e-posta ile zaten bir hesap var. Giriş yap' : code === 'AUTH_INVALID_CREDENTIALS' ? 'E-posta veya şifre hatalı.' : error instanceof TypeError || !navigator.onLine ? 'İnternet bağlantını kontrol edip tekrar dene.' : code?.startsWith('AUTH_') ? 'Şu anda hesabını oluşturamıyoruz. Biraz sonra tekrar dene.' : 'Hesap oluşturulamadı. Tekrar deneyebilirsin.'; authView(message, mode); }
  finally { state.authBusy = false; }
}

function oauthErrorMessage(code) {
  return ({
    OAUTH_PROVIDER_NOT_CONFIGURED: 'Google girişi henüz yapılandırılmadı. Kurulum tamamlanınca tekrar deneyebilirsin.',
    OAUTH_STATE_INVALID: 'Google giriş oturumu süresi doldu. Lütfen tekrar dene.',
    OAUTH_CODE_INVALID: 'Google giriş izni doğrulanamadı. Lütfen tekrar dene.',
    OAUTH_CLIENT_INVALID: 'Google bağlantı ayarları geçersiz. Kurulumu kontrol etmemiz gerekiyor.',
    OAUTH_EMAIL_MISSING: 'Google hesabından e-posta bilgisi alınamadı.',
    OAUTH_FAILED: 'Google ile giriş tamamlanamadı. Lütfen tekrar dene.'
  })[code] || 'Google ile giriş tamamlanamadı. Lütfen tekrar dene.';
}

function legacyMigrationView() { title.textContent = 'Mevcut Veriler'; nav('account'); app.innerHTML = `<section class="summary-card"><h2>Bu cihazda mevcut antrenman verileri bulundu.</h2><p class="muted">Veriler silinmez. İsterseniz bu hesabınıza aktarılır.</p><div class="builder-actions"><button class="secondary-btn" data-action="skip-legacy">Şimdilik Atla</button><button class="primary-btn" data-action="migrate-legacy">Bu verileri hesabıma aktar</button></div></section>`; }

async function accountView() {
  title.textContent = 'Profil'; nav('account');
  const legacy = await workoutRepository.hasLegacyDeviceData();
  const installed = window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone;
  const settings = await workoutRepository.getSettings();
  const profile = settings.profile || {};
  const displayName = profile.displayName || state.user?.email?.split('@')[0] || 'Profil';
  const avatar = profile.avatarDataUrl ? `<img src="${escapeHtml(profile.avatarDataUrl)}" alt="">` : `<span>${escapeHtml(displayName.slice(0, 1).toLocaleUpperCase('tr-TR'))}</span>`;
  const notificationControls = notificationSettingsHtml();
  app.innerHTML = `<section class="summary-card profile-card">
    <label class="profile-avatar">${avatar}<input type="file" id="profileAvatarInput" accept="image/*"></label>
    <div class="profile-info"><input id="displayNameSetting" value="${escapeHtml(profile.displayName || '')}" placeholder="Kullanıcı adı"><p class="small muted">${escapeHtml(state.user?.email || '')}</p><p id="syncStatus" class="muted">${syncLabel(state.syncStatus)}</p></div>
  </section>
  <section class="summary-card">
    <h3>Ayarlar</h3>
    <label class="setting-row">Varsayılan dinlenme <input id="restSetting" inputmode="numeric" type="number" min="15" step="5" value="${settings.rest || 90}"><span>saniye</span></label>
    <label class="setting-row">Ağırlık birimi <select id="weightUnitSetting"><option value="kg" ${settings.weightUnit !== 'lb' ? 'selected' : ''}>kg</option><option value="lb" ${settings.weightUnit === 'lb' ? 'selected' : ''}>lbs</option></select></label>
    ${notificationControls}
    <button class="secondary-btn full" data-action="save-settings">Kaydet</button>
  </section>
  <section class="summary-card">
    ${!installed ? `<button class="primary-btn full" data-action="install-app">Reptrio'yu Yükle</button><p class="small muted" id="installHelp" hidden>Safari'de Paylaş düğmesine dokunun → Ana Ekrana Ekle</p>` : ''}
    <button class="secondary-btn full" data-action="export-csv">CSV Log İndir</button>
    <details><summary>Gelişmiş</summary>${legacy ? `<button class="secondary-btn full" data-action="migrate-legacy">Bu cihazdaki eski verileri içe aktar</button>` : ''}<button class="secondary-btn full" data-action="export-json">Veriyi Dışa Aktar</button><input type="file" id="restoreFile" accept="application/json"><button class="secondary-btn full" data-action="restore-json">JSON'dan Geri Yükle</button></details>
    <p class="small muted">Exercise data by <a href="https://repdb.co" target="_blank" rel="noopener">RepDB (repdb.co)</a></p>
    <button class="secondary-btn full" data-action="logout">Çıkış Yap</button>
    <button class="danger-btn full" data-action="delete-account">Hesabımı Sil</button>
  </section>`;
}

function notificationSettingsHtml() {
  if (!('Notification' in window)) return '<p class="small muted">Bu cihazda bildirim desteklenmiyor.</p>';
  if (Notification.permission === 'granted') return '<p class="small muted">Dinlenme ve program analizi bildirimleri açık.</p>';
  if (Notification.permission === 'denied') return '<p class="small muted">Bildirim izni kapalı. Açmak için tarayıcı/site ayarlarını kullanman gerekiyor.</p>';
  return '<button class="secondary-btn full" data-action="enable-notifications">Bildirimleri Aç</button>';
}

async function enableNotifications() {
  if (!('Notification' in window)) return toast('Bu cihaz bildirim desteklemiyor');
  const permission = await Notification.requestPermission();
  toast(permission === 'granted' ? 'Bildirimler açıldı' : 'Bildirim izni verilmedi');
  await accountView();
}

async function exercisesView(query = '') {
  state.view = 'exercises'; title.textContent = 'Hareketler'; nav('exercises');
  const db = await loadExerciseDatabase();
  const normalized = query.trim().toLowerCase();
  const results = normalized ? await searchExercises(normalized, 50) : db.slice(0, 50);
  app.innerHTML = `<section class="summary-card"><h2>Hareketler</h2><p class="muted">Hareket kütüphanesi ve özel hareketler burada toparlanacak. Şimdilik hızlı arama aktif.</p><input class="exercise-select" id="exerciseLibrarySearch" placeholder="Hareket ara" value="${escapeHtml(query)}"></section><section class="exercise-library" id="exerciseLibraryResults">${results.map(exerciseLibraryCard).join('')}</section>`;
}

function exerciseLibraryCard(item) {
  return `<article class="exercise-card exercise-library-card"><div class="exercise-head"><div class="exercise-summary">${exerciseThumb(item)}<div><div class="exercise-name">${escapeHtml(item.nameTr || item.nameEn || item.id)}</div><div class="small muted">${escapeHtml(exerciseMeta(item))}</div></div></div><div class="prescription">${escapeHtml((item.primaryMuscles || []).slice(0, 2).join(', ') || 'Hareket')}</div></div></article>`;
}

function exerciseThumb(item) {
  const image = item?.media?.image || item?.imageUrl;
  return image ? `<img class="exercise-thumb" src="${escapeHtml(image)}" alt="" loading="lazy">` : '<span class="exercise-thumb placeholder" aria-hidden="true"></span>';
}

function exerciseMeta(item) {
  return [item.nameEn !== item.nameTr ? item.nameEn : '', ...(item.equipment || []).slice(0, 2)].filter(Boolean).join(' · ');
}

async function exerciseImageMap() {
  return new Map((await loadExerciseDatabase()).map(item => [item.id, item.media?.image || null]));
}

async function updateExerciseLibraryResults(query) {
  const holder = document.querySelector('#exerciseLibraryResults');
  if (!holder) return;
  const normalized = query.trim().toLowerCase();
  const results = normalized ? await searchExercises(normalized, 50) : (await loadExerciseDatabase()).slice(0, 50);
  holder.innerHTML = results.map(exerciseLibraryCard).join('');
}

const EXERCISE_REGION_FILTERS = [
  ['', 'Tümü'],
  ['chest', 'Göğüs'],
  ['back', 'Sırt'],
  ['shoulders', 'Omuz'],
  ['arms', 'Kol'],
  ['legs', 'Bacak'],
  ['core', 'Core'],
  ['full_body', 'Tüm Vücut']
];

const EXERCISE_MUSCLE_LABELS = {
  abductors: 'Abduktor',
  adductors: 'Adduktor',
  'anterior-deltoid': 'Ön Omuz',
  'biceps-brachii': 'Biceps',
  brachialis: 'Brachialis',
  brachioradialis: 'Ön Kol',
  'erector-spinae': 'Bel/Sırt',
  'forearm-extensors': 'Ön Kol Ekstansör',
  'forearm-flexors': 'Ön Kol Fleksör',
  gastrocnemius: 'Baldır',
  'gluteus-maximus': 'Kalça',
  'gluteus-medius': 'Yan Kalça',
  hamstrings: 'Hamstring',
  'hip-flexors': 'Kalça Fleksör',
  'lateral-deltoid': 'Yan Omuz',
  'latissimus-dorsi': 'Lat',
  obliques: 'Oblik',
  'pectoralis-major': 'Göğüs',
  'posterior-deltoid': 'Arka Omuz',
  'quadratus-lumborum': 'Bel',
  quadriceps: 'Quadriceps',
  'rectus-abdominis': 'Karın',
  rhomboids: 'Rhomboid',
  'serratus-anterior': 'Serratus',
  soleus: 'Soleus',
  'transverse-abdominis': 'Derin Karın',
  trapezius: 'Trapez',
  'triceps-brachii': 'Triceps'
};

function exerciseRegion(item) {
  const bodyPart = item.repdb?.body_part;
  if (bodyPart === 'upper_arms' || bodyPart === 'lower_arms') return 'arms';
  if (bodyPart === 'upper_legs' || bodyPart === 'lower_legs') return 'legs';
  return bodyPart || '';
}

function exerciseRegionLabel(item) {
  return EXERCISE_REGION_FILTERS.find(([value]) => value === exerciseRegion(item))?.[1] || 'Diğer';
}

function exerciseMuscleLabel(muscle) {
  return EXERCISE_MUSCLE_LABELS[muscle] || String(muscle || '').replace(/-/g, ' ');
}

function priorityValue(item) {
  return ({ core: 0, standard: 1, specialist: 2 })[item.priority] ?? 9;
}

function sortExercisePool(items) {
  return [...items].sort((a, b) => priorityValue(a) - priorityValue(b) || a.nameTr.localeCompare(b.nameTr, 'tr'));
}

function filterExercisePool(items, picker) {
  return items
    .filter(item => !picker.region || exerciseRegion(item) === picker.region)
    .filter(item => !picker.muscle || [...(item.primaryMuscles || []), ...(item.secondaryMuscles || [])].includes(picker.muscle));
}

function pickerMuscleFilters(items, picker) {
  return [...new Set(filterExercisePool(items, { ...picker, muscle: '' }).flatMap(item => [...(item.primaryMuscles || []), ...(item.secondaryMuscles || [])]))]
    .sort((a, b) => exerciseMuscleLabel(a).localeCompare(exerciseMuscleLabel(b), 'tr'));
}

async function fileImportView() {
  state.view = 'import'; title.textContent = 'Rutin yükle'; nav('programs');
  const data = await workoutRepository.getData();
  const latest = latestImportEntry(data);
  app.innerHTML = `<button class="text-btn" data-action="new-routine-menu">← Yeni Rutin Oluştur</button>
    ${latestImportStatusCard(latest)}
    <section class="import-upload"><label class="routine-row upload-row" for="importFile"><span>Yükle +</span></label><input id="importFile" type="file" accept=".pdf,.docx,.xlsx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"><div id="importStatus" class="import-status" aria-live="polite"></div></section>
    ${importLogSection(data)}`;
  if (latest?.kind === 'preview' && latest.item.parserStatus === 'pending' && latest.item.normalizedDocument) {
    state.pendingImportId = latest.item.importId;
    state.pendingNormalizedDocument = latest.item.normalizedDocument;
    pollImportJob(latest.item.importId, true).catch(error => console.warn('Import status refresh failed', error));
  }
}

function importLoading(message) {
  return `<div class="loading-state"><span class="loading-spinner" aria-hidden="true"></span><span>${escapeHtml(message)}</span></div>`;
}

function importLogSection(data) {
  const previews = Object.values(data.importPreviews || {}).filter(Boolean).sort((a, b) => String(b.importedAt || '').localeCompare(String(a.importedAt || '')));
  const history = [...(data.importHistory || [])].sort((a, b) => String(b.finalizedAt || '').localeCompare(String(a.finalizedAt || '')));
  const rows = [
    ...previews.map(importPreviewLogRow),
    ...history.map(importHistoryLogRow)
  ];
  return `<section class="summary-card import-log"><h2>Yükleme Geçmişi</h2><p class="muted">Program yüklemelerinin son durumunu buradan takip edebilirsin.</p>${rows.length ? `<div class="import-log-list">${rows.join('')}</div>` : '<div class="muted">Henüz program yüklemedin.</div>'}</section>`;
}

function latestImportEntry(data) {
  const previews = Object.values(data.importPreviews || {}).filter(Boolean).map(item => ({ kind: 'preview', item, time: item.importedAt || item.failedAt || '' }));
  const history = (data.importHistory || []).map(item => ({ kind: 'history', item, time: item.finalizedAt || '' }));
  return [...previews, ...history].sort((a, b) => String(b.time).localeCompare(String(a.time)))[0] || null;
}

function latestImportStatusCard(entry) {
  if (!entry) return `<section class="summary-card import-latest-card"><span>Son yükleme</span><h2>Henüz yükleme yok</h2><p class="muted">Program yüklediğinde analiz durumu burada görünecek.</p></section>`;
  if (entry.kind === 'history') {
    const item = entry.item;
    const name = item.source?.fileName || item.finalProgramId || 'Oluşturulan program';
    const date = item.finalizedAt ? new Date(item.finalizedAt).toLocaleString('tr-TR') : '';
    return `<section class="summary-card import-latest-card done"><span>Son yükleme</span><h2>${escapeHtml(name)}</h2><p class="muted">Programa dönüştürüldü${date ? ` · ${escapeHtml(date)}` : ''}</p>${item.finalProgramId ? `<button class="primary-btn full" data-open-program="${escapeHtml(item.finalProgramId)}">Programı Aç</button>` : ''}</section>`;
  }
  const preview = entry.item;
  const status = importPreviewStatus(preview);
  const stats = importPreviewStats(preview);
  const name = preview.program?.name || preview.source?.fileName || 'Yüklenen program';
  const date = preview.importedAt ? new Date(preview.importedAt).toLocaleString('tr-TR') : '';
  const actions = status.key === 'ready'
    ? `<button class="primary-btn full" data-resume-import="${escapeHtml(preview.importId)}">Önizlemeyi Aç</button><button class="danger-btn full" data-delete-import="${escapeHtml(preview.importId)}">Sil</button>`
    : status.key === 'pending'
      ? `<button class="secondary-btn full" data-check-import="${escapeHtml(preview.importId)}">Durumu Kontrol Et</button><button class="danger-btn full" data-delete-import="${escapeHtml(preview.importId)}">Sil</button>`
      : `<button class="secondary-btn full" data-retry-import="${escapeHtml(preview.importId)}">Tekrar Dene</button><button class="danger-btn full" data-delete-import="${escapeHtml(preview.importId)}">Sil</button>`;
  return `<section class="summary-card import-latest-card ${status.key}"><span>Son yükleme</span><h2>${escapeHtml(name)}</h2><p class="muted">${escapeHtml(status.label)}${stats ? ` · ${escapeHtml(stats)}` : ''}${date ? ` · ${escapeHtml(date)}` : ''}</p>${actions}</section>`;
}

function importPreviewLogRow(preview) {
  const status = importPreviewStatus(preview);
  const stats = importPreviewStats(preview);
  const name = preview.program?.name || preview.source?.fileName || 'Yüklenen program';
  const file = preview.source?.fileName || '';
  const date = preview.importedAt ? new Date(preview.importedAt).toLocaleString('tr-TR') : '';
  const actions = status.key === 'ready'
    ? `<button class="primary-btn" data-resume-import="${escapeHtml(preview.importId)}">Önizlemeyi Aç</button><button class="danger-btn" data-delete-import="${escapeHtml(preview.importId)}">Sil</button>`
    : status.key === 'pending'
      ? `<button class="secondary-btn" data-check-import="${escapeHtml(preview.importId)}">Durumu Kontrol Et</button><button class="danger-btn" data-delete-import="${escapeHtml(preview.importId)}">Sil</button>`
      : `<button class="secondary-btn" data-retry-import="${escapeHtml(preview.importId)}">Tekrar Dene</button><button class="danger-btn" data-delete-import="${escapeHtml(preview.importId)}">Sil</button>`;
  return `<article class="import-log-item ${status.key}"><div><b>${escapeHtml(name)}</b><span>${escapeHtml(status.label)}${stats ? ` · ${escapeHtml(stats)}` : ''}</span><small>${escapeHtml(file)}${date ? ` · ${escapeHtml(date)}` : ''}</small></div><div class="compact-actions">${actions}</div></article>`;
}

function importHistoryLogRow(item) {
  const name = item.source?.fileName || item.finalProgramId || 'Oluşturulan program';
  const date = item.finalizedAt ? new Date(item.finalizedAt).toLocaleString('tr-TR') : '';
  return `<article class="import-log-item done"><div><b>${escapeHtml(name)}</b><span>Programa dönüştürüldü</span><small>${escapeHtml(date)}</small></div><div class="compact-actions">${item.finalProgramId ? `<button class="secondary-btn" data-open-program="${escapeHtml(item.finalProgramId)}">Programı Aç</button>` : ''}</div></article>`;
}

function importPreviewStatus(preview) {
  if (preview.parserStatus === 'pending') return { key: 'pending', label: 'Analiz devam ediyor' };
  if (preview.parserStatus === 'failed') return { key: 'failed', label: `Başarısız: ${importErrorMessage(preview.errorCode || 'OPENAI_REQUEST_FAILED')}` };
  if (preview.program?.days?.some(day => day.sections?.some(section => section.items?.some(item => item.itemType === 'exercise')))) return { key: 'ready', label: 'Önizleme hazır' };
  return { key: 'failed', label: 'Başarısız: program çıkarılamadı' };
}

function importPreviewStats(preview) {
  const days = preview.program?.days?.length || 0;
  const exercises = (preview.program?.days || []).reduce((sum, day) => sum + (day.sections || []).reduce((inner, section) => inner + (section.items || []).filter(item => item.itemType === 'exercise').length, 0), 0);
  if (!days && !exercises) return '';
  return `${days} gün · ${exercises} hareket`;
}

async function importFile(file) {
  const status = document.querySelector('#importStatus');
  try {
    status.textContent = `${file.name} hazırlanıyor...`;
    const normalized = await documentExtractor.extract(file);
    state.pendingNormalizedDocument = normalized; state.pendingImportId = uid();
    await workoutRepository.saveImportPreview({ schemaVersion: '1.1', importId: state.pendingImportId, importedAt: new Date().toISOString(), source: { fileName: normalized.fileName, fileType: normalized.fileType, language: normalized.language, documentTitle: null }, program: { id: null, name: normalized.fileName.replace(/\.[^.]+$/, ''), description: null, sourceType: `${normalized.fileType}-import`, notes: null, days: [] }, warnings: [], unparsedContent: [], normalizedDocument: normalized, parserStatus: 'pending' });
    status.innerHTML = importLoading('Program arka planda analiz ediliyor');
    await createImportJob(normalized, file);
    await pollImportJob(state.pendingImportId, true);
  } catch (error) {
    console.error(error);
    if (IMPORT_PARSER_PROVIDER === 'openai' && state.pendingNormalizedDocument) status.innerHTML = importFailureActions(error.code || 'OPENAI_REQUEST_FAILED');
    else status.textContent = importErrorMessage(error.code || 'PARSER_FAILURE');
  }
}

async function parseNormalizedDocument(provider) {
  const preview = await getImportParser(provider).parse(state.pendingNormalizedDocument, { importId: state.pendingImportId });
  preview.importId = state.pendingImportId; preview.normalizedDocument = state.pendingNormalizedDocument; preview.parserProvider = provider; delete preview.parserStatus;
  return matchImportExercises(preview);
}

async function resumePendingImport(provider) {
  try { const preview = await parseNormalizedDocument(provider); await workoutRepository.saveImportPreview(preview); await renderImportPreview(preview.importId); }
  catch (error) { console.error(error); toast(importErrorMessage(error.code || 'OPENAI_REQUEST_FAILED')); }
}

async function createImportJob(normalizedDocument, file = null) {
  let body;
  let headers;
  if (file) {
    body = new FormData();
    body.append('importId', state.pendingImportId);
    body.append('normalizedDocument', JSON.stringify(normalizedDocument));
    body.append('file', file, file.name);
  } else {
    headers = { 'Content-Type': 'application/json' };
    body = JSON.stringify({ importId: state.pendingImportId, normalizedDocument });
  }
  const response = await fetch('/api/import/jobs', { method: 'POST', credentials: 'same-origin', headers, body });
  const responseBody = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(responseBody.code || 'OPENAI_REQUEST_FAILED'), { code: responseBody.code || 'OPENAI_REQUEST_FAILED' });
  return responseBody;
}

async function retryImportAnalysis(importId = state.pendingImportId) {
  const preview = importId ? await workoutRepository.getImportPreview(importId) : null;
  state.pendingImportId = importId || state.pendingImportId;
  state.pendingNormalizedDocument = preview?.normalizedDocument || state.pendingNormalizedDocument;
  if (!state.pendingImportId || !state.pendingNormalizedDocument) return toast('Tekrar denenecek aktarım bulunamadı');
  const status = document.querySelector('#importStatus');
  if (status) status.innerHTML = importLoading('Program tekrar analiz ediliyor');
  try {
    if (preview) {
      preview.parserStatus = 'pending';
      preview.errorCode = null;
      await workoutRepository.saveImportPreview(preview);
    }
    const response = await fetch(`/api/import/jobs/${encodeURIComponent(state.pendingImportId)}/retry`, { method: 'POST', credentials: 'same-origin' });
    if (!response.ok) await createImportJob(state.pendingNormalizedDocument);
    await pollImportJob(state.pendingImportId, true);
  } catch (error) {
    console.error(error);
    if (status) status.innerHTML = importFailureActions(error.code || 'OPENAI_REQUEST_FAILED');
  }
}

async function pollImportJob(importId, immediate = false) {
  if (state.importJobPoll) clearTimeout(state.importJobPoll);
  if (!immediate) await new Promise(resolve => setTimeout(resolve, 2500));
  const response = await fetch(`/api/import/jobs/${encodeURIComponent(importId)}`, { credentials: 'same-origin' });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(body.code || 'OPENAI_REQUEST_FAILED'), { code: body.code || 'OPENAI_REQUEST_FAILED' });
  const status = document.querySelector('#importStatus');
  if (body.status === 'done' && body.preview) {
    const stored = await workoutRepository.getImportPreview(importId);
    const normalizedDocument = state.pendingNormalizedDocument || stored?.normalizedDocument || null;
    const preview = await matchImportExercises({ ...body.preview, importId, normalizedDocument, parserProvider: 'openai-background' });
    delete preview.parserStatus;
    delete preview.errorCode;
    await workoutRepository.saveImportPreview(preview);
    if (state.importJobPoll) clearTimeout(state.importJobPoll);
    state.importJobPoll = null;
    await notifyImportComplete(preview);
    if (state.view === 'import' || state.view === 'import-preview') return renderImportPreview(importId);
    toast('Program analizi tamamlandı');
    if (state.view === 'today') return todayView();
    return;
  }
  if (body.status === 'failed') {
    const preview = await workoutRepository.getImportPreview(importId);
    if (preview) {
      preview.parserStatus = 'failed';
      preview.errorCode = body.errorCode || 'OPENAI_REQUEST_FAILED';
      preview.failedAt = new Date().toISOString();
      await workoutRepository.saveImportPreview(preview);
    }
    if (status) status.innerHTML = importFailureActions(body.errorCode || 'OPENAI_REQUEST_FAILED');
    if (state.view === 'import') await fileImportView();
    return;
  }
  if (status) status.innerHTML = `${importLoading('Program arka planda analiz ediliyor')}<p class="small muted">Bu ekranı kapatsan da analiz devam eder. Hazır olduğunda önizlemeyi açacağız.</p>`;
  state.importJobPoll = setTimeout(() => pollImportJob(importId).catch(error => {
    console.error(error);
    const currentStatus = document.querySelector('#importStatus');
    if (currentStatus) currentStatus.innerHTML = importFailureActions(error.code || 'OPENAI_REQUEST_FAILED');
  }), 3000);
}

async function notifyImportComplete(preview) {
  const importId = preview?.importId;
  if (!importId || state.notifiedImports.has(importId)) return;
  state.notifiedImports.add(importId);
  const programName = preview?.program?.name || preview?.source?.fileName || 'Program';
  const titleText = 'Program analizi tamamlandı';
  const body = `${programName} önizlemeye hazır.`;
  if ('Notification' in window && Notification.permission === 'granted') {
    try {
      const options = { body, icon: './icons/icon-192.png', badge: './icons/icon-192.png', tag: `a2-import-${importId}`, renotify: true, data: { importId, url: './' } };
      if ('serviceWorker' in navigator) {
        const registration = await navigator.serviceWorker.ready;
        registration.showNotification(titleText, options);
      } else {
        new Notification(titleText, options);
      }
    } catch {}
  }
}

function importFailureActions(code) {
  return `${escapeHtml(importErrorMessage(code))}
    <div class="builder-actions">
      <button class="secondary-btn" data-action="retry-openai">Tekrar Dene</button>
      <button class="primary-btn" data-action="report-import">Rapor Et</button>
    </div>`;
}

function reportImportIssue() {
  // Future implementation note:
  // Raw files are sent to OpenAI for background analysis, but they are not stored by Reptrio yet.
  // To inspect failed uploads later, enable Cloudflare R2 and attach the stored object key
  // to an import report queue with a clear retention policy.
  const fileName = state.pendingNormalizedDocument?.fileName || 'Dosya';
  const message = `${fileName} için rapor notu oluşturuldu. Dosya inceleme arşivi R2 aktifleşince eklenecek.`;
  toast(message);
}

async function resumeImport(importId) {
  const preview = await workoutRepository.getImportPreview(importId);
  if (preview?.parserStatus === 'pending' && preview.normalizedDocument) { state.pendingImportId = importId; state.pendingNormalizedDocument = preview.normalizedDocument; await fileImportView(); const status = document.querySelector('#importStatus'); status.innerHTML = `${importLoading('Program arka planda analiz ediliyor')}<p class="small muted">Aktarım sonucu kontrol ediliyor.</p>`; return pollImportJob(importId, true).catch(() => { status.innerHTML = `Aktarım yeniden başlatılmaya hazır.<div class="builder-actions"><button class="primary-btn" data-action="retry-openai">Tekrar Dene</button><button class="secondary-btn" data-action="report-import">Rapor Et</button></div>`; }); }
  if (preview?.parserStatus === 'failed') { state.pendingImportId = importId; state.pendingNormalizedDocument = preview.normalizedDocument || null; return fileImportView(); }
  return renderImportPreview(importId);
}

async function renderImportPreview(importId) {
  const preview = await workoutRepository.getImportPreview(importId); if (!preview) return programsView();
  state.importId = importId; state.view = 'import-preview'; title.textContent = 'Aktarım Önizlemesi'; nav('programs');
  const errors = validateImportPreview(preview, new Set((await loadExerciseDatabase()).map(item => item.id)));
  app.innerHTML = `<section class="builder-head"><input data-import-program-name value="${escapeHtml(preview.program.name)}" aria-label="Program adı"><div class="small muted">${escapeHtml(preview.source.fileName)} · ${escapeHtml(preview.source.fileType.toUpperCase())}</div><button class="danger-btn full" data-delete-import="${escapeHtml(preview.importId)}">Bu yüklemeyi sil</button></section>
    ${preview.program.days.map((day, dayIndex) => importDay(preview, day, dayIndex)).join('')}
    ${errors.length ? `<div class="import-warning error">Çözüm bekleyen kayıtlar var: ${escapeHtml(errors.join(', '))}</div>` : ''}
    <div class="workout-toolbar"><button class="secondary-btn" data-action="programs">Sonra Devam Et</button><button class="primary-btn" data-action="finalize-import">Programı Oluştur</button></div>`;
}

async function deleteImportPreview(importId) {
  if (!importId) return;
  if (!confirm('Bu program yüklemesini silmek istiyor musun? Oluşturulmuş programlar ve antrenman geçmişi silinmez.')) return;
  await workoutRepository.deleteImportPreview(importId);
  if (state.importId === importId) state.importId = null;
  if (state.pendingImportId === importId) {
    state.pendingImportId = null;
    state.pendingNormalizedDocument = null;
  }
  toast('Yükleme silindi');
  return todayView();
}

function importDay(preview, day, dayIndex) { return `<article class="builder-day import-day"><input data-import-day="${dayIndex}" value="${escapeHtml(day.name)}" aria-label="Gün adı">${day.sections.map((section, sectionIndex) => `<section class="builder-section import-simple-section">${section.items.filter(item => item.itemType === 'exercise').map((item, itemIndex) => importExercise(dayIndex, sectionIndex, itemIndex, item)).join('')}</section>`).join('')}</article>`; }
function importExercise(dayIndex, sectionIndex, itemIndex, item) {
  const p = item.prescription || {};
  const match = item.exerciseMatch;
  const status = item.resolutionStatus === 'accepted-canonical' ? 'Sistem hareketi' : 'Yeni hareket';
  const extraFields = [
    ['Kilo', 'weightText', p.weightText],
    ['RIR', 'rirText', p.rirText],
    ['RPE', 'rpeText', p.rpeText],
    ['Dinlenme', 'restText', p.restText],
    ['Tempo', 'tempoText', p.tempoText],
    ['Süre', 'durationText', p.durationText],
    ['Mesafe', 'distanceText', p.distanceText]
  ].filter(([, , value]) => value !== undefined && value !== null && String(value).trim() !== '');
  const field = (label, key, value) => `<label>${label}<input data-import-field="${dayIndex}:${sectionIndex}:${itemIndex}:${key}" value="${escapeHtml(value || '')}"></label>`;
  return `<article class="builder-exercise import-exercise">
    <div class="match-status ${item.resolutionStatus === 'accepted-canonical' ? 'matched' : 'custom'}">${status}</div>
    <b>${itemIndex + 1}. ${escapeHtml(match?.matchedName || item.sourceExerciseName)}</b>
    ${match ? `<div class="small muted">Dosyadaki ad: ${escapeHtml(item.sourceExerciseName)}</div>` : ''}
    <div class="compact-fields"><label>Set<input data-import-field="${dayIndex}:${sectionIndex}:${itemIndex}:setsText" value="${escapeHtml(p.setsText || p.sets || '')}"></label><label>Tekrar<input data-import-field="${dayIndex}:${sectionIndex}:${itemIndex}:repsText" value="${escapeHtml(p.repsText || '')}"></label></div>
    ${extraFields.length ? `<div class="details open"><div class="detail-grid">${extraFields.map(([label, key, value]) => field(label, key, value)).join('')}</div></div>` : ''}
    <input data-import-search="${dayIndex}:${sectionIndex}:${itemIndex}" placeholder="Hareketi değiştir">
    <div class="search-results" id="import-search-${dayIndex}-${sectionIndex}-${itemIndex}"></div>
  </article>`;
}

function importErrorMessage(code) { return ({ UNSUPPORTED_FILE: 'PDF, DOCX veya XLSX dosyası seçin.', EMPTY_DOCUMENT: 'Dosya boş.', SCAN_ONLY_PDF: 'Bu PDF metin içermiyor. OCR desteği henüz eklenmedi.', CORRUPT_PDF: 'PDF okunamadı.', CORRUPT_DOCX: 'Word dosyası okunamadı.', CORRUPT_XLSX: 'Excel dosyası okunamadı.', UNSUPPORTED_BROWSER_COMPRESSION: 'Bu tarayıcı DOCX/XLSX dosyalarını açmak için gereken sıkıştırma desteğine sahip değil.', OPENAI_OFFLINE: 'Analiz için internet bağlantısı gerekiyor.', OPENAI_API_KEY_MISSING: 'Program analizi şu anda yapılandırılmadı.', OPENAI_RATE_LIMITED: 'Program analizi geçici olarak yoğun.', AI_IMPORT_RATE_LIMITED: 'Program analiz limiti doldu. Biraz sonra tekrar deneyin.', OPENAI_TIMEOUT: 'Program analizi beklenenden uzun sürdü.', OPENAI_REQUEST_FAILED: 'Program analiz edilirken bir sorun oluştu.', DOCUMENT_TOO_LARGE: 'Dosya analiz için çok büyük.', PARSER_FAILURE: 'Dosya içeriğinden güvenli bir program oluşturulamadı.' })[code] || 'Dosya işlenemedi.'; }

async function openProgram(programId) {
  const program = await workoutRepository.getProgram(programId);
  if (!program) return toast('Program bulunamadı');
  state.builder = null;
  state.picker = null;
  const exerciseDb = await loadExerciseDatabase();
  const names = new Map(exerciseDb.map(item => [item.id, item.nameTr]));
  const exercisesById = new Map(exerciseDb.map(item => [item.id, item]));
  title.textContent = program.name;
  app.innerHTML = `<section class="summary-card"><b>${escapeHtml(program.name)}</b><div class="small muted">Bir günü başlatarak kayıt akışına geç.</div></section>${program.days.map(day => `<article class="day-card program-day"><div class="day">${escapeHtml(day.name)}</div>${day.sections.map(section => `<div class="program-section"><b>${escapeHtml(section.title)}</b>${section.items.filter(item => item.itemType === 'exercise').map(item => programExerciseRow(item, names, exercisesById)).join('')}</div>`).join('')}<button class="primary-btn full" data-start-program-day="${program.id}:${day.id}">Başlat</button></article>`).join('')}`;
  state.openProgram = { program, names }; nav('programs');
}

function programExerciseRow(item, names, exercisesById) {
  const canonical = exercisesById.get(item.exerciseId);
  const displayItem = canonical || { imageUrl: item.imageUrl };
  const name = names.get(item.exerciseId) || item.customExerciseName || item.displayName || item.exerciseId || 'Hareket';
  const prescription = programPrescription(item);
  return `<div class="program-exercise"><div class="exercise-summary">${exerciseThumb(displayItem)}<span>${escapeHtml(name)}</span></div>${prescription ? `<small>${escapeHtml(prescription)}</small>` : ''}</div>`;
}

function programPrescription(item) {
  const sets = item.setsText || item.sets || '';
  const reps = item.repsText || (item.repsMin != null ? `${item.repsMin}${item.repsMax != null && item.repsMax !== item.repsMin ? `-${item.repsMax}` : ''}` : '');
  const main = [sets, reps].filter(Boolean).join(' × ');
  const details = [
    item.weightText,
    item.rirText ? `RIR ${item.rirText}` : '',
    item.rpeText ? `RPE ${item.rpeText}` : '',
    item.restText,
    item.tempoText ? `Tempo ${item.tempoText}` : '',
    item.durationText,
    item.distanceText
  ].filter(Boolean);
  return [main, ...details].filter(Boolean).join(' · ');
}

async function startProgramWorkout(programId, dayId) {
  const program = await workoutRepository.getProgram(programId); const day = program?.days.find(item => item.id === dayId);
  if (!day) return toast('Gün bulunamadı');
  const names = new Map((await loadExerciseDatabase()).map(item => [item.id, item.nameTr]));
  state.executionDay = permanentDayToLegacy(day, names); state.executionExercises = new Map(state.executionDay.sections.flatMap(section => section.exercises).map(item => [item.id, item]));
  const draft = await workoutRepository.getDraft();
  if (draft && !confirm('Devam eden antrenman silinip yeni antrenman başlatılsın mı?')) return;
  await workoutRepository.saveSettings({ activeProgramId: programId });
  state.workout = { id: uid(), programId, workoutDayId: dayId, startedAt: new Date().toISOString(), status: 'active', completedActivities: {}, sets: {} };
  await workoutRepository.saveDraft(state.workout); await renderWorkout();
}

async function startWorkout(workoutDayId) {
  const draft = await workoutRepository.getDraft();
  if (draft && !confirm('Devam eden antrenman silinip yeni antrenman başlatılsın mı?')) return;
  state.workout = {
    id: uid(),
    programId: A2_PROGRAM.id,
    workoutDayId,
    startedAt: new Date().toISOString(),
    status: 'active',
    completedActivities: {},
    sets: {}
  };
  await workoutRepository.saveDraft(state.workout);
  await renderWorkout();
}

async function resumeWorkout() {
  state.workout = await workoutRepository.getDraft();
  const day = await hydrateExecutionDay(state.workout);
  if (!day) { await workoutRepository.clearDraft(); state.workout = null; toast('Devam eden antrenman bulunamadı.'); return todayView(); }
  await renderWorkout();
}

async function renderWorkout() {
  const workout = state.workout;
  const day = executionDayFor(workout);
  const images = await exerciseImageMap();
  const settings = await workoutRepository.getSettings();
  const counts = workoutCounts(workout);
  syncTimerFromWorkout();
  startTimerInterval();
  if (state.timerEndsAt && timerSecondsLeft() <= 0) setTimeout(checkTimer, 0);
  title.textContent = day.label;
  app.innerHTML = `
    <section class="summary-card">
      <b>${escapeHtml(day.label)}</b>
      <div class="progress"><div style="width:${Math.min(100, counts.done / counts.total * 100)}%"></div></div>
      <div class="small muted">${counts.done}/${counts.total} hareket/blok kayıtlandı • Başlangıç ${new Date(workout.startedAt).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })}</div>
    </section>
    ${day.sections.map(section => `<div class="section-title ${section.type}">${escapeHtml(section.name)}</div>${section.exercises.map(exercise => exerciseCard(exercise, section.type, images, settings)).join('')}`).join('')}
    <div class="workout-toolbar">
      <button class="secondary-btn" data-action="home">Kapat</button>
      <button class="primary-btn" data-action="finish">Antrenmanı Bitir</button>
    </div>`;
  nav('home');
}

function timerHtml(exerciseId) {
  const left = timerSecondsLeft();
  if (left <= 0 || state.timerExerciseId !== exerciseId) return '';
  return `<div class="timer" aria-live="polite">
    <span>Dinlenme</span><strong id="timerText">${fmt(left)}</strong>
    <div><button data-action="timer-reset">Sıfırla</button><button data-action="timer-stop">Atla</button></div>
  </div>`;
}

function exerciseHeader(exercise) {
  const name = `<button class="exercise-name video-name-link" data-video-exercise="${escapeHtml(exercise.canonicalExerciseId || '')}" data-video-exercise-name="${escapeHtml(exercise.name)}">${escapeHtml(exercise.name)}</button>`;
  return `<div class="exercise-summary">${exerciseThumb({ imageUrl: exercise.imageUrl })}<div>${name}${exercise.setType === 'warmup' ? '<div class="warmup-label">Isınma seti</div>' : ''}</div></div>`;
}

function exerciseCard(exercise, sectionType, images = new Map(), settings = {}) {
  exercise.imageUrl ||= images.get(exercise.canonicalExerciseId || exercise.id) || null;
  const prescription = exercise.prescription.text;
  const prescriptionHtml = prescription ? `<div class="prescription">${escapeHtml(prescription)}</div>` : '';
  if (['activation', 'stretch'].includes(exercise.setType)) {
    const done = Boolean(state.workout.completedActivities[exercise.id]);
    return `<article class="exercise-card simple ${sectionType}">
      <div class="exercise-head">${exerciseHeader(exercise)}${prescriptionHtml}</div>
      <div class="simple-done">
        ${done ? '<span class="done-badge">Tamamlandı</span>' : '<span class="muted small">Aktivasyon / süre çalışması</span>'}
        <button class="secondary-btn" data-toggle-activity="${exercise.id}">${done ? 'Geri Al' : 'Tamam'}</button>
      </div>
    </article>`;
  }
  const current = state.workout.sets[exercise.id] || {};
  const unit = settings.weightUnit === 'lb' ? 'lbs' : 'kg';
  const rows = Array.from({ length: exercise.prescription.plannedSets }, (_, i) => setRow(exercise, i + 1, current[i + 1], unit)).join('');
  return `<article class="exercise-card ${exercise.setType}" id="ex-${exercise.id}">
    <div class="exercise-head">
      ${exerciseHeader(exercise)}
      ${prescriptionHtml}
    </div>
    ${timerHtml(exercise.id)}
    <div data-last="${exercise.id}">${lastBlock(exercise.id, exercise.canonicalExerciseId || exercise.id, unit)}</div>
    ${progressionText(exercise.id, unit)}
    <div class="labels"><span>Set</span><span>${escapeHtml(unit)}</span><span>Tekrar</span><span>RIR</span><span></span></div>
    ${rows}
  </article>`;
}

function setRow(exercise, setNumber, set, unit = 'kg') {
  const planned = exercise.planned || {};
  const weight = set?.weight ?? planned.weight ?? '';
  const reps = set?.reps ?? planned.reps ?? '';
  const rir = set?.rir ?? planned.rir ?? '';
  return `<div class="set-row ${set ? 'saved' : ''}">
    <div class="set-n">${setNumber}</div>
    <input inputmode="decimal" autocomplete="off" pattern="[0-9]*[.,]?[0-9]*" placeholder="${escapeHtml(unit)}" id="kg-${exercise.id}-${setNumber}" value="${escapeHtml(weight)}">
    <input inputmode="numeric" autocomplete="off" pattern="[0-9]*" placeholder="tekrar" id="rp-${exercise.id}-${setNumber}" value="${escapeHtml(reps)}">
    <input inputmode="numeric" autocomplete="off" pattern="[0-9]*" placeholder="RIR" id="ri-${exercise.id}-${setNumber}" value="${escapeHtml(rir)}">
    <div class="set-actions">
      <button class="save-set" data-save-set="${exercise.id}:${setNumber}" aria-label="Set kaydet">${set ? '↻' : '✓'}</button>
      ${set ? `<button class="delete-set" data-delete-set="${exercise.id}:${setNumber}" aria-label="Set sil">×</button>` : ''}
    </div>
  </div>`;
}

function lastBlock(exerciseId, lookupExerciseId = exerciseId, unit = 'kg') {
  const last = lastFor(lookupExerciseId);
  if (!last) return '<div class="last empty">Geçen Antrenman: İlk kayıt</div>';
  const rows = last.sets.map(set => `<div>${escapeHtml(set.weight || '-')} ${escapeHtml(unit)} × ${escapeHtml(set.reps || '-')} @ RIR ${escapeHtml(set.rir || '-')}</div>`).join('');
  return `<button class="last last-fill" data-fill-last="${exerciseId}:${lookupExerciseId}"><b>Geçen Antrenman</b><span>${new Date(last.session.startedAt).toLocaleDateString('tr-TR')}</span>${rows}<em>Bu değerleri doldur</em></button>`;
}

function fillFromLastWorkout(exerciseId, lookupExerciseId) {
  const last = lastFor(lookupExerciseId);
  if (!last) return toast('Geçmiş kayıt bulunamadı');
  if (!confirm('Geçen antrenmandaki değerler bu forma doldurulsun mu?')) return;
  last.sets.forEach((set, index) => {
    const setNumber = Number(set.setNumber) || index + 1;
    const kg = document.querySelector(`#kg-${exerciseId}-${setNumber}`);
    const reps = document.querySelector(`#rp-${exerciseId}-${setNumber}`);
    const rir = document.querySelector(`#ri-${exerciseId}-${setNumber}`);
    if (kg) kg.value = set.weight || '';
    if (reps) reps.value = set.reps || '';
    if (rir) rir.value = set.rir || '';
  });
  toast('Geçmiş değerler dolduruldu');
}

let cachedSessions = [];

function lastFor(exerciseId) {
  for (let i = cachedSessions.length - 1; i >= 0; i -= 1) {
    const sets = cachedSessions[i].sets.filter(set => set.exerciseId === exerciseId);
    if (sets.length) return { session: cachedSessions[i], sets };
  }
  return null;
}

function progressionText(exerciseId, unit = 'kg') {
  const entries = [];
  for (let i = cachedSessions.length - 1; i >= 0 && entries.length < 2; i -= 1) {
    const sets = cachedSessions[i].sets.filter(set => set.exerciseId === exerciseId);
    if (sets.length) entries.push(sets);
  }
  if (entries.length < 2) return '';
  const current = aggregateByWeight(entries[0]);
  const previous = aggregateByWeight(entries[1]);
  const messages = [];
  Object.entries(current).forEach(([weight, reps]) => {
    if (previous[weight] !== undefined && reps > previous[weight]) messages.push(`${weight} ${unit} toplam tekrar: ${previous[weight]} → ${reps}`);
  });
  return messages.length ? `<div class="progress-note">Progresyon: ${escapeHtml(messages.join(' • '))}</div>` : '';
}

function aggregateByWeight(sets) {
  return sets.reduce((acc, set) => {
    const weight = String(set.weight ?? '').trim();
    const reps = Number(set.reps);
    if (weight && Number.isFinite(reps)) acc[weight] = (acc[weight] || 0) + reps;
    return acc;
  }, {});
}

async function saveSet(exerciseId, setNumber) {
  const exercise = executionExercise(exerciseId);
  const weight = document.querySelector(`#kg-${exerciseId}-${setNumber}`).value.trim().replace(',', '.');
  const reps = document.querySelector(`#rp-${exerciseId}-${setNumber}`).value.trim();
  const rir = document.querySelector(`#ri-${exerciseId}-${setNumber}`).value.trim();
  if (!weight && !reps) return toast('Kg veya tekrar gir');
  state.workout.sets[exerciseId] ??= {};
  const old = state.workout.sets[exerciseId][setNumber];
  state.workout.sets[exerciseId][setNumber] = {
    id: old?.id || uid(),
    sessionId: state.workout.id,
    exerciseId: exercise.canonicalExerciseId || exerciseId,
    exerciseName: exercise.name,
    setNumber,
    setType: exercise.setType,
    weight,
    reps,
    rir,
    completedAt: old?.completedAt || new Date().toISOString(),
    updatedAt: old ? new Date().toISOString() : null
  };
  await workoutRepository.saveDraft(state.workout);
  if (['working', 'core'].includes(exercise.setType)) await startTimer(exercise.id);
  await renderWorkout();
  toast(old ? 'Set güncellendi' : 'Set kaydedildi');
}

async function deleteSet(exerciseId, setNumber) {
  delete state.workout.sets[exerciseId]?.[setNumber];
  if (!Object.keys(state.workout.sets[exerciseId] || {}).length) delete state.workout.sets[exerciseId];
  await workoutRepository.saveDraft(state.workout);
  await renderWorkout();
  toast('Set silindi');
}

async function toggleActivity(exerciseId) {
  if (state.workout.completedActivities[exerciseId]) delete state.workout.completedActivities[exerciseId];
  else state.workout.completedActivities[exerciseId] = new Date().toISOString();
  await workoutRepository.saveDraft(state.workout);
  await renderWorkout();
}

function plannedRestSeconds(exercise) {
  const raw = String(exercise?.planned?.rest || '').trim().toLocaleLowerCase('tr-TR');
  if (!raw) return null;
  const value = Number(raw.replace(',', '.').match(/\d+(?:\.\d+)?/)?.[0]);
  if (!Number.isFinite(value) || value <= 0) return null;
  if (raw.includes('dk') || raw.includes('dak') || raw.includes('min')) return Math.round(value * 60);
  return Math.round(value);
}

function timerSecondsLeft() {
  if (!state.timerEndsAt) return 0;
  const endTime = new Date(state.timerEndsAt).getTime();
  if (!Number.isFinite(endTime)) return 0;
  return Math.max(0, Math.ceil((endTime - Date.now()) / 1000));
}

function syncTimerFromWorkout() {
  const timer = state.workout?.timer;
  if (!timer?.endsAt) {
    clearTimerInterval();
    state.timerEndsAt = null;
    state.timerExerciseId = null;
    state.timerNotified = false;
    return;
  }
  state.timerExerciseId = timer.exerciseId;
  state.timerEndsAt = timer.endsAt;
  state.timerNotified = Boolean(timer.notified);
}

function clearTimerInterval() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
}

function startTimerInterval() {
  clearTimerInterval();
  if (!state.timerEndsAt || timerSecondsLeft() <= 0) return;
  state.timer = setInterval(checkTimer, 1000);
}

async function notifyRestComplete() {
  if (state.timerNotified) return;
  state.timerNotified = true;
  if (state.workout?.timer) {
    state.workout.timer.notified = true;
    await workoutRepository.saveDraft(state.workout);
  }
  const titleText = 'Dinlenme tamam';
  if ('Notification' in window && Notification.permission === 'granted') {
    try {
      if ('serviceWorker' in navigator) {
        const registration = await navigator.serviceWorker.ready;
        registration.showNotification(titleText, { body: 'Sonraki sete hazırsın.', icon: './icons/icon-192.png', badge: './icons/icon-192.png', tag: 'a2-rest-timer', renotify: true });
      } else {
        new Notification(titleText, { body: 'Sonraki sete hazırsın.' });
      }
      return;
    } catch {}
  }
  toast(titleText);
}

async function startTimer(exerciseId = state.timerExerciseId) {
  clearTimerInterval();
  const settings = await workoutRepository.getSettings();
  const exercise = executionExercise(exerciseId);
  const seconds = plannedRestSeconds(exercise) || settings.rest || 90;
  state.timerExerciseId = exerciseId;
  state.timerEndsAt = new Date(Date.now() + seconds * 1000).toISOString();
  state.timerNotified = false;
  if (state.workout) {
    state.workout.timer = { exerciseId, endsAt: state.timerEndsAt, durationSeconds: seconds, notified: false };
    await workoutRepository.saveDraft(state.workout);
  }
  startTimerInterval();
}

async function resetTimer() {
  await startTimer(state.timerExerciseId);
  await renderWorkout();
}

async function checkTimer() {
  if (!state.timerEndsAt) return;
  const left = timerSecondsLeft();
  const el = document.querySelector('#timerText');
  if (el) el.textContent = fmt(left);
  if (left > 0) return;
  await notifyRestComplete();
  await stopTimer(false);
  await renderWorkout();
}

async function stopTimer(rerender = true) {
  clearTimerInterval();
  state.timerEndsAt = null;
  state.timerExerciseId = null;
  state.timerNotified = false;
  if (state.workout?.timer) {
    delete state.workout.timer;
    await workoutRepository.saveDraft(state.workout);
  }
  if (rerender && state.workout) await renderWorkout();
}

function fmt(seconds) {
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

async function finishWorkout(force = false) {
  const counts = workoutCounts(state.workout);
  if (!force && counts.done < counts.total) {
    app.insertAdjacentHTML('afterbegin', `<div class="finish-warning">
      <b>Eksik hareket var</b><span>${counts.total - counts.done} hareket/blok tamamlanmamış görünüyor.</span>
      <button class="secondary-btn" data-action="render-workout">Devam Et</button>
      <button class="primary-btn" data-action="force-finish">Yine de Bitir</button>
    </div>`);
    window.scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }
  const session = buildSession(state.workout);
  session.summary = sessionSummary(session);
  await stopTimer(false);
  await workoutRepository.addSession(session);
  await workoutRepository.clearDraft();
  cachedSessions = await workoutRepository.getSessions();
  state.workout = null;
  renderSummary(session);
}

function buildSession(workout) {
  return {
    id: workout.id,
    programId: workout.programId,
    workoutDayId: workout.workoutDayId,
    startedAt: workout.startedAt,
    completedAt: new Date().toISOString(),
    status: 'completed',
    completedActivities: Object.keys(workout.completedActivities || {}),
    sets: Object.values(workout.sets).flatMap(group => Object.values(group)).sort((a, b) => a.completedAt.localeCompare(b.completedAt))
  };
}

function sessionSummary(session) {
  const durationMin = Math.max(0, Math.round((new Date(session.completedAt) - new Date(session.startedAt)) / 60000));
  const setCount = session.sets.length;
  const completedExercises = new Set(session.sets.map(set => set.exerciseId)).size + (session.completedActivities?.length || 0);
  const volume = session.sets.reduce((sum, set) => {
    const weight = Number(set.weight);
    const reps = Number(set.reps);
    return Number.isFinite(weight) && Number.isFinite(reps) ? sum + weight * reps : sum;
  }, 0);
  return { durationMin, setCount, completedExercises, volume };
}

function renderSummary(session) {
  title.textContent = 'Özet';
  const s = session.summary || sessionSummary(session);
  app.innerHTML = `<section class="summary-card finish-summary">
    <h2>Antrenman Kaydedildi</h2>
    <div class="metric-grid">
      <div><b>${s.durationMin}</b><span>dk</span></div>
      <div><b>${s.completedExercises}</b><span>hareket</span></div>
      <div><b>${s.setCount}</b><span>set</span></div>
      <div><b>${Math.round(s.volume)}</b><span>kg × tekrar</span></div>
    </div>
    <button class="primary-btn full" data-action="history">Geçmişe Git</button>
  </section>`;
  nav('');
}

async function historyView() {
  state.view = 'history';
  title.textContent = 'Geçmiş';
  cachedSessions = await workoutRepository.getSessions();
  const programs = await workoutRepository.getPrograms();
  const sessions = [...cachedSessions].reverse();
  app.innerHTML = `
    <section class="history-tabs">
      <button class="tab-btn active" data-action="history">Antrenmanlar</button>
      <button class="tab-btn" data-action="exercise-history">Hareketler</button>
    </section>
    ${sessions.length ? sessions.map(session => sessionCard(session, sessionDayLabel(session, programs))).join('') : '<div class="summary-card">Henüz kayıt yok.</div>'}`;
  nav('history');
}

function sessionCard(session, label = 'Antrenman') {
  const summary = session.summary || sessionSummary(session);
  const grouped = Object.groupBy ? Object.groupBy(session.sets, set => set.exerciseId) : groupBy(session.sets, set => set.exerciseId);
  return `<article class="history-card">
    <div class="history-head">
      <div><h3>${escapeHtml(label)}</h3><div class="sub">${new Date(session.startedAt).toLocaleString('tr-TR')} • ${summary.durationMin} dk</div></div>
      <button class="danger-btn small-btn" data-delete-session="${session.id}">Sil</button>
    </div>
    <div class="history-metrics">${summary.completedExercises} hareket • ${summary.setCount} set • ${Math.round(summary.volume)} kg × tekrar</div>
    <div class="session-lines">${Object.entries(grouped).map(([exerciseId, sets]) => `<p><b>${escapeHtml(findExercise(exerciseId)?.name || sets[0]?.exerciseName || exerciseId)}</b><br>${sets.map(set => `${escapeHtml(set.weight || '-')} kg × ${escapeHtml(set.reps || '-')} @ RIR ${escapeHtml(set.rir || '-')}`).join('<br>')}</p>`).join('')}</div>
  </article>`;
}

function groupBy(items, fn) {
  return items.reduce((acc, item) => {
    const key = fn(item);
    acc[key] ||= [];
    acc[key].push(item);
    return acc;
  }, {});
}

async function deleteSession(sessionId) {
  if (!confirm('Bu antrenman geçmişten silinsin mi?')) return;
  await workoutRepository.deleteSession(sessionId);
  await historyView();
  toast('Antrenman silindi');
}

async function exerciseHistory(selected = '') {
  state.view = 'history';
  title.textContent = 'Hareket Geçmişi';
  cachedSessions = await workoutRepository.getSessions();
  const exerciseIds = [...new Set(cachedSessions.flatMap(session => session.sets.map(set => set.exerciseId)))].sort();
  const chosen = selected || exerciseIds[0] || '';
  app.innerHTML = `
    <section class="history-tabs">
      <button class="tab-btn" data-action="history">Antrenmanlar</button>
      <button class="tab-btn active" data-action="exercise-history">Hareketler</button>
    </section>
    ${exerciseIds.length ? `<select class="exercise-select" id="exerciseSelect">${exerciseIds.map(id => `<option value="${id}" ${id === chosen ? 'selected' : ''}>${escapeHtml(findExercise(id)?.name || id)}</option>`).join('')}</select>${exerciseRows(chosen)}` : '<div class="summary-card">Henüz hareket kaydı yok.</div>'}`;
  nav('history');
}

function exerciseRows(exerciseId) {
  const rows = cachedSessions.flatMap(session => session.sets.filter(set => set.exerciseId === exerciseId).map(set => ({ session, set })));
  if (!rows.length) return '<div class="summary-card">Bu hareket için kayıt yok.</div>';
  return `<div class="history-card"><h3>${escapeHtml(findExercise(exerciseId)?.name || exerciseId)}</h3><div class="table-wrap"><table>
    <thead><tr><th>Tarih</th><th>Kg</th><th>Tekrar</th><th>RIR</th></tr></thead>
    <tbody>${rows.map(row => `<tr><td>${new Date(row.session.startedAt).toLocaleDateString('tr-TR')}</td><td>${escapeHtml(row.set.weight || '-')}</td><td>${escapeHtml(row.set.reps || '-')}</td><td>${escapeHtml(row.set.rir || '-')}</td></tr>`).join('')}</tbody>
  </table></div></div>`;
}

async function backup() {
  state.view = 'backup';
  title.textContent = 'Yedek';
  const settings = await workoutRepository.getSettings();
  app.innerHTML = `<section class="backup-card">
    <h3>Verilerini koru</h3>
    <p class="muted">Kayıtlar bu cihazdaki IndexedDB alanında saklanır. JSON tam yedek, CSV set log çıktısıdır.</p>
    <button class="primary-btn full" data-action="export-json">JSON Yedeği İndir</button>
    <button class="secondary-btn full" data-action="export-csv">CSV Log İndir</button>
  </section>
  <section class="backup-card">
    <h3>Geri yükle</h3>
    <input type="file" id="restoreFile" accept="application/json">
    <button class="secondary-btn full" data-action="restore-json">JSON'dan Geri Yükle</button>
  </section>
  <section class="backup-card">
    <h3>Dinlenme sayacı</h3>
    <label class="setting-row">Saniye <input id="restSetting" inputmode="numeric" type="number" min="15" step="5" value="${settings.rest || 90}"></label>
    <button class="secondary-btn" data-action="save-settings">Kaydet</button>
  </section>`;
  nav('backup');
}

async function saveSettings() {
  const current = await workoutRepository.getSettings();
  await workoutRepository.saveSettings({
    rest: Number(document.querySelector('#restSetting')?.value) || 90,
    weightUnit: document.querySelector('#weightUnitSetting')?.value === 'lb' ? 'lb' : 'kg',
    profile: {
      ...(current.profile || {}),
      displayName: document.querySelector('#displayNameSetting')?.value?.trim() || ''
    }
  });
  toast('Ayar kaydedildi');
  await accountView();
}

function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 500);
}

async function exportJSON() {
  download(`a2-yedek-${dateKey()}.json`, JSON.stringify(await workoutRepository.exportBackup(), null, 2), 'application/json');
}

async function exportCSV() {
  const data = await workoutRepository.getData();
  download(`a2-log-${dateKey()}.csv`, buildCsv(data), 'text/csv;charset=utf-8');
}

function buildCsv(data) {
  const rows = [['SessionId', 'ProgramId', 'WorkoutDayId', 'Tarih', 'Saat', 'HareketId', 'Hareket', 'Set', 'SetType', 'Kg', 'Tekrar', 'RIR', 'SetKayitZamani']];
  data.sessions.forEach(session => {
    session.sets.forEach(set => rows.push([
      session.id,
      session.programId,
      session.workoutDayId,
      new Date(session.startedAt).toLocaleDateString('tr-TR'),
      new Date(session.startedAt).toLocaleTimeString('tr-TR'),
      set.exerciseId,
      findExercise(set.exerciseId)?.name || set.exerciseName || set.exerciseId,
      set.setNumber,
      set.setType,
      set.weight,
      set.reps,
      set.rir,
      set.completedAt
    ]));
  });
  return rows.map(row => row.map(v => `"${String(v ?? '').replaceAll('"', '""')}"`).join(',')).join('\n');
}

async function restoreJSON() {
  const file = document.querySelector('#restoreFile').files[0];
  if (!file) return toast('Dosya seç');
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const parsed = JSON.parse(reader.result);
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.sessions)) throw new Error('Invalid backup');
      await workoutRepository.replaceData(parsed);
      cachedSessions = await workoutRepository.getSessions();
      toast('Yedek geri yüklendi');
      await historyView();
    } catch {
      toast('Geçersiz JSON');
    }
  };
  reader.readAsText(file);
}

function dateKey() {
  return new Date().toISOString().slice(0, 10);
}

function blankDayWithMainSection(programId, order = 1) {
  const day = blankDay(programId, order);
  day.sections.push(blankSection(day.id, 'strength', 1));
  return day;
}

function ensureMainSection(day) {
  day.sections = Array.isArray(day.sections) ? day.sections : [];
  if (!day.sections.length) day.sections.push(blankSection(day.id, 'strength', 1));
  return day.sections[0];
}

async function openBuilder(program = null) {
  state.builder = program ? structuredClone(program) : (await workoutRepository.getProgramBuilderDraft()) || blankProgram();
  state.builder.days.forEach(ensureMainSection);
  state.picker = null;
  renderBuilder();
}

async function persistBuilder() {
  const nameInput = document.querySelector('#builderName');
  if (nameInput) state.builder.name = nameInput.value.trim();
  state.builder.description = null;
  state.builder.days.forEach(ensureMainSection);
  state.builder = normalizeProgram(state.builder);
  await workoutRepository.saveProgramBuilderDraft(state.builder);
}

function renderBuilder() {
  state.view = 'builder';
  const program = state.builder; title.textContent = 'Rutin Oluştur'; nav('programs');
  app.innerHTML = `<section class="builder-head simple-builder-head"><input id="builderName" placeholder="Rutin adı" value="${escapeHtml(program.name)}"><div class="builder-actions"><button class="secondary-btn" data-action="new-routine-menu">İptal</button><button class="primary-btn" data-action="save-program">Kaydet</button></div></section>
  ${program.days.map((day, dayIndex) => builderDay(day, dayIndex)).join('')}
  <button class="secondary-btn full" data-action="add-day">+ Gün Ekle</button>`;
}

function builderDay(day, dayIndex) {
  ensureMainSection(day);
  return `<article class="builder-day simple-builder-day"><div class="builder-row"><label class="simple-day-label"><span>Gün ${dayIndex + 1}</span><input data-builder-day-name="${day.id}" value="${escapeHtml(day.name)}" aria-label="Gün adı"></label></div>
    ${day.sections.map(section => builderSection(section)).join('')}</article>`;
}

function builderSection(section) {
  return `<section class="builder-section builder-section-hidden simple-builder-section">
    ${section.items.filter(item => item.itemType === 'exercise').map((item, itemIndex) => builderExercise(item, itemIndex)).join('')}
    <div class="builder-add simple-builder-add"><input data-exercise-search="${section.id}" placeholder="Hareket ara veya yaz..." autocomplete="off"><button class="secondary-btn" data-open-picker="${section.id}">Hareket Seç</button></div><div class="search-results" id="search-${section.id}"></div>
    </section>`;
}

async function renderExercisePoolPicker() {
  const picker = state.picker;
  if (!state.builder || !picker) return renderBuilder();
  state.view = 'exercise-picker';
  title.textContent = 'Hareket Seç'; nav('programs');
  const db = await loadExerciseDatabase();
  const source = picker.query?.trim() ? await searchExercises(picker.query, 250) : sortExercisePool(db);
  const results = filterExercisePool(source, picker);
  const muscles = pickerMuscleFilters(db, picker);
  const custom = picker.query?.trim() ? `<button class="exercise-result custom-exercise-result" data-custom-exercise="${picker.sectionId}"><span><b>+ “${escapeHtml(picker.query.trim())}” özel hareketini oluştur</b><small>Havuzda yoksa bu isimle ekle</small></span></button>` : '';
  app.innerHTML = `<section class="exercise-pool-page">
    <button class="text-btn" data-close-picker>← Rutin Oluştur</button>
    <input class="exercise-select" data-picker-search="${picker.sectionId}" placeholder="Hareket ara" value="${escapeHtml(picker.query || '')}" autocomplete="off" autofocus>
    <div class="picker-label">Bölge</div>
    <div class="picker-filters">${EXERCISE_REGION_FILTERS.map(([value, label]) => `<button class="${picker.region === value ? 'active' : ''}" data-picker-region="${picker.sectionId}:${value}">${label}</button>`).join('')}</div>
    <div class="picker-label">Kas grubu</div>
    <div class="picker-filters"><button class="${picker.muscle === '' ? 'active' : ''}" data-picker-muscle="${picker.sectionId}:">Tümü</button>${muscles.map(muscle => `<button class="${picker.muscle === muscle ? 'active' : ''}" data-picker-muscle="${picker.sectionId}:${muscle}">${escapeHtml(exerciseMuscleLabel(muscle))}</button>`).join('')}</div>
    <div class="small muted">${results.length} hareket</div>
    <div class="exercise-pool-results">${exercisePoolGroups(results, picker.sectionId)}${custom}</div>
  </section>`;
}

function builderInstruction(item) { return `<div class="instruction-row"><input data-instruction="${item.id}" value="${escapeHtml(item.text)}" placeholder="Talimat"></div>`; }
function builderExercise(item, itemIndex) {
  const name = item.customExerciseName || item.displayName || item.exerciseId || 'Hareket';
  const detailField = (label, key) => `<label>${label}<input data-field="${item.id}:${key}" inputmode="text" value="${escapeHtml(item[key] || '')}"></label>`;
  return `<article class="builder-exercise-shell" data-builder-exercise-card="${item.id}" data-builder-section-card="${item.sectionId}"><button class="builder-delete-action" data-delete-item="${item.id}">Sil</button><div class="builder-exercise simple-builder-exercise" data-swipe-exercise="${item.id}">
    <div class="builder-exercise-main"><div class="builder-exercise-title"><span class="drag-handle" data-drag-exercise="${item.sectionId}:${item.id}" aria-label="Sırayı değiştir">☰</span><b>${itemIndex + 1}. ${escapeHtml(name)}</b></div>${exerciseThumb(item)}</div>
    <div class="compact-fields builder-main-fields"><label>Set<input data-field="${item.id}:setsText" inputmode="text" value="${escapeHtml(item.setsText ?? item.sets ?? '')}"></label><label>Tekrar<input data-field="${item.id}:repsText" inputmode="text" value="${escapeHtml(item.repsText ?? '')}"></label><button class="detail-toggle-btn" data-toggle-details="${item.id}" aria-label="Diğer seçenekler">${item.showDetails ? '−' : '+'}</button></div>
    <div class="details ${item.showDetails ? 'open' : ''}"><div class="detail-grid">${detailField('KG','weightText')}${detailField('RIR','rirText')}${detailField('RPE','rpeText')}${detailField('Dinlenme','restText')}${detailField('Tempo','tempoText')}${detailField('Süre','durationText')}${detailField('Mesafe','distanceText')}${detailField('Not','notes')}</div></div></div></article>`;
}

function exerciseSearchResult(sectionId, item) {
  return `<button class="exercise-result" data-select-exercise="${sectionId}:${item.id}">${exerciseThumb(item)}<span><b>${escapeHtml(item.nameTr)}</b><small>${escapeHtml(exerciseMeta(item) || (item.primaryMuscles || []).join(', ') || 'Diğer')}</small></span></button>`;
}

function exercisePoolGroups(results, sectionId) {
  if (!results.length) return '<div class="summary-card muted">Bu filtrelerle hareket bulunamadı.</div>';
  const groups = EXERCISE_REGION_FILTERS.filter(([value]) => value);
  return groups.map(([region, label]) => {
    const items = results.filter(item => exerciseRegion(item) === region);
    if (!items.length) return '';
    return `<section class="exercise-pool-group"><h3>${label}</h3>${items.map(item => exerciseSearchResult(sectionId, item)).join('')}</section>`;
  }).join('');
}

function sectionLabel(type) { return ({warmup:'Isınma',activation:'Aktivasyon',strength:'Ana Antrenman',core:'Core',cardio:'Kardiyo',stretch:'Stretch',mobility:'Mobilite',cooldown:'Soğuma',custom:'Özel Bölüm'})[type]; }
function findBuilderItem(id) { for (const day of state.builder.days) for (const section of day.sections) { const item = section.items.find(value => value.id === id); if (item) return { day, section, item }; } return null; }
function reorder(items, index, direction) { const target = index + direction; if (target < 0 || target >= items.length) return; [items[index], items[target]] = [items[target], items[index]]; }

async function saveProgram() {
  state.builder.name = document.querySelector('#builderName').value.trim(); state.builder.description = null;
  const canonicalIds = new Set((await loadExerciseDatabase()).map(item => item.id)); const program = normalizeProgram(state.builder); const errors = validateProgram(program, canonicalIds);
  if (errors.length) return toast(errors[0] === 'NO_WORKOUT_DAYS' ? 'En az bir gün ekleyin' : 'Programda eksik veya geçersiz alan var');
  await workoutRepository.saveProgram(program); await workoutRepository.clearProgramBuilderDraft(); state.builder = null; toast('Program kaydedildi'); await programsView();
}

async function showVideo(exerciseId, exerciseName = '') {
  const exercise = exerciseId ? await getCanonicalExercise(exerciseId) : null;
  const fallbackExercise = { id: null, name: exerciseName, nameEn: exerciseName, customExerciseName: exerciseName };
  const result = await youtube.search(exercise || fallbackExercise);
  const displayName = exercise?.nameTr || exercise?.nameEn || exerciseName || 'Form Videosu';
  if (result.status === 'search') {
    title.textContent = 'Form Videosu';
    app.innerHTML = `<section class="summary-card"><b>${escapeHtml(displayName)}</b><p class="muted">Bu hareket için YouTube araması açılacak.</p><a class="primary-btn full" href="${escapeHtml(result.url)}" target="_blank" rel="noopener">YouTube'da Ara</a><button class="secondary-btn full" data-action="render-workout">Antrenmana Dön</button></section>`;
    return;
  }
  if (result.status !== 'ok') return toast(result.message);
  state.video = { ...result, exerciseName: displayName };
  renderVideoResults();
}

function renderVideoResults() {
  if (!state.video?.videos?.length) return renderWorkout();
  title.textContent = 'Form Videosu';
  app.innerHTML = `<section class="summary-card"><b>${escapeHtml(state.video.exerciseName || 'Form Videosu')}</b><div class="video-results">${state.video.videos.map(video => `<button class="video-result" data-open-video="${video.videoId}"><img src="${escapeHtml(video.thumbnailUrl)}" alt=""><span><b>${escapeHtml(video.title)}</b><small>${escapeHtml(video.channelTitle)}</small></span></button>`).join('')}</div><button class="secondary-btn full" data-action="render-workout">Antrenmana Dön</button></section>`;
}

function openVideo(videoId) { app.innerHTML = `<section class="video-player"><iframe src="https://www.youtube.com/embed/${encodeURIComponent(videoId)}" title="YouTube form videosu" allowfullscreen></iframe><button class="secondary-btn full" data-action="video-results">Video Listesine Dön</button><button class="secondary-btn full" data-action="render-workout">Antrenmana Dön</button></section>`; }

app.addEventListener('click', async event => {
  const target = event.target.closest('button');
  if (!target) return;
  if (target.dataset.providerDisabled !== undefined) return toast('Bu giriş yöntemi yakında kullanılabilir olacak.');
  if (target.dataset.oauthProvider) return authService.startOAuth(target.dataset.oauthProvider, state.authMode);
  if (target.dataset.togglePassword !== undefined) { const input = document.querySelector('#authPassword'); if (input) { input.type = input.type === 'password' ? 'text' : 'password'; target.textContent = input.type === 'password' ? 'Göster' : 'Gizle'; } return; }
  if (target.dataset.fillLast) { const [exerciseId, lookupExerciseId] = target.dataset.fillLast.split(':'); return fillFromLastWorkout(exerciseId, lookupExerciseId); }
  if (target.dataset.onboardingValue) { const [key, value] = target.dataset.onboardingValue.split(':'); state.onboarding[key] = value; return onboardingView(); }
  if (target.dataset.startDay) return startWorkout(target.dataset.startDay);
  if (target.dataset.resumeImport) return resumeImport(target.dataset.resumeImport);
  if (target.dataset.deleteImport) return deleteImportPreview(target.dataset.deleteImport);
  if (target.dataset.checkImport) { const preview = await workoutRepository.getImportPreview(target.dataset.checkImport); state.pendingImportId = target.dataset.checkImport; state.pendingNormalizedDocument = preview?.normalizedDocument || null; return pollImportJob(target.dataset.checkImport, true).catch(error => toast(importErrorMessage(error.code || 'OPENAI_REQUEST_FAILED'))); }
  if (target.dataset.retryImport) return retryImportAnalysis(target.dataset.retryImport);
  if (target.dataset.importCustom) { const [day, section, item] = target.dataset.importCustom.split(':').map(Number); const exercise = (await workoutRepository.getImportPreview(state.importId)).program.days[day].sections[section].items[item]; exercise.resolutionStatus = 'accepted-custom'; exercise.userEditedExerciseName = exercise.userEditedExerciseName || exercise.normalizedExerciseName || exercise.sourceExerciseName; await workoutRepository.saveImportPreview(await workoutRepository.getImportPreview(state.importId)); return renderImportPreview(state.importId); }
  if (target.dataset.importSelect) { const [day, section, item, exerciseId] = target.dataset.importSelect.split(':'); const preview = await workoutRepository.getImportPreview(state.importId); const exercise = preview.program.days[Number(day)].sections[Number(section)].items[Number(item)]; const canonical = await getCanonicalExercise(exerciseId); exercise.exerciseMatch = { status: 'matched', exerciseId, matchedName: canonical?.nameTr || exerciseId, score: 1, candidates: [] }; exercise.resolutionStatus = 'accepted-canonical'; exercise.userEditedExerciseName = null; await workoutRepository.saveImportPreview(preview); return renderImportPreview(state.importId); }
  if (target.dataset.unparsed) { const [index, resolution] = target.dataset.unparsed.split(':'); const preview = await workoutRepository.getImportPreview(state.importId); const item = preview.unparsedContent[Number(index)]; item.resolutionStatus = resolution === 'note' ? 'assigned' : resolution; if (resolution === 'instruction') { const section = preview.program.days[0]?.sections[0]; if (section) section.items.push({ itemType: 'instruction', order: section.items.length + 1, text: item.text, sourceReference: item.sourceReference }); } else if (resolution === 'note') preview.program.notes = `${preview.program.notes ? `${preview.program.notes}\n` : ''}${item.text}`; await workoutRepository.saveImportPreview(preview); return renderImportPreview(state.importId); }
  if (target.dataset.openPicker) {
    const sectionId = target.dataset.openPicker;
    const query = document.querySelector(`[data-exercise-search="${sectionId}"]`)?.value || '';
    state.picker = { sectionId, query, region: '', muscle: '' };
    return renderExercisePoolPicker();
  }
  if (target.dataset.closePicker !== undefined) { state.picker = null; return renderBuilder(); }
  if (target.dataset.pickerRegion !== undefined || target.dataset.pickerMuscle !== undefined) {
    const [sectionId, value = ''] = (target.dataset.pickerRegion ?? target.dataset.pickerMuscle).split(':');
    if (!state.picker || state.picker.sectionId !== sectionId) return;
    if (target.dataset.pickerRegion !== undefined) { state.picker.region = value; state.picker.muscle = ''; }
    else state.picker.muscle = value;
    return renderExercisePoolPicker();
  }
  if (target.dataset.selectExercise) { const [sectionId, exerciseId] = target.dataset.selectExercise.split(':'); const section = state.builder.days.flatMap(day => day.sections).find(item => item.id === sectionId); const item = blankExercise(section.id, section.items.length + 1, exerciseId); const canonical = await getCanonicalExercise(exerciseId); item.displayName = canonical?.nameTr || canonical?.nameEn || exerciseId; item.imageUrl = canonical?.media?.image || null; section.items.push(item); state.picker = null; await persistBuilder(); return renderBuilder(); }
  if (target.dataset.customExercise) { const section = state.builder.days.flatMap(day => day.sections).find(item => item.id === target.dataset.customExercise); const value = (document.querySelector(`[data-exercise-search="${section.id}"]`)?.value || state.picker?.query || '').trim(); if (!value) return toast('Hareket adı yazın'); section.items.push(blankExercise(section.id, section.items.length + 1, null, value)); state.picker = null; await persistBuilder(); return renderBuilder(); }
  if (target.dataset.startProgramDay) { const [programId, dayId] = target.dataset.startProgramDay.split(':'); return startProgramWorkout(programId, dayId); }
  if (target.dataset.setActiveProgram) { await workoutRepository.saveSettings({ activeProgramId: target.dataset.setActiveProgram }); toast('Aktif program değişti'); return programsView(); }
  if (target.dataset.openProgram) return openProgram(target.dataset.openProgram);
  if (target.dataset.editProgram) return openBuilder(await workoutRepository.getProgram(target.dataset.editProgram));
  if (target.dataset.videoExercise !== undefined) return showVideo(target.dataset.videoExercise, target.dataset.videoExerciseName || '');
  if (target.dataset.openVideo) return openVideo(target.dataset.openVideo);
  if (target.dataset.addDay) { state.builder.days.push(blankDayWithMainSection(state.builder.id, state.builder.days.length + 1)); await persistBuilder(); return renderBuilder(); }
  if (target.dataset.addSection) { const [dayId, type] = target.dataset.addSection.split(':'); const day = state.builder.days.find(item => item.id === dayId); day.sections.push(blankSection(day.id, type, day.sections.length + 1)); await persistBuilder(); return renderBuilder(); }
  if (target.dataset.addInstruction) { const section = state.builder.days.flatMap(day => day.sections).find(item => item.id === target.dataset.addInstruction); section.items.push(blankInstruction(section.items.length + 1)); await persistBuilder(); return renderBuilder(); }
  if (target.dataset.deleteDay) { state.builder.days = state.builder.days.filter(day => day.id !== target.dataset.deleteDay); await persistBuilder(); return renderBuilder(); }
  if (target.dataset.copyDay) { const index = state.builder.days.findIndex(day => day.id === target.dataset.copyDay); const copy = structuredClone(state.builder.days[index]); copy.id = uid(); copy.name = `${copy.name} Kopya`; copy.sections.forEach(section => { section.id = uid(); section.workoutDayId = copy.id; section.items.forEach(item => { item.id = uid(); item.sectionId = section.id; item.individualSets?.forEach(set => { set.id = uid(); set.exercisePrescriptionId = item.id; }); }); }); state.builder.days.splice(index + 1, 0, copy); await persistBuilder(); return renderBuilder(); }
  if (target.dataset.deleteSection) { state.builder.days.forEach(day => day.sections = day.sections.filter(section => section.id !== target.dataset.deleteSection)); await persistBuilder(); return renderBuilder(); }
  if (target.dataset.copySection) { for (const day of state.builder.days) { const index = day.sections.findIndex(section => section.id === target.dataset.copySection); if (index >= 0) { const copy = structuredClone(day.sections[index]); copy.id = uid(); copy.workoutDayId = day.id; copy.title = `${copy.title} Kopya`; copy.items.forEach(item => { item.id = uid(); item.sectionId = copy.id; item.individualSets?.forEach(set => { set.id = uid(); set.exercisePrescriptionId = item.id; }); }); day.sections.splice(index + 1, 0, copy); } } await persistBuilder(); return renderBuilder(); }
  if (target.dataset.deleteItem) { state.builder.days.forEach(day => day.sections.forEach(section => section.items = section.items.filter(item => item.id !== target.dataset.deleteItem))); await persistBuilder(); return renderBuilder(); }
  if (target.dataset.copyItem) { const found = findBuilderItem(target.dataset.copyItem); const index = found.section.items.findIndex(item => item.id === target.dataset.copyItem); const copy = structuredClone(found.item); copy.id = uid(); copy.individualSets?.forEach(set => { set.id = uid(); set.exercisePrescriptionId = copy.id; }); found.section.items.splice(index + 1, 0, copy); await persistBuilder(); return renderBuilder(); }
  if (target.dataset.toggleDetails) { const found = findBuilderItem(target.dataset.toggleDetails); found.item.showDetails = !found.item.showDetails; await persistBuilder(); return renderBuilder(); }
  if (target.dataset.addIndividualSet) { const found = findBuilderItem(target.dataset.addIndividualSet); found.item.individualSets.push({ id: uid(), exercisePrescriptionId: found.item.id, setNumber: found.item.individualSets.length + 1, setType: 'working', reps: null, repsText: null, weight: null, weightUnit: null, weightText: null, rir: null, rirText: null, rpe: null, rpeText: null, restSeconds: null, restText: null, notes: null }); await persistBuilder(); return renderBuilder(); }
  if (target.dataset.deleteIndividualSet) { const [itemId, setId] = target.dataset.deleteIndividualSet.split(':'); const found = findBuilderItem(itemId); found.item.individualSets = found.item.individualSets.filter(set => set.id !== setId).map((set, index) => ({ ...set, setNumber: index + 1 })); await persistBuilder(); return renderBuilder(); }
  if (target.dataset.moveDay) { const [index, direction] = target.dataset.moveDay.split(':').map(Number); reorder(state.builder.days, index, direction); await persistBuilder(); return renderBuilder(); }
  if (target.dataset.moveSection) { const [dayId, index, direction] = target.dataset.moveSection.split(':'); reorder(state.builder.days.find(day => day.id === dayId).sections, Number(index), Number(direction)); await persistBuilder(); return renderBuilder(); }
  if (target.dataset.moveItem) { const [itemId, index, direction] = target.dataset.moveItem.split(':'); const found = findBuilderItem(itemId); reorder(found.section.items, Number(index), Number(direction)); await persistBuilder(); return renderBuilder(); }
  if (target.dataset.saveSet) {
    const [exerciseId, setNumber] = target.dataset.saveSet.split(':');
    return saveSet(exerciseId, Number(setNumber));
  }
  if (target.dataset.deleteSet) {
    const [exerciseId, setNumber] = target.dataset.deleteSet.split(':');
    return deleteSet(exerciseId, Number(setNumber));
  }
  if (target.dataset.toggleActivity) return toggleActivity(target.dataset.toggleActivity);
  if (target.dataset.deleteSession) return deleteSession(target.dataset.deleteSession);
  const action = target.dataset.action;
  if (action === 'onboarding-start') { state.onboarding = { step: 0 }; return onboardingView(); }
  if (action === 'returning-login') { state.onboarding = null; return authView('', 'login'); }
  if (action === 'auth-back') { if (state.onboarding) return onboardingView(); return welcomeView(); }
  if (action === 'onboarding-back') { if (state.onboarding.step <= 0) return welcomeView(); state.onboarding.step -= 1; return onboardingView(); }
  if (action === 'onboarding-skip') { const step = onboardingSteps[state.onboarding.step]; state.onboarding[step.key] = null; state.onboarding.step += 1; return state.onboarding.step >= onboardingSteps.length ? authView('', 'register') : onboardingView(); }
  if (action === 'onboarding-next') { const step = onboardingSteps[state.onboarding.step]; if (step.input) state.onboarding[step.key] = document.querySelector('#onboardingInput')?.value || null; if (!step.optional && !state.onboarding[step.key]) return; state.onboarding.step += 1; return state.onboarding.step >= onboardingSteps.length ? authView('', 'register') : onboardingView(); }
  if (action === 'add-day') { state.builder.days.push(blankDayWithMainSection(state.builder.id, state.builder.days.length + 1)); await persistBuilder(); return renderBuilder(); }
  if (action === 'resume') return resumeWorkout();
  if (action === 'login') return submitAuth('login');
  if (action === 'register') return submitAuth('register');
  if (action === 'migrate-legacy') { try { await sync.migrateLegacy(); cachedSessions = await workoutRepository.getSessions(); toast('Mevcut veriler hesabınıza aktarıldı.'); return todayView(); } catch { return toast('Veriler aktarılırken bir sorun oluştu.'); } }
  if (action === 'skip-legacy') return todayView();
  if (action === 'install-app') { if (state.installPrompt) { state.installPrompt.prompt(); await state.installPrompt.userChoice; state.installPrompt = null; return accountView(); } const help = document.querySelector('#installHelp'); if (help) help.hidden = false; return; }
  if (action === 'logout') { await authService.logout(); sync.stop(); await workoutRepository.setActiveAccount(null); state.user = null; state.workout = null; state.onboarding = null; state.authMode = 'login'; cachedSessions = []; return welcomeView(); }
  if (action === 'delete-account') { let info; try { info = await authService.deletionInfo(); } catch { return toast('Hesap bilgisi alınamadı. Hesabınız silinmedi.'); } if (info.appleReauthRequired) return toast('Hesabınızı silmeden önce Apple ile çıkış yapıp yeniden giriş yapın. Hesabınız silinmedi.'); let password; if (info.requiresPassword) { password = prompt('Hesabı silmek için şifrenizi girin. Bu işlem bulut verilerinizi siler.'); if (password === null) return; } if (!confirm('Hesabınızı ve bulut verilerinizi kalıcı olarak silmek istediğinizi onaylıyor musunuz? Bu işlem geri alınamaz.')) return; try { await authService.deleteAccount(password); sync.stop(); await workoutRepository.setActiveAccount(null); state.user = null; state.onboarding = null; state.authMode = 'login'; cachedSessions = []; toast('Hesabınız silindi.'); return welcomeView(); } catch (error) { const code = error?.code || ''; return toast(code === 'AUTH_INVALID_CREDENTIALS' ? 'Şifre doğrulanamadı. Hesabınız silinmedi.' : code === 'APPLE_REAUTH_REQUIRED' ? 'Apple ile çıkış yapıp yeniden giriş yapın. Hesabınız silinmedi.' : code.startsWith('APPLE_') ? 'Apple bağlantısı kaldırılamadı. Hesabınız silinmedi.' : 'Hesap silinemedi. Hesabınız silinmedi; tekrar deneyin.'); } }
  if (action === 'programs') return workoutHomeView();
  if (action === 'my-routines') return myRoutinesView();
  if (action === 'new-routine-menu') return newRoutineMenuView();
  if (action === 'discover-routines') return discoverRoutinesView();
  if (action === 'empty-workout') return toast('Boş antrenman başlatma yakında eklenecek.');
  if (action === 'new-program') return openBuilder(blankProgram());
  if (action === 'file-import') return fileImportView();
  if (action === 'retry-openai') return retryImportAnalysis();
  if (action === 'report-import') return reportImportIssue();
  if (action === 'finalize-import') {
    try { const ids = new Set((await loadExerciseDatabase()).map(item => item.id)); const result = await workoutRepository.finalizeImportAtomically(state.importId, preview => finalizeImport(preview, ids)); toast(result.existing ? 'Program zaten oluşturulmuştu' : 'Program oluşturuldu'); return openProgram(result.program.id); } catch (error) { console.error(error); return toast('Program oluşturulamadı: çözülmemiş kayıtları kontrol edin'); }
  }
  if (action === 'resume-builder') return openBuilder();
  if (action === 'save-program') return saveProgram();
  if (action === 'home') return home();
  if (action === 'exercises') return exercisesView();
  if (action === 'render-workout') return renderWorkout();
  if (action === 'video-results') return renderVideoResults();
  if (action === 'finish') return finishWorkout();
  if (action === 'force-finish') return finishWorkout(true);
  if (action === 'timer-reset') return resetTimer();
  if (action === 'timer-stop') return stopTimer();
  if (action === 'history') return historyView();
  if (action === 'exercise-history') return exerciseHistory();
  if (action === 'export-json') return exportJSON();
  if (action === 'export-csv') return exportCSV();
  if (action === 'restore-json') return restoreJSON();
  if (action === 'save-settings') return saveSettings();
  if (action === 'enable-notifications') return enableNotifications();
});

app.addEventListener('input', async event => {
  if (event.target.id === 'exerciseLibrarySearch') return updateExerciseLibraryResults(event.target.value);
  if (event.target.id === 'importFile') { const file = event.target.files[0]; if (file) return importFile(file); }
  if (state.importId) {
    const preview = await workoutRepository.getImportPreview(state.importId);
    if ('importProgramName' in event.target.dataset) { preview.program.name = event.target.value; await workoutRepository.saveImportPreview(preview); return; }
    if (event.target.dataset.importDay) { preview.program.days[Number(event.target.dataset.importDay)].name = event.target.value; await workoutRepository.saveImportPreview(preview); return; }
    if (event.target.dataset.importSection) { const [day, section] = event.target.dataset.importSection.split(':').map(Number); preview.program.days[day].sections[section].title = event.target.value; await workoutRepository.saveImportPreview(preview); return; }
    if (event.target.dataset.importField) { const [day, section, item, field] = event.target.dataset.importField.split(':'); const exercise = preview.program.days[Number(day)].sections[Number(section)].items[Number(item)]; if (field === 'notes') exercise.notes = event.target.value || null; else { const prescription = exercise.prescription; prescription[field] = event.target.value || null; if (field === 'setsText') prescription.sets = /^\d+$/.test(event.target.value) ? Number(event.target.value) : null; } await workoutRepository.saveImportPreview(preview); return; }
    if (event.target.dataset.importSearch) { const [day, section, item] = event.target.dataset.importSearch.split(':'); const results = await searchExercises(event.target.value, 5); const holder = document.querySelector(`#import-search-${day}-${section}-${item}`); holder.innerHTML = results.map(result => `<button data-import-select="${day}:${section}:${item}:${result.id}">${escapeHtml(result.nameTr)}</button>`).join(''); return; }
  }
  if (!state.builder) return;
  if (event.target.dataset.pickerSearch) {
    if (!state.picker || state.picker.sectionId !== event.target.dataset.pickerSearch) return;
    state.picker.query = event.target.value;
    return renderExercisePoolPicker();
  }
  if (event.target.dataset.builderDayName) { state.builder.days.find(day => day.id === event.target.dataset.builderDayName).name = event.target.value; return persistBuilder(); }
  if (event.target.dataset.builderSectionTitle) { state.builder.days.flatMap(day => day.sections).find(section => section.id === event.target.dataset.builderSectionTitle).title = event.target.value; return persistBuilder(); }
  if (event.target.dataset.instruction) { findBuilderItem(event.target.dataset.instruction).item.text = event.target.value; return persistBuilder(); }
  if (event.target.dataset.field) { const [itemId, field] = event.target.dataset.field.split(':'); const item = findBuilderItem(itemId).item; const value = event.target.value; item[field] = value; if (field === 'setsText') item.sets = /^\d+$/.test(value.trim()) ? Number(value) : null; if (field === 'repsText') { const match = value.trim().match(/^(\d+)\s*(?:-\s*(\d+))?$/); item.repsMin = match ? Number(match[1]) : null; item.repsMax = match ? Number(match[2] || match[1]) : null; } return persistBuilder(); }
  if (event.target.dataset.setField) { const [itemId, setId, field] = event.target.dataset.setField.split(':'); const set = findBuilderItem(itemId).item.individualSets.find(item => item.id === setId); set[field] = event.target.value || null; return persistBuilder(); }
  if (event.target.dataset.exerciseSearch) {
    const sectionId = event.target.dataset.exerciseSearch; const query = event.target.value; const results = await searchExercises(query, 24); const holder = document.querySelector(`#search-${sectionId}`);
    if (state.picker?.sectionId === sectionId) state.picker = { ...state.picker, query, results };
    holder.innerHTML = results.map(item => exerciseSearchResult(sectionId, item)).join('');
  }
});

app.addEventListener('focusin', async event => {
  if (!state.builder || !event.target.dataset.exerciseSearch) return;
  const sectionId = event.target.dataset.exerciseSearch;
  const holder = document.querySelector(`#search-${sectionId}`);
  if (!holder || holder.innerHTML.trim()) return;
  const results = await searchExercises(event.target.value, 24);
  holder.innerHTML = results.map(item => exerciseSearchResult(sectionId, item)).join('');
});

app.addEventListener('change', event => {
  if (event.target.id === 'profileAvatarInput') {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      const current = await workoutRepository.getSettings();
      await workoutRepository.saveSettings({ profile: { ...(current.profile || {}), avatarDataUrl: String(reader.result || '') } });
      toast('Profil resmi kaydedildi');
      await accountView();
    };
    reader.readAsDataURL(file);
    return;
  }
  if (state.importId && event.target.dataset.importSectionType) { workoutRepository.getImportPreview(state.importId).then(preview => { const [day, section] = event.target.dataset.importSectionType.split(':').map(Number); preview.program.days[day].sections[section].sectionType = event.target.value; return workoutRepository.saveImportPreview(preview); }); return; }
  if (state.builder && event.target.dataset.builderSectionType) { state.builder.days.flatMap(day => day.sections).find(section => section.id === event.target.dataset.builderSectionType).sectionType = event.target.value; persistBuilder(); return; }
  if (event.target.id === 'exerciseSelect') exerciseHistory(event.target.value);
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) checkTimer();
});

window.addEventListener('focus', () => {
  checkTimer();
});

app.addEventListener('pointerdown', event => {
  const handle = event.target.closest('[data-drag-exercise]');
  const swipeCard = event.target.closest('[data-swipe-exercise]');
  if (state.view === 'builder' && state.builder && handle) {
    const [sectionId, itemId] = handle.dataset.dragExercise.split(':');
    const shell = document.querySelector(`[data-builder-exercise-card="${itemId}"]`);
    if (!shell) return;
    event.preventDefault();
    handle.setPointerCapture?.(event.pointerId);
    document.querySelectorAll('[data-swipe-exercise].swiped').forEach(item => item.classList.remove('swiped'));
    state.builderDrag = { sectionId, itemId, pointerId: event.pointerId, targetIndex: null };
    shell.classList.add('dragging');
    document.body.classList.add('is-dragging-builder-exercise');
    return;
  }
  if (state.view === 'builder' && state.builder && swipeCard && !event.target.closest('input, button, [data-drag-exercise]')) {
    state.builderSwipe = { itemId: swipeCard.dataset.swipeExercise, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, active: false };
    swipeCard.setPointerCapture?.(event.pointerId);
  }
});

app.addEventListener('pointermove', event => {
  if (state.builderDrag && event.pointerId === state.builderDrag.pointerId) {
    const drag = state.builderDrag;
    const shell = document.querySelector(`[data-builder-exercise-card="${drag.itemId}"]`);
    if (!shell) return;
    const cards = [...document.querySelectorAll(`[data-builder-section-card="${drag.sectionId}"]`)].filter(card => card.dataset.builderExerciseCard !== drag.itemId);
    const targetIndex = cards.findIndex(card => event.clientY < card.getBoundingClientRect().top + card.getBoundingClientRect().height / 2);
    drag.targetIndex = targetIndex === -1 ? cards.length : targetIndex;
    cards.forEach((card, index) => {
      card.classList.toggle('drop-before', index === drag.targetIndex);
      card.classList.toggle('drop-after', drag.targetIndex === cards.length && index === cards.length - 1);
    });
    shell.classList.add('dragging');
    return;
  }
  if (state.builderSwipe && event.pointerId === state.builderSwipe.pointerId) {
    const swipe = state.builderSwipe;
    const dx = event.clientX - swipe.startX;
    const dy = event.clientY - swipe.startY;
    const card = document.querySelector(`[data-swipe-exercise="${swipe.itemId}"]`);
    if (!card) return;
    if (!swipe.active && Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy) * 1.2) swipe.active = true;
    if (!swipe.active) return;
    event.preventDefault();
    const offset = Math.max(-96, Math.min(0, dx));
    card.style.transform = `translateX(${offset}px)`;
  }
});

app.addEventListener('pointerup', async event => {
  if (state.builderDrag && event.pointerId === state.builderDrag.pointerId) {
    const drag = state.builderDrag;
    state.builderDrag = null;
    document.body.classList.remove('is-dragging-builder-exercise');
    const section = state.builder.days.flatMap(day => day.sections).find(item => item.id === drag.sectionId);
    if (!section) return renderBuilder();
    const exerciseItems = section.items.filter(item => item.itemType === 'exercise');
    const dragged = exerciseItems.find(item => item.id === drag.itemId);
    if (!dragged) return renderBuilder();
    const remaining = exerciseItems.filter(item => item.id !== drag.itemId);
    remaining.splice(drag.targetIndex ?? remaining.length, 0, dragged);
    section.items = remaining.map((item, index) => ({ ...item, order: index + 1 }));
    await persistBuilder();
    renderBuilder();
    return;
  }
  if (state.builderSwipe && event.pointerId === state.builderSwipe.pointerId) {
    const swipe = state.builderSwipe;
    state.builderSwipe = null;
    const card = document.querySelector(`[data-swipe-exercise="${swipe.itemId}"]`);
    if (!card) return;
    const dx = event.clientX - swipe.startX;
    document.querySelectorAll('[data-swipe-exercise].swiped').forEach(item => { if (item !== card) item.classList.remove('swiped'); });
    card.style.transform = '';
    card.classList.toggle('swiped', swipe.active && dx < -44);
  }
});

app.addEventListener('pointercancel', () => {
  const wasBuilderGesture = Boolean(state.builderDrag || state.builderSwipe);
  state.builderDrag = null;
  state.builderSwipe = null;
  document.body.classList.remove('is-dragging-builder-exercise');
  if (wasBuilderGesture && state.view === 'builder' && state.builder) renderBuilder();
});

document.querySelectorAll('.nav-btn').forEach(button => {
  button.addEventListener('click', () => ({ home: todayView, programs: workoutHomeView, account: accountView }[button.dataset.nav]()));
});
document.querySelector('#historyBtn').addEventListener('click', historyView);

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}
window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); state.installPrompt = event; });
window.addEventListener('appinstalled', () => { state.installPrompt = null; });

init();

async function init() {
  try {
    const user = await authService.me();
    const params = new URLSearchParams(window.location.search);
    const authError = params.get('auth_error');
    if (authError) {
      params.delete('auth_error');
      const cleanUrl = `${window.location.pathname}${params.toString() ? `?${params}` : ''}${window.location.hash}`;
      window.history.replaceState({}, '', cleanUrl);
    }
    window.addEventListener('online', async () => sync.push(await workoutRepository.getData()));
    window.__a2 = { repository: workoutRepository, schemaVersion: SCHEMA_VERSION, buildCsv, searchExercises, loadExerciseDatabase, validateImportPreview, finalizeImport, matchImportExercises, youtube, documentExtractor, localImportParser, openAIImportParser, authService, sync };
    if (!user && authError) return authView(oauthErrorMessage(authError), 'login');
    if (!user) return welcomeView();
    await completeAuth(user);
  } catch (error) {
    app.innerHTML = '<section class="summary-card">Uygulama başlatılamadı. Sayfayı yenileyin.</section>';
    console.error(error);
  }
}
