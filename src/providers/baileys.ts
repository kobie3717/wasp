/**
 * Baileys provider implementation
 *
 * Integrates @whiskeysockets/baileys with WaSP protocol.
 * Production-grade patterns extracted from WhatsAuction.
 */

import { EventEmitter } from 'events';
import path from 'path';
import fs from 'fs';
import type {
  Provider,
  ProviderType,
  Message,
  SendMessageOptions,
} from '../types.js';
import { MessageType, EventType } from '../types.js';
import { InvalidSessionIdError, NotConnectedError } from '../errors.js';
import { TcTokenManager } from './baileys-tc-token.js';

// Baileys types - dynamically imported
type BaileysSocket = any;
type WAMessage = any;

/**
 * Baileys provider options
 */
export interface BaileysProviderOptions {
  /** Authentication state directory */
  authDir?: string;
  /** Print QR to console */
  printQR?: boolean;
  /** Browser metadata [name, description, version] */
  browser?: [string, string, string];
  /** Pino logger instance */
  logger?: any;
  /** Proxy URL (SOCKS5) */
  proxyUrl?: string;
  /** Maximum reconnection attempts (only used when internalReconnect=true) */
  maxReconnectAttempts?: number;
  /**
   * If true, BaileysProvider auto-reconnects internally via setTimeout on
   * recoverable close events. If false (default), the provider always emits
   * 'disconnected' on close and lets the consumer (e.g. baileys-keep-alive)
   * own the reconnect lifecycle. Recommended: false — single source of truth
   * avoids racing reconnect attempts.
   */
  internalReconnect?: boolean;
  /** Allowed media directory (for file path security) */
  allowedMediaDir?: string;
  /** TC token configuration for error 463 prevention */
  tcTokenConfig?: import('../types.js').TcTokenConfig;
  /** Mark account as online when connecting (default: false — less bot-like) */
  markOnlineOnConnect?: boolean;
  /** WebSocket keepalive ping interval in ms (default: 30000) */
  keepAliveIntervalMs?: number;
  /** Connection timeout in ms (default: 60000) */
  connectTimeoutMs?: number;
  /** Default query timeout in ms (default: 60000) */
  defaultQueryTimeoutMs?: number;
  /** Sync full message history on connect (default: false — saves memory) */
  syncFullHistory?: boolean;
  /** Fire init queries on connect (default: false — faster connect) */
  fireInitQueries?: boolean;
}

/**
 * Baileys provider
 *
 * Implements the Provider interface using @whiskeysockets/baileys.
 * Includes production-ready patterns: exponential backoff, Bad MAC handling,
 * proper disconnect detection, and memory leak mitigation.
 *
 * @example
 * ```typescript
 * import { BaileysProvider } from '@wasp/core/providers/baileys';
 *
 * const provider = new BaileysProvider({
 *   authDir: './auth_states',
 *   printQR: true,
 * });
 *
 * await provider.connect('session-1');
 * await provider.sendMessage('27821234567@s.whatsapp.net', 'Hello!');
 * ```
 */
export class BaileysProvider implements Provider {
  readonly type: ProviderType = 'BAILEYS' as ProviderType;
  readonly events: EventEmitter = new EventEmitter();

  private socket: BaileysSocket | null = null;
  private phoneNumber: string | null = null;
  private qrCode: string | null = null;
  private options: Required<BaileysProviderOptions>;
  private currentSessionId: string | null = null;
  private reconnectAttempts: number = 0;
  private isConnecting: boolean = false;
  private isManualDisconnect: boolean = false;
  private _connected: boolean = false;
  private timelockState: {
    isActive: boolean;
    enforcementType?: string;
    expiresAt?: Date;
  } | null = null;

  // TC Token manager for error 463 prevention
  private tcTokenManager: TcTokenManager | null = null;

  // Message deduplication to prevent processing same message multiple times
  private processedMessages: Set<string> = new Set();
  private readonly MAX_PROCESSED_MESSAGES = 1000;

  constructor(options?: BaileysProviderOptions) {
    this.options = {
      authDir: options?.authDir ?? './auth_states',
      printQR: options?.printQR ?? false,
      browser: options?.browser ?? ['WaSP', 'Chrome', '120.0.0'],
      logger: options?.logger ?? { level: 'silent', child: () => ({ level: 'silent' }) },
      proxyUrl: options?.proxyUrl ?? '',
      maxReconnectAttempts: options?.maxReconnectAttempts ?? 5,
      internalReconnect: options?.internalReconnect ?? false,
      allowedMediaDir: options?.allowedMediaDir ?? '',
      tcTokenConfig: options?.tcTokenConfig ?? {},
      markOnlineOnConnect: options?.markOnlineOnConnect ?? false,
      keepAliveIntervalMs: options?.keepAliveIntervalMs ?? 30000,
      connectTimeoutMs: options?.connectTimeoutMs ?? 60000,
      defaultQueryTimeoutMs: options?.defaultQueryTimeoutMs ?? 60000,
      syncFullHistory: options?.syncFullHistory ?? false,
      fireInitQueries: options?.fireInitQueries ?? false,
    };

    // Ensure auth directory exists
    const authDir = this.options.authDir;
    if (authDir && !fs.existsSync(authDir)) {
      fs.mkdirSync(authDir, { recursive: true });
    }
  }

  /**
   * Calculate reconnection delay with exponential backoff and jitter
   */
  private getReconnectDelay(): number {
    const baseDelay = 1000; // 1 second
    const exponentialDelay = Math.min(
      baseDelay * Math.pow(2, this.reconnectAttempts - 1),
      60000 // Max 60 seconds
    );
    // Add ±25% jitter to prevent thundering herd
    const jitter = exponentialDelay * 0.25 * (Math.random() * 2 - 1);
    return Math.floor(exponentialDelay + jitter);
  }

  /**
   * Connect to WhatsApp using Baileys
   */
  async connect(sessionId: string, _options?: unknown): Promise<void> {
    // Validate session ID to prevent path traversal
    if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
      throw new InvalidSessionIdError(sessionId);
    }

    if (this.isConnecting) {
      return;
    }

    if (this.socket && this._connected) {
      return; // Already connected
    }

    this.currentSessionId = sessionId;
    this.isConnecting = true;
    this.isManualDisconnect = false;

    try {
      // Dynamic import to make Baileys optional peer dependency
      let makeWASocket: any;
      let useMultiFileAuthState: any;
      let DisconnectReason: any;
      let getContentType: any;

      try {
        const baileys = await import('@whiskeysockets/baileys');
        makeWASocket = baileys.default;
        useMultiFileAuthState = baileys.useMultiFileAuthState;
        DisconnectReason = baileys.DisconnectReason;
        getContentType = baileys.getContentType;
      } catch (error) {
        throw new Error(
          'Baileys not installed. Run: npm install @whiskeysockets/baileys'
        );
      }

      const baseAuthDir = this.options.authDir;
      const authDir = path.join(baseAuthDir, sessionId);
      if (!fs.existsSync(authDir)) {
        fs.mkdirSync(authDir, { recursive: true });
      }

      const { state, saveCreds } = await useMultiFileAuthState(authDir);

      // Optional proxy support
      let agent: any;
      if (this.options.proxyUrl) {
        try {
          // Note: socks-proxy-agent is optional - users must install separately
          const module = await import('socks-proxy-agent');
          const SocksProxyAgent = (module as any).SocksProxyAgent;
          agent = new SocksProxyAgent(this.options.proxyUrl);
        } catch {
          console.warn('[BaileysProvider] socks-proxy-agent not installed, skipping proxy');
        }
      }

      this.socket = makeWASocket({
        auth: state,
        logger: this.options.logger,
        printQRInTerminal: this.options.printQR,
        browser: this.options.browser,
        syncFullHistory: this.options.syncFullHistory,
        markOnlineOnConnect: this.options.markOnlineOnConnect,
        fireInitQueries: this.options.fireInitQueries,
        keepAliveIntervalMs: this.options.keepAliveIntervalMs,
        connectTimeoutMs: this.options.connectTimeoutMs,
        defaultQueryTimeoutMs: this.options.defaultQueryTimeoutMs,
        ...(agent ? { agent, fetchAgent: agent } : {}),
        // Required for group message handling
        getMessage: async () => undefined,
      });

      // Initialize TC token manager for error 463 prevention
      if (!this.options.tcTokenConfig?.disabled) {
        this.tcTokenManager = new TcTokenManager({
          authDir,
          sessionId,
          logger: this.options.logger,
          config: this.options.tcTokenConfig,
        });
        await this.tcTokenManager.load();
        this.tcTokenManager.startPruning();
      }

      // Monkey-patch sendMessage to inject TC/CS tokens
      if (this.tcTokenManager) {
        const originalSendMessage = this.socket.sendMessage.bind(this.socket);
        this.socket.sendMessage = async (jid: string, content: any, options?: any) => {
          // Only attach tokens on 1:1 messages (not groups or broadcast)
          if (!jid.endsWith('@g.us') && !jid.endsWith('@broadcast')) {
            const tokenNodes = this.tcTokenManager!.getTokenNodes(jid);
            if (tokenNodes) {
              // Baileys accepts additional nodes in options
              options = options || {};
              options.additionalNodes = [
                ...(options.additionalNodes || []),
                ...tokenNodes,
              ];
            }
          }

          const result = await originalSendMessage(jid, content, options);

          // Fire-and-forget: re-issue TC token if needed
          if (!jid.endsWith('@g.us') && !jid.endsWith('@broadcast')) {
            if (this.tcTokenManager!.shouldSendNewToken(jid)) {
              this.issuePrivacyToken(jid).catch(() => {
                // Silent fail - fire and forget
              });
            }
          }

          return result;
        };
      }

      // Handle connection updates
      this.socket.ev.on('connection.update', async (update: any) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          this.qrCode = qr;
          this.events.emit('qr', qr);
          this.events.emit('event', {
            type: EventType.SESSION_QR,
            sessionId: this.currentSessionId!,
            timestamp: new Date(),
            data: { qr },
          });
        }

        // Reachout timelock detection
        if ((update as any).reachoutTimeLock) {
          const tl = (update as any).reachoutTimeLock;
          this.timelockState = {
            isActive: !!tl.isActive,
            enforcementType: tl.enforcementType,
            expiresAt: tl.timeEnforcementEnds,
          };
          this.events.emit('reachout-timelock', this.timelockState);
          this.events.emit('event', {
            type: EventType.REACHOUT_TIMELOCK,
            sessionId: this.currentSessionId!,
            timestamp: new Date(),
            data: {
              isActive: this.timelockState.isActive,
              enforcementType: this.timelockState.enforcementType,
              expiresAt: this.timelockState.expiresAt,
              newContactsBlocked: this.timelockState.isActive,
            },
          });
        }

        if (connection === 'close') {
          const boom = lastDisconnect?.error as any;
          const reason = boom?.output?.statusCode;
          const errorMessage = boom?.message || '';

          // Categorize errors for appropriate handling
          const isBadMac = errorMessage.includes('Bad MAC') || errorMessage.includes('hmac mismatch');
          const isStreamError = reason === DisconnectReason?.restartRequired || errorMessage.includes('Stream Errored');
          const isLoggedOut = reason === DisconnectReason?.loggedOut;
          const isReplaced = reason === DisconnectReason?.connectionReplaced;
          const shouldReconnect = !this.isManualDisconnect && !isLoggedOut && !isReplaced;

          this.socket = null;
          this._connected = false;
          this.isConnecting = false;

          if (this.isManualDisconnect) {
            this.events.emit('disconnected', { reason, shouldReconnect: false });
            this.events.emit('event', {
              type: EventType.SESSION_DISCONNECTED,
              sessionId: this.currentSessionId!,
              timestamp: new Date(),
              data: { reason: 'manual', shouldReconnect: false },
            });
          } else if (isBadMac) {
            // Bad MAC errors indicate corrupted session — clear session keys
            // BUT preserve v7 auth state files (lid-mapping, device-list, tctoken, app-state-sync)
            try {
              // Files that must survive Bad MAC cleanup (v7 + critical auth data)
              const V7_PRESERVED_PREFIXES = [
                'creds',           // Main credentials
                'lid-mapping',     // v7: LID↔PN bidirectional mapping
                'device-list',     // v7: Device registration
                'tctoken',         // v7: Privacy tokens (error 463 prevention)
                'app-state-sync',  // App state sync keys (not related to E2E)
              ];

              const sessionFiles = fs.readdirSync(authDir)
                .filter(f => {
                  if (!f.endsWith('.json')) return false;
                  // Preserve critical auth files
                  if (V7_PRESERVED_PREFIXES.some(prefix => f.startsWith(prefix))) return false;
                  // Delete session/pre-key/sender-key crypto files
                  return f.startsWith('session-') || f.startsWith('pre-key-') || f.startsWith('sender-key-');
                });

              for (const file of sessionFiles) {
                fs.unlinkSync(path.join(authDir, file));
              }
            } catch {
              // Ignore cleanup errors
            }

            // Reconnect after cleanup — shorter delay (only if internalReconnect enabled)
            if (this.reconnectAttempts < 3) {
              this.reconnectAttempts++;
              if (this.options.internalReconnect) {
                const delay = 2000 + Math.random() * 2000;
                setTimeout(() => this.connect(this.currentSessionId!), delay);
              } else {
                this.events.emit('disconnected', { reason: 'badMac', shouldReconnect: true });
                this.events.emit('event', {
                  type: EventType.SESSION_DISCONNECTED,
                  sessionId: this.currentSessionId!,
                  timestamp: new Date(),
                  data: { reason: 'badMac', shouldReconnect: true },
                });
              }
            } else {
              // Bad MAC persists — full reset needed
              fs.rmSync(authDir, { recursive: true, force: true });
              this.events.emit('disconnected', { reason: 'loggedOut', shouldReconnect: false });
              this.events.emit('event', {
                type: EventType.SESSION_ERROR,
                sessionId: this.currentSessionId!,
                timestamp: new Date(),
                data: { error: new Error('Bad MAC error persists - full auth reset needed') },
              });
            }
          } else if (isStreamError) {
            // Stream errors are transient — let consumer reconnect (or self-reconnect if enabled)
            this.reconnectAttempts++;
            if (this.options.internalReconnect) {
              const delay = Math.min(1000 * this.reconnectAttempts, 5000);
              setTimeout(() => this.connect(this.currentSessionId!), delay);
            } else {
              this.events.emit('disconnected', { reason: 'streamError', shouldReconnect: true });
              this.events.emit('event', {
                type: EventType.SESSION_DISCONNECTED,
                sessionId: this.currentSessionId!,
                timestamp: new Date(),
                data: { reason: 'streamError', shouldReconnect: true },
              });
            }
          } else if (reason === 405) {
            // 405 = rate limited — preserve credentials
            this.events.emit('disconnected', { reason: 'rate-limited', shouldReconnect: false });
            this.events.emit('event', {
              type: EventType.SESSION_ERROR,
              sessionId: this.currentSessionId!,
              timestamp: new Date(),
              data: { error: new Error('Rate limited by WhatsApp') },
            });
          } else if (shouldReconnect && (this.options.internalReconnect || true)) {
            // Recoverable disconnect — let consumer (keep-alive) reconnect, or
            // self-reconnect with exponential backoff if internalReconnect is on.
            this.reconnectAttempts++;
            if (this.options.internalReconnect) {
              if (this.reconnectAttempts < this.options.maxReconnectAttempts) {
                const delay = this.getReconnectDelay();
                setTimeout(() => this.connect(this.currentSessionId!), delay);
              } else {
                this.events.emit('disconnected', { reason: 'max-retries', shouldReconnect: false });
                this.events.emit('event', {
                  type: EventType.SESSION_DISCONNECTED,
                  sessionId: this.currentSessionId!,
                  timestamp: new Date(),
                  data: { reason: 'max-retries', shouldReconnect: false },
                });
              }
            } else {
              this.events.emit('disconnected', { reason, shouldReconnect: true });
              this.events.emit('event', {
                type: EventType.SESSION_DISCONNECTED,
                sessionId: this.currentSessionId!,
                timestamp: new Date(),
                data: { reason, shouldReconnect: true },
              });
            }
          } else if (isLoggedOut) {
            // Logged out — clear auth
            if (!this.isManualDisconnect) {
              fs.rmSync(authDir, { recursive: true, force: true });
            }
            this.events.emit('disconnected', { reason: 'loggedOut', shouldReconnect: false });
            this.events.emit('event', {
              type: EventType.SESSION_DISCONNECTED,
              sessionId: this.currentSessionId!,
              timestamp: new Date(),
              data: { reason: 'loggedOut', shouldReconnect: false },
            });
          } else if (isReplaced) {
            this.events.emit('disconnected', { reason: 'replaced', shouldReconnect: false });
            this.events.emit('event', {
              type: EventType.SESSION_DISCONNECTED,
              sessionId: this.currentSessionId!,
              timestamp: new Date(),
              data: { reason: 'replaced', shouldReconnect: false },
            });
          } else {
            // Permanent disconnect
            this.events.emit('disconnected', { reason: 'unknown', shouldReconnect: false });
            this.events.emit('event', {
              type: EventType.SESSION_DISCONNECTED,
              sessionId: this.currentSessionId!,
              timestamp: new Date(),
              data: { reason: 'max-retries', shouldReconnect: false },
            });
          }
        }

        if (connection === 'open') {
          this.phoneNumber = this.socket.user?.id?.split(':')[0] ?? null;
          this._connected = true;
          this.isConnecting = false;
          this.reconnectAttempts = 0;
          this.events.emit('connected', { phone: this.phoneNumber });
          this.events.emit('event', {
            type: EventType.SESSION_CONNECTED,
            sessionId: this.currentSessionId!,
            timestamp: new Date(),
            data: { phone: this.phoneNumber },
          });
        }
      });

      // Handle credentials update
      this.socket.ev.on('creds.update', async (update: any) => {
        await saveCreds();

        // TC Token: Extract nctSalt when credentials update
        if (this.tcTokenManager && update.nctSalt) {
          this.tcTokenManager.setNctSalt(Buffer.from(update.nctSalt));
          await this.tcTokenManager.persist();
        }
      });

      // TC Token: Extract from history sync
      if (this.tcTokenManager) {
        this.socket.ev.on('messaging-history.set', async ({ conversations }: any) => {
          if (conversations) {
            this.tcTokenManager!.processHistorySync(conversations);
            await this.tcTokenManager!.persist();
          }
        });
      }

      // Handle incoming messages
      this.socket.ev.on('messages.upsert', async ({ messages, type }: any) => {
        if (type !== 'notify') return; // Skip non-notification messages

        for (const msg of messages) {
          const normalized = this.normalizeMessage(msg, getContentType);
          if (normalized) {
            // Deduplication
            if (this.processedMessages.has(normalized.id)) {
              continue;
            }
            this.processedMessages.add(normalized.id);

            // Trim deduplication cache
            if (this.processedMessages.size > this.MAX_PROCESSED_MESSAGES) {
              const entries = Array.from(this.processedMessages);
              const toDelete = Math.floor(entries.length * 0.3); // Remove 30%
              for (let i = 0; i < toDelete; i++) {
                this.processedMessages.delete(entries[i]!);
              }
            }

            this.events.emit('message', normalized);
            // Emit raw Baileys message for consumers that need full message object
            this.events.emit('raw-message', msg);
            this.events.emit('event', {
              type: EventType.MESSAGE_RECEIVED,
              sessionId: this.currentSessionId!,
              timestamp: new Date(),
              data: normalized,
            });
          }
        }
      });
    } catch (error) {
      this.isConnecting = false;
      this.events.emit('error', error);
      this.events.emit('event', {
        type: EventType.SESSION_ERROR,
        sessionId: this.currentSessionId!,
        timestamp: new Date(),
        data: { error },
      });
      throw error;
    }
  }

  /**
   * Recreate the underlying Baileys socket using existing auth state and
   * return it. Intended for use by external reconnect managers
   * (e.g. baileys-keep-alive's reconnectFactory) when internalReconnect is off.
   */
  async recreateSocket(): Promise<BaileysSocket | null> {
    if (!this.currentSessionId) {
      throw new Error('BaileysProvider.recreateSocket: no active sessionId');
    }
    // connect() short-circuits if already connected; force a fresh socket by
    // resetting the connecting flag so it re-runs the makeWASocket flow.
    this.isConnecting = false;
    this._connected = false;
    this.socket = null;
    await this.connect(this.currentSessionId);
    return this.socket;
  }

  /**
   * Disconnect from WhatsApp
   */
  async disconnect(): Promise<void> {
    this.isManualDisconnect = true;

    // Persist and cleanup TC token manager
    if (this.tcTokenManager) {
      await this.tcTokenManager.persist();
      this.tcTokenManager.destroy();
      this.tcTokenManager = null;
    }

    if (this.socket) {
      try {
        await this.socket.logout();
      } catch {
        // Ignore logout errors
      }
      this.socket = null;
    }

    this.currentSessionId = null;
    this.phoneNumber = null;
    this.qrCode = null;
    this._connected = false;
    this.timelockState = null;
    this.processedMessages.clear();
    this.events.emit('disconnected', { shouldReconnect: false });
  }

  /**
   * Send a message
   */
  async sendMessage(
    to: string,
    content: string,
    options?: SendMessageOptions
  ): Promise<Message> {
    if (!this.socket || !this._connected) {
      throw new NotConnectedError();
    }

    try {
      const jid = this.formatJid(to);
      const message: any = { text: content };

      if (options?.quoted) {
        message.quoted = options.quoted;
      }

      // Handle media
      if (options?.media) {
        if (typeof options.media === 'string') {
          // URL or file path
          if (options.media.startsWith('http://') || options.media.startsWith('https://')) {
            message.image = { url: options.media };
          } else {
            // File path - validate it's within allowed directory
            if (this.options.allowedMediaDir) {
              const resolvedPath = path.resolve(options.media);
              const allowedDir = path.resolve(this.options.allowedMediaDir);

              if (!resolvedPath.startsWith(allowedDir)) {
                throw new Error(`Media file path must be within allowed directory: ${allowedDir}`);
              }
            } else {
              throw new Error('File path media requires allowedMediaDir to be configured for security');
            }

            message.image = fs.readFileSync(options.media);
          }
        } else {
          // Buffer
          message.image = options.media;
        }
        message.caption = content;
        delete message.text;
      }

      const sent = await this.socket.sendMessage(jid, message);

      const result: Message = {
        id: sent.key.id ?? `msg-${Date.now()}`,
        from: this.phoneNumber ?? '',
        to,
        type: options?.media ? MessageType.IMAGE : MessageType.TEXT,
        content,
        timestamp: new Date(),
        isGroup: to.includes('@g.us'),
        groupId: to.includes('@g.us') ? to : undefined,
        mediaUrl: options?.media ? (typeof options.media === 'string' ? options.media : undefined) : undefined,
        mediaMimeType: options?.mediaMimeType,
      };

      this.events.emit('event', {
        type: EventType.MESSAGE_SENT,
        sessionId: this.currentSessionId!,
        timestamp: new Date(),
        data: result,
      });

      return result;
    } catch (error) {
      this.events.emit('error', error);
      throw error;
    }
  }

  /**
   * Send a reaction
   */
  async sendReaction(_messageId: string, _emoji: string): Promise<void> {
    if (!this.socket || !this._connected) {
      throw new NotConnectedError();
    }

    // Note: This requires the message key which we don't have in the current interface
    // For now, we throw an error
    throw new Error('Reaction sending requires message key - use provider directly for reactions');
  }

  /**
   * Get QR code for authentication
   */
  async getQR(): Promise<string | null> {
    return this.qrCode;
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this._connected && this.socket !== null;
  }

  /**
   * Get session phone number
   */
  getPhoneNumber(): string | null {
    return this.phoneNumber;
  }

  /**
   * Get current reachout timelock state
   */
  getTimelockState(): { isActive: boolean; enforcementType?: string; expiresAt?: Date } | null {
    return this.timelockState;
  }

  /**
   * Get raw WASocket instance
   *
   * Useful for advanced operations like media downloads,
   * presence updates, group operations, etc.
   *
   * @returns WASocket instance or null if not connected
   */
  getSocket(): BaileysSocket | null {
    return this.socket;
  }

  /**
   * Normalize Baileys message to WaSP format
   */
  private normalizeMessage(msg: WAMessage, getContentType: any): Message | null {
    try {
      const messageContent = msg.message;
      if (!messageContent) return null;

      const contentType = getContentType(messageContent);
      if (!contentType) return null;

      const content = messageContent[contentType];
      let text = '';
      let messageType = MessageType.TEXT;
      let mediaUrl: string | undefined;
      let mediaMimeType: string | undefined;

      // Extract text based on content type
      if (contentType === 'conversation') {
        text = messageContent.conversation;
      } else if (contentType === 'extendedTextMessage') {
        text = content.text ?? '';
      } else if (contentType === 'imageMessage') {
        text = content.caption ?? '';
        messageType = MessageType.IMAGE;
        mediaMimeType = content.mimetype;
      } else if (contentType === 'videoMessage') {
        text = content.caption ?? '';
        messageType = MessageType.VIDEO;
        mediaMimeType = content.mimetype;
      } else if (contentType === 'audioMessage') {
        messageType = MessageType.AUDIO;
        mediaMimeType = content.mimetype;
      } else if (contentType === 'documentMessage') {
        text = content.caption ?? '';
        messageType = MessageType.DOCUMENT;
        mediaMimeType = content.mimetype;
      } else if (contentType === 'stickerMessage') {
        messageType = MessageType.STICKER;
        mediaMimeType = content.mimetype;
      } else {
        return null; // Unsupported message type
      }

      const fromJid = msg.key.remoteJid ?? '';
      const senderJid = msg.key.participant ?? fromJid;

      // Extract quoted message if present
      let quotedMessage;
      if (content.contextInfo?.quotedMessage) {
        quotedMessage = {
          id: content.contextInfo.stanzaId ?? '',
          from: content.contextInfo.participant ?? '',
          content: content.contextInfo.quotedMessage.conversation ?? '',
        };
      }

      return {
        id: msg.key.id ?? `msg-${Date.now()}`,
        from: senderJid,
        to: fromJid,
        type: messageType,
        content: text,
        timestamp: new Date((msg.messageTimestamp as number) * 1000),
        isGroup: fromJid.includes('@g.us'),
        groupId: fromJid.includes('@g.us') ? fromJid : undefined,
        quotedMessage,
        mediaUrl,
        mediaMimeType,
        raw: msg,
      };
    } catch (error) {
      this.events.emit('error', error);
      return null;
    }
  }

  /**
   * Format phone number to WhatsApp JID
   */
  private formatJid(identifier: string): string {
    // If already a JID, return as-is
    if (identifier.includes('@')) {
      return identifier;
    }

    // Otherwise, assume it's a phone number
    const normalized = identifier.replace(/[^0-9]/g, '');
    return `${normalized}@s.whatsapp.net`;
  }

  /**
   * Issue privacy token to recipient (fire-and-forget)
   *
   * @param jid Recipient JID
   */
  private async issuePrivacyToken(jid: string): Promise<void> {
    try {
      // Check if Baileys socket has a privacy token query method
      // This is implementation-specific to Baileys and may not exist
      // in all versions. We attempt to call it if available.
      if (this.socket && typeof (this.socket as any).query === 'function') {
        // Baileys uses query() for low-level protocol requests
        await (this.socket as any).query({
          tag: 'iq',
          attrs: {
            to: jid,
            type: 'get',
            xmlns: 'encrypt',
          },
          content: [
            {
              tag: 'key',
              attrs: {},
            },
          ],
        });
      }
    } catch {
      // Silent fail - this is fire-and-forget
    }
  }
}
