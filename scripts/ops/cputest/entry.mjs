// CPU test entry (test Worker only; production deploys worker/index.js directly). Maps the test's frequent cron
// strings onto the production cron names so the unchanged production handler runs each trigger's real code path
// within minutes: purge every minute (unchanged), maintenance every 5 minutes, digest every 10 minutes (production:
// 15 minutes and 06:00 UTC). Adds one object spread per invocation; no other behaviour.
import worker from '../../../worker/index.js';
const ALIAS = { '*/5 * * * *': '*/15 * * * *', '*/10 * * * *': '0 6 * * *' };
export default {
  ...worker,
  scheduled(event, env, ctx) {
    return worker.scheduled({ cron: ALIAS[event.cron] || event.cron, scheduledTime: event.scheduledTime, type: event.type }, env, ctx);
  },
};
