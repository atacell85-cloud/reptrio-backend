// Second CPU profile round (isolated test Worker only): D1 batch cost, fetch cost (service-binding mock and the real
// provider network path unauthenticated -> 401), and a single-statement readiness probe.
const realDeletes = async n => { for (let i = 0; i < n; i++) { const r = await fetch(`https://api.openai.com/v1/responses/resp_cputest_${i}`, { method: 'DELETE', headers: { Authorization: 'Bearer sk-cputest-invalid' }, signal: AbortSignal.timeout(10000) }); await r.body?.cancel(); } };
const VARIANTS = {
  '* * * * *': () => realDeletes(10),
  '*/1 * * * *': () => realDeletes(20),
  '0-59 * * * *': () => realDeletes(5),
  '*/3 * * * *': () => realDeletes(40),
  '* 0-23 * * *': async () => {},
};
export default {
  async scheduled(event, env) {
    const run = VARIANTS[event.cron]; if (!run) return;
    let detail = null; try { const r = await run(env); detail = r && typeof r === 'object' && !Array.isArray(r) ? Object.keys(r) : Array.isArray(r) ? r.length : null; } catch (e) { detail = 'error:' + e.message; }
    console.log(JSON.stringify({ event: 'cpu_profile', variant: event.cron, detail }));
  },
};
