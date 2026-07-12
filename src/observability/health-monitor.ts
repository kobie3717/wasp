/**
 * Proactive health monitoring for WaSP sessions
 *
 * Implements the "pong timer" pattern: periodically scans all sessions
 * and emits events when sessions become stale or recover.
 *
 * Unlike the reactive health-server (query on demand), this monitor
 * actively fires on an interval and alerts you when things go wrong.
 */

import type { WaSP } from '../wasp.js';
import type { EventType, Session } from '../types.js';

/**
 * Health monitor configuration
 */
export interface HealthMonitorOptions {
  /** Tick interval in milliseconds (default: 5 minutes) */
  intervalMs?: number;

  /** Staleness threshold in milliseconds (default: 5 minutes) */
  stalenessThresholdMs?: number;

  /** Log memory usage on each tick (default: false) */
  logMemory?: boolean;

  /** Custom logger */
  logger?: {
    info(msg: string, ctx?: any): void;
    warn(msg: string, ctx?: any): void;
  };
}

/**
 * Health tick data
 */
export interface HealthTickData {
  sessions: Array<{
    id: string;
    connected: boolean;
    staleSinceMs: number | null;
  }>;
  memory?: {
    heapUsed: number;
    heapTotal: number;
  };
}

/**
 * Session staleness event data
 */
export interface SessionStaleData {
  sessionId: string;
  staleSinceMs: number;
  lastActivityAt: Date | null;
}

/**
 * Proactive health monitor for WaSP sessions
 *
 * Runs on a configurable interval and emits events when sessions
 * go stale or recover. Prevents alert spam by tracking alert state.
 *
 * @example
 * ```typescript
 * import { WaSP, WaspHealthMonitor } from 'wasp-protocol';
 *
 * const wasp = new WaSP();
 * const monitor = new WaspHealthMonitor(wasp, {
 *   intervalMs: 5 * 60 * 1000,      // 5 minutes
 *   stalenessThresholdMs: 5 * 60 * 1000, // 5 minutes
 *   logMemory: true,
 * });
 *
 * wasp.on('health:degraded', (event) => {
 *   console.log('Session stale:', event.data.sessionId);
 * });
 *
 * wasp.on('health:recovered', (event) => {
 *   console.log('Session recovered:', event.data.sessionId);
 * });
 *
 * monitor.start();
 * ```
 */
export class WaspHealthMonitor {
  private wasp: WaSP;
  private options: Required<HealthMonitorOptions>;
  private timer: NodeJS.Timeout | null = null;
  private staleSessionIds: Set<string> = new Set();

  constructor(wasp: WaSP, options?: HealthMonitorOptions) {
    this.wasp = wasp;
    this.options = {
      intervalMs: options?.intervalMs ?? 5 * 60 * 1000,
      stalenessThresholdMs: options?.stalenessThresholdMs ?? 5 * 60 * 1000,
      logMemory: options?.logMemory ?? false,
      logger: options?.logger ?? {
        info: (msg: string, ctx?: any) => console.log(`[WaspHealthMonitor] ${msg}`, ctx || ''),
        warn: (msg: string, ctx?: any) => console.warn(`[WaspHealthMonitor] ${msg}`, ctx || ''),
      },
    };
  }

  /**
   * Start the health monitor
   *
   * Begins periodic health checks. Safe to call multiple times (no-op if already started).
   */
  start(): void {
    if (this.timer) {
      return; // Already running
    }

    this.options.logger.info('Health monitor started', {
      intervalMs: this.options.intervalMs,
      stalenessThresholdMs: this.options.stalenessThresholdMs,
    });

    // Run immediately on start
    this.tick().catch((error) => {
      this.options.logger.warn('Initial health check failed', { error: error.message });
    });

    // Then run on interval
    this.timer = setInterval(() => {
      this.tick().catch((error) => {
        this.options.logger.warn('Health check failed', { error: error.message });
      });
    }, this.options.intervalMs);
  }

  /**
   * Stop the health monitor
   *
   * Clears the interval timer and resets alert state.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.staleSessionIds.clear();
      this.options.logger.info('Health monitor stopped');
    }
  }

  /**
   * Perform a single health check tick
   */
  private async tick(): Promise<void> {
    const now = Date.now();
    const tickData: HealthTickData = {
      sessions: [],
    };

    // Get all sessions from the store
    const allSessions = await this.wasp.sessions.list();

    for (const session of allSessions) {
      const staleSinceMs = this.calculateStaleness(session, now);
      const isStale = staleSinceMs !== null && staleSinceMs > this.options.stalenessThresholdMs;
      const wasStale = this.staleSessionIds.has(session.id);

      tickData.sessions.push({
        id: session.id,
        connected: session.status === 'CONNECTED',
        staleSinceMs,
      });

      // Emit degraded event if newly stale
      if (isStale && !wasStale) {
        this.staleSessionIds.add(session.id);
        await this.emitHealthEvent('health:degraded', {
          sessionId: session.id,
          staleSinceMs: staleSinceMs!,
          lastActivityAt: session.lastActivityAt ?? null,
        });

        this.options.logger.warn('Session degraded (stale)', {
          sessionId: session.id,
          staleSinceMs: staleSinceMs!,
          lastActivityAt: session.lastActivityAt,
        });
      }

      // Emit recovered event if was stale but now fresh
      if (!isStale && wasStale) {
        this.staleSessionIds.delete(session.id);
        await this.emitHealthEvent('health:recovered', {
          sessionId: session.id,
          staleSinceMs: staleSinceMs ?? 0,
          lastActivityAt: session.lastActivityAt ?? null,
        });

        this.options.logger.info('Session recovered (fresh)', {
          sessionId: session.id,
          lastActivityAt: session.lastActivityAt,
        });
      }
    }

    // Add memory stats if enabled
    if (this.options.logMemory) {
      const memUsage = process.memoryUsage();
      tickData.memory = {
        heapUsed: memUsage.heapUsed,
        heapTotal: memUsage.heapTotal,
      };

      this.options.logger.info('Memory usage', {
        heapUsedMB: Math.round(memUsage.heapUsed / 1024 / 1024),
        heapTotalMB: Math.round(memUsage.heapTotal / 1024 / 1024),
      });
    }

    // Emit tick event
    await this.emitHealthEvent('health:tick', tickData);
  }

  /**
   * Calculate staleness in milliseconds
   *
   * Returns null if:
   * - Session has no lastActivityAt
   * - Session is not connected
   * - Session has never received messages (best-effort check)
   *
   * @param session Session to check
   * @param now Current timestamp
   * @returns Milliseconds since last activity, or null if not applicable
   */
  private calculateStaleness(session: Session, now: number): number | null {
    // Can't determine staleness for disconnected sessions
    if (session.status !== 'CONNECTED') {
      return null;
    }

    // No activity timestamp = can't determine staleness
    if (!session.lastActivityAt) {
      // Fallback to connectedAt if available (session just connected)
      if (session.connectedAt) {
        return now - session.connectedAt.getTime();
      }
      return null;
    }

    return now - session.lastActivityAt.getTime();
  }

  /**
   * Emit a health event via WaSP's event system
   */
  private async emitHealthEvent(type: string, data: any): Promise<void> {
    // WaSP's EventEmitter is synchronous, but we wrap in Promise for consistency
    // and to handle potential async middleware in the future
    return new Promise((resolve) => {
      // Emit using WaSP's standard event pattern
      // The event type is passed as a string since health events are custom
      this.wasp.emit(type as any, {
        type: type as EventType,
        sessionId: data.sessionId ?? 'system',
        timestamp: new Date(),
        data,
      });
      resolve();
    });
  }
}
