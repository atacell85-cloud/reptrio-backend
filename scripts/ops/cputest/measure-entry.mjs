// Final CPU measurement entry (isolated test Worker only; runbook §5c). Runs the unchanged production handlers on the
// production trigger names and keeps the test Worker's existing per-minute cron strings (new cron strings take up to 15
// minutes to propagate). OpenAI deletes really go to api.openai.com (real network/TLS path; without an API key it
// answers 401), and the answer handed to the purge code is the provider's "already absent" 404, so the code runs the
// full successful-delete path without a real key. Apple revoke and D1 are real.
import worker from '../../../worker/index.js';
const ALIAS = { '* * * * *': '* * * * *', '*/3 * * * *': '*/15 * * * *', '* 0-23 * * *': '0 6 * * *' };
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  if (url.startsWith('https://api.openai.com/v1/responses/') && init.method === 'DELETE') {
    const upstream = await realFetch(input, init); await upstream.body?.cancel();
    return new Response('{"error":{"message":"No response found","type":"invalid_request_error"}}', { status: 404, headers: { 'Content-Type': 'application/json' } });
  }
  return realFetch(input, init);
};
export default {
  ...worker,
  scheduled(event, env, ctx) {
    const cron = ALIAS[event.cron];
    if (!cron) return;
    return worker.scheduled({ cron, scheduledTime: event.scheduledTime, type: event.type }, env, ctx);
  },
};
