# Changelog

All notable changes to WaSP (WhatsApp Session Protocol) will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.3] - 2026-05-22

### Added
- **`createAdminRouter(wasp, options)`** - Optional Express router for HTTP session management.
  Mount on any Express app to get `GET /`, `GET /:id`, `POST /:id/connect`, `POST /:id/disconnect`, `GET /:id/qr`.
  - Bearer token auth via `options.token`
  - QR codes cached in-memory from `SESSION_QR` events, cleared on `SESSION_CONNECTED`
  - `GET /:id/qr` returns data URL if `qrcode` package is installed, raw QR string otherwise
  - No Express peer dependency required at compile time (inline interfaces)
  - Exported as `createAdminRouter` and `AdminRouterOptions` from main package

## [0.4.2] - 2026-04-27

### Fixed
- Bad MAC session cleanup now preserves v7 auth state files: `lid-mapping.*`, `device-list.*`, `tctoken.*`, `app-state-sync.*`. Previously these could be accidentally deleted during Bad MAC recovery, requiring full re-registration.

## [0.4.0] - 2026-04-18

### Added
- **Domain-Split Backend Interfaces** (pattern adapted from jlucaso1/whatsapp-rust)
  - `SessionStore` - CRUD operations for session data (replaces `Store` as primary interface)
  - `CredentialStore` - auth tokens, device credentials, encrypted keys
  - `CacheStore` - namespaced ephemeral data with TTL support
  - `MetricsStore` - health stats and per-session counters
  - `Backend` - composed interface implementing all four stores
  - All stores (MemoryStore, PostgresStore, RedisStore) now implement full `Backend` interface
- **ClockSync Utility** (pattern adapted from jlucaso1/whatsapp-rust RTT-adjusted clock sync)
  - Rolling window of RTT samples for server time synchronization
  - Median-based skew calculation (resists outliers)
  - Confidence scoring (low/medium/high based on sample count and variance)
  - `toServerTime()` and `toLocalTime()` conversion methods
  - Exposed via `wasp.clock` getter
- **Namespaced CacheStore** with best-effort semantics
  - Methods: `getCached()`, `setCached()`, `deleteCached()`, `clearCache()`
  - Namespace isolation (e.g., 'group', 'device', 'contact')
  - TTL support in milliseconds
  - Best-effort error handling (cache read/write failures never throw)
  - Background sweep for expired entries (MemoryStore: every 60s)
  - Redis: uses `SETEX` for TTL, `SCAN` for namespace clearing
  - Postgres: separate `wasp_cache` table with `expires_at` column
- **CredentialStore** for secure credential management
  - String and Buffer support
  - Postgres: stores as `BYTEA`, auto-upsert on conflict
  - Redis: base64 encoding for Buffers
  - Per-session isolation with `clearCredentials()` for cleanup
- **MetricsStore** for per-session counters
  - Atomic increment operations with custom delta
  - `getAll()` returns all metrics for a session
  - `reset()` clears specific metric or all metrics
  - Postgres: uses `ON CONFLICT DO UPDATE` for atomic increments
  - Redis: uses `INCRBY` for atomic operations
- **Enhanced HealthStats**
  - `clockSync` field with skew, RTT, sample count, confidence
  - `cache.size` field (total cached entries)
  - `credentials.total` field (total credential count)
- **New Getters on Wasp Class**
  - `wasp.sessions` - SessionStore
  - `wasp.credentials` - CredentialStore
  - `wasp.cache` - CacheStore
  - `wasp.metrics` - MetricsStore
  - `wasp.clock` - ClockSync
- **Comprehensive Test Suite** (5 new test files, 80+ tests)
  - `clock-sync.test.ts` - 15 tests for ClockSync
  - `credentialStore.test.ts` - 11 tests for CredentialStore
  - `cacheStore.test.ts` - 16 tests for CacheStore
  - `metricsStore.test.ts` - 12 tests for MetricsStore
  - `backend-composition.test.ts` - 7 integration tests

### Changed
- **BREAKING**: `Store` interface unchanged but now represents only `SessionStore`
  - Existing code using `Store` continues to work (backward-compatible type alias)
  - `Backend` is the new composed interface for all four stores
- `WaspConfig` now accepts optional fields:
  - `backend?: Backend` - full backend implementation (overrides individual stores)
  - `credentialStore?: CredentialStore`
  - `cacheStore?: CacheStore`
  - `metricsStore?: MetricsStore`
- `MemoryStore` constructor now starts background cache sweep timer (60s interval)
- `PostgresStore` constructor now accepts `tablePrefix` option (default: 'wasp')
- All Postgres schema changes are **additive only** (no drops, no renames):
  - New table: `wasp_credentials (session_id, key, value, created_at)`
  - New table: `wasp_cache (namespace, key, value, expires_at, created_at)`
  - New table: `wasp_metrics (session_id, metric, value, updated_at)`
  - New indexes on `session_id`, `expires_at` (cache), etc.
- Redis key patterns:
  - Credentials: `wasp:cred:{sessionId}:{key}`
  - Cache: `wasp:cache:{namespace}:{key}`
  - Metrics: `wasp:metrics:{sessionId}:{metric}`

### Migration Notes
- **Existing consumers**: No changes required. Passing `store: new MemoryStore()` works identically to v0.3.2
- **To use new features**:
  ```typescript
  const wasp = new WaSP({ store: new MemoryStore() });

  // Access new stores:
  await wasp.credentials.saveCredential('session-1', 'auth-token', 'secret');
  await wasp.cache.setCached('group', 'metadata-123', { name: 'Group' }, 60000); // 60s TTL
  await wasp.metrics.increment('session-1', 'messages-sent');
  const stats = wasp.clock.getStats();
  ```
- **Postgres users**: Run migrations to create new tables (see `PostgresStore` auto-create or run SQL manually)
- **Redis users**: No migration needed (keys created on first write)

### Technical Details
- ClockSync uses rolling median (not mean) to resist RTT outliers
- Cache TTL is milliseconds (Postgres stores `expires_at` as timestamp, Redis uses `EX` in seconds)
- Postgres uses `BYTEA` for credentials (supports both string and binary)
- Redis uses base64 encoding for Buffer credentials
- All cache operations log warnings on error but never throw (best-effort semantics)
- Cache sweep runs every 60s in MemoryStore (configurable by destroying and recreating)

### Credit
Patterns adapted from [jlucaso1/whatsapp-rust](https://github.com/jlucaso1/whatsapp-rust):
- Domain-split storage backends (wacore/src/store/traits.rs)
- RTT-adjusted clock sync (src/unified_session.rs)

## [0.3.0] - 2026-03-27

### Added
- **TC Token / CS Token Support** - Error 463 prevention (MAJOR FEATURE)
  - Automatic TC token extraction from history sync (field 21, 22, 28)
  - Automatic TC token extraction from privacy_token notifications
  - CS token fallback via HMAC-SHA256(nctSalt, recipientLid)
  - Rolling bucket expiration (28 day default window, configurable)
  - Monotonicity guard (rejects older tokens)
  - Automatic token attachment to 1:1 messages (not groups/broadcast)
  - Automatic privacy token re-issuance (fire-and-forget)
  - LRU cache for CS tokens (max 5 entries, configurable)
  - Automatic pruning every 24h (configurable)
  - Persistent storage to `tc-tokens.json` (base64 serialization)
  - `TcTokenManager` class (comprehensive token management)
  - `tcTokenConfig` option in `BaileysProviderOptions`
  - Can be disabled per-session via `tcTokenConfig.disabled`
- **CloudAPIProvider** - Meta WhatsApp Cloud API support
  - REST-based provider (no WebSocket, easier deployment)
  - Interactive button messages (up to 3 reply buttons)
  - List messages with sections and dropdown menus
  - Template messages (pre-approved message templates)
  - Media messages (image, video, audio, document with URLs)
  - Location messages (GPS coordinates with name/address)
  - Contact messages (vCard sharing)
  - Reaction messages (emoji reactions)
  - Webhook verification (`CloudAPIProvider.verifyWebhook()`)
  - Webhook parsing (`CloudAPIProvider.parseWebhook()`)
- **Comprehensive test suite** for CloudAPIProvider (30 tests)
  - Connection and authentication tests
  - All message type sending tests
  - Webhook verification tests
  - Webhook message parsing tests
  - Error handling tests
- **Documentation** for Cloud API provider
  - Complete usage guide (`docs/CLOUD_API_PROVIDER.md`)
  - Interactive message examples
  - Webhook setup instructions
  - Rate limit guidance
  - Hybrid setup (Baileys + Cloud API)
- **Example applications**
  - `cloud-api-buttons.ts` - All message types showcase
  - `cloud-api-webhook-server.ts` - Complete webhook server with auto-replies
  - `cloud-api-shop-bot.ts` - Full e-commerce bot with cart management
- **TypeScript exports**
  - `CloudAPIProvider` class
  - `CloudAPIProviderOptions` interface
  - `InteractiveMessage`, `InteractiveButton`, `ListSection` types
  - `TemplateMessage`, `LocationMessage`, `ContactMessage` types
  - `MediaMessage`, `ReactionMessage` types
  - `CloudAPIMessageContent` union type

### Changed
- Updated `wasp.ts` to support CLOUD_API provider type
- Enhanced `index.ts` with Cloud API exports

### Technical Details
- Cloud API uses native `fetch` (Node 18+) - no axios dependency
- Proper error mapping from Meta API errors to WaSP error types
- Phone number formatting (removes `@s.whatsapp.net` suffix)
- Message type normalization for webhook parsing
- Support for interactive button/list replies in webhooks

## [0.2.0] - 2026-03-22

### Added
- **Production-grade Baileys provider** with real WhatsApp connection logic
  - Exponential backoff reconnection (1s → 32s)
  - Bad MAC error recovery with state cleanup
  - Rate limit detection and throttle handling
  - Message normalization with JID formatting
- **Complete store implementations**
  - RedisStore with SCAN-based operations, TTL support, Date serialization
  - PostgresStore with auto-schema creation, JSONB metadata, indexed queries
  - MemoryStore with filtering and pagination
- **GitHub Actions CI** with Node.js 18/20 matrix testing
- **Comprehensive documentation**
  - 888-line README with API reference, examples, architecture diagrams
  - Comparison tables (WaSP vs Baileys vs Cloud API vs RetentionStack)
  - Complete TypeScript type definitions
- **Example applications**
  - Echo bot (simple message echo)
  - Webhook forwarder (integration example)
  - Group monitor (activity logging)
  - Multi-session manager (multi-tenant demo)
- **Docker support**
  - Production Dockerfile with optimized build
  - docker-compose.yml with Redis integration
  - docker-compose.dev.yml for development workflow

### Changed
- Upgraded to TypeScript 5.7.2
- Updated Baileys to ^7.0.0
- Updated pino to 9.5.0
- Enhanced test coverage to 36 tests across 3 stores and 4 middleware

### Fixed
- Session state persistence across reconnects
- Memory leaks in event handlers
- Type safety issues with provider abstraction

## [0.1.1] - 2026-03-19

### Added
- Basic store system (Memory, Redis, Postgres stubs)
- Middleware pipeline (logger, autoReconnect, rateLimit, errorHandler)
- Anti-ban queue with priority lanes
- Event normalization system

### Changed
- Improved TypeScript types
- Better error handling

## [0.1.0] - 2026-03-10

### Added
- Initial WaSP core implementation
- Session management abstraction
- Provider interface design
- Message queue with priority support
- Basic Baileys provider scaffold
- MIT license
- Project scaffolding (tsup, Vitest, ESLint)

### Notes
- First release - proof of concept
- Not production-ready (scaffold only)

---

## [Unreleased]

### Planned
- [ ] Whatsmeow provider implementation
- [ ] Cloud API provider implementation
- [ ] Message templates system
- [ ] Built-in webhook support with retry logic
- [ ] Group management utilities
- [ ] Metrics and monitoring dashboard
- [ ] Rate limiting per session/org
- [ ] Message queuing with Redis backend
- [ ] CLI tool for session management
- [ ] Admin dashboard UI

---

[0.2.0]: https://github.com/kobie3717/wasp/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/kobie3717/wasp/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/kobie3717/wasp/releases/tag/v0.1.0
