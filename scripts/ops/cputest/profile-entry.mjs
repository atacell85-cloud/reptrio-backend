// CPU profile entry for the isolated test Worker only (runbook §5c). Workers timers do not advance during CPU work, so
// cost components are separated by running ONE component per cron trigger and reading each invocation's cpuTime.
import worker from '../../../worker/index.js';
import { lifecycleReady } from '../../../worker/account-lifecycle.js';
const select1 = async (env, n) => { for (let i = 0; i < n; i++) await env.DB.prepare('SELECT 1 AS one').first(); };
const VARIANTS = {
  '* * * * *': async () => {},                                    // P0 baseline: invocation + bundle startup
  '*/1 * * * *': env => select1(env, 1),                           // P1 one D1 round trip
  '0-59 * * * *': env => select1(env, 10),                         // P2 ten D1 round trips
  '0-59/1 * * * *': env => lifecycleReady(env.DB),                  // P3 schema readiness check
  '* 0-23 * * *': (env, ctx) => worker.scheduled({ cron: '*/15 * * * *', scheduledTime: Date.now() }, env, ctx), // P4 real maintenance
};
export default {
  async scheduled(event, env, ctx) {
    const run = VARIANTS[event.cron];
    if (!run) return;
    let inner; await run(env, { waitUntil(p) { inner = p; } }); if (inner) await inner;
    console.log(JSON.stringify({ event: 'cpu_profile', variant: event.cron }));
  },
};
