/**
 * WaSP Admin Router
 *
 * Optional Express router for managing WaSP sessions via HTTP.
 * Provides list / connect / disconnect / qr endpoints per session.
 *
 * @example
 * ```typescript
 * import express from 'express';
 * import { WaSP, createAdminRouter } from 'wasp-protocol';
 *
 * const app = express();
 * const wasp = new WaSP(config);
 *
 * app.use('/wa-admin', createAdminRouter(wasp, { token: process.env.ADMIN_TOKEN }));
 * ```
 */

import type { WaSP } from './wasp.js';
import type { WaspEvent, ProviderType } from './types.js';
import { EventType } from './types.js';

// Minimal Express-compatible interfaces — avoids @types/express peer dependency
interface Req {
  params: Record<string, string>;
  body?: Record<string, unknown>;
  headers: Record<string, string | string[] | undefined>;
}
interface Res {
  status(code: number): Res;
  json(body: unknown): void;
}
type Next = () => void;
type Handler = (req: Req, res: Res, next: Next) => void | Promise<void>;
interface ExpressRouter {
  use(handler: Handler): ExpressRouter;
  get(path: string, handler: Handler): ExpressRouter;
  post(path: string, handler: Handler): ExpressRouter;
}
interface ExpressModule {
  Router(): ExpressRouter;
}

export interface AdminRouterOptions {
  /** Bearer token for auth. If omitted no auth is applied — never expose publicly without one. */
  token?: string;
  /** Default provider type for new sessions. Defaults to 'BAILEYS'. */
  defaultProvider?: ProviderType;
  /** Extra options forwarded to wasp.createSession(). */
  sessionOptions?: Record<string, unknown>;
}

/** In-memory QR cache: sessionId → raw QR string (cleared on connect) */
const qrCache = new Map<string, string>();

export function createAdminRouter(wasp: WaSP, options: AdminRouterOptions = {}): ExpressRouter {
  let express: ExpressModule;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    express = require('express') as ExpressModule;
  } catch {
    throw new Error(
      '[wasp-admin] Express is required to use createAdminRouter. Install it: npm i express'
    );
  }

  const router = express.Router();

  // Cache QR codes from SESSION_QR events
  wasp.on(EventType.SESSION_QR, (event: WaspEvent<unknown>) => {
    const data = event.data as { qr: string };
    if (data?.qr) qrCache.set(event.sessionId, data.qr);
  });

  // Clear QR once session connects
  wasp.on(EventType.SESSION_CONNECTED, (event: WaspEvent<unknown>) => {
    qrCache.delete(event.sessionId);
  });

  // ── Auth middleware ──────────────────────────────────────────────────────────
  if (options.token) {
    const expected = `Bearer ${options.token}`;
    router.use((req: Req, res: Res, next: Next) => {
      if (req.headers['authorization'] !== expected) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      next();
    });
  }

  // ── GET / — list all sessions ────────────────────────────────────────────────
  router.get('/', async (_req: Req, res: Res, _next: Next) => {
    try {
      const sessions = await wasp.listSessions();
      res.json(
        sessions.map((s) => ({
          id: s.id,
          status: s.status,
          provider: s.provider,
          phone: s.phone ?? null,
          orgId: s.orgId ?? null,
          createdAt: s.createdAt,
          connectedAt: s.connectedAt ?? null,
          lastActivityAt: s.lastActivityAt ?? null,
          hasQr: qrCache.has(s.id),
        }))
      );
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── GET /:id — single session ────────────────────────────────────────────────
  router.get('/:id', async (req: Req, res: Res, _next: Next) => {
    try {
      const session = await wasp.getSession(req.params.id);
      if (!session) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }
      res.json({ ...session, hasQr: qrCache.has(session.id) });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── POST /:id/connect — create + connect session ─────────────────────────────
  router.post('/:id/connect', async (req: Req, res: Res, _next: Next) => {
    try {
      const { id } = req.params;
      const body = req.body ?? {};
      const { provider, ...extra } = body;

      // Already active — skip creation to avoid duplicate-session error
      const existing = await wasp.getSession(id);
      if (existing && ['CONNECTING', 'CONNECTED'].includes(existing.status as string)) {
        res.json({ ok: true, session: existing, message: 'Already connecting/connected' });
        return;
      }

      const session = await wasp.createSession(
        id,
        ((provider ?? options.defaultProvider ?? 'BAILEYS') as ProviderType),
        { ...options.sessionOptions, ...extra }
      );
      res.json({ ok: true, session });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── POST /:id/disconnect — destroy session ───────────────────────────────────
  router.post('/:id/disconnect', async (req: Req, res: Res, _next: Next) => {
    try {
      await wasp.destroySession(req.params.id);
      qrCache.delete(req.params.id);
      res.json({ ok: true });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── GET /:id/qr — QR code as data URL ───────────────────────────────────────
  // Needs optional `qrcode` package (npm i qrcode). Falls back to raw string.
  router.get('/:id/qr', async (req: Req, res: Res, _next: Next) => {
    try {
      const rawQr = qrCache.get(req.params.id);
      if (!rawQr) {
        res.json({ qr: null });
        return;
      }

      try {
        // Dynamic import — qrcode is optional
        const qrcodeModule = await import('qrcode' as string) as {
          default?: { toDataURL(s: string, o?: object): Promise<string> };
          toDataURL?(s: string, o?: object): Promise<string>;
        };
        const toDataURL = qrcodeModule.default?.toDataURL ?? qrcodeModule.toDataURL;
        if (toDataURL) {
          const dataUrl = await toDataURL(rawQr, { width: 300, margin: 2 });
          res.json({ qr: dataUrl });
          return;
        }
      } catch {
        // qrcode not installed — return raw string
      }

      res.json({ qr: rawQr });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}
