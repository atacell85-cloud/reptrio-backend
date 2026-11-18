export function createSyncService(repository, onStatus = () => {}) {
  let user = null; let timer = null; let pushing = false; let syncVersion = 0;
  // B57-002: the account holds data this web app cannot handle (data level 3, e.g. an exercise removed in the Build 57 mobile app):
  // the server refuses its reads and writes. Local data is kept untouched, nothing is sent, the status says so.
  let upgradeRequired = false;
  const setStatus = status => onStatus(status);
  async function request(path, options = {}) {
    const response = await fetch(`/api/sync${path}`, { credentials: 'same-origin', ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(body.code || 'SYNC_FAILED'), { code: body.code || 'SYNC_FAILED' });
    return body;
  }
  return {
    async start(account) {
      user = account;
      repository.setSyncHandler(data => this.schedule(data));
      upgradeRequired = false;
      if (!navigator.onLine) return setStatus('offline');
      let remote;
      try { remote = await request('/pull'); }
      catch (error) {
        if (error.code !== 'SYNC_CLIENT_UPGRADE_REQUIRED') throw error;
        upgradeRequired = true;
        return setStatus('upgradeRequired');
      }
      const localMeta = await repository.getSyncMetadata();
      const localData = await repository.getData();
      const localIsEmpty = !localData.programs.length
        && !localData.sessions.length
        && !localData.draft
        && !localData.programBuilderDraft
        && !Object.keys(localData.importPreviews || {}).length;
      if (remote.data && (!localMeta.dirty || localIsEmpty)) await repository.replaceData(remote.data);
      syncVersion = remote.syncVersion || 0;
      setStatus('saved');
    },
    stop() { user = null; syncVersion = 0; upgradeRequired = false; clearTimeout(timer); repository.setSyncHandler(null); },
    // B57-002: true while the server refuses this web app for the signed-in account (callers word their messages with it).
    isUpgradeRequired() { return upgradeRequired; },
    async schedule(data) {
      if (!user) return;
      clearTimeout(timer);
      timer = setTimeout(() => this.push(data), 400);
    },
    async push(data) {
      if (!user || pushing) return;
      if (upgradeRequired) return setStatus('upgradeRequired');
      if (!navigator.onLine) return setStatus('offline');
      pushing = true; setStatus('syncing');
      const owner = user;
      try { const result = await request('/push', { method: 'POST', body: JSON.stringify({ data, syncVersion }) }); syncVersion = result.syncVersion; await repository.markSyncSucceeded(); setStatus('saved'); }
      catch (error) { await repository.markSyncFailed(error); if (error.code === 'SYNC_CLIENT_UPGRADE_REQUIRED' && user === owner) upgradeRequired = true; /* a late answer for a signed-out account changes nothing */ setStatus(upgradeRequired ? 'upgradeRequired' : navigator.onLine ? 'pending' : 'offline'); if (error.code === 'SYNC_CONFLICT') console.warn('Sync conflict retained locally.'); }
      finally { pushing = false; }
    },
    async migrateLegacy() { const data = await repository.importLegacyDeviceData(); await this.push(data); return data; }
  };
}
