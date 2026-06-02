/**
 * Ban Risk Detection
 *
 * Monitors session health signals and emits ban_risk_high events
 * when elevated ban risk is detected.
 */

import type { MetricsStore, CacheStore } from './types.js';

/**
 * Ban risk level
 */
export type BanRiskLevel = 'medium' | 'high' | 'critical';

/**
 * Ban risk event data
 */
export interface BanRiskEvent {
  sessionId: string;
  riskLevel: BanRiskLevel;
  signals: string[];
  recommendation: string;
  timestamp: Date;
}

/**
 * Ban risk detector configuration
 */
export interface BanRiskConfig {
  /** Check interval in ms (default: 30000 = 30s) */
  checkInterval?: number;
  /** Enable detector (default: true) */
  enabled?: boolean;
  /** Rapid restart threshold (restarts in 5min window, default: 3) */
  rapidRestartThreshold?: number;
  /** High error rate percentage (default: 10%) */
  highErrorRatePercent?: number;
  /** Disconnect threshold (disconnects in 10min window, default: 5) */
  disconnectThreshold?: number;
  /** QR rescan threshold (rescans in 10min window, default: 3) */
  qrRescanThreshold?: number;
}

/**
 * Default configuration
 */
const DEFAULT_CONFIG: Required<BanRiskConfig> = {
  checkInterval: 30000, // 30 seconds
  enabled: true,
  rapidRestartThreshold: 3,
  highErrorRatePercent: 10,
  disconnectThreshold: 5,
  qrRescanThreshold: 3,
};

/**
 * Ban risk detector
 *
 * Analyzes session metrics and cache data to detect ban risk patterns.
 * Emits ban_risk_high events when thresholds are exceeded.
 */
export class BanRiskDetector {
  private config: Required<BanRiskConfig>;
  private metrics: MetricsStore;
  private cache: CacheStore;
  private checkTimer: NodeJS.Timeout | null = null;

  constructor(
    metrics: MetricsStore,
    cache: CacheStore,
    config?: BanRiskConfig
  ) {
    this.metrics = metrics;
    this.cache = cache;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Start periodic ban risk checks
   *
   * @param sessionIds Array of session IDs to monitor
   * @param onRiskDetected Callback when risk is detected
   */
  start(
    sessionIds: () => string[],
    onRiskDetected: (event: BanRiskEvent) => void
  ): void {
    if (!this.config.enabled) {
      return;
    }

    // Clear existing timer
    this.stop();

    // Setup periodic check
    this.checkTimer = setInterval(async () => {
      const sessions = sessionIds();
      for (const sessionId of sessions) {
        const riskEvent = await this.checkSession(sessionId);
        if (riskEvent) {
          onRiskDetected(riskEvent);
        }
      }
    }, this.config.checkInterval);
  }

  /**
   * Stop periodic checks
   */
  stop(): void {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }
  }

  /**
   * Check a specific session for ban risk
   *
   * @param sessionId Session ID to check
   * @returns BanRiskEvent if risk detected, null otherwise
   */
  async checkSession(sessionId: string): Promise<BanRiskEvent | null> {
    const signals: string[] = [];
    let riskLevel: BanRiskLevel = 'medium';

    // Check 1: Rapid restart rate
    const restartCount = await this.getRecentCount(sessionId, 'restarts', 5 * 60 * 1000); // 5 min
    if (restartCount >= this.config.rapidRestartThreshold) {
      signals.push('rapid_restarts');
      if (restartCount >= this.config.rapidRestartThreshold * 2) {
        riskLevel = 'critical';
      } else if (restartCount >= this.config.rapidRestartThreshold * 1.5) {
        riskLevel = 'high';
      }
    }

    // Check 2: High message error rate
    const errorRate = await this.getErrorRate(sessionId);
    if (errorRate >= this.config.highErrorRatePercent) {
      signals.push('high_error_rate');
      if (errorRate >= this.config.highErrorRatePercent * 2) {
        riskLevel = 'critical';
      } else if (riskLevel !== 'critical') {
        riskLevel = 'high';
      }
    }

    // Check 3: Unstable connection (multiple disconnects)
    const disconnectCount = await this.getRecentCount(sessionId, 'disconnects', 10 * 60 * 1000); // 10 min
    if (disconnectCount >= this.config.disconnectThreshold) {
      signals.push('unstable_connection');
      if (disconnectCount >= this.config.disconnectThreshold * 2) {
        riskLevel = 'critical';
      } else if (riskLevel === 'medium') {
        riskLevel = 'high';
      }
    }

    // Check 4: QR re-scan required multiple times
    const qrCount = await this.getRecentCount(sessionId, 'qr_scans', 10 * 60 * 1000); // 10 min
    if (qrCount >= this.config.qrRescanThreshold) {
      signals.push('frequent_qr_rescans');
      if (qrCount >= this.config.qrRescanThreshold * 2) {
        riskLevel = 'critical';
      } else if (riskLevel === 'medium') {
        riskLevel = 'high';
      }
    }

    // Check 5: Account reachout restricted error
    const hasReachoutError = await this.cache.getCached<boolean>('ban_risk', `${sessionId}:reachout_restricted`);
    if (hasReachoutError) {
      signals.push('account_reachout_restricted');
      riskLevel = 'critical';
    }

    // Check 6: Rate limit errors
    const rateLimitCount = await this.getRecentCount(sessionId, 'rate_limit_errors', 10 * 60 * 1000); // 10 min
    if (rateLimitCount > 0) {
      signals.push('rate_limited');
      if (rateLimitCount >= 3) {
        riskLevel = 'critical';
      } else if (riskLevel === 'medium') {
        riskLevel = 'high';
      }
    }

    // If no signals detected, no risk
    if (signals.length === 0) {
      return null;
    }

    // Generate recommendation based on risk level and signals
    const recommendation = this.generateRecommendation(riskLevel, signals);

    return {
      sessionId,
      riskLevel,
      signals,
      recommendation,
      timestamp: new Date(),
    };
  }

  /**
   * Get count of recent events from time-series cache
   */
  private async getRecentCount(
    sessionId: string,
    metric: string,
    windowMs: number
  ): Promise<number> {
    const key = `${sessionId}:${metric}`;
    const timestamps = await this.cache.getCached<number[]>('ban_risk', key);

    if (!timestamps || timestamps.length === 0) {
      return 0;
    }

    const cutoff = Date.now() - windowMs;
    return timestamps.filter(ts => ts >= cutoff).length;
  }

  /**
   * Calculate error rate based on recent message metrics
   */
  private async getErrorRate(sessionId: string): Promise<number> {
    const allMetrics = await this.metrics.getAll(sessionId);
    const sent = allMetrics['messages_sent'] ?? 0;
    const errors = allMetrics['message_errors'] ?? 0;

    if (sent === 0) {
      return 0;
    }

    return (errors / sent) * 100;
  }

  /**
   * Generate human-readable recommendation
   */
  private generateRecommendation(level: BanRiskLevel, signals: string[]): string {
    const recommendations: Record<BanRiskLevel, string> = {
      medium: 'Monitor session closely. Consider reducing message frequency.',
      high: 'Reduce message frequency significantly or pause session for 30 minutes.',
      critical: 'Stop all activity immediately. Session may be banned or under review. Wait 2-4 hours before reconnecting.',
    };

    let base = recommendations[level];

    // Add specific guidance based on signals
    if (signals.includes('account_reachout_restricted')) {
      base += ' Account has reachout timelock active.';
    }

    if (signals.includes('rate_limited')) {
      base += ' Rate limit detected - pause all sends.';
    }

    if (signals.includes('rapid_restarts')) {
      base += ' Too many restarts - wait before reconnecting.';
    }

    if (signals.includes('frequent_qr_rescans')) {
      base += ' Session credentials may be compromised - verify QR scans.';
    }

    return base;
  }

  /**
   * Record a restart event
   */
  async recordRestart(sessionId: string): Promise<void> {
    await this.recordEvent(sessionId, 'restarts');
  }

  /**
   * Record a disconnect event
   */
  async recordDisconnect(sessionId: string): Promise<void> {
    await this.recordEvent(sessionId, 'disconnects');
  }

  /**
   * Record a QR scan event
   */
  async recordQRScan(sessionId: string): Promise<void> {
    await this.recordEvent(sessionId, 'qr_scans');
  }

  /**
   * Record a rate limit error
   */
  async recordRateLimitError(sessionId: string): Promise<void> {
    await this.recordEvent(sessionId, 'rate_limit_errors');
  }

  /**
   * Record an account reachout restricted error
   */
  async recordReachoutRestricted(sessionId: string, expiresAt?: Date): Promise<void> {
    const ttl = expiresAt ? expiresAt.getTime() - Date.now() : 24 * 60 * 60 * 1000; // 24h default
    await this.cache.setCached('ban_risk', `${sessionId}:reachout_restricted`, true, ttl);
  }

  /**
   * Record a message error
   */
  async recordMessageError(sessionId: string): Promise<void> {
    await this.metrics.increment(sessionId, 'message_errors', 1);
  }

  /**
   * Record a generic event to time-series cache
   */
  private async recordEvent(sessionId: string, metric: string): Promise<void> {
    const key = `${sessionId}:${metric}`;
    const timestamps = await this.cache.getCached<number[]>('ban_risk', key) ?? [];

    timestamps.push(Date.now());

    // Keep only last 100 timestamps (prevent unbounded growth)
    const limited = timestamps.slice(-100);

    // Store with 1 hour TTL (old data auto-expires)
    await this.cache.setCached('ban_risk', key, limited, 60 * 60 * 1000);
  }
}
