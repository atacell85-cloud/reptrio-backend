// Split measurement (isolated test Worker only; runbook §5c): the unchanged purge code on two cron strings at once.
// '* * * * *' sends the OpenAI deletes over the real network (answer replaced by the provider's 404 "already absent");
// '*/1 * * * *' answers them in-process without any network call. The difference is the cost of real fetches; the
// second is the D1 + JavaScript cost of a step.
import worker from '../../../worker/index.js';
const realFetch = globalThis.fetch;
let network = true;
const absent = () => new Response('{"error":{"message":"No response found","type":"invalid_request_error"}}', { status: 404, headers: { 'Content-Type': 'application/json' } });
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  if (url.startsWith('https://api.openai.com/v1/responses/') && init.method === 'DELETE') {
    if (!network) return absent();
    const upstream = await realFetch(input, init); await upstream.body?.cancel(); return absent();
  }
  return realFetch(input, init);
};
export default {
  async scheduled(event, env, ctx) {
    if (event.cron !== '* * * * *' && event.cron !== '*/1 * * * *') return;
    network = event.cron === '* * * * *';
    console.log(JSON.stringify({ event: 'cpu_split', network }));
    return worker.scheduled({ cron: '* * * * *', scheduledTime: event.scheduledTime }, env, ctx);
  },
};
