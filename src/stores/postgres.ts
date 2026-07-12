/**
 * PostgreSQL session store
 *
 * Persistent session storage using PostgreSQL.
 * Recommended for production when you need relational queries.
 */

import type { Session, Backend, SessionStatus, ProviderType } from '../types.js';
import { InvalidTableNameError, SessionNotFoundError } from '../errors.js';

// PostgreSQL client type - dynamically imported
type PgPool = any;

/**
 * PostgreSQL store configuration
 */
export interface PostgresStoreConfig {
  /** PostgreSQL connection string */
  connectionString?: string;
  /** Table name for sessions */
  tableName?: string;
  /** Table name prefix for all tables (credentials, cache, metrics) */
  tablePrefix?: string;
  /** Auto-create table if not exists */
  autoCreate?: boolean;
}

/**
 * PostgreSQL session store
 *
 * Uses pg connection pool for optimal performance.
 * Auto-creates table schema if autoCreate is enabled.
 *
 * @example
 * ```typescript
 * import { PostgresStore } from '@wasp/core/stores/postgres';
 *
 * const store = new PostgresStore({
 *   connectionString: 'postgresql://user:pass@localhost/wasp',
 *   tableName: 'wasp_sessions',
 *   autoCreate: true,
 * });
 * ```
 *
 * Table schema:
 * ```sql
 * CREATE TABLE wasp_sessions (
 *   id VARCHAR(255) PRIMARY KEY,
 *   phone VARCHAR(50),
 *   status VARCHAR(50) NOT NULL,
 *   provider VARCHAR(50) NOT NULL,
 *   org_id VARCHAR(255),
 *   connected_at TIMESTAMP,
 *   created_at TIMESTAMP NOT NULL,
 *   last_activity_at TIMESTAMP,
 *   metadata JSONB
 * );
 * CREATE INDEX idx_wasp_sessions_org_id ON wasp_sessions(org_id);
 * CREATE INDEX idx_wasp_sessions_status ON wasp_sessions(status);
 * ```
 */
export class PostgresStore implements Backend {
  private pool: PgPool | null = null;
  private config: Required<PostgresStoreConfig>;
  private initPromise: Promise<void> | null = null;
  private credentialsTable: string;
  private cacheTable: string;
  private metricsTable: string;
  private qrTable: string;

  constructor(config?: PostgresStoreConfig) {
    const tableName = config?.tableName ?? 'wasp_sessions';
    const tablePrefix = config?.tablePrefix ?? 'wasp';

    // Validate table name to prevent SQL injection
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(tableName)) {
      throw new InvalidTableNameError(tableName);
    }

    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(tablePrefix)) {
      throw new InvalidTableNameError(tablePrefix);
    }

    this.credentialsTable = `${tablePrefix}_credentials`;
    this.cacheTable = `${tablePrefix}_cache`;
    this.metricsTable = `${tablePrefix}_metrics`;
    this.qrTable = `${tablePrefix}_qr_codes`;

    this.config = {
      connectionString: config?.connectionString ?? 'postgresql://localhost/wasp',
      tableName,
      tablePrefix,
      autoCreate: config?.autoCreate ?? false,
    };

    this.initPromise = this.initializePool();
  }

  /**
   * Initialize PostgreSQL connection pool
   */
  private async initializePool(): Promise<void> {
    try {
      const module = await import('pg');
      const Pool = (module as any).Pool || module.default?.Pool;
      this.pool = new Pool({
        connectionString: this.config.connectionString,
      });

      // Test connection
      await this.pool.query('SELECT NOW()');

      if (this.config.autoCreate) {
        await this.createTableIfNotExists();
      }
    } catch (error: any) {
      if (error.code === 'MODULE_NOT_FOUND') {
        throw new Error('pg not installed. Run: npm install pg');
      }
      throw error;
    }
  }

  /**
   * Ensure pool is initialized
   */
  private async ensureInitialized(): Promise<void> {
    if (this.initPromise) {
      await this.initPromise;
      this.initPromise = null;
    }
  }

  /**
   * Create table and indexes if they don't exist
   */
  private async createTableIfNotExists(): Promise<void> {
    if (!this.pool) throw new Error('Pool not initialized');

    // Sessions table
    const createSessionsSQL = `
      CREATE TABLE IF NOT EXISTS ${this.config.tableName} (
        id VARCHAR(255) PRIMARY KEY,
        phone VARCHAR(50),
        status VARCHAR(50) NOT NULL,
        provider VARCHAR(50) NOT NULL,
        org_id VARCHAR(255),
        connected_at TIMESTAMP,
        created_at TIMESTAMP NOT NULL,
        last_activity_at TIMESTAMP,
        metadata JSONB
      );

      CREATE INDEX IF NOT EXISTS idx_${this.config.tableName}_org_id
        ON ${this.config.tableName}(org_id);

      CREATE INDEX IF NOT EXISTS idx_${this.config.tableName}_status
        ON ${this.config.tableName}(status);
    `;

    // Credentials table
    const createCredentialsSQL = `
      CREATE TABLE IF NOT EXISTS ${this.credentialsTable} (
        session_id VARCHAR(255) NOT NULL,
        key VARCHAR(255) NOT NULL,
        value BYTEA NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        PRIMARY KEY (session_id, key)
      );

      CREATE INDEX IF NOT EXISTS idx_${this.credentialsTable}_session_id
        ON ${this.credentialsTable}(session_id);
    `;

    // Cache table
    const createCacheSQL = `
      CREATE TABLE IF NOT EXISTS ${this.cacheTable} (
        namespace VARCHAR(255) NOT NULL,
        key VARCHAR(255) NOT NULL,
        value JSONB NOT NULL,
        expires_at TIMESTAMP,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        PRIMARY KEY (namespace, key)
      );

      CREATE INDEX IF NOT EXISTS idx_${this.cacheTable}_expires_at
        ON ${this.cacheTable}(expires_at)
        WHERE expires_at IS NOT NULL;
    `;

    // Metrics table
    const createMetricsSQL = `
      CREATE TABLE IF NOT EXISTS ${this.metricsTable} (
        session_id VARCHAR(255) NOT NULL,
        metric VARCHAR(255) NOT NULL,
        value BIGINT NOT NULL DEFAULT 0,
        updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
        PRIMARY KEY (session_id, metric)
      );

      CREATE INDEX IF NOT EXISTS idx_${this.metricsTable}_session_id
        ON ${this.metricsTable}(session_id);
    `;

    // QR codes table
    const createQRSQL = `
      CREATE TABLE IF NOT EXISTS ${this.qrTable} (
        session_id VARCHAR(255) PRIMARY KEY,
        qr_code TEXT NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMP NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_${this.qrTable}_expires_at
        ON ${this.qrTable}(expires_at);
    `;

    await this.pool.query(createSessionsSQL);
    await this.pool.query(createCredentialsSQL);
    await this.pool.query(createCacheSQL);
    await this.pool.query(createMetricsSQL);
    await this.pool.query(createQRSQL);
  }

  /**
   * Save session (upsert)
   */
  async save(session: Session): Promise<void> {
    await this.ensureInitialized();
    if (!this.pool) throw new Error('Pool not initialized');

    const sql = `
      INSERT INTO ${this.config.tableName}
        (id, phone, status, provider, org_id, connected_at, created_at, last_activity_at, metadata)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (id)
      DO UPDATE SET
        phone = EXCLUDED.phone,
        status = EXCLUDED.status,
        provider = EXCLUDED.provider,
        org_id = EXCLUDED.org_id,
        connected_at = EXCLUDED.connected_at,
        last_activity_at = EXCLUDED.last_activity_at,
        metadata = EXCLUDED.metadata
    `;

    await this.pool.query(sql, [
      session.id,
      session.phone ?? null,
      session.status,
      session.provider,
      session.orgId ?? null,
      session.connectedAt ?? null,
      session.createdAt,
      session.lastActivityAt ?? null,
      JSON.stringify(session.metadata ?? {}),
    ]);
  }

  /**
   * Load session by ID
   */
  async load(id: string): Promise<Session | null> {
    await this.ensureInitialized();
    if (!this.pool) throw new Error('Pool not initialized');

    const sql = `SELECT * FROM ${this.config.tableName} WHERE id = $1`;
    const result = await this.pool.query(sql, [id]);

    if (result.rows.length === 0) {
      return null;
    }

    return this.rowToSession(result.rows[0]);
  }

  /**
   * Delete session
   */
  async delete(id: string): Promise<void> {
    await this.ensureInitialized();
    if (!this.pool) throw new Error('Pool not initialized');

    const sql = `DELETE FROM ${this.config.tableName} WHERE id = $1`;
    await this.pool.query(sql, [id]);
  }

  /**
   * List sessions with optional filter
   */
  async list(filter?: Partial<Session>, limit?: number, offset?: number): Promise<Session[]> {
    await this.ensureInitialized();
    if (!this.pool) throw new Error('Pool not initialized');

    let sql = `SELECT * FROM ${this.config.tableName}`;
    const params: any[] = [];
    const conditions: string[] = [];
    let paramCount = 1;

    if (filter) {
      if (filter.status !== undefined) {
        conditions.push(`status = $${paramCount++}`);
        params.push(filter.status);
      }

      if (filter.provider !== undefined) {
        conditions.push(`provider = $${paramCount++}`);
        params.push(filter.provider);
      }

      if (filter.orgId !== undefined) {
        conditions.push(`org_id = $${paramCount++}`);
        params.push(filter.orgId);
      }

      if (filter.phone !== undefined) {
        conditions.push(`phone = $${paramCount++}`);
        params.push(filter.phone);
      }

      if (filter.id !== undefined) {
        conditions.push(`id = $${paramCount++}`);
        params.push(filter.id);
      }

      if (conditions.length > 0) {
        sql += ' WHERE ' + conditions.join(' AND ');
      }
    }

    sql += ' ORDER BY created_at DESC';

    // Add pagination
    if (limit !== undefined && limit > 0) {
      sql += ` LIMIT $${paramCount++}`;
      params.push(limit);
    }

    if (offset !== undefined && offset > 0) {
      sql += ` OFFSET $${paramCount++}`;
      params.push(offset);
    }

    const result = await this.pool.query(sql, params);
    return result.rows.map(this.rowToSession);
  }

  /**
   * Check if session exists
   */
  async exists(id: string): Promise<boolean> {
    await this.ensureInitialized();
    if (!this.pool) throw new Error('Pool not initialized');

    const sql = `SELECT EXISTS(SELECT 1 FROM ${this.config.tableName} WHERE id = $1)`;
    const result = await this.pool.query(sql, [id]);
    return result.rows[0]?.exists ?? false;
  }

  /**
   * Update session
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
   * Convert database row to Session object
   */
  private rowToSession(row: any): Session {
    return {
      id: row.id,
      phone: row.phone ?? undefined,
      status: row.status as SessionStatus,
      provider: row.provider as ProviderType,
      orgId: row.org_id ?? undefined,
      connectedAt: row.connected_at ? new Date(row.connected_at) : undefined,
      createdAt: new Date(row.created_at),
      lastActivityAt: row.last_activity_at ? new Date(row.last_activity_at) : undefined,
      metadata: row.metadata ?? {},
    };
  }

  /**
   * Close connection pool
   */
  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }

  // ============================================================================
  // CredentialStore implementation
  // ============================================================================

  async saveCredential(sessionId: string, key: string, value: string | Buffer): Promise<void> {
    await this.ensureInitialized();
    if (!this.pool) throw new Error('Pool not initialized');

    const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);

    const sql = `
      INSERT INTO ${this.credentialsTable} (session_id, key, value)
      VALUES ($1, $2, $3)
      ON CONFLICT (session_id, key)
      DO UPDATE SET value = EXCLUDED.value, created_at = NOW()
    `;

    await this.pool.query(sql, [sessionId, key, buffer]);
  }

  async loadCredential(sessionId: string, key: string): Promise<string | Buffer | null> {
    await this.ensureInitialized();
    if (!this.pool) throw new Error('Pool not initialized');

    const sql = `SELECT value FROM ${this.credentialsTable} WHERE session_id = $1 AND key = $2`;
    const result = await this.pool.query(sql, [sessionId, key]);

    if (result.rows.length === 0) {
      return null;
    }

    return result.rows[0].value;
  }

  async deleteCredential(sessionId: string, key: string): Promise<void> {
    await this.ensureInitialized();
    if (!this.pool) throw new Error('Pool not initialized');

    const sql = `DELETE FROM ${this.credentialsTable} WHERE session_id = $1 AND key = $2`;
    await this.pool.query(sql, [sessionId, key]);
  }

  async listCredentialKeys(sessionId: string): Promise<string[]> {
    await this.ensureInitialized();
    if (!this.pool) throw new Error('Pool not initialized');

    const sql = `SELECT key FROM ${this.credentialsTable} WHERE session_id = $1`;
    const result = await this.pool.query(sql, [sessionId]);

    return result.rows.map((row: any) => row.key);
  }

  async clearCredentials(sessionId: string): Promise<void> {
    await this.ensureInitialized();
    if (!this.pool) throw new Error('Pool not initialized');

    const sql = `DELETE FROM ${this.credentialsTable} WHERE session_id = $1`;
    await this.pool.query(sql, [sessionId]);
  }

  // ============================================================================
  // CacheStore implementation
  // ============================================================================

  async getCached<T = unknown>(namespace: string, key: string): Promise<T | null> {
    try {
      await this.ensureInitialized();
      if (!this.pool) throw new Error('Pool not initialized');

      const sql = `
        SELECT value FROM ${this.cacheTable}
        WHERE namespace = $1 AND key = $2
        AND (expires_at IS NULL OR expires_at > NOW())
      `;
      const result = await this.pool.query(sql, [namespace, key]);

      if (result.rows.length === 0) {
        return null;
      }

      return result.rows[0].value as T;
    } catch (error) {
      // Best-effort semantics
      console.warn(`[PostgresStore] Cache read error for ${namespace}:${key}:`, error);
      return null;
    }
  }

  async setCached<T = unknown>(namespace: string, key: string, value: T, ttlMs?: number): Promise<void> {
    try {
      await this.ensureInitialized();
      if (!this.pool) throw new Error('Pool not initialized');

      const expiresAt = ttlMs ? new Date(Date.now() + ttlMs) : null;

      const sql = `
        INSERT INTO ${this.cacheTable} (namespace, key, value, expires_at)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (namespace, key)
        DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at, created_at = NOW()
      `;

      await this.pool.query(sql, [namespace, key, JSON.stringify(value), expiresAt]);
    } catch (error) {
      // Best-effort semantics
      console.warn(`[PostgresStore] Cache write error for ${namespace}:${key}:`, error);
    }
  }

  async deleteCached(namespace: string, key: string): Promise<void> {
    try {
      await this.ensureInitialized();
      if (!this.pool) throw new Error('Pool not initialized');

      const sql = `DELETE FROM ${this.cacheTable} WHERE namespace = $1 AND key = $2`;
      await this.pool.query(sql, [namespace, key]);
    } catch (error) {
      console.warn(`[PostgresStore] Cache delete error for ${namespace}:${key}:`, error);
    }
  }

  async clearCache(namespace: string): Promise<void> {
    try {
      await this.ensureInitialized();
      if (!this.pool) throw new Error('Pool not initialized');

      const sql = `DELETE FROM ${this.cacheTable} WHERE namespace = $1`;
      await this.pool.query(sql, [namespace]);
    } catch (error) {
      console.warn(`[PostgresStore] Cache clear error for namespace ${namespace}:`, error);
    }
  }

  // ============================================================================
  // MetricsStore implementation
  // ============================================================================

  async increment(sessionId: string, metric: string, delta: number = 1): Promise<void> {
    await this.ensureInitialized();
    if (!this.pool) throw new Error('Pool not initialized');

    const sql = `
      INSERT INTO ${this.metricsTable} (session_id, metric, value)
      VALUES ($1, $2, $3)
      ON CONFLICT (session_id, metric)
      DO UPDATE SET value = ${this.metricsTable}.value + EXCLUDED.value, updated_at = NOW()
    `;

    await this.pool.query(sql, [sessionId, metric, delta]);
  }

  async get(sessionId: string, metric: string): Promise<number> {
    await this.ensureInitialized();
    if (!this.pool) throw new Error('Pool not initialized');

    const sql = `SELECT value FROM ${this.metricsTable} WHERE session_id = $1 AND metric = $2`;
    const result = await this.pool.query(sql, [sessionId, metric]);

    if (result.rows.length === 0) {
      return 0;
    }

    return parseInt(result.rows[0].value, 10);
  }

  async getAll(sessionId: string): Promise<Record<string, number>> {
    await this.ensureInitialized();
    if (!this.pool) throw new Error('Pool not initialized');

    const sql = `SELECT metric, value FROM ${this.metricsTable} WHERE session_id = $1`;
    const result = await this.pool.query(sql, [sessionId]);

    const metrics: Record<string, number> = {};
    for (const row of result.rows) {
      metrics[row.metric] = parseInt(row.value, 10);
    }

    return metrics;
  }

  async reset(sessionId: string, metric?: string): Promise<void> {
    await this.ensureInitialized();
    if (!this.pool) throw new Error('Pool not initialized');

    if (metric) {
      const sql = `DELETE FROM ${this.metricsTable} WHERE session_id = $1 AND metric = $2`;
      await this.pool.query(sql, [sessionId, metric]);
    } else {
      const sql = `DELETE FROM ${this.metricsTable} WHERE session_id = $1`;
      await this.pool.query(sql, [sessionId]);
    }
  }

  /**
   * Get total credential count across all sessions
   */
  async getTotalCredentialCount(): Promise<number> {
    await this.ensureInitialized();
    if (!this.pool) throw new Error('Pool not initialized');

    const sql = `SELECT COUNT(*) as count FROM ${this.credentialsTable}`;
    const result = await this.pool.query(sql);

    return parseInt(result.rows[0]?.count ?? 0, 10);
  }

  /**
   * Get cache size
   */
  async getCacheSize(): Promise<number> {
    await this.ensureInitialized();
    if (!this.pool) throw new Error('Pool not initialized');

    const sql = `
      SELECT COUNT(*) as count FROM ${this.cacheTable}
      WHERE expires_at IS NULL OR expires_at > NOW()
    `;
    const result = await this.pool.query(sql);

    return parseInt(result.rows[0]?.count ?? 0, 10);
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
    if (!this.pool) throw new Error('Pool not initialized');

    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

    const sql = `
      INSERT INTO ${this.qrTable} (session_id, qr_code, expires_at)
      VALUES ($1, $2, $3)
      ON CONFLICT (session_id)
      DO UPDATE SET qr_code = $2, created_at = NOW(), expires_at = $3
    `;

    await this.pool.query(sql, [sessionId, qr, expiresAt]);
  }

  /**
   * Get stored QR code
   *
   * @param sessionId Session ID
   * @returns QR code string or null if not found/expired
   */
  async getQR(sessionId: string): Promise<string | null> {
    await this.ensureInitialized();
    if (!this.pool) throw new Error('Pool not initialized');

    const sql = `
      SELECT qr_code FROM ${this.qrTable}
      WHERE session_id = $1 AND expires_at > NOW()
    `;

    const result = await this.pool.query(sql, [sessionId]);

    if (result.rows.length === 0) {
      return null;
    }

    return result.rows[0].qr_code;
  }

  /**
   * Delete stored QR code
   *
   * @param sessionId Session ID
   */
  async deleteQR(sessionId: string): Promise<void> {
    await this.ensureInitialized();
    if (!this.pool) throw new Error('Pool not initialized');

    const sql = `DELETE FROM ${this.qrTable} WHERE session_id = $1`;
    await this.pool.query(sql, [sessionId]);
  }
}
