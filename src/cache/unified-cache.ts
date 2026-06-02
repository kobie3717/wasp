/**
 * Unified Redis/Memory cache abstraction with TTL, batch ops, proactive sweep
 *
 * Automatically falls back to in-memory cache if Redis is not available.
 * Memory cache includes proactive TTL sweep to prevent memory leaks.
 */

export interface UnifiedCacheStore {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set<T = unknown>(key: string, value: T): Promise<void>;
  del(key: string): Promise<void>;
  flushAll(): Promise<void>;
  mget<T = unknown>(keys: string[]): Promise<Record<string, T | undefined>>;
  mset<T = unknown>(entries: Array<{ key: string; value: T }>): Promise<void>;
  mdel(keys: string[]): Promise<void>;
}

export interface UnifiedCacheOptions {
  name: string;          // namespace, e.g. 'contacts'
  ttlSeconds: number;
  connectionId?: string;
  redis?: any | null;    // import('ioredis').Redis - avoid TS error with optional peer dep
  prefix?: string;       // default 'wasp'
}

interface CacheEntry<T = unknown> {
  value: T;
  expiresAt: number;
}

/**
 * Create unified cache store
 *
 * Automatically selects Redis or in-memory backend based on availability.
 *
 * @example
 * ```typescript
 * import { createUnifiedCacheStore } from 'wasp-protocol';
 * import Redis from 'ioredis';
 *
 * const redis = new Redis();
 * const cache = createUnifiedCacheStore({
 *   name: 'contacts',
 *   ttlSeconds: 3600,
 *   connectionId: 'user-123',
 *   redis,
 * });
 *
 * await cache.set('contact:1', { name: 'Alice', phone: '+1234567890' });
 * const contact = await cache.get('contact:1');
 * ```
 */
export function createUnifiedCacheStore(options: UnifiedCacheOptions): UnifiedCacheStore {
  const { name, ttlSeconds, connectionId, redis, prefix = 'wasp' } = options;

  const buildKey = (key: string): string => {
    const parts = [prefix];
    if (connectionId) parts.push(connectionId);
    parts.push(name, key);
    return parts.join(':');
  };

  // Redis backend
  if (redis) {
    return {
      async get<T = unknown>(key: string): Promise<T | undefined> {
        const raw = await redis.get(buildKey(key));
        return raw ? JSON.parse(raw) : undefined;
      },

      async set<T = unknown>(key: string, value: T): Promise<void> {
        await redis.setex(buildKey(key), ttlSeconds, JSON.stringify(value));
      },

      async del(key: string): Promise<void> {
        await redis.del(buildKey(key));
      },

      async flushAll(): Promise<void> {
        const pattern = buildKey('*');
        const keys = await redis.keys(pattern);
        if (keys.length > 0) {
          await redis.del(...keys);
        }
      },

      async mget<T = unknown>(keys: string[]): Promise<Record<string, T | undefined>> {
        if (keys.length === 0) return {};
        const redisKeys = keys.map(buildKey);
        const values = await redis.mget(...redisKeys);
        const result: Record<string, T | undefined> = {};
        for (let i = 0; i < keys.length; i++) {
          result[keys[i]] = values[i] ? JSON.parse(values[i]!) : undefined;
        }
        return result;
      },

      async mset<T = unknown>(entries: Array<{ key: string; value: T }>): Promise<void> {
        if (entries.length === 0) return;
        const pipeline = redis.pipeline();
        for (const { key, value } of entries) {
          pipeline.setex(buildKey(key), ttlSeconds, JSON.stringify(value));
        }
        await pipeline.exec();
      },

      async mdel(keys: string[]): Promise<void> {
        if (keys.length === 0) return;
        const redisKeys = keys.map(buildKey);
        await redis.del(...redisKeys);
      },
    };
  }

  // In-memory backend with TTL
  const store = new Map<string, CacheEntry>();
  const ttlMs = ttlSeconds * 1000;

  // Proactive sweep to prevent memory leaks
  const sweepInterval = Math.min(ttlMs, 5 * 60 * 1000); // Max 5 minutes
  const sweepTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of store.entries()) {
      if (entry.expiresAt <= now) {
        store.delete(key);
      }
    }
  }, sweepInterval);

  // Don't prevent process exit
  sweepTimer.unref();

  const isExpired = (entry: CacheEntry): boolean => {
    return entry.expiresAt <= Date.now();
  };

  return {
    async get<T = unknown>(key: string): Promise<T | undefined> {
      const entry = store.get(buildKey(key));
      if (!entry || isExpired(entry)) {
        if (entry) store.delete(buildKey(key));
        return undefined;
      }
      return entry.value as T;
    },

    async set<T = unknown>(key: string, value: T): Promise<void> {
      store.set(buildKey(key), {
        value,
        expiresAt: Date.now() + ttlMs,
      });
    },

    async del(key: string): Promise<void> {
      store.delete(buildKey(key));
    },

    async flushAll(): Promise<void> {
      const pattern = buildKey('');
      for (const key of store.keys()) {
        if (key.startsWith(pattern)) {
          store.delete(key);
        }
      }
    },

    async mget<T = unknown>(keys: string[]): Promise<Record<string, T | undefined>> {
      const result: Record<string, T | undefined> = {};
      const now = Date.now();
      for (const key of keys) {
        const entry = store.get(buildKey(key));
        if (entry && entry.expiresAt > now) {
          result[key] = entry.value as T;
        } else {
          if (entry) store.delete(buildKey(key));
          result[key] = undefined;
        }
      }
      return result;
    },

    async mset<T = unknown>(entries: Array<{ key: string; value: T }>): Promise<void> {
      const expiresAt = Date.now() + ttlMs;
      for (const { key, value } of entries) {
        store.set(buildKey(key), { value, expiresAt });
      }
    },

    async mdel(keys: string[]): Promise<void> {
      for (const key of keys) {
        store.delete(buildKey(key));
      }
    },
  };
}
