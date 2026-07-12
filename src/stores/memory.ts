/**
 * In-memory session store
 *
 * Simple Map-based store for development and testing.
 * NOT recommended for production - sessions are lost on restart.
 */

import type { Session, Backend } from '../types.js';
import { SessionNotFoundError } from '../errors.js';

interface CacheEntry<T = unknown> {
  value: T;
  expiresAt?: number;
}

/**
 * In-memory session store (implements full Backend interface)
 */
export class MemoryStore implements Backend {
  private sessions: Map<string, Session> = new Map();
  private credentials: Map<string, Map<string, string | Buffer>> = new Map();
  private cache: Map<string, CacheEntry> = new Map();
  private metrics: Map<string, Map<string, number>> = new Map();
  private cacheSweepInterval: NodeJS.Timeout | null = null;

  constructor() {
    // Start background sweep for expired cache entries (every 60s)
    this.cacheSweepInterval = setInterval(() => {
      this.sweepExpiredCache();
    }, 60000);
  }

  /**
   * Save session state
   */
  async save(session: Session): Promise<void> {
    this.sessions.set(session.id, { ...session });
  }

  /**
   * Load session state
   */
  async load(id: string): Promise<Session | null> {
    const session = this.sessions.get(id);
    return session ? { ...session } : null;
  }

  /**
   * Delete session state
   */
  async delete(id: string): Promise<void> {
    this.sessions.delete(id);
  }

  /**
   * List all sessions
   */
  async list(filter?: Partial<Session>, limit?: number, offset?: number): Promise<Session[]> {
    let sessions = Array.from(this.sessions.values());

    // Apply filters if provided
    if (filter) {
      sessions = sessions.filter((session) => {
        for (const [key, value] of Object.entries(filter)) {
          if (session[key as keyof Session] !== value) {
            return false;
          }
        }
        return true;
      });
    }

    // Apply pagination
    if (offset !== undefined && offset > 0) {
      sessions = sessions.slice(offset);
    }
    if (limit !== undefined && limit > 0) {
      sessions = sessions.slice(0, limit);
    }

    // Return copies to prevent external mutation
    return sessions.map((s) => ({ ...s }));
  }

  /**
   * Check if session exists
   */
  async exists(id: string): Promise<boolean> {
    return this.sessions.has(id);
  }

  /**
   * Update session metadata
   */
  async update(id: string, updates: Partial<Session>): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) {
      throw new SessionNotFoundError(id);
    }

    // Merge updates
    Object.assign(session, updates);
    this.sessions.set(id, session);
  }

  /**
   * Clear all sessions (useful for testing)
   */
  async clear(): Promise<void> {
    this.sessions.clear();
  }

  /**
   * Get session count
   */
  get size(): number {
    return this.sessions.size;
  }

  // ============================================================================
  // CredentialStore implementation
  // ============================================================================

  /**
   * Save a credential
   */
  async saveCredential(sessionId: string, key: string, value: string | Buffer): Promise<void> {
    if (!this.credentials.has(sessionId)) {
      this.credentials.set(sessionId, new Map());
    }

    this.credentials.get(sessionId)!.set(key, value);
  }

  /**
   * Load a credential
   */
  async loadCredential(sessionId: string, key: string): Promise<string | Buffer | null> {
    const sessionCreds = this.credentials.get(sessionId);
    if (!sessionCreds) {
      return null;
    }

    return sessionCreds.get(key) ?? null;
  }

  /**
   * Delete a credential
   */
  async deleteCredential(sessionId: string, key: string): Promise<void> {
    const sessionCreds = this.credentials.get(sessionId);
    if (sessionCreds) {
      sessionCreds.delete(key);
    }
  }

  /**
   * List all credential keys for a session
   */
  async listCredentialKeys(sessionId: string): Promise<string[]> {
    const sessionCreds = this.credentials.get(sessionId);
    if (!sessionCreds) {
      return [];
    }

    return Array.from(sessionCreds.keys());
  }

  /**
   * Clear all credentials for a session
   */
  async clearCredentials(sessionId: string): Promise<void> {
    this.credentials.delete(sessionId);
  }

  // ============================================================================
  // CacheStore implementation
  // ============================================================================

  /**
   * Get cached value (best-effort, never throws)
   */
  async getCached<T = unknown>(namespace: string, key: string): Promise<T | null> {
    try {
      const cacheKey = `${namespace}:${key}`;
      const entry = this.cache.get(cacheKey);

      if (!entry) {
        return null;
      }

      // Check expiry
      if (entry.expiresAt && entry.expiresAt < Date.now()) {
        this.cache.delete(cacheKey);
        return null;
      }

      return entry.value as T;
    } catch (error) {
      // Best-effort: log and return null on error
      console.warn(`[MemoryStore] Cache read error for ${namespace}:${key}:`, error);
      return null;
    }
  }

  /**
   * Set cached value (best-effort, never throws)
   */
  async setCached<T = unknown>(namespace: string, key: string, value: T, ttlMs?: number): Promise<void> {
    try {
      const cacheKey = `${namespace}:${key}`;
      const entry: CacheEntry<T> = {
        value,
        expiresAt: ttlMs ? Date.now() + ttlMs : undefined,
      };

      this.cache.set(cacheKey, entry as CacheEntry);
    } catch (error) {
      // Best-effort: log and continue on error
      console.warn(`[MemoryStore] Cache write error for ${namespace}:${key}:`, error);
    }
  }

  /**
   * Delete cached value
   */
  async deleteCached(namespace: string, key: string): Promise<void> {
    try {
      const cacheKey = `${namespace}:${key}`;
      this.cache.delete(cacheKey);
    } catch (error) {
      console.warn(`[MemoryStore] Cache delete error for ${namespace}:${key}:`, error);
    }
  }

  /**
   * Clear all cached values in a namespace
   */
  async clearCache(namespace: string): Promise<void> {
    try {
      const prefix = `${namespace}:`;
      for (const key of this.cache.keys()) {
        if (key.startsWith(prefix)) {
          this.cache.delete(key);
        }
      }
    } catch (error) {
      console.warn(`[MemoryStore] Cache clear error for namespace ${namespace}:`, error);
    }
  }

  /**
   * Get cache size
   */
  getCacheSize(): number {
    return this.cache.size;
  }

  /**
   * Background sweep for expired cache entries
   */
  private sweepExpiredCache(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if (entry.expiresAt && entry.expiresAt < now) {
        this.cache.delete(key);
      }
    }
  }

  // ============================================================================
  // MetricsStore implementation
  // ============================================================================

  /**
   * Increment a metric counter
   */
  async increment(sessionId: string, metric: string, delta: number = 1): Promise<void> {
    if (!this.metrics.has(sessionId)) {
      this.metrics.set(sessionId, new Map());
    }

    const sessionMetrics = this.metrics.get(sessionId)!;
    const current = sessionMetrics.get(metric) ?? 0;
    sessionMetrics.set(metric, current + delta);
  }

  /**
   * Get a metric value
   */
  async get(sessionId: string, metric: string): Promise<number> {
    const sessionMetrics = this.metrics.get(sessionId);
    if (!sessionMetrics) {
      return 0;
    }

    return sessionMetrics.get(metric) ?? 0;
  }

  /**
   * Get all metrics for a session
   */
  async getAll(sessionId: string): Promise<Record<string, number>> {
    const sessionMetrics = this.metrics.get(sessionId);
    if (!sessionMetrics) {
      return {};
    }

    const result: Record<string, number> = {};
    for (const [key, value] of sessionMetrics.entries()) {
      result[key] = value;
    }

    return result;
  }

  /**
   * Reset metrics for a session
   */
  async reset(sessionId: string, metric?: string): Promise<void> {
    const sessionMetrics = this.metrics.get(sessionId);
    if (!sessionMetrics) {
      return;
    }

    if (metric) {
      // Reset specific metric
      sessionMetrics.delete(metric);
    } else {
      // Reset all metrics for session
      this.metrics.delete(sessionId);
    }
  }

  /**
   * Get total credential count across all sessions
   */
  getTotalCredentialCount(): number {
    let total = 0;
    for (const sessionCreds of this.credentials.values()) {
      total += sessionCreds.size;
    }
    return total;
  }

  /**
   * Cleanup on shutdown
   */
  destroy(): void {
    if (this.cacheSweepInterval) {
      clearInterval(this.cacheSweepInterval);
      this.cacheSweepInterval = null;
    }
  }

  // ============================================================================
  // QR Code storage (for worker/API split architectures)
  // ============================================================================

  /**
   * Save QR code with TTL
   *
   * Stores QR code emitted during session creation so worker/API split
   * architectures can retrieve it without needing a live event listener.
   *
   * @param sessionId Session ID
   * @param qr QR code string
   * @param ttlSeconds TTL in seconds (default: 120)
   */
  async saveQR(sessionId: string, qr: string, ttlSeconds: number = 120): Promise<void> {
    try {
      const key = `qr:${sessionId}`;
      const ttlMs = ttlSeconds * 1000;
      await this.setCached('wasp', key, qr, ttlMs);
    } catch (error) {
      console.warn(`[MemoryStore] QR save error for ${sessionId}:`, error);
    }
  }

  /**
   * Get stored QR code
   *
   * @param sessionId Session ID
   * @returns QR code string or null if not found/expired
   */
  async getQR(sessionId: string): Promise<string | null> {
    try {
      const key = `qr:${sessionId}`;
      return await this.getCached<string>('wasp', key);
    } catch (error) {
      console.warn(`[MemoryStore] QR read error for ${sessionId}:`, error);
      return null;
    }
  }

  /**
   * Delete stored QR code
   *
   * @param sessionId Session ID
   */
  async deleteQR(sessionId: string): Promise<void> {
    try {
      const key = `qr:${sessionId}`;
      await this.deleteCached('wasp', key);
    } catch (error) {
      console.warn(`[MemoryStore] QR delete error for ${sessionId}:`, error);
    }
  }
}
