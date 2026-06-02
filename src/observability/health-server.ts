/**
 * HTTP health server with /health, /ready, /metrics
 *
 * Provides health checks and Prometheus metrics for WaSP instances.
 * Uses stdlib node:http only, no dependencies.
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';

export interface WaspHealthState {
  connected: boolean;          // any session connected
  sessionCount: number;        // total sessions
  connectedCount: number;      // connected sessions
  socketGeneration: number;    // increments on each reconnect
  reconnectAttempt: number;    // current backoff attempt
  lastMessageReceivedAt: number | null;
  stalenessThresholdMs: number; // 0 = disabled
}

export interface HealthServerOptions {
  port?: number;       // default 9090
  host?: string;       // default '0.0.0.0'
  enabled?: boolean;   // default true
  getState: () => WaspHealthState;
  logger?: { info(msg: string, ctx?: any): void; error?(msg: string, ctx?: any): void };
}

export interface HealthServerHandle {
  stop(): Promise<void>;
}

const noop = () => {};
const startTime = Date.now();

/**
 * Start WaSP health server
 *
 * @example
 * ```typescript
 * import { startWaspHealthServer } from 'wasp-protocol';
 *
 * const handle = startWaspHealthServer({
 *   port: 9090,
 *   getState: () => ({
 *     connected: true,
 *     sessionCount: 5,
 *     connectedCount: 3,
 *     socketGeneration: 1,
 *     reconnectAttempt: 0,
 *     lastMessageReceivedAt: Date.now(),
 *     stalenessThresholdMs: 300_000,
 *   }),
 * });
 *
 * // Later: await handle.stop();
 * ```
 */
export function startWaspHealthServer(options: HealthServerOptions): HealthServerHandle {
  const {
    port = 9090,
    host = '0.0.0.0',
    enabled = true,
    getState,
    logger
  } = options;

  const log = {
    info: logger?.info ?? noop,
    error: logger?.error ?? logger?.info ?? noop,
  };

  if (!enabled) {
    return { stop: async () => {} };
  }

  // Security headers
  const securityHeaders = {
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'cache-control': 'no-store',
  };

  const sendJson = (res: ServerResponse, status: number, data: any) => {
    res.writeHead(status, { 'content-type': 'application/json', ...securityHeaders });
    res.end(JSON.stringify(data));
  };

  const sendText = (res: ServerResponse, status: number, text: string) => {
    res.writeHead(status, { 'content-type': 'text/plain; version=0.0.4', ...securityHeaders });
    res.end(text);
  };

  const send404 = (res: ServerResponse) => {
    res.writeHead(404, { 'content-type': 'text/plain', ...securityHeaders });
    res.end('Not Found');
  };

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? '/';

    try {
      if (url === '/health') {
        const state = getState();
        const uptime = Math.floor((Date.now() - startTime) / 1000);
        const isStale = state.stalenessThresholdMs > 0 && state.lastMessageReceivedAt !== null
          ? Date.now() - state.lastMessageReceivedAt > state.stalenessThresholdMs
          : false;

        const response: any = {
          status: state.connected && !isStale ? 'healthy' : 'degraded',
          connected: state.connected,
          uptime,
          sessionCount: state.sessionCount,
          connectedCount: state.connectedCount,
          stale: isStale,
        };

        if (state.lastMessageReceivedAt !== null) {
          response.lastMessageReceivedMs = Date.now() - state.lastMessageReceivedAt;
        }

        sendJson(res, 200, response);
      } else if (url === '/ready') {
        const state = getState();
        const isStale = state.stalenessThresholdMs > 0 && state.lastMessageReceivedAt !== null
          ? Date.now() - state.lastMessageReceivedAt > state.stalenessThresholdMs
          : false;

        if (state.connected && !isStale) {
          sendJson(res, 200, { ready: true });
        } else {
          sendJson(res, 503, { ready: false, reason: !state.connected ? 'not connected' : 'stale' });
        }
      } else if (url === '/metrics') {
        const state = getState();
        const uptime = Math.floor((Date.now() - startTime) / 1000);
        const isStale = state.stalenessThresholdMs > 0 && state.lastMessageReceivedAt !== null
          ? Date.now() - state.lastMessageReceivedAt > state.stalenessThresholdMs
          : false;

        const metrics: string[] = [
          '# HELP wasp_connected Whether WaSP is connected (1 = connected, 0 = disconnected)',
          '# TYPE wasp_connected gauge',
          `wasp_connected ${state.connected ? 1 : 0}`,
          '',
          '# HELP wasp_session_count Total number of sessions managed by WaSP',
          '# TYPE wasp_session_count gauge',
          `wasp_session_count ${state.sessionCount}`,
          '',
          '# HELP wasp_connected_count Number of sessions currently connected',
          '# TYPE wasp_connected_count gauge',
          `wasp_connected_count ${state.connectedCount}`,
          '',
          '# HELP wasp_socket_generation Socket generation counter (increments on reconnect)',
          '# TYPE wasp_socket_generation counter',
          `wasp_socket_generation ${state.socketGeneration}`,
          '',
          '# HELP wasp_reconnect_attempt Current reconnection attempt number',
          '# TYPE wasp_reconnect_attempt gauge',
          `wasp_reconnect_attempt ${state.reconnectAttempt}`,
          '',
          '# HELP wasp_uptime_seconds Uptime in seconds',
          '# TYPE wasp_uptime_seconds counter',
          `wasp_uptime_seconds ${uptime}`,
          '',
          '# HELP wasp_connection_stale Whether connection is stale (1 = stale, 0 = fresh)',
          '# TYPE wasp_connection_stale gauge',
          `wasp_connection_stale ${isStale ? 1 : 0}`,
          '',
        ];

        if (state.lastMessageReceivedAt !== null) {
          const lastMessageSeconds = Math.floor((Date.now() - state.lastMessageReceivedAt) / 1000);
          metrics.push(
            '# HELP wasp_last_message_received_seconds Seconds since last message received',
            '# TYPE wasp_last_message_received_seconds gauge',
            `wasp_last_message_received_seconds ${lastMessageSeconds}`,
            ''
          );
        }

        sendText(res, 200, metrics.join('\n'));
      } else {
        send404(res);
      }
    } catch (error) {
      log.error('Health server request error', { error: (error as Error).message, url });
      sendJson(res, 500, { error: 'Internal server error' });
    }
  });

  server.listen(port, host, () => {
    log.info('WaSP health server started', { host, port });
  });

  return {
    async stop() {
      return new Promise((resolve, reject) => {
        if ((server as any).closeAllConnections) {
          (server as any).closeAllConnections();
        }
        server.close((err) => {
          if (err) {
            log.error('Error stopping health server', { error: err.message });
            reject(err);
          } else {
            log.info('WaSP health server stopped');
            resolve();
          }
        });
      });
    },
  };
}
