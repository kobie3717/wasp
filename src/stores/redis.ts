/**
 * Redis session store
 *
 * Persistent session storage using Redis.
 * Recommended for production multi-instance deployments.
 */

import type { Session, Backend } from '../types.js';
import { SessionNotFoundError } from '../errors.js';

// Redis client type - dynamically imported
type RedisClient = any;

/**
 * Redis store configuration
 */
export interface RedisStoreConfig {
  /** Redis host */
  host?: string;
  /** Redis port */
  port?: number;
  /** Redis password */
  password?: string;
  /** Redis database number */
  db?: number;
  /** Key prefix */
  keyPrefix?: string;
  /** Session TTL (seconds) - 0 for no expiry */
  ttl?: number;
}

/**
 * Redis session store
 *
 * Uses ioredis for Redis connectivity.
 * Sessions are stored as JSON with optional TTL.
 * Uses SCAN for listing (not KEYS) to avoid blocking.
 *
 * @example
 * ```typescript
 * import { RedisStore } from '@wasp/core/stores/redis';
 *
 * const store = new RedisStore({
 *   host: 'localhost',
 *   port: 6379,
 *   keyPrefix: 'wasp:session:',
 *   ttl: 86400, // 24 hours
 * });
 * ```
 */
export class RedisStore implements Backend {
  private redis: RedisClient | null = null;
  private config: Required<RedisStoreConfig>;
  private initPromise: Promise<void> | null = null;

  constructor(config?: RedisStoreConfig) {
    this.config = {
      host: config?.host ?? 'localhost',
      port: config?.port ?? 6379,
      password: config?.password ?? '',
      db: config?.db ?? 0,
      keyPrefix: config?.keyPrefix ?? 'wasp:session:',
      ttl: config?.ttl ?? 0, // 0 = no expiry
    };

    // Initialize Redis client - lazy loaded
    this.initPromise = this.initializeRedis();
  }

  /**
   * Initialize Redis client (dynamic import for optional peer dependency)
   */
  private async initializeRedis(): Promise<void> {
    try {
      const module = await import('ioredis');
      const Redis = module.default || module;
      this.redis = new (Redis as any)({
        host: this.config.host,
        port: this.config.port,
        password: this.config.password || undefined,
        db: this.config.db,
        lazyConnect: false,
        retryStrategy: (times: number) => {
          const delay = Math.min(times * 50, 2000);
          return delay;
        },
      });

      await this.redis.ping();
    } catch (error: any) {
      if (error.code === 'MODULE_NOT_FOUND') {
        throw new Error('ioredis not installed. Run: npm install ioredis');
      }
      throw error;
    }
  }

  /**
   * Ensure Redis is initialized
   */
  private async ensureInitialized(): Promise<void> {
    if (this.initPromise) {
      await this.initPromise;
      this.initPromise = null;
    }
  }

  /**
   * Get Redis key with prefix
   */
  private getKey(id: string): string {
    return `${this.config.keyPrefix}${id}`;
  }

  /**
   * Serialize session to JSON (handle Date fields)
   */
  private serialize(session: Session): string {
    return JSON.stringify(session, (_key, value) => {
      if (value instanceof Date) {
        return value.toISOString();
      }
      return value;
    });
  }

  /**
   * Deserialize session from JSON (restore Date fields)
   */
  private deserialize(data: string): Session {
    const session = JSON.parse(data);
    if (session.createdAt) session.createdAt = new Date(session.createdAt);
    if (session.connectedAt) session.connectedAt = new Date(session.connectedAt);
    if (session.lastActivityAt) session.lastActivityAt = new Date(session.lastActivityAt);
    return session;
  }

  /**
   * Save session to Redis
   */
  async save(session: Session): Promise<void> {
    await this.ensureInitialized();
    if (!this.redis) throw new Error('Redis not initialized');

    const key = this.getKey(session.id);
    const value = this.serialize(session);

    if (this.config.ttl > 0) {
      await this.redis.set(key, value, 'EX', this.config.ttl);
    } else {
      await this.redis.set(key, value);
    }
  }

  /**
   * Load session from Redis
   */
  async load(id: string): Promise<Session | null> {
    await this.ensureInitialized();
    if (!this.redis) throw new Error('Redis not initialized');

    const key = this.getKey(id);
    const data = await this.redis.get(key);

    if (!data) {
      return null;
    }

    try {
      return this.deserialize(data);
    } catch {
      return null;
    }
  }

  /**
   * Delete session from Redis
   */
  async delete(id: string): Promise<void> {
    await this.ensureInitialized();
    if (!this.redis) throw new Error('Redis not initialized');

    const key = this.getKey(id);
    await this.redis.del(key);
  }

  /**
   * List all sessions matching filter
   * Uses SCAN to avoid blocking (not KEYS)
   */
  async list(filter?: Partial<Session>, limit?: number, offset?: number): Promise<Session[]> {
    await this.ensureInitialized();
    if (!this.redis) throw new Error('Redis not initialized');

    const pattern = this.getKey('*');
    const keys: string[] = [];

    // Use SCAN cursor to avoid blocking (prevents Redis from being blocked on large datasets)
    let cursor = '0';
    do {
      const result = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = result[0];
      keys.push(...result[1]);
    } while (cursor !== '0');

    if (keys.length === 0) {
      return [];
    }

    // Get all sessions in parallel
    const values = await this.redis.mget(keys);
    const sessions: Session[] = [];

    for (const value of values) {
      if (!value) continue;

      try {
        const session = this.deserialize(value);

        // Apply filter
        if (filter) {
          let matches = true;
          for (const [key, val] of Object.entries(filter)) {
            if (session[key as keyof Session] !== val) {
              matches = false;
              break;
            }
          }
          if (!matches) continue;
        }

        sessions.push(session);
      } catch {
        // Skip invalid sessions
        continue;
      }
    }

    // Apply pagination
    let result = sessions;
    if (offset !== undefined && offset > 0) {
      result = result.slice(offset);
    }
    if (limit !== undefined && limit > 0) {
      result = result.slice(0, limit);
    }

    return result;
  }

  /**
   * Check if session exists
   */
  async exists(id: string): Promise<boolean> {
    await this.ensureInitialized();
    if (!this.redis) throw new Error('Redis not initialized');

    const key = this.getKey(id);
    const result = await this.redis.exists(key);
    return result === 1;
  }

  /**
   * Update session metadata
   */
  async update(id: string, updates: Partial<Session>): Promise<void> {
    const session = await this.load(id);
    if (!session) {
      throw new SessionNotFoundError(id);
    }

    const updated = { ...session, ...updates };
    await this.save(updated);
  }

  /**
   * Close Redis connection
   */
  async close(): Promise<void> {
    if (this.redis) {
      await this.redis.quit();
      this.redis = null;
    }
  }

  // ============================================================================
  // CredentialStore implementation
  // ============================================================================

  async saveCredential(sessionId: string, key: string, value: string | Buffer): Promise<void> {
    await this.ensureInitialized();
    if (!this.redis) throw new Error('Redis not initialized');

    const redisKey = `wasp:cred:${sessionId}:${key}`;
    const serialized = Buffer.isBuffer(value) ? value.toString('base64') : value;

    await this.redis.set(redisKey, serialized);
  }

  async loadCredential(sessionId: string, key: string): Promise<string | Buffer | null> {
    await this.ensureInitialized();
    if (!this.redis) throw new Error('Redis not initialized');

    const redisKey = `wasp:cred:${sessionId}:${key}`;
    const data = await this.redis.get(redisKey);

    if (!data) {
      return null;
    }

    // Try to decode as base64 Buffer, fallback to string
    try {
      return Buffer.from(data, 'base64');
    } catch {
      return data;
    }
  }

  async deleteCredential(sessionId: string, key: string): Promise<void> {
    await this.ensureInitialized();
    if (!this.redis) throw new Error('Redis not initialized');

    const redisKey = `wasp:cred:${sessionId}:${key}`;
    await this.redis.del(redisKey);
  }

  async listCredentialKeys(sessionId: string): Promise<string[]> {
    await this.ensureInitialized();
    if (!this.redis) throw new Error('Redis not initialized');

    const pattern = `wasp:cred:${sessionId}:*`;
    const keys: string[] = [];

    let cursor = '0';
    do {
      const result = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = result[0];
      keys.push(...result[1]);
    } while (cursor !== '0');

    // Extract key names (remove prefix)
    const prefix = `wasp:cred:${sessionId}:`;
    return keys.map((k) => k.substring(prefix.length));
  }

  async clearCredentials(sessionId: string): Promise<void> {
    await this.ensureInitialized();
    if (!this.redis) throw new Error('Redis not initialized');

    const pattern = `wasp:cred:${sessionId}:*`;
    let cursor = '0';

    do {
      const result = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = result[0];

      if (result[1].length > 0) {
        await this.redis.del(...result[1]);
      }
    } while (cursor !== '0');
  }

  // ============================================================================
  // CacheStore implementation
  // ============================================================================

  async getCached<T = unknown>(namespace: string, key: string): Promise<T | null> {
    try {
      await this.ensureInitialized();
      if (!this.redis) throw new Error('Redis not initialized');

      const redisKey = `wasp:cache:${namespace}:${key}`;
      const data = await this.redis.get(redisKey);

      if (!data) {
        return null;
      }

      return JSON.parse(data) as T;
    } catch (error) {
      // Best-effort semantics
      console.warn(`[RedisStore] Cache read error for ${namespace}:${key}:`, error);
      return null;
    }
  }

  async setCached<T = unknown>(namespace: string, key: string, value: T, ttlMs?: number): Promise<void> {
    try {
      await this.ensureInitialized();
      if (!this.redis) throw new Error('Redis not initialized');

      const redisKey = `wasp:cache:${namespace}:${key}`;
      const serialized = JSON.stringify(value);

      if (ttlMs) {
        const ttlSeconds = Math.ceil(ttlMs / 1000);
        await this.redis.set(redisKey, serialized, 'EX', ttlSeconds);
      } else {
        await this.redis.set(redisKey, serialized);
      }
    } catch (error) {
      // Best-effort semantics
      console.warn(`[RedisStore] Cache write error for ${namespace}:${key}:`, error);
    }
  }

  async deleteCached(namespace: string, key: string): Promise<void> {
    try {
      await this.ensureInitialized();
      if (!this.redis) throw new Error('Redis not initialized');

      const redisKey = `wasp:cache:${namespace}:${key}`;
      await this.redis.del(redisKey);
    } catch (error) {
      console.warn(`[RedisStore] Cache delete error for ${namespace}:${key}:`, error);
    }
  }

  async clearCache(namespace: string): Promise<void> {
    try {
      await this.ensureInitialized();
      if (!this.redis) throw new Error('Redis not initialized');

      const pattern = `wasp:cache:${namespace}:*`;
      let cursor = '0';

      do {
        const result = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
        cursor = result[0];

        if (result[1].length > 0) {
          await this.redis.del(...result[1]);
        }
      } while (cursor !== '0');
    } catch (error) {
      console.warn(`[RedisStore] Cache clear error for namespace ${namespace}:`, error);
    }
  }

  // ============================================================================
  // MetricsStore implementation
  // ============================================================================

  async increment(sessionId: string, metric: string, delta: number = 1): Promise<void> {
    await this.ensureInitialized();
    if (!this.redis) throw new Error('Redis not initialized');

    const redisKey = `wasp:metrics:${sessionId}:${metric}`;
    await this.redis.incrby(redisKey, delta);
  }

  async get(sessionId: string, metric: string): Promise<number> {
    await this.ensureInitialized();
    if (!this.redis) throw new Error('Redis not initialized');

    const redisKey = `wasp:metrics:${sessionId}:${metric}`;
    const value = await this.redis.get(redisKey);

    return value ? parseInt(value, 10) : 0;
  }

  async getAll(sessionId: string): Promise<Record<string, number>> {
    await this.ensureInitialized();
    if (!this.redis) throw new Error('Redis not initialized');

    const pattern = `wasp:metrics:${sessionId}:*`;
    const keys: string[] = [];
    let cursor = '0';

    do {
      const result = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = result[0];
      keys.push(...result[1]);
    } while (cursor !== '0');

    if (keys.length === 0) {
      return {};
    }

    const values = await this.redis.mget(keys);
    const metrics: Record<string, number> = {};
    const prefix = `wasp:metrics:${sessionId}:`;

    for (let i = 0; i < keys.length; i++) {
      const metricName = keys[i].substring(prefix.length);
      metrics[metricName] = values[i] ? parseInt(values[i], 10) : 0;
    }

    return metrics;
  }

  async reset(sessionId: string, metric?: string): Promise<void> {
    await this.ensureInitialized();
    if (!this.redis) throw new Error('Redis not initialized');

    if (metric) {
      const redisKey = `wasp:metrics:${sessionId}:${metric}`;
      await this.redis.del(redisKey);
    } else {
      const pattern = `wasp:metrics:${sessionId}:*`;
      let cursor = '0';

      do {
        const result = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
        cursor = result[0];

        if (result[1].length > 0) {
          await this.redis.del(...result[1]);
        }
      } while (cursor !== '0');
    }
  }

  /**
   * Get total credential count across all sessions
   */
  async getTotalCredentialCount(): Promise<number> {
    await this.ensureInitialized();
    if (!this.redis) throw new Error('Redis not initialized');

    const pattern = 'wasp:cred:*';
    let count = 0;
    let cursor = '0';

    do {
      const result = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = result[0];
      count += result[1].length;
    } while (cursor !== '0');

    return count;
  }

  /**
   * Get cache size
   */
  async getCacheSize(): Promise<number> {
    await this.ensureInitialized();
    if (!this.redis) throw new Error('Redis not initialized');

    const pattern = 'wasp:cache:*';
    let count = 0;
    let cursor = '0';

    do {
      const result = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = result[0];
      count += result[1].length;
    } while (cursor !== '0');

    return count;
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
    await this.ensureInitialized();
    if (!this.redis) throw new Error('Redis not initialized');

    const key = `${this.config.keyPrefix}qr:${sessionId}`;
    await this.redis.set(key, qr, 'EX', ttlSeconds);
  }

  /**
   * Get stored QR code
   *
   * @param sessionId Session ID
   * @returns QR code string or null if not found/expired
   */
  async getQR(sessionId: string): Promise<string | null> {
    await this.ensureInitialized();
    if (!this.redis) throw new Error('Redis not initialized');

    const key = `${this.config.keyPrefix}qr:${sessionId}`;
    return await this.redis.get(key);
  }

  /**
   * Delete stored QR code
   *
   * @param sessionId Session ID
   */
  async deleteQR(sessionId: string): Promise<void> {
    await this.ensureInitialized();
    if (!this.redis) throw new Error('Redis not initialized');

    const key = `${this.config.keyPrefix}qr:${sessionId}`;
    await this.redis.del(key);
  }
}
