/**
 * Core type definitions for WaSP (WhatsApp Session Protocol)
 */

import { EventEmitter } from 'events';

/**
 * Session status enumeration
 */
export enum SessionStatus {
  CONNECTING = 'CONNECTING',
  CONNECTED = 'CONNECTED',
  DISCONNECTED = 'DISCONNECTED',
  BANNED = 'BANNED',
  THROTTLED = 'THROTTLED',
  ERROR = 'ERROR',
}

/**
 * Message type enumeration
 */
export enum MessageType {
  TEXT = 'TEXT',
  IMAGE = 'IMAGE',
  VIDEO = 'VIDEO',
  AUDIO = 'AUDIO',
  DOCUMENT = 'DOCUMENT',
  LOCATION = 'LOCATION',
  CONTACT = 'CONTACT',
  REACTION = 'REACTION',
  STICKER = 'STICKER',
  POLL = 'POLL',
  POLL_UPDATE = 'POLL_UPDATE',
}

/**
 * Event type enumeration
 */
export enum EventType {
  MESSAGE_RECEIVED = 'MESSAGE_RECEIVED',
  MESSAGE_SENT = 'MESSAGE_SENT',
  MESSAGE_DELIVERED = 'MESSAGE_DELIVERED',
  MESSAGE_READ = 'MESSAGE_READ',
  SESSION_CONNECTED = 'SESSION_CONNECTED',
  SESSION_DISCONNECTED = 'SESSION_DISCONNECTED',
  SESSION_QR = 'SESSION_QR',
  SESSION_ERROR = 'SESSION_ERROR',
  GROUP_JOIN = 'GROUP_JOIN',
  GROUP_LEAVE = 'GROUP_LEAVE',
  PRESENCE_UPDATE = 'PRESENCE_UPDATE',
  REACHOUT_TIMELOCK = 'REACHOUT_TIMELOCK',
  BAN_RISK_HIGH = 'BAN_RISK_HIGH',
}

/**
 * Provider type enumeration
 */
export enum ProviderType {
  BAILEYS = 'BAILEYS',
  WHATSMEOW = 'WHATSMEOW',
  CLOUD_API = 'CLOUD_API',
}

/**
 * Session metadata interface
 */
export interface SessionMetadata {
  /** Organization ID (for multi-tenant applications) */
  orgId?: string;
  /** Application-specific data */
  [key: string]: unknown;
}

/**
 * Reachout timelock state from WhatsApp
 */
export interface ReachoutTimelockInfo {
  isActive: boolean;
  enforcementType?: string;
  expiresAt?: Date;
  /** Whether new-contact messages are currently blocked */
  newContactsBlocked: boolean;
}

/**
 * Session state
 */
export interface Session {
  /** Unique session identifier */
  id: string;
  /** WhatsApp phone number (with country code, e.g., "27821234567") */
  phone?: string;
  /** Current session status */
  status: SessionStatus;
  /** Provider type */
  provider: ProviderType;
  /** Organization ID */
  orgId?: string;
  /** Timestamp when session connected */
  connectedAt?: Date;
  /** Timestamp when session was created */
  createdAt: Date;
  /** Timestamp of last activity */
  lastActivityAt?: Date;
  /** Additional metadata */
  metadata?: SessionMetadata;
}

/**
 * Quoted/replied message reference
 */
export interface QuotedMessage {
  /** Message ID being quoted */
  id: string;
  /** Sender of quoted message */
  from: string;
  /** Content of quoted message */
  content: string;
}

/**
 * Normalized message format
 */
export interface Message {
  /** Unique message identifier */
  id: string;
  /** Sender phone number */
  from: string;
  /** Recipient phone number or group ID */
  to: string;
  /** Message type */
  type: MessageType;
  /** Message content (text, caption, or serialized data) */
  content: string;
  /** Timestamp when message was created */
  timestamp: Date;
  /** Whether message is from a group */
  isGroup: boolean;
  /** Group ID if isGroup is true */
  groupId?: string;
  /** Quoted/replied message */
  quotedMessage?: QuotedMessage;
  /** Media URL (for IMAGE, VIDEO, AUDIO, DOCUMENT) */
  mediaUrl?: string;
  /** Media MIME type */
  mediaMimeType?: string;
  /** Additional provider-specific data */
  raw?: unknown;
}

/**
 * WaSP event
 */
export interface WaspEvent<T = unknown> {
  /** Event type */
  type: EventType;
  /** Session ID that triggered the event */
  sessionId: string;
  /** Event timestamp */
  timestamp: Date;
  /** Event-specific data */
  data: T;
}

/**
 * Message send options
 */
export interface SendMessageOptions {
  /** Message to quote/reply to */
  quoted?: string;
  /** Priority (higher = sent first) */
  priority?: number;
  /** Skip anti-ban queue (use with caution) */
  immediate?: boolean;
  /** Media URL or buffer */
  media?: string | Buffer;
  /** Media MIME type */
  mediaMimeType?: string;
}

/**
 * Queue configuration options
 */
export interface QueueOptions {
  /** Minimum delay between messages (ms) */
  minDelay: number;
  /** Maximum delay between messages (ms) */
  maxDelay: number;
  /** Maximum concurrent message processing */
  maxConcurrent: number;
  /** Enable priority lanes (priority messages skip delay) */
  priorityLanes: boolean;
  /** Maximum queue size per session (0 = unlimited) */
  maxQueueSize?: number;
}

/**
 * Provider interface - must be implemented by all WhatsApp libraries
 */
export interface Provider {
  /** Provider type */
  readonly type: ProviderType;

  /** Event emitter for provider events */
  readonly events: EventEmitter;

  /**
   * Connect to WhatsApp
   * @param sessionId Session identifier
   * @param options Provider-specific connection options
   */
  connect(sessionId: string, options?: unknown): Promise<void>;

  /**
   * Disconnect from WhatsApp
   */
  disconnect(): Promise<void>;

  /**
   * Send a message
   * @param to Recipient phone number or group ID
   * @param content Message content
   * @param options Send options
   */
  sendMessage(
    to: string,
    content: string,
    options?: SendMessageOptions
  ): Promise<Message>;

  /**
   * Send a reaction to a message
   * @param messageId Message ID to react to
   * @param emoji Reaction emoji
   */
  sendReaction(messageId: string, emoji: string): Promise<void>;

  /**
   * Get QR code for authentication (if applicable)
   */
  getQR?(): Promise<string | null>;

  /**
   * Check if provider is connected
   */
  isConnected(): boolean;

  /**
   * Get session phone number
   */
  getPhoneNumber(): string | null;
}

/**
 * Session store interface - CRUD operations for session data
 */
export interface SessionStore {
  /**
   * Save session state
   * @param session Session to save
   */
  save(session: Session): Promise<void>;

  /**
   * Load session state
   * @param id Session ID
   */
  load(id: string): Promise<Session | null>;

  /**
   * Delete session state
   * @param id Session ID
   */
  delete(id: string): Promise<void>;

  /**
   * List all sessions
   * @param filter Optional filter criteria
   * @param limit Optional limit on number of results
   * @param offset Optional offset for pagination
   */
  list(filter?: Partial<Session>, limit?: number, offset?: number): Promise<Session[]>;

  /**
   * Check if session exists
   * @param id Session ID
   */
  exists(id: string): Promise<boolean>;

  /**
   * Update session metadata
   * @param id Session ID
   * @param updates Partial session updates
   */
  update(id: string, updates: Partial<Session>): Promise<void>;
}

/**
 * Store interface - pluggable session storage
 * @deprecated Use SessionStore instead (backward compatibility alias)
 */
export type Store = SessionStore;

/**
 * Credential store interface - auth tokens, device credentials, encrypted keys
 */
export interface CredentialStore {
  /**
   * Save a credential
   * @param sessionId Session ID
   * @param key Credential key (e.g., 'auth-token', 'device-key')
   * @param value Credential value (string or Buffer)
   */
  saveCredential(sessionId: string, key: string, value: string | Buffer): Promise<void>;

  /**
   * Load a credential
   * @param sessionId Session ID
   * @param key Credential key
   * @returns Credential value or null if not found
   */
  loadCredential(sessionId: string, key: string): Promise<string | Buffer | null>;

  /**
   * Delete a credential
   * @param sessionId Session ID
   * @param key Credential key
   */
  deleteCredential(sessionId: string, key: string): Promise<void>;

  /**
   * List all credential keys for a session
   * @param sessionId Session ID
   * @returns Array of credential keys
   */
  listCredentialKeys(sessionId: string): Promise<string[]>;

  /**
   * Clear all credentials for a session
   * @param sessionId Session ID
   */
  clearCredentials(sessionId: string): Promise<void>;
}

/**
 * Cache store interface - namespaced ephemeral data with TTL support
 */
export interface CacheStore {
  /**
   * Get cached value
   * @param namespace Cache namespace (e.g., 'group', 'device')
   * @param key Cache key
   * @returns Cached value or null if not found/expired
   */
  getCached<T = unknown>(namespace: string, key: string): Promise<T | null>;

  /**
   * Set cached value
   * @param namespace Cache namespace
   * @param key Cache key
   * @param value Value to cache
   * @param ttlMs Optional TTL in milliseconds (undefined = no expiry)
   */
  setCached<T = unknown>(namespace: string, key: string, value: T, ttlMs?: number): Promise<void>;

  /**
   * Delete cached value
   * @param namespace Cache namespace
   * @param key Cache key
   */
  deleteCached(namespace: string, key: string): Promise<void>;

  /**
   * Clear all cached values in a namespace
   * @param namespace Cache namespace
   */
  clearCache(namespace: string): Promise<void>;
}

/**
 * Metrics store interface - health stats and per-session counters
 */
export interface MetricsStore {
  /**
   * Increment a metric counter
   * @param sessionId Session ID
   * @param metric Metric name
   * @param delta Amount to increment by (default: 1)
   */
  increment(sessionId: string, metric: string, delta?: number): Promise<void>;

  /**
   * Get a metric value
   * @param sessionId Session ID
   * @param metric Metric name
   * @returns Metric value (0 if not found)
   */
  get(sessionId: string, metric: string): Promise<number>;

  /**
   * Get all metrics for a session
   * @param sessionId Session ID
   * @returns Record of metric names to values
   */
  getAll(sessionId: string): Promise<Record<string, number>>;

  /**
   * Reset metrics for a session
   * @param sessionId Session ID
   * @param metric Optional specific metric to reset (undefined = reset all)
   */
  reset(sessionId: string, metric?: string): Promise<void>;
}

/**
 * QR code store interface - QR code caching for worker/API split architectures
 */
export interface QRStore {
  /**
   * Save QR code with TTL
   * @param sessionId Session ID
   * @param qr QR code string
   * @param ttlSeconds TTL in seconds (default: 120)
   */
  saveQR(sessionId: string, qr: string, ttlSeconds?: number): Promise<void>;

  /**
   * Get stored QR code
   * @param sessionId Session ID
   * @returns QR code string or null if not found/expired
   */
  getQR(sessionId: string): Promise<string | null>;

  /**
   * Delete stored QR code
   * @param sessionId Session ID
   */
  deleteQR(sessionId: string): Promise<void>;
}

/**
 * Backend interface - composes all domain stores
 */
export interface Backend extends SessionStore, CredentialStore, CacheStore, MetricsStore, QRStore {}

/**
 * Webhook configuration
 */
export interface WebhookConfig {
  /** Webhook URL to POST events to */
  url: string;
  /** HMAC signing secret (optional) */
  secret?: string;
  /** Event filter - which events to send (default: all) */
  events?: EventType[];
  /** Number of retry attempts on failure (default: 3) */
  retries?: number;
  /** Request timeout in ms (default: 5000) */
  timeout?: number;
}

/**
 * WaSP configuration
 */
export interface WaspConfig {
  /** Session store (defaults to in-memory) */
  store?: SessionStore;

  /** Full backend implementation (overrides individual stores) */
  backend?: Backend;

  /** Credential store (auth tokens, device keys) */
  credentialStore?: CredentialStore;

  /** Cache store (namespaced ephemeral data) */
  cacheStore?: CacheStore;

  /** Metrics store (session counters) */
  metricsStore?: MetricsStore;

  /** Message queue options */
  queue?: Partial<QueueOptions>;

  /** Default provider options */
  defaultProvider?: ProviderType;

  /** Enable debug logging */
  debug?: boolean;

  /** Custom logger */
  logger?: {
    debug: (message: string, ...args: unknown[]) => void;
    info: (message: string, ...args: unknown[]) => void;
    warn: (message: string, ...args: unknown[]) => void;
    error: (message: string, ...args: unknown[]) => void;
  };

  /** Webhook configurations */
  webhooks?: WebhookConfig[];

  /** Ban risk detector configuration */
  banRiskDetector?: {
    enabled?: boolean;
    checkInterval?: number;
    rapidRestartThreshold?: number;
    highErrorRatePercent?: number;
    disconnectThreshold?: number;
    qrRescanThreshold?: number;
  };

  /** Health monitor configuration (proactive pong timer) */
  healthMonitor?: boolean | {
    intervalMs?: number;
    stalenessThresholdMs?: number;
    logMemory?: boolean;
    logger?: {
      info(msg: string, ctx?: any): void;
      warn(msg: string, ctx?: any): void;
    };
  };
}

/**
 * Middleware function type
 */
export interface Middleware {
  (event: WaspEvent, next: () => Promise<void>): Promise<void>;
}

/**
 * Message queue item
 */
export interface QueueItem {
  /** Session ID */
  sessionId: string;
  /** Recipient */
  to: string;
  /** Message content */
  content: string;
  /** Send options */
  options?: SendMessageOptions;
  /** Promise resolve - can return void or Promise<Message> */
  resolve: (message?: Message) => void | Promise<Message>;
  /** Promise reject */
  reject: (error: Error) => void;
  /** Timestamp when queued */
  queuedAt: Date;
  /** Priority */
  priority: number;
}

/**
 * Clock sync sample for RTT-adjusted time synchronization
 */
export interface ClockSyncSample {
  /** Local timestamp when request was sent (ms since epoch) */
  localSentAt: number;
  /** Local timestamp when response was received (ms since epoch) */
  localReceivedAt: number;
  /** Server timestamp reported in response (ms since epoch) */
  serverTimestamp: number;
}

/**
 * Clock sync statistics
 */
export interface ClockSyncStats {
  /** Estimated clock skew in ms (negative = local ahead, positive = local behind) */
  skewMs: number;
  /** Estimated round-trip time in ms */
  estimatedRttMs: number;
  /** Number of samples collected */
  sampleCount: number;
  /** Confidence level based on sample count and variance */
  confidence: 'low' | 'medium' | 'high';
  /** Timestamp when stats were last updated */
  lastUpdatedAt: number;
}

/**
 * Clock sync configuration
 */
export interface ClockSyncConfig {
  /** Rolling window size for samples (default: 10) */
  sampleWindowSize?: number;
  /** Minimum RTT samples before trusting skew (default: 3) */
  minRttSamples?: number;
}

/**
 * Health/stats information
 */
export interface HealthStats {
  /** Uptime in milliseconds */
  uptime: number;
  /** Session statistics */
  sessions: {
    total: number;
    connected: number;
    disconnected: number;
  };
  /** Message statistics */
  messages: {
    sent: number;
    received: number;
  };
  /** Memory usage */
  memory: {
    heapUsed: number;
    heapTotal: number;
  };
  /** Clock sync statistics */
  clockSync?: ClockSyncStats;
  /** Cache statistics */
  cache?: {
    size: number;
  };
  /** Credential count */
  credentials?: {
    total: number;
  };
}

/**
 * TC Token for error 463 prevention
 */
export interface TcToken {
  /** Token buffer (raw bytes) */
  token: Buffer;
  /** Receiver timestamp (when token was issued) */
  timestamp: number;
  /** Sender timestamp (when we sent the token) */
  senderTimestamp?: number;
}

/**
 * TC Token manager configuration
 */
export interface TcTokenConfig {
  /** Rolling bucket size in seconds (default: 7 days) */
  bucketSize?: number;
  /** Number of rolling buckets (default: 4) */
  numBuckets?: number;
  /** Sender mode bucket size in seconds (default: 7 days) */
  senderBucketSize?: number;
  /** Sender mode number of buckets (default: 4) */
  senderNumBuckets?: number;
  /** Pruning interval in ms (default: 24h) */
  pruneInterval?: number;
  /** CS token LRU cache size (default: 5) */
  cstokenCacheSize?: number;
  /** Disable TC token feature entirely */
  disabled?: boolean;
}
