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
      try {
        if (!env.TIMING_STATE) throw new Error('TIMING_STATE binding missing');
        const id = env.TIMING_STATE.idFromName('singleton-v2');
        const stub = env.TIMING_STATE.get(id);
        return await stub.fetch(request);
      } catch (err) {
        return new Response(JSON.stringify({ routerError: err.message, stack: err.stack }), {
          status: 500, headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    // Static assets
    return env.ASSETS.fetch(request);
  },
};
