/**
 * Generic in-memory TTL cache with automatic pruning
 *
 * Auto-prunes expired entries on a configurable interval.
 * Injectable clock for unit testing.
 */

/**
 * Cache entry with expiration timestamp
 */
interface CacheEntry<V> {
  value: V;
  expiresAt: number;
}

/**
 * Configuration options for ExpiringMapCache
 */
export interface ExpiringMapCacheConfig {
  /** Time-to-live in milliseconds */
  ttlMs: number;
  /** Prune interval in milliseconds (defaults to ttlMs) */
  pruneIntervalMs?: number;
  /** Injectable clock function for testing (defaults to Date.now) */
  clock?: () => number;
}

/**
 * Generic in-memory cache with TTL and automatic pruning
 */
export interface ExpiringMapCache<K, V> {
  /** Set a value in the cache */
  set(key: K, value: V): void;
  /** Get a value from the cache (returns undefined if expired or not found) */
  get(key: K): V | undefined;
  /** Check if key exists and is not expired */
  has(key: K): boolean;
  /** Delete a key from the cache */
  delete(key: K): boolean;
  /** Current size after lazy expiry pass */
  get size(): number;
  /** Stop the prune interval (call on shutdown) */
  stop(): void;
}

/**
 * Create a new expiring map cache
 *
 * @example
 * ```typescript
 * const cache = createExpiringMapCache<string, User>({
 *   ttlMs: 5 * 60_000,         // 5 minutes
 *   pruneIntervalMs: 60_000,   // prune every 60s
 * });
 *
 * cache.set('user-1', { id: '1', name: 'Alice' });
 * const user = cache.get('user-1'); // => User object or undefined
 * cache.stop(); // cleanup on shutdown
 * ```
 */
export function createExpiringMapCache<K, V>(
  config: ExpiringMapCacheConfig
): ExpiringMapCache<K, V> {
  const { ttlMs, pruneIntervalMs = ttlMs, clock = () => Date.now() } = config;
  const map = new Map<K, CacheEntry<V>>();
  let pruneTimer: NodeJS.Timeout | null = null;

  /**
   * Prune expired entries from the cache
   */
  const prune = (): void => {
    const now = clock();
    for (const [key, entry] of map.entries()) {
      if (entry.expiresAt <= now) {
        map.delete(key);
      }
    }
  };

  // Start automatic pruning
  pruneTimer = setInterval(prune, pruneIntervalMs);

  return {
    set(key: K, value: V): void {
      const expiresAt = clock() + ttlMs;
      map.set(key, { value, expiresAt });
    },

    get(key: K): V | undefined {
      const entry = map.get(key);
      if (!entry) {
        return undefined;
      }

      // Lazy expiry on access
      if (entry.expiresAt <= clock()) {
        map.delete(key);
        return undefined;
      }

      return entry.value;
    },

    has(key: K): boolean {
      const entry = map.get(key);
      if (!entry) {
        return false;
      }

      // Lazy expiry on access
      if (entry.expiresAt <= clock()) {
        map.delete(key);
        return false;
      }

      return true;
    },

    delete(key: K): boolean {
      return map.delete(key);
    },

    get size(): number {
      // Perform lazy cleanup before returning size
      const now = clock();
      for (const [key, entry] of map.entries()) {
        if (entry.expiresAt <= now) {
          map.delete(key);
        }
      }
      return map.size;
    },

    stop(): void {
      if (pruneTimer !== null) {
        clearInterval(pruneTimer);
        pruneTimer = null;
      }
    },
  };
}
