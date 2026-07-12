# WaSP Pro SDK Specification

## Overview

**WaSP Pro** is a commercial npm package extension that adds enterprise-grade features on top of the open-source `wasp-protocol` library. It is a **software product**, not a managed service — developers install the package, pay a subscription, and run it in their own infrastructure.

## Product Positioning

- **Target Market**: Businesses running 3+ WhatsApp sessions (agencies, SaaS platforms, chatbot companies)
- **Pricing**: $49/month per company (honor system, annual key validation)
- **Distribution**: npm package `wasp-protocol-pro`
- **License**: Commercial, requires active subscription key
- **Support**: Priority Discord/email support, 24h SLA for Pro subscribers

## Architecture

### Package Structure

```
@wasp/pro (npm package name: wasp-protocol-pro)
├── src/
│   ├── index.ts                 # Main exports
│   ├── ban-predictor.ts         # ML-based ban risk scoring (0-100)
│   ├── cloud-api-client.ts      # WhatsApp Cloud API provider (drop-in)
│   ├── auto-migration.ts        # Auto-migrate sessions to Cloud API on ban risk
│   ├── health-dashboard/        # React components for session health UI
│   │   ├── SessionHealth.tsx
│   │   ├── BanRiskChart.tsx
│   │   └── MetricsDashboard.tsx
│   └── license.ts               # License key validation
├── package.json
└── README.md
```

### Peer Dependencies

- `wasp-protocol`: `^0.4.0` (peer dependency, not bundled)
- `react`: `^18.0.0` (optional, for dashboard components)

### Installation

```bash
npm install wasp-protocol wasp-protocol-pro
```

### Usage

```typescript
import { WaSP } from 'wasp-protocol';
import { BanPredictor, CloudAPIProvider, SessionHealthDashboard } from 'wasp-protocol-pro';

// Initialize WaSP with Pro features
const wasp = new WaSP({ /* config */ });

// Enable ban prediction scoring (0-100 risk score)
const banPredictor = new BanPredictor(wasp, {
  licenseKey: process.env.WASP_PRO_LICENSE_KEY
});

banPredictor.on('high_risk', async (event) => {
  console.log(`Session ${event.sessionId} has ${event.riskScore}/100 ban risk`);
  
  // Auto-migrate to Cloud API
  if (event.riskScore >= 80) {
    await wasp.migrateToCloudAPI(event.sessionId);
  }
});

// Use Cloud API as fallback provider
await wasp.createSession('my-session', 'CLOUD_API', {
  phoneNumberId: '123456789',
  accessToken: process.env.WHATSAPP_CLOUD_API_TOKEN
});
```

## Pro Features

### 1. Ban Prediction Scoring (0-100)

**What it does**: Upgrades the free `ban_risk_high` event (boolean) to a continuous 0-100 risk score using machine learning.

**How it works**:
- Trains on historical ban data (signals: error rate, disconnect frequency, message velocity, session age)
- Uses a lightweight logistic regression model (no external ML deps)
- Provides granular risk scores: 0-30 (safe), 31-60 (warning), 61-80 (high), 81-100 (critical)
- Emits `ban_risk_score` events every 30 seconds with updated score

**Code example**:
```typescript
banPredictor.on('ban_risk_score', (event) => {
  console.log(`Session ${event.sessionId}: risk = ${event.riskScore}/100`);
  
  // Custom actions based on score
  if (event.riskScore > 70) {
    // Reduce message rate
    wasp.updateQueueConfig(event.sessionId, { minDelay: 10000 });
  }
});
```

**API**:
```typescript
interface BanRiskScoreEvent {
  sessionId: string;
  riskScore: number; // 0-100
  signals: {
    errorRate: number;
    disconnectFrequency: number;
    messageVelocity: number;
    sessionAge: number;
    accountAge?: number; // if available
  };
  timestamp: Date;
}
```

### 2. WhatsApp Cloud API Client (Official Meta API)

**What it does**: Adds WhatsApp Cloud API as a drop-in provider alongside Baileys/Whatsmeow.

**Why it matters**: 
- Baileys/Whatsmeow use unofficial web protocol → ban risk
- Cloud API is official Meta API → no ban risk, but costs $0.005-0.05/message
- Pro users can **auto-migrate** high-risk sessions from Baileys → Cloud API

**How it works**:
- Implements the `Provider` interface from WaSP core
- Uses Meta's official REST API for sending/receiving messages
- Requires Meta Business account + phone number registration

**Code example**:
```typescript
import { CloudAPIProvider } from 'wasp-protocol-pro';

await wasp.createSession('cloud-session', 'CLOUD_API', {
  phoneNumberId: '123456789',
  accessToken: process.env.WHATSAPP_CLOUD_API_TOKEN,
  webhookUrl: 'https://myapp.com/webhook/whatsapp'
});
```

**Configuration**:
- `phoneNumberId`: Meta phone number ID (from Business Manager)
- `accessToken`: Meta Graph API access token (from Business Manager)
- `webhookUrl`: Your HTTPS endpoint to receive incoming messages

### 3. Auto-Migration to Cloud API

**What it does**: Automatically migrates sessions from Baileys → Cloud API when ban risk exceeds threshold.

**How it works**:
1. Monitor ban risk score via `BanPredictor`
2. When score > 80, emit `auto_migrate_recommended` event
3. User can enable auto-migration: `banPredictor.enableAutoMigration({ threshold: 80 })`
4. System disconnects Baileys session, creates Cloud API session with same ID
5. Seamless transition — queue preserves pending messages

**Code example**:
```typescript
banPredictor.enableAutoMigration({
  threshold: 80, // migrate when risk > 80
  cloudApiConfig: {
    phoneNumberId: '123456789',
    accessToken: process.env.WHATSAPP_CLOUD_API_TOKEN
  }
});

// Emitted when migration happens
wasp.on('SESSION_MIGRATED', (event) => {
  console.log(`Session ${event.sessionId} migrated from ${event.fromProvider} to ${event.toProvider}`);
});
```

### 4. Session Health Dashboard (React Components)

**What it does**: Embeddable React components for visualizing session health, ban risk, and metrics.

**Components**:
- `<SessionHealthDashboard />`: Full dashboard with all sessions
- `<BanRiskChart sessionId="..." />`: Line chart of ban risk over time
- `<MetricsDashboard sessionId="..." />`: Message stats, error rates, uptime

**Code example** (Next.js/React):
```tsx
import { SessionHealthDashboard } from 'wasp-protocol-pro/dashboard';

export default function AdminPage() {
  return (
    <div>
      <h1>WhatsApp Sessions</h1>
      <SessionHealthDashboard 
        waspInstance={wasp}
        refreshInterval={5000}
      />
    </div>
  );
}
```

**Features**:
- Real-time updates (polling or SSE)
- Ban risk gauges with color coding (green/yellow/red)
- Disconnect/restart alerts
- Export metrics to CSV
- Mobile-responsive

### 5. Priority Support

**What you get**:
- Private Discord channel or email support (support@wasp.dev)
- 24-hour response SLA on bugs/questions
- Direct line to maintainer (Kobus)
- Feature requests prioritized
- Help with production deployments

**How to access**:
- Email your license key + question to support@wasp.dev
- Join Pro Discord: discord.gg/wasp-pro (invite sent with license key)

## Revenue Model

### License Validation

**How it works**:
1. User subscribes at https://wasp.dev/pro (Stripe checkout)
2. System generates license key (JWT with expiry)
3. User sets `WASP_PRO_LICENSE_KEY` env var
4. Pro package validates key on startup (offline JWT check)
5. Phone-home check once per 24h to verify subscription active (optional, can be disabled)

**Honor System**:
- No phone-home enforcement initially (trust-based)
- License key checked on startup only
- Annual renewal reminders via email
- Later: add telemetry for license usage stats (opt-in)

**Pricing Tiers**:
- **Solo**: $49/month — unlimited sessions, 1 developer
- **Team**: $149/month — unlimited sessions, 5 developers, shared license
- **Enterprise**: $499/month — unlimited sessions, unlimited devs, on-prem license server

**Annual Discounts**:
- Solo: $490/year (2 months free)
- Team: $1,490/year (2 months free)
- Enterprise: custom pricing

### License Key Format

```
wasp_pro_v1_<base64(jwt)>

JWT payload:
{
  "sub": "customer_id",
  "iss": "wasp.dev",
  "exp": 1735689600, // expiry timestamp
  "tier": "solo" | "team" | "enterprise",
  "seats": 1 | 5 | -1 // -1 = unlimited
}
```

## Target Market

### Primary

1. **WhatsApp Chatbot Agencies** (5-50 clients, each needs 1-3 sessions)
2. **SaaS Platforms** (multi-tenant WA messaging, 10-1000 sessions)
3. **Customer Support Teams** (rotating agents, 5-20 sessions)

### Use Cases

- **Agency**: Manage 30 client WA accounts, need ban prevention + health monitoring
- **SaaS**: Multi-tenant messaging platform, need reliable session management at scale
- **E-commerce**: Automated order updates via WhatsApp, need Cloud API fallback

### Why They Pay

1. **Ban Prevention = Revenue Protection**: Losing a session = losing a client ($500-5k/month revenue)
2. **Time Savings**: Dashboard + auto-migration save 10+ hours/month of firefighting
3. **Cloud API Integration**: Official API access without building custom client
4. **Peace of Mind**: Priority support when production breaks

## Competitive Analysis

### Alternatives

1. **Baileys** (free, but no session management, no ban prevention)
2. **whatsapp-web.js** (free, but legacy, no TypeScript, no multi-tenant)
3. **Twilio WhatsApp API** ($0.005/msg, no ban risk, but expensive at scale)
4. **360dialog** (Cloud API reseller, $49/month + $0.01/msg)

### WaSP Pro Positioning

| Feature | WaSP Pro | Baileys | Twilio | 360dialog |
|---------|----------|---------|--------|-----------|
| Ban Prevention | ✅ ML-based | ❌ | ✅ Official | ✅ Official |
| Session Management | ✅ Built-in | ❌ DIY | N/A | ❌ |
| Multi-Tenant | ✅ Native | ❌ | ✅ | ❌ |
| Cloud API Fallback | ✅ | ❌ | N/A | ✅ |
| Pricing | $49/mo flat | Free | Pay-per-msg | $49/mo + per-msg |
| Self-Hosted | ✅ | ✅ | ❌ | ❌ |

**Key differentiator**: WaSP Pro is the **only solution** that combines unofficial API (Baileys) with official Cloud API as auto-fallback, plus session management + ban prevention, all self-hosted.

## SEO Strategy

### Target Keywords

- "whatsapp api ban prevention"
- "baileys session management"
- "whatsapp cloud api nodejs"
- "whatsapp bot session restore"
- "whatsapp api for agencies"
- "multi-tenant whatsapp api"

### Content Marketing

1. **Blog posts**:
   - "How to prevent WhatsApp bans when using Baileys"
   - "Baileys vs Cloud API: When to use which"
   - "Building a multi-tenant WhatsApp SaaS"

2. **Comparison pages**:
   - "WaSP vs Baileys"
   - "WaSP vs Twilio WhatsApp API"
   - "WaSP vs 360dialog"

3. **Case studies**:
   - "Agency scales from 10 to 100 clients without bans"
   - "SaaS platform saves $10k/month switching from Twilio"

## Timeline & Roadmap

### v0.1.0 (MVP — Week 1)

- [ ] Package scaffolding (`wasp-protocol-pro` npm package)
- [ ] License key validation (JWT-based, no phone-home)
- [ ] Cloud API provider implementation (send/receive)
- [ ] Basic ban predictor (rule-based, 0-100 score)

### v0.2.0 (Dashboard — Week 2-3)

- [ ] React dashboard components
- [ ] Ban risk chart (recharts.js)
- [ ] Session health metrics panel
- [ ] Example Next.js app

### v0.3.0 (Auto-Migration — Week 4)

- [ ] Auto-migration logic (Baileys → Cloud API)
- [ ] Queue preservation during migration
- [ ] Migration event emitter
- [ ] Migration guide documentation

### v1.0.0 (Launch — Week 5-6)

- [ ] ML-based ban predictor (logistic regression)
- [ ] Training data collection (anonymized)
- [ ] Phone-home license check (optional)
- [ ] Production-ready documentation
- [ ] Launch blog post + Product Hunt

### Post-Launch

- [ ] Stripe integration for self-serve signup
- [ ] Customer dashboard (manage license, billing)
- [ ] Telemetry dashboard (usage stats for license enforcement)
- [ ] Zapier integration (trigger webhooks on ban risk)
- [ ] Terraform module for AWS/GCP deployment

## Distribution

### npm Package

```bash
npm install wasp-protocol-pro
```

**Scoped**: `@wasp/pro` (requires npm org `@wasp`)

**Private vs Public**:
- Public package (anyone can install)
- License key required at runtime (throws error if missing/invalid)
- Free trial: 14 days, then requires paid license

### Website

**wasp.dev/pro**:
- Feature comparison table
- Pricing calculator (sessions × cost)
- Live demo (dashboard screenshot)
- Signup form (Stripe checkout)
- Documentation portal

## Maintenance Plan

### Upstream Sync

- **WaSP Core**: Pro imports `wasp-protocol` as peer dependency
- When core updates, Pro gets updates automatically (semver)
- Pro-specific features are additive (no core patches)

### Baileys Sync

- Cloud API provider doesn't depend on Baileys version
- Ban predictor uses WaSP metrics, not Baileys internals
- No maintenance burden from Baileys breaking changes

### Support Load

**Expected support volume** (per 100 customers):
- 10 setup questions/month
- 5 bug reports/month
- 3 feature requests/month

**Staffing**:
- Solo (0-50 customers): Kobus handles all support
- Team (50-200 customers): Hire part-time support engineer
- Enterprise (200+ customers): Full-time support team

## Open Questions

1. **Should Cloud API provider be free tier?**
   - Pro: Attracts more users to WaSP ecosystem
   - Con: Reduces Pro value prop
   - Decision: Keep in Pro (it's the auto-migration that matters)

2. **Phone-home enforcement or honor system?**
   - Pro: Honor system = no telemetry infrastructure cost
   - Con: Risk of piracy
   - Decision: Start honor system, add phone-home v2 if piracy becomes issue

3. **Should dashboard be separate package?**
   - `wasp-protocol-pro` (core features)
   - `wasp-protocol-pro-dashboard` (React components)
   - Pro: Reduces bundle size for non-React users
   - Con: Splits product, harder to market
   - Decision: Keep unified, tree-shakeable imports

4. **ML model training — where to get data?**
   - Option 1: Synthetic data (simulate ban patterns)
   - Option 2: Opt-in telemetry from Pro users
   - Option 3: Partner with agencies for historical data
   - Decision: Start with rule-based (v0.1), add ML later with telemetry opt-in

## Success Metrics

### Year 1 Goals

- **Customers**: 50 paying customers ($2,450 MRR)
- **Sessions**: 500+ managed sessions across all customers
- **Churn**: <10% monthly churn
- **NPS**: >50 (strong product-market fit)

### Unit Economics

- **CAC** (Customer Acquisition Cost): $200 (ads + content)
- **LTV** (Lifetime Value): $490 (assuming 10-month avg retention)
- **LTV/CAC**: 2.45x (healthy for early-stage SaaS)

### Growth Channels

1. **SEO** (40%): Blog content + comparison pages
2. **Community** (30%): Discord, GitHub, Baileys forums
3. **Partnerships** (20%): Agency partnerships, referrals
4. **Paid Ads** (10%): Google Ads on "whatsapp api" keywords

## Conclusion

WaSP Pro is a **commercial extension** of the open-source WaSP library, targeting businesses that need production-grade WhatsApp session management with ban prevention and Cloud API integration.

**Key value props**:
1. Ban prevention (ML-based risk scoring)
2. Cloud API as drop-in provider + auto-migration
3. Session health dashboard (embeddable React components)
4. Priority support

**Business model**: $49/month subscription, honor system licensing, self-hosted deployment.

**Timeline**: MVP in 1 week, launch in 6 weeks.

**Target market**: WhatsApp agencies, SaaS platforms, customer support teams managing 3+ sessions.

Next steps: Build MVP, validate with 5 beta customers, iterate, launch.
