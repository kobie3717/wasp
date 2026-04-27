/**
 * Two-tier session store cache
 *
 * Caches both raw file contents and parsed JSON objects.
 * Invalidates when file metadata (mtime + size) changes.
 * LRU eviction at maxEntries.
 */

import * as fs from 'node:fs/promises';

/**
 * File system adapter interface for testability
 */
export interface FsAdapter {
  stat(path: string): Promise<{ mtimeMs: number; size: number }>;
  readFile(path: string, encoding: 'utf-8'): Promise<string>;
}

/**
 * Default filesystem adapter using node:fs/promises
 */
const defaultFsAdapter: FsAdapter = {
  stat: (path: string) => fs.stat(path),
  readFile: (path: string, encoding: 'utf-8') => fs.readFile(path, encoding),
};

/**
 * Cache entry with file metadata fingerprint
 */
interface CacheEntry {
  mtimeMs: number;
  size: number;
  raw: string;
  parsed: unknown;
  /** Last access timestamp for LRU */
  lastAccess: number;
}

/**
 * Configuration options for SessionStoreCache
 */
export interface SessionStoreCacheConfig {
  /** Maximum number of entries before LRU eviction (default: 100) */
  maxEntries?: number;
  /** File system adapter for testability */
  fs?: FsAdapter;
}

/**
 * Two-tier session store cache
 */
export interface SessionStoreCache {
  /** Read and parse a JSON file (returns parsed object) */
  read<T = unknown>(path: string): Promise<T>;
  /** Read raw file contents (returns string) */
  readRaw(path: string): Promise<string>;
  /** Manually invalidate a cached file */
  invalidate(path: string): void;
  /** Current cache size */
  get size(): number;
}

/**
 * Create a new session store cache
 *
 * @example
 * ```typescript
 * const cache = createSessionStoreCache({ maxEntries: 100 });
 *
 * const session = await cache.read<SessionData>('/path/to/auth.json');
 * const raw = await cache.readRaw('/path/to/auth.json');
 *
 * cache.invalidate('/path/to/auth.json'); // manual bust
 * ```
 */
export function createSessionStoreCache(
  config: SessionStoreCacheConfig = {}
): SessionStoreCache {
  const { maxEntries = 100, fs: fsAdapter = defaultFsAdapter } = config;
  const cache = new Map<string, CacheEntry>();

  /**
   * Evict least recently used entry
   */
  const evictLRU = (): void => {
    if (cache.size === 0) return;

    let oldestPath: string | null = null;
    let oldestAccess = Infinity;

    for (const [path, entry] of cache.entries()) {
      if (entry.lastAccess < oldestAccess) {
        oldestAccess = entry.lastAccess;
        oldestPath = path;
      }
    }

    if (oldestPath !== null) {
      cache.delete(oldestPath);
    }
  };

  /**
   * Check if cached entry is still valid
   */
  const isValid = async (
    path: string,
    entry: CacheEntry
  ): Promise<boolean> => {
    try {
      const stats = await fsAdapter.stat(path);
      return stats.mtimeMs === entry.mtimeMs && stats.size === entry.size;
    } catch {
      // If stat fails, consider cache invalid
      return false;
    }
  };

  /**
   * Load and cache a file
   */
  const loadAndCache = async (path: string): Promise<CacheEntry> => {
    // Read file and stats
    const [raw, stats] = await Promise.all([
      fsAdapter.readFile(path, 'utf-8'),
      fsAdapter.stat(path),
    ]);

    // Parse JSON
    const parsed = JSON.parse(raw);

    // Create cache entry
    const entry: CacheEntry = {
      mtimeMs: stats.mtimeMs,
      size: stats.size,
      raw,
      parsed,
      lastAccess: Date.now(),
    };

    // Evict LRU if at capacity
    if (cache.size >= maxEntries) {
      evictLRU();
    }

    // Store in cache
    cache.set(path, entry);

    return entry;
  };

  return {
    async read<T = unknown>(path: string): Promise<T> {
      const cached = cache.get(path);

      // Cache hit - check if still valid
      if (cached) {
        if (await isValid(path, cached)) {
          // Update last access for LRU
          cached.lastAccess = Date.now();
          return cached.parsed as T;
        } else {
          // Invalid - remove from cache
          cache.delete(path);
        }
      }

      // Cache miss or invalid - load and cache
      const entry = await loadAndCache(path);
      return entry.parsed as T;
    },

    async readRaw(path: string): Promise<string> {
      const cached = cache.get(path);

      // Cache hit - check if still valid
      if (cached) {
        if (await isValid(path, cached)) {
          // Update last access for LRU
          cached.lastAccess = Date.now();
          return cached.raw;
        } else {
          // Invalid - remove from cache
          cache.delete(path);
        }
      }

      // Cache miss or invalid - load and cache
      const entry = await loadAndCache(path);
      return entry.raw;
    },

    invalidate(path: string): void {
      cache.delete(path);
    },

    get size(): number {
      return cache.size;
    },
  };
}
