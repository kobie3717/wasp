/**
 * L3 layered Baileys auth state: Redis(L1) → Postgres(L2) → Disk(L3)
 *
 * Features:
 * - Multi-layer credential storage with automatic best-source selection
 * - Per-layer circuit breakers with auto-recovery
 * - Cache warming: slow layers write back to fast layers
 * - Batched writes to Postgres, pipelined writes to Redis
 * - Optional disk persistence for signal keys
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { type AuthenticationState, type SignalKeyStore } from '@whiskeysockets/baileys';
import { selectBestCreds } from './creds-utils.js';

// Dynamic imports for optional peer deps
type IRedis = any; // import('ioredis').Redis - avoid TS error with optional peer dep
type PgPool = import('pg').Pool;

export interface LayeredAuthOptions {
  connectionId: string;
  authDir: string;
  redis?: IRedis | null;
  pg?: PgPool | null;
  retryIntervalMs?: number;     // default 30_000
  chunkSize?: number;           // default 500
  diskConcurrency?: number;     // default 50
  persistKeysToDisk?: boolean;  // default false
  logger?: { info(msg: string, ctx?: any): void; warn(msg: string, ctx?: any): void; error?(msg: string, ctx?: any): void };
}

interface CircuitBreaker {
  healthy: boolean;
  lastFailure: number;
  retryInterval: number;
  loggedOnce: boolean;
}

const TABLE_CREDS = 'wasp_auth_creds';
const TABLE_KEYS = 'wasp_signal_keys';

const noop = () => {};

/**
 * Create auth directory recursively
 */
async function createAuthDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

/**
 * Serialize value to JSON with Buffer support
 */
function serialize(value: any): string {
  return JSON.stringify(value, (_, v) => v instanceof Buffer ? { type: 'Buffer', data: Array.from(v) } : v);
}

/**
 * Deserialize JSON with Buffer support
 */
function deserialize(json: string): any {
  return JSON.parse(json, (_, v) => {
    if (v && typeof v === 'object' && v.type === 'Buffer' && Array.isArray(v.data)) {
      return Buffer.from(v.data);
    }
    return v;
  });
}

/**
 * Create layered auth state
 *
 * @example
 * ```typescript
 * import { useLayeredAuthState } from 'wasp-protocol';
 * import Redis from 'ioredis';
 * import { Pool } from 'pg';
 *
 * const redis = new Redis();
 * const pg = new Pool({ connectionString: process.env.DATABASE_URL });
 *
 * const { state, saveCreds } = await useLayeredAuthState({
 *   connectionId: 'user-123',
 *   authDir: './auth',
 *   redis,
 *   pg,
 * });
 * ```
 */
export async function useLayeredAuthState(options: LayeredAuthOptions): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }> {
  const {
    connectionId,
    authDir,
    redis = null,
    pg = null,
    retryIntervalMs = 30_000,
    chunkSize = 500,
    diskConcurrency = 50,
    persistKeysToDisk = false,
    logger
  } = options;

  const log = {
    info: logger?.info ?? noop,
    warn: logger?.warn ?? noop,
    error: logger?.error ?? logger?.warn ?? noop,
  };

  // Circuit breakers
  const redisBreaker: CircuitBreaker = { healthy: true, lastFailure: 0, retryInterval: retryIntervalMs, loggedOnce: false };
  const pgBreaker: CircuitBreaker = { healthy: true, lastFailure: 0, retryInterval: retryIntervalMs, loggedOnce: false };

  const checkBreaker = (breaker: CircuitBreaker, name: string): boolean => {
    if (breaker.healthy) return true;
    const now = Date.now();
    if (now - breaker.lastFailure >= breaker.retryInterval) {
      breaker.healthy = true;
      breaker.loggedOnce = false;
      log.info(`${name} circuit breaker auto-recovered`, { connectionId });
      return true;
    }
    return false;
  };

  const tripBreaker = (breaker: CircuitBreaker, name: string, error: any): void => {
    breaker.healthy = false;
    breaker.lastFailure = Date.now();
    if (!breaker.loggedOnce) {
      log.warn(`${name} circuit breaker tripped`, { connectionId, error: error?.message });
      breaker.loggedOnce = true;
    }
  };

  // Create auth directory
  await createAuthDir(path.join(authDir, connectionId));

  // Load creds from all sources
  const candidates = await Promise.all([
    // Redis
    (async () => {
      if (!redis || !checkBreaker(redisBreaker, 'Redis')) return { source: 'redis' as const, creds: null };
      try {
        const raw = await redis.get(`wasp:auth:${connectionId}:creds`);
        return { source: 'redis' as const, creds: raw ? deserialize(raw) : null };
      } catch (error) {
        tripBreaker(redisBreaker, 'Redis', error);
        return { source: 'redis' as const, creds: null };
      }
    })(),
    // Postgres
    (async () => {
      if (!pg || !checkBreaker(pgBreaker, 'Postgres')) return { source: 'postgres' as const, creds: null };
      try {
        const res = await pg.query(`SELECT creds_json FROM ${TABLE_CREDS} WHERE session_id = $1`, [connectionId]);
        return { source: 'postgres' as const, creds: res.rows[0] ? deserialize(res.rows[0].creds_json) : null };
      } catch (error) {
        tripBreaker(pgBreaker, 'Postgres', error);
        return { source: 'postgres' as const, creds: null };
      }
    })(),
    // Disk
    (async () => {
      try {
        const credsPath = path.join(authDir, connectionId, 'creds.json');
        const raw = await fs.readFile(credsPath, 'utf-8');
        return { source: 'disk' as const, creds: deserialize(raw) };
      } catch {
        return { source: 'disk' as const, creds: null };
      }
    })(),
  ]);

  // Select best creds
  const { creds, meta } = selectBestCreds(candidates, ['redis', 'postgres', 'disk']);
  log.info('Selected best creds', { connectionId, source: meta.source, score: meta.score });

  // Auto-sync lagging sources
  const syncPromises: Promise<void>[] = [];
  for (const candidate of candidates) {
    if (candidate.source !== meta.source && (candidate.creds === null || meta.score > 0)) {
      if (candidate.source === 'redis' && redis && checkBreaker(redisBreaker, 'Redis')) {
        syncPromises.push(
          redis.set(`wasp:auth:${connectionId}:creds`, serialize(creds)).catch((err: any) => tripBreaker(redisBreaker, 'Redis', err))
        );
      } else if (candidate.source === 'postgres' && pg && checkBreaker(pgBreaker, 'Postgres')) {
        syncPromises.push(
          pg.query(
            `INSERT INTO ${TABLE_CREDS} (session_id, creds_json, updated_at) VALUES ($1, $2, NOW())
             ON CONFLICT (session_id) DO UPDATE SET creds_json = EXCLUDED.creds_json, updated_at = NOW()`,
            [connectionId, serialize(creds)]
          ).then(() => {}).catch((err: any) => tripBreaker(pgBreaker, 'Postgres', err))
        );
      } else if (candidate.source === 'disk') {
        syncPromises.push(
          fs.writeFile(path.join(authDir, connectionId, 'creds.json'), serialize(creds)).catch(() => {})
        );
      }
    }
  }
  await Promise.allSettled(syncPromises);

  // Current creds state
  let currentCreds = creds;

  // Signal keys store
  const keys: SignalKeyStore = {
    async get(type, ids) {
      const entries: Record<string, any> = {};

      // Try Redis first
      if (redis && checkBreaker(redisBreaker, 'Redis')) {
        try {
          const redisKeys = ids.map(id => `wasp:auth:${connectionId}:${type}:${id}`);
          const values = await redis.mget(...redisKeys);
          for (let i = 0; i < ids.length; i++) {
            if (values[i]) {
              entries[ids[i]] = deserialize(values[i]!);
            }
          }
          if (Object.keys(entries).length === ids.length) return entries;
        } catch (error) {
          tripBreaker(redisBreaker, 'Redis', error);
        }
      }

      // Fallback to Postgres
      if (pg && checkBreaker(pgBreaker, 'Postgres')) {
        try {
          const missingIds = ids.filter(id => !(id in entries));
          if (missingIds.length > 0) {
            const res = await pg.query(
              `SELECT key_id, value_json FROM ${TABLE_KEYS} WHERE session_id = $1 AND key_type = $2 AND key_id = ANY($3)`,
              [connectionId, type, missingIds]
            );
            for (const row of res.rows) {
              entries[row.key_id] = deserialize(row.value_json);
            }
          }

          // Warm cache to Redis
          if (redis && checkBreaker(redisBreaker, 'Redis')) {
            const warmEntries = Object.entries(entries).filter(([id]) => !ids.includes(id));
            if (warmEntries.length > 0) {
              const pipeline = redis.pipeline();
              for (const [id, value] of warmEntries) {
                pipeline.set(`wasp:auth:${connectionId}:${type}:${id}`, serialize(value));
              }
              pipeline.exec().catch((err: any) => tripBreaker(redisBreaker, 'Redis', err));
            }
          }

          if (Object.keys(entries).length === ids.length) return entries;
        } catch (error) {
          tripBreaker(pgBreaker, 'Postgres', error);
        }
      }

      // Fallback to disk (if enabled)
      if (persistKeysToDisk) {
        const missingIds = ids.filter(id => !(id in entries));
        const results = await Promise.allSettled(
          missingIds.map(async (id) => {
            const filePath = path.join(authDir, connectionId, `${type}-${id}.json`);
            const raw = await fs.readFile(filePath, 'utf-8');
            return { id, value: deserialize(raw) };
          })
        );
        for (const result of results) {
          if (result.status === 'fulfilled') {
            entries[result.value.id] = result.value.value;
          }
        }
      }

      return entries;
    },

    async set(data) {
      const entries = Object.entries(data).flatMap(([type, mapping]) =>
        Object.entries(mapping).map(([id, value]) => ({ type, id, value }))
      );

      // Write to Redis (pipeline)
      if (redis && checkBreaker(redisBreaker, 'Redis')) {
        try {
          const pipeline = redis.pipeline();
          for (const { type, id, value } of entries) {
            pipeline.set(`wasp:auth:${connectionId}:${type}:${id}`, serialize(value));
          }
          await pipeline.exec();
        } catch (error) {
          tripBreaker(redisBreaker, 'Redis', error);
        }
      }

      // Write to Postgres (batched)
      if (pg && checkBreaker(pgBreaker, 'Postgres')) {
        try {
          for (let i = 0; i < entries.length; i += chunkSize) {
            const chunk = entries.slice(i, i + chunkSize);
            const values = chunk.map((_entry, idx) => `($${idx * 4 + 1}, $${idx * 4 + 2}, $${idx * 4 + 3}, $${idx * 4 + 4})`).join(',');
            const params = chunk.flatMap(entry => [connectionId, entry.type, entry.id, serialize(entry.value)]);
            await pg.query(
              `INSERT INTO ${TABLE_KEYS} (session_id, key_type, key_id, value_json) VALUES ${values}
               ON CONFLICT (session_id, key_type, key_id) DO UPDATE SET value_json = EXCLUDED.value_json, updated_at = NOW()`,
              params
            );
          }
        } catch (error) {
          tripBreaker(pgBreaker, 'Postgres', error);
        }
      }

      // Write to disk (if enabled)
      if (persistKeysToDisk) {
        const chunks: any[][] = [];
        for (let i = 0; i < entries.length; i += diskConcurrency) {
          chunks.push(entries.slice(i, i + diskConcurrency));
        }
        for (const chunk of chunks) {
          await Promise.allSettled(
            chunk.map(({ type, id, value }) =>
              fs.writeFile(path.join(authDir, connectionId, `${type}-${id}.json`), serialize(value))
            )
          );
        }
      }
    },
  };

  // Save creds function
  const saveCreds = async () => {
    const writes: Promise<void>[] = [];

    // Redis
    if (redis && checkBreaker(redisBreaker, 'Redis')) {
      writes.push(
        redis.set(`wasp:auth:${connectionId}:creds`, serialize(currentCreds)).then(() => {}).catch((err: any) => tripBreaker(redisBreaker, 'Redis', err))
      );
    }

    // Postgres
    if (pg && checkBreaker(pgBreaker, 'Postgres')) {
      writes.push(
        pg.query(
          `INSERT INTO ${TABLE_CREDS} (session_id, creds_json, updated_at) VALUES ($1, $2, NOW())
           ON CONFLICT (session_id) DO UPDATE SET creds_json = EXCLUDED.creds_json, updated_at = NOW()`,
          [connectionId, serialize(currentCreds)]
        ).then(() => {}).catch((err: any) => tripBreaker(pgBreaker, 'Postgres', err))
      );
    }

    // Disk
    writes.push(
      fs.writeFile(path.join(authDir, connectionId, 'creds.json'), serialize(currentCreds)).catch(() => {})
    );

    await Promise.allSettled(writes);
  };

  const state: AuthenticationState = {
    creds: currentCreds,
    keys,
  };

  // Update current creds reference when modified
  const originalCredsProxy = new Proxy(currentCreds, {
    set(target, prop, value) {
      (target as any)[prop] = value;
      currentCreds = target;
      return true;
    },
  });
  state.creds = originalCredsProxy;

  return { state, saveCreds };
}
