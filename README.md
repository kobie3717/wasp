# WaSP - WhatsApp Session Protocol

<div align="center">

```
██╗    ██╗ █████╗ ███████╗██████╗
██║    ██║██╔══██╗██╔════╝██╔══██╗
██║ █╗ ██║███████║███████╗██████╔╝
██║███╗██║██╔══██║╚════██║██╔═══╝
╚███╔███╔╝██║  ██║███████║██║
 ╚══╝╚══╝ ╚═╝  ╚═╝╚══════╝╚═╝
```

[![npm version](https://img.shields.io/npm/v/wasp-protocol.svg)](https://www.npmjs.com/package/wasp-protocol)
[![npm downloads](https://img.shields.io/npm/dm/wasp-protocol.svg?style=flat-square)](https://www.npmjs.com/package/wasp-protocol)
[![CI](https://github.com/kobie3717/wasp/actions/workflows/ci.yml/badge.svg)](https://github.com/kobie3717/wasp/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue.svg)](https://www.typescriptlang.org/)
[![Discord](https://img.shields.io/badge/Discord-Join%20Chat-5865F2?logo=discord&logoColor=white)](https://discord.gg/Y2jCXNGgE)

**Production-ready infrastructure layer for WhatsApp integrations**

[Quick Start](#quick-start) • [Features](#features) • [Documentation](#documentation) • [Examples](#examples) • [Docker](#docker)

</div>

---

> **WhatsApp Session Protocol for Node.js.** Drop-in session infrastructure for Baileys. Built-in reconnection, rate limiting, secure credential storage, and multi-tenant isolation — everything Baileys leaves out.
> 
> Baileys alternative · whatsapp-web.js alternative · Secure session management · npm install wasp-protocol

## Used in Production

WaSP powers real-world WhatsApp integrations:
- **[WhatsHub](https://github.com/kobie3717/whatshub)** - Multi-tenant WhatsApp messaging platform
- **WhatsAuction** (whatsauction.co.za) - Live auction bidding via WhatsApp
- **FlashVault VPN** (flashvault.co.za) - Customer support automation

## Why WaSP?

Building WhatsApp integrations is painful. Every project requires re-implementing:
- Session management and persistence
- Multi-tenant isolation
- Anti-ban queueing with human-like delays
- Reconnection logic and error handling
- Provider-specific quirks

**WaSP solves this.** One unified API across Baileys, Whatsmeow, and Cloud API with batteries included.

## WaSP vs Baileys vs whatsapp-web.js

| Feature | WaSP | Baileys | whatsapp-web.js |
|---|---|---|---|
| Session persistence | ✅ Pluggable adapters | ❌ Dropped (DIY) | ⚠️ Basic |
| Reconnection logic | ✅ Built-in backoff | ❌ DIY | ❌ DIY |
| Rate limiting | ✅ Built-in governor | ❌ Undocumented (silent bans) | ❌ None |
| Credential security | ✅ Abstracted store | ❌ Plaintext filesystem | ❌ Plaintext |
| Multi-tenant | ✅ Isolated per org/user | ❌ Manual | ❌ No |
| Chrome/Puppeteer | ✅ Not required | ✅ Not required | ❌ 400MB+ |
| Supply chain | ✅ Known maintainer | ⚠️ lotusbail attack Dec 2025 | ⚠️ Ecosystem risk |
| TypeScript | ✅ First-class | ⚠️ Partial | ⚠️ Basic |
| Production-ready | ✅ Yes | ❌ Assembly required | ❌ Regression Jan 2026 |

## Features

- ✅ **Unified API** - One interface across all WhatsApp providers
- 🏢 **Multi-tenant** - Isolated sessions per org/user
- 🛡️ **Anti-ban queue** - Human-like delays, priority lanes
- 💾 **Pluggable storage** - Memory, Redis, Postgres
- 🔧 **Middleware system** - Logging, reconnection, rate limiting
- 📘 **TypeScript-first** - Full type safety
- 🚀 **Production-ready** - Auto-reconnect, error recovery
- 📡 **Event-driven** - Normalized events across providers
- 🐳 **Docker support** - Ready-to-deploy containers

## Quick Start

### Installation

```bash
npm install wasp-protocol @whiskeysockets/baileys

# Optional: For persistence
npm install ioredis  # Redis store
npm install pg       # Postgres store
```

### Basic Usage

```typescript
import { WaSP } from 'wasp-protocol';

const wasp = new WaSP({
  queue: {
    minDelay: 2000,  // Min 2s between messages
    maxDelay: 5000,  // Max 5s between messages
  },
});

// Create session (QR code authentication)
const session = await wasp.createSession('user-123', 'BAILEYS');

// Listen for QR code
wasp.on('SESSION_QR', (event) => {
  console.log('Scan this:', event.data.qr);
});

// Listen for connection
wasp.on('SESSION_CONNECTED', (event) => {
  console.log('Connected as:', event.data.phone);
});

// Handle incoming messages
wasp.on('MESSAGE_RECEIVED', async (event) => {
  const msg = event.data;
  console.log(`From ${msg.from}: ${msg.content}`);

  // Auto-reply
  if (msg.content === 'hello') {
    await wasp.sendMessage(event.sessionId, msg.from, 'Hi there!');
  }
});

// Send message (auto-queued with anti-ban delay)
await wasp.sendMessage('user-123', '27821234567@s.whatsapp.net', 'Hello!');
```

## Architecture

```
┌─────────────────────────────────────────┐
│         Your Application                │
│  (SaaS, Bot, Notifications, etc.)       │
└─────────────────────────────────────────┘
                  │
                  │ WaSP Unified API
                  ▼
┌─────────────────────────────────────────┐
│            WaSP Core                    │
│  • Session Manager (multi-tenant)       │
│  • Anti-Ban Queue (priority lanes)      │
│  • Middleware Pipeline                  │
│  • Store (Memory/Redis/Postgres)        │
└─────────────────────────────────────────┘
                  │
       ┌──────────┼──────────┐
       ▼          ▼          ▼
   Baileys  Whatsmeow  Cloud API
       │          │          │
       └──────────┴──────────┘
                  │
           WhatsApp Servers
```

## Core Concepts

### Sessions

Multi-tenant session isolation. Each user/org gets their own WhatsApp connection.

```typescript
// Create session with metadata
await wasp.createSession('org-acme', 'BAILEYS', {
  orgId: 'org-acme',
  metadata: { plan: 'enterprise' },
});

// List sessions by org
const sessions = await wasp.listSessions({ orgId: 'org-acme' });

// Destroy session
await wasp.destroySession('org-acme');
```

### Anti-Ban Queue

Prevents WhatsApp bans with human-like delays and priority lanes.

```typescript
// Regular message (2-5s delay)
await wasp.sendMessage('session-1', recipient, 'Hello');

// Priority message (1-2.5s delay)
await wasp.sendMessage('session-1', recipient, 'Urgent!', { priority: 10 });

// Immediate (skip queue - use sparingly!)
await wasp.sendMessage('session-1', recipient, 'Alert!', { immediate: true });
```

### Storage

Choose persistence layer based on your needs.

```typescript
import { WaSP, RedisStore, PostgresStore } from 'wasp-protocol';

// Redis (multi-instance, fast)
const wasp = new WaSP({
  store: new RedisStore({
    host: 'localhost',
    port: 6379,
    keyPrefix: 'wasp:',
  }),
});

// Postgres (queryable, analytics)
const wasp = new WaSP({
  store: new PostgresStore({
    connectionString: 'postgresql://user:pass@localhost/db',
    autoCreate: true,
  }),
});
```

### Middleware

Compose cross-cutting concerns without polluting core logic.

```typescript
import { logger, autoReconnect, errorHandler } from 'wasp-protocol';

wasp.use(logger());  // Log all events
wasp.use(autoReconnect({ maxAttempts: 5 }));  // Auto-reconnect on disconnect
wasp.use(errorHandler((error) => console.error(error)));

// Custom middleware
wasp.use(async (event, next) => {
  console.log('Before:', event.type);
  await next();
  console.log('After:', event.type);
});
```

## Events

WaSP emits normalized events across all providers:

| Event | Description |
|-------|-------------|
| `SESSION_CONNECTED` | Session authenticated |
| `SESSION_DISCONNECTED` | Connection lost |
| `SESSION_QR` | QR code for scanning |
| `SESSION_ERROR` | Error occurred |
| `MESSAGE_RECEIVED` | Incoming message |
| `MESSAGE_SENT` | Outgoing message sent |
| `MESSAGE_DELIVERED` | Message delivered |
| `MESSAGE_READ` | Message read by recipient |
| `GROUP_JOIN` | Bot joined group |
| `GROUP_LEAVE` | Bot left group |
| `PRESENCE_UPDATE` | User online/typing |

```typescript
wasp.on('MESSAGE_RECEIVED', (event) => {
  console.log(event.data);  // Normalized Message object
});

wasp.on('*', (event) => {
  console.log('Any event:', event.type);
});
```

## Examples

See [`examples/`](./examples) directory:

- **[echo-bot.ts](./examples/echo-bot.ts)** - Simple bot that echoes messages
- **[webhook-forwarder.ts](./examples/webhook-forwarder.ts)** - Forward messages to webhook
- **[group-monitor.ts](./examples/group-monitor.ts)** - Monitor and log group activity
- **[multi-session.ts](./examples/multi-session.ts)** - Manage 3 sessions simultaneously

Run examples:
```bash
npx tsx examples/echo-bot.ts
```

## Docker

### Quick Start

```bash
# Build and run with Redis
docker-compose up

# Development mode (hot reload)
docker-compose -f docker-compose.yml -f docker-compose.dev.yml up
```

### Dockerfile

Pre-configured production Dockerfile included. Supports:
- Node.js 20 slim base
- Multi-stage builds
- Auth state persistence
- Environment configuration

See [`Dockerfile`](./Dockerfile) and [`docker-compose.yml`](./docker-compose.yml).

## CLI Usage

WaSP provides a CLI for testing and development:

```bash
# Start interactive session
npx wasp-protocol connect

# Send message
npx wasp-protocol send --to 27821234567 --message "Hello"

# List sessions
npx wasp-protocol list
```

## API Reference

### Core Methods

```typescript
// Session management
createSession(id, provider, options?): Promise<Session>
destroySession(id): Promise<void>
getSession(id): Promise<Session | null>
listSessions(filter?): Promise<Session[]>

// Messaging
sendMessage(sessionId, to, content, options?): Promise<Message>

// Events
on(event, handler): this
off(event, handler): this
once(event, handler): this

// Middleware
use(middleware): this

// Stats
getQueueStats(): QueueStats
getSessionCount(): number
```

### Types

```typescript
interface Session {
  id: string;
  phone?: string;
  status: SessionStatus;
  provider: ProviderType;
  orgId?: string;
  connectedAt?: Date;
  createdAt: Date;
  lastActivityAt?: Date;
  metadata?: Record<string, unknown>;
}

interface Message {
  id: string;
  from: string;
  to: string;
  type: MessageType;
  content: string;
  timestamp: Date;
  isGroup: boolean;
  groupId?: string;
  mediaUrl?: string;
  mediaMimeType?: string;
}
```

Full API docs: See TypeScript definitions in [`src/types.ts`](./src/types.ts).

## Comparison

| Feature | WaSP | Raw Baileys | Cloud API | RetentionStack |
|---------|------|-------------|-----------|----------------|
| **Multi-tenant** | ✅ Built-in | ❌ DIY | ❌ DIY | ✅ Built-in |
| **Anti-ban queue** | ✅ Built-in | ❌ DIY | ✅ Official | ✅ Paid |
| **Reconnection** | ✅ Auto | ❌ DIY | ✅ Auto | ✅ Auto |
| **Storage** | ✅ Pluggable | ❌ DIY | ☁️ Cloud | ☁️ Hosted |
| **Middleware** | ✅ Built-in | ❌ None | ❌ None | ⚠️ Limited |
| **TypeScript** | ✅ Full | ⚠️ Partial | ✅ Full | ✅ Full |
| **Cost** | 🆓 Free | 🆓 Free | 💰 $0.005-0.09/msg | 💰 $99+/mo |
| **Self-hosted** | ✅ Yes | ✅ Yes | ❌ No | ❌ No |
| **Provider swap** | ✅ Easy | ❌ Rewrite | ❌ Locked | ❌ Locked |

## Roadmap

- [x] Baileys provider (v7.0+)
- [x] Memory/Redis/Postgres stores
- [x] Anti-ban queue
- [x] Middleware system
- [x] Docker support
- [x] CLI tool
- [ ] Whatsmeow provider
- [ ] Cloud API provider
- [ ] Webhook system
- [ ] Message templates
- [ ] Admin dashboard UI

## Contributing

Contributions welcome! See [CONTRIBUTING.md](./CONTRIBUTING.md).

```bash
git clone https://github.com/kobie3717/wasp.git
cd wasp
npm install
npm test
npm run build
```

## License

MIT © [Kobus Wentzel](https://github.com/kobie3717)

## Support

- **Discord:** [Join our community](https://discord.gg/Y2jCXNGgE)
- **Issues:** [GitHub Issues](https://github.com/kobie3717/wasp/issues)
- **Discussions:** [GitHub Discussions](https://github.com/kobie3717/wasp/discussions)
- **Email:** kobie3717@gmail.com

## Security

For security issues, email kobie3717@gmail.com instead of using the issue tracker.

## Changelog

See [CHANGELOG.md](./CHANGELOG.md) for release history.

---

<div align="center">

**Built with ❤️ in South Africa**

[npm](https://www.npmjs.com/package/wasp-protocol) • [GitHub](https://github.com/kobie3717/wasp) • [Issues](https://github.com/kobie3717/wasp/issues)

</div>
