/**
 * WaSP - WhatsApp Session Protocol
 *
 * A protocol layer for WhatsApp session management and message routing.
 * Provides a unified interface across Baileys, Whatsmeow, and Cloud API.
 *
 * @module @wasp/core
 */

// Main exports
export { WaSP } from './wasp.js';
export { createAdminRouter } from './admin.js';
export type { AdminRouterOptions } from './admin.js';
export { MessageQueue } from './queue.js';
export { WebhookManager } from './webhook.js';
export { wrapSocket } from './wrap-socket.js';
export type { WrappedSocket } from './wrap-socket.js';
export { ClockSync } from './clock-sync.js';

// Types
export type {
  WaspConfig,
  Session,
  Message,
  Provider,
  Store,
  SessionStore,
  CredentialStore,
  CacheStore,
  MetricsStore,
  Backend,
  WaspEvent,
  SendMessageOptions,
  QueueOptions,
  Middleware,
  SessionMetadata,
  QuotedMessage,
  WebhookConfig,
  HealthStats,
  ReachoutTimelockInfo,
  ClockSyncConfig,
  ClockSyncSample,
  ClockSyncStats,
} from './types.js';

export {
  SessionStatus,
  MessageType,
  EventType,
  ProviderType,
} from './types.js';

// Stores
export { MemoryStore } from './stores/memory.js';
export { RedisStore } from './stores/redis.js';
export type { RedisStoreConfig } from './stores/redis.js';
export { PostgresStore } from './stores/postgres.js';
export type { PostgresStoreConfig } from './stores/postgres.js';

// Providers
export { BaileysProvider } from './providers/baileys.js';
export type { BaileysProviderOptions } from './providers/baileys.js';
export { TcTokenManager } from './providers/baileys-tc-token.js';
export type { TcToken, TcTokenConfig } from './types.js';
export { CloudAPIProvider } from './providers/cloud-api.js';
export type {
  CloudAPIProviderOptions,
  InteractiveMessage,
  InteractiveButton,
  ListSection,
  TemplateMessage,
  LocationMessage,
  ContactMessage,
  MediaMessage,
  ReactionMessage,
  CloudAPIMessageContent,
} from './providers/cloud-api.js';

// Middleware
export {
  logger,
  autoReconnect,
  rateLimit,
  errorHandler,
} from './middleware.js';

// Errors
export {
  SessionNotFoundError,
  NotConnectedError,
  InvalidSessionIdError,
  QueueFullError,
  InvalidTableNameError,
} from './errors.js';
