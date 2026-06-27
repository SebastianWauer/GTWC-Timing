export { TimingState } from './TimingState.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Route WebSocket, /api/*, /ingest, /_cron to the Durable Object
    if (
      request.headers.get('Upgrade') === 'websocket' ||
      url.pathname.startsWith('/api/') ||
      url.pathname === '/ingest' ||
      url.pathname === '/_cron'
    ) {
      // 'singleton-v2': fresh DO instance. The previous one's persisted lap
      // history grew oversized during a long race and crashed DO startup (1101).
      const id = env.TIMING_STATE.idFromName('singleton-v2');
      const stub = env.TIMING_STATE.get(id);
      return stub.fetch(request);
    }

    // Static assets
    return env.ASSETS.fetch(request);
  },
};
