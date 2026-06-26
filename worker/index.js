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
      const id = env.TIMING_STATE.idFromName('singleton');
      const stub = env.TIMING_STATE.get(id);
      return stub.fetch(request);
    }

    // Static assets
    return env.ASSETS.fetch(request);
  },
};
