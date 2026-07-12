# @wasp/baileys-core — Baileys Fork Strategy

## Overview

**@wasp/baileys-core** is a production-ready fork of [Baileys](https://github.com/WhiskeySockets/Baileys) that adds **session persistence** and **reconnection middleware** on top of the official Baileys library.

**Problem**: Baileys dropped built-in session persistence in v7.0+, leaving 2.4M monthly npm downloads without a solution. Developers now must DIY session management (auth state, credentials, restore logic) — error-prone and complex.

**Solution**: `@wasp/baileys-core` = Baileys + WaSP's session persistence layer baked in. Same API, but production-ready out of the box.

## Positioning

### Target Audience

1. **Existing Baileys users** (2.4M monthly downloads) who need session persistence
2. **New WhatsApp bot builders** who want "Baileys, but easier"
3. **Teams scaling from 1 → 10+ sessions** who hit DIY session management pain

### Value Proposition

> "Baileys, but production-ready. Same API, adds session persistence + reconnection + ban risk detection."

**Why not just use Baileys?**
- Baileys v7+ removed session persistence (auth state management)
- Reconnection logic is DIY (complex, easy to mess up)
- No ban risk detection (you find out when you're banned)

**Why not use wasp-protocol?**
- wasp-protocol is a session management **layer** on top of Baileys (more abstraction)
- `@wasp/baileys-core` is a **drop-in replacement** for Baileys (same API)
- Use `@wasp/baileys-core` if you want Baileys with batteries included
- Use `wasp-protocol` if you need multi-provider (Baileys + Whatsmeow + Cloud API)

### Competitive Matrix

| Feature | Baileys | @wasp/baileys-core | wasp-protocol |
|---------|---------|-------------------|---------------|
| Session Persistence | ❌ (removed in v7) | ✅ File/Redis/Postgres | ✅ File/Redis/Postgres |
| Reconnection | ❌ DIY | ✅ Auto backoff | ✅ Auto backoff |
| Ban Risk Detection | ❌ | ✅ Basic | ✅ Advanced (Pro) |
| Multi-Provider | ❌ Baileys only | ❌ Baileys only | ✅ Baileys + Cloud API |
| API Complexity | Low | Low (same API) | Medium (abstraction layer) |
| TypeScript Support | Partial | ✅ Strict | ✅ Strict |

## Architecture

### Fork vs Wrapper

**Decision: Fork + patch, not wrapper.**

**Why fork**:
- Baileys has breaking changes every few months → wrapper breaks
- Session auth state is deeply integrated into Baileys internals
- Forking lets us maintain API compatibility while adding features

**Patching strategy**:
1. Fork official Baileys repo → `kobie3717/baileys-core`
2. Apply WaSP patches on top (session persistence, reconnection)
3. Sync from upstream Baileys monthly (merge strategy)
4. Publish as `@wasp/baileys-core` to npm

### Package Structure

```
@wasp/baileys-core
├── src/
│   ├── Socket/                    # Original Baileys socket code
│   ├── WABinary/                  # Original Baileys protocol code
│   ├── Store/                     # Original Baileys store code
│   ├── Persistence/               # NEW: WaSP session persistence
│   │   ├── FileStore.ts
│   │   ├── RedisStore.ts
│   │   ├── PostgresStore.ts
│   │   └── index.ts
│   ├── Reconnection/              # NEW: Auto-reconnection middleware
│   │   ├── backoff.ts
│   │   └── reconnect.ts
│   ├── BanRisk/                   # NEW: Basic ban risk detection
│   │   └── detector.ts
│   ├── Defaults/                  # Original Baileys defaults
│   ├── Utils/                     # Original Baileys utils
│   └── index.ts                   # Main exports (Baileys + WaSP)
├── package.json
├── tsconfig.json
└── README.md
```

### What We Add vs Original Baileys

| Component | Baileys | @wasp/baileys-core |
|-----------|---------|-------------------|
| makeWASocket | ✅ | ✅ (same API) |
| Auth State | Manual | Auto-save to file/Redis/Postgres |
| Reconnection | DIY | Auto-retry with exponential backoff |
| Ban Risk Events | ❌ | ✅ Emit `ban_risk_high` event |
| TypeScript | Partial | Strict (no `any` types) |
| Session Restore | Manual | Auto-restore on restart |

### API Design

**Drop-in replacement for Baileys** — existing Baileys code works with zero changes:

```typescript
// Before (Baileys)
import makeWASocket from '@whiskeysockets/baileys';
const sock = makeWASocket({ /* config */ });

// After (@wasp/baileys-core) — SAME API
import makeWASocket from '@wasp/baileys-core';
const sock = makeWASocket({ /* config */ });
```

**New features are opt-in**:

```typescript
import makeWASocket, { FileStore, enableAutoReconnect } from '@wasp/baileys-core';

// Enable session persistence (file-based)
const sock = makeWASocket({
  auth: FileStore('./auth_states/session-1'),
  // Rest of config same as Baileys
});

// Enable auto-reconnection
enableAutoReconnect(sock, {
  maxAttempts: 5,
  backoff: 'exponential' // 1s, 2s, 4s, 8s, 16s
});

// Listen for ban risk events
sock.ev.on('ban_risk_high', (event) => {
  console.log('Ban risk detected:', event);
});
```

### Session Persistence

**How it works**:

1. **Auth state hooks**: Hook into Baileys' `useMultiFileAuthState` and replace with WaSP stores
2. **Auto-save**: Every auth update (creds, keys) saves to backend (file/Redis/Postgres)
3. **Auto-restore**: On socket reconnect, loads auth state from backend
4. **Credentials isolation**: Each session ID gets isolated storage namespace

**Stores**:

```typescript
// File store (default, no dependencies)
const sock = makeWASocket({
  auth: FileStore('./auth_states/session-1')
});

// Redis store (multi-server, shared state)
import { RedisStore } from '@wasp/baileys-core';
const sock = makeWASocket({
  auth: RedisStore({
    host: 'localhost',
    port: 6379,
    sessionId: 'session-1'
  })
});

// Postgres store (enterprise, relational)
import { PostgresStore } from '@wasp/baileys-core';
const sock = makeWASocket({
  auth: PostgresStore({
    connectionString: process.env.DATABASE_URL,
    sessionId: 'session-1'
  })
});
```

**Store interface** (matches WaSP `CredentialStore`):

```typescript
interface AuthStore {
  saveCreds(creds: AuthenticationCreds): Promise<void>;
  loadCreds(): Promise<AuthenticationCreds | null>;
  saveKeys(keys: SignalKeyStore): Promise<void>;
  loadKeys(): Promise<SignalKeyStore | null>;
  clear(): Promise<void>;
}
```

### Auto-Reconnection

**How it works**:

1. Listen for `connection.update` events
2. On disconnect (not logged out), schedule reconnect
3. Exponential backoff: 1s, 2s, 4s, 8s, 16s (max 5 attempts by default)
4. Emit `reconnecting` and `reconnected` events

**API**:

```typescript
import { enableAutoReconnect } from '@wasp/baileys-core';

enableAutoReconnect(sock, {
  maxAttempts: 5,
  backoff: 'exponential', // or 'linear', 'fixed'
  initialDelay: 1000, // ms
  maxDelay: 60000, // cap at 60s
  onReconnecting: (attempt) => {
    console.log(`Reconnecting (attempt ${attempt})...`);
  },
  onReconnected: () => {
    console.log('Reconnected successfully');
  },
  onFailed: () => {
    console.log('Max reconnect attempts reached');
  }
});
```

### Ban Risk Detection

**Basic implementation** (v0.1.0):

- Detect rapid disconnect/reconnect cycles (>3 in 5 min)
- Detect message send errors (>10% failure rate)
- Emit `ban_risk_high` event with recommendation

**Event shape** (matches WaSP):

```typescript
interface BanRiskEvent {
  sessionId: string;
  riskLevel: 'medium' | 'high' | 'critical';
  signals: string[];
  recommendation: string;
  timestamp: Date;
}

sock.ev.on('ban_risk_high', (event) => {
  console.log(`Ban risk: ${event.riskLevel}`);
  console.log(`Signals: ${event.signals.join(', ')}`);
  console.log(`Recommendation: ${event.recommendation}`);
});
```

**Advanced implementation** (v1.0.0):
- Integrate WaSP Pro's ML-based ban predictor (0-100 score)
- Requires Pro license key

## Maintenance Strategy

### Upstream Sync

**Goal**: Stay compatible with official Baileys updates while maintaining our patches.

**Process**:

1. **Monthly sync**: Merge upstream Baileys `main` branch into our fork
2. **Conflict resolution**: Our patches may conflict with upstream changes
   - Session persistence code is isolated (`src/Persistence/`) → low conflict risk
   - Reconnection middleware hooks into events → medium conflict risk
   - Ban risk detection is additive → no conflict
3. **Testing**: Run full test suite after each merge
4. **Version strategy**: `@wasp/baileys-core@X.Y.Z+baileys-A.B.C`
   - Example: `7.0.0+baileys-7.0.1` (our v7.0.0, based on Baileys v7.0.1)

**Automation**:

```yaml
# .github/workflows/sync-upstream.yml
name: Sync Upstream Baileys
on:
  schedule:
    - cron: '0 0 1 * *' # Monthly on 1st
  workflow_dispatch: # Manual trigger

jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - name: Add upstream remote
        run: git remote add upstream https://github.com/WhiskeySockets/Baileys.git
      - name: Fetch upstream
        run: git fetch upstream
      - name: Merge upstream main
        run: git merge upstream/main --no-ff
      - name: Run tests
        run: npm test
      - name: Create PR
        uses: peter-evans/create-pull-request@v5
        with:
          title: 'chore: sync upstream Baileys'
          branch: sync-upstream
```

### Breaking Changes

**If upstream Baileys breaks our patches**:

1. **Document breaking change** in `CHANGELOG.md`
2. **Release major version** (e.g., `7.0.0` → `8.0.0`)
3. **Provide migration guide** in docs
4. **Maintain LTS branch** (e.g., `v7-lts`) for 6 months

**Historical examples**:
- Baileys v6 → v7: Removed `useMultiFileAuthState` (we restore it)
- Baileys v5 → v6: Changed message format (we handle both)

### Test Coverage

**Goal**: 80%+ code coverage for WaSP-added features.

**Test strategy**:
- **Unit tests**: FileStore, RedisStore, PostgresStore
- **Integration tests**: Auto-reconnection logic
- **E2E tests**: Full socket lifecycle (connect → send → disconnect → reconnect)

**CI/CD**:
- Run tests on every commit (GitHub Actions)
- Run tests against multiple Node versions (18, 20, 22)
- Run tests against Baileys official package (ensure compatibility)

## Distribution

### npm Package

**Package name**: `@wasp/baileys-core`

**Installation**:

```bash
npm install @wasp/baileys-core
```

**Peer dependencies**:
- Node.js >= 18
- TypeScript >= 5.0 (for strict types)
- Optional: `ioredis` (for RedisStore)
- Optional: `pg` (for PostgresStore)

### GitHub Repo

**Repo**: `kobie3717/baileys-core`

**Branch strategy**:
- `main`: Stable releases (synced with upstream Baileys + our patches)
- `develop`: Active development
- `upstream-sync`: Auto-generated PRs from upstream merges

**Tagging strategy**:
- Git tags: `v7.0.0+baileys-7.0.1`
- npm tags: `latest`, `next`, `v7-lts`

### Documentation

**README.md**:
- Quick start (drop-in replacement for Baileys)
- Migration guide (from Baileys to @wasp/baileys-core)
- Feature comparison table
- API reference (session persistence, reconnection, ban risk)

**Docs site** (https://wasp.dev/baileys-core):
- Installation guide
- Session persistence guide (file/Redis/Postgres)
- Reconnection strategies
- Ban risk detection
- FAQ (vs Baileys, vs wasp-protocol)

## SEO Strategy

### Target Keywords

- "baileys session management"
- "baileys redis storage"
- "baileys reconnect"
- "baileys session persistence"
- "baileys production ready"
- "whatsapp bot session restore"

### Content

**Blog posts**:
1. "How to restore Baileys sessions after server restart"
2. "Baileys v7+ removed session persistence — here's the fix"
3. "Production-ready Baileys: Session management + reconnection"

**GitHub**:
- Comprehensive README with code examples
- Tag with keywords: `baileys`, `whatsapp`, `session-management`, `typescript`
- Link to official Baileys repo (credit upstream)

**Stack Overflow**:
- Answer "baileys session restore" questions
- Link to @wasp/baileys-core as solution

## Timeline

### v0.1.0 (MVP — Week 1)

**Goal**: Drop-in Baileys replacement with file-based session persistence.

- [ ] Fork Baileys repo → `kobie3717/baileys-core`
- [ ] Add `FileStore` (session persistence to disk)
- [ ] Hook into Baileys auth state
- [ ] Test with existing Baileys code (ensure API compatibility)
- [ ] Publish to npm as `@wasp/baileys-core@0.1.0`

**Deliverables**:
- npm package installable
- README with quick start
- Example project (basic bot with session persistence)

### v0.2.0 (Redis + Postgres — Week 2)

**Goal**: Add Redis and Postgres backends for multi-server deployments.

- [ ] Implement `RedisStore` (using `ioredis`)
- [ ] Implement `PostgresStore` (using `pg`)
- [ ] Add tests for all stores (unit + integration)
- [ ] Update README with store options

**Deliverables**:
- Redis example (Docker Compose)
- Postgres example (Heroku deployment)
- Migration guide (file → Redis → Postgres)

### v0.3.0 (Auto-Reconnection — Week 3)

**Goal**: Add reconnection middleware with exponential backoff.

- [ ] Implement `enableAutoReconnect` function
- [ ] Hook into `connection.update` events
- [ ] Add backoff strategies (exponential, linear, fixed)
- [ ] Emit `reconnecting`, `reconnected`, `reconnect_failed` events
- [ ] Add tests

**Deliverables**:
- Reconnection guide (docs)
- Example: long-running bot with auto-reconnect

### v0.4.0 (Ban Risk Detection — Week 4)

**Goal**: Add basic ban risk detection (signals + events).

- [ ] Implement `BanRiskDetector` (ported from WaSP)
- [ ] Emit `ban_risk_high` events
- [ ] Track metrics (disconnects, errors, restarts)
- [ ] Add tests

**Deliverables**:
- Ban risk guide (docs)
- Example: pause bot on high ban risk

### v1.0.0 (Production-Ready — Week 5-6)

**Goal**: Polish, docs, launch.

- [ ] TypeScript strict mode (no `any` types)
- [ ] 80%+ test coverage
- [ ] Full API docs (JSDoc + docs site)
- [ ] Migration guide (Baileys → @wasp/baileys-core)
- [ ] Comparison guide (vs Baileys, vs wasp-protocol)
- [ ] Launch blog post + Product Hunt

**Deliverables**:
- Production-ready v1.0.0 release
- Docs site live (https://wasp.dev/baileys-core)
- Case study (agency using @wasp/baileys-core)

## Licensing

### License Choice

**MIT License** (same as Baileys).

**Why MIT**:
- Compatible with upstream Baileys (MIT)
- Permissive (commercial use allowed)
- Widely adopted in npm ecosystem

**Attribution**:
- Credit WhiskeySockets/Baileys in README
- Link to official Baileys repo
- Clearly state this is a fork, not official Baileys

### Commercial Use

**@wasp/baileys-core is free and open-source** (MIT).

**WaSP Pro features** (paid):
- ML-based ban prediction (0-100 score)
- Cloud API integration
- Dashboard components

**Upsell strategy**:
- Use @wasp/baileys-core for free session management
- Upgrade to WaSP Pro for advanced ban prevention + Cloud API

## Risk Analysis

### Risk 1: Baileys Breaking Changes

**Probability**: High (Baileys has breaking changes every few months)

**Impact**: High (our patches may break)

**Mitigation**:
- Automated upstream sync (monthly)
- Comprehensive test suite (catch breaks early)
- LTS branches (v7-lts for 6 months)

### Risk 2: Upstream Baileys Adds Session Persistence

**Probability**: Low (they explicitly removed it in v7)

**Impact**: High (our main value prop disappears)

**Mitigation**:
- We're still adding reconnection + ban risk detection
- If they add persistence, we pivot to focus on those features
- Our stores may be more advanced (multi-backend support)

### Risk 3: Baileys Shuts Down

**Probability**: Low (2.4M monthly downloads)

**Impact**: Critical (we depend on upstream)

**Mitigation**:
- We maintain a fork (can continue independently)
- Community may fork Baileys → we can sync from community forks

### Risk 4: WhatsApp Bans All Unofficial Clients

**Probability**: Medium (WhatsApp has cracked down before)

**Impact**: Critical (entire ecosystem collapses)

**Mitigation**:
- WaSP Pro offers Cloud API as fallback
- @wasp/baileys-core users can migrate to WaSP Pro

## Success Metrics

### Year 1 Goals

- **npm downloads**: 100k/month (5% of Baileys' 2.4M)
- **GitHub stars**: 500 stars
- **Production users**: 50 companies using in production
- **WaSP Pro conversions**: 10% of @wasp/baileys-core users upgrade to Pro

### Unit Economics

- **@wasp/baileys-core**: Free (MIT) → lead gen for WaSP Pro
- **WaSP Pro**: $49/month
- **Conversion funnel**: 100k downloads → 1k active users → 100 Pro upgrades → $4,900 MRR

### Growth Channels

1. **SEO** (50%): "baileys session management" keywords
2. **GitHub** (30%): Stars, forks, issues
3. **Community** (20%): Baileys Discord, WhatsApp dev forums

## Open Questions

1. **Should we maintain backward compatibility with Baileys v6?**
   - Pro: Larger user base (many still on v6)
   - Con: Maintenance burden
   - Decision: v1.0.0 targets Baileys v7+, v0.x can support v6

2. **Should we contribute session persistence back to upstream Baileys?**
   - Pro: Good open-source citizen
   - Con: They may reject (they removed it for a reason)
   - Decision: Offer, but don't force. Fork is our backup.

3. **Should we use WaSP stores directly or reimplement?**
   - Pro: Code reuse, maintain compatibility
   - Con: Coupling with WaSP protocol
   - Decision: Reimplement with same interface (keep independent)

4. **How to handle Baileys security patches?**
   - Pro: Security is critical
   - Con: May require urgent merges
   - Decision: Monitor Baileys releases, fast-track security patches

## Conclusion

**@wasp/baileys-core** is a production-ready fork of Baileys that restores session persistence (removed in v7+) and adds reconnection middleware + ban risk detection.

**Key value props**:
1. Drop-in replacement for Baileys (same API)
2. Session persistence (file/Redis/Postgres)
3. Auto-reconnection with exponential backoff
4. Ban risk detection (basic, upgrades to WaSP Pro for ML-based)

**Distribution**: Free & open-source (MIT), npm package `@wasp/baileys-core`.

**Maintenance**: Monthly upstream sync, LTS branches, 80%+ test coverage.

**Timeline**: v0.1.0 in 1 week, v1.0.0 in 6 weeks.

**Business model**: Lead gen for WaSP Pro (free OSS → paid Pro conversion).

Next steps: Fork Baileys, implement FileStore, publish v0.1.0.
