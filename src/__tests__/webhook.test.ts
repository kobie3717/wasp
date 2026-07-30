/**
 * Webhook tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WaSP } from '../wasp.js';
import { EventType, MessageType } from '../types.js';
import type { Message } from '../types.js';

// Mock fetch globally
global.fetch = vi.fn();

describe('Webhook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should deliver events to webhook URL', async () => {
    const mockFetch = global.fetch as any;
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
    });

    const wasp = new WaSP({
      webhooks: [
        {
          url: 'https://example.com/webhook',
          secret: 'test-secret',
        },
      ],
    });

    // Create a mock provider
    const eventHandlers = new Map<string, (...args: any[]) => void>();
    const mockProvider = {
      type: 'BAILEYS' as const,
      events: {
        on: vi.fn((event: string, handler: (...args: any[]) => void) => {
          eventHandlers.set(event, handler);
        }),
        emit: vi.fn(),
        removeAllListeners: vi.fn(),
      },
      connect: vi.fn(async () => {
        // Simulate connection
        const handler = eventHandlers.get('connected');
        if (handler) {
          handler({ phone: '1234567890' });
        }
      }),
      disconnect: vi.fn(),
      sendMessage: vi.fn(async (to: string, content: string) => {
        const message: Message = {
          id: 'msg-1',
          from: '1234567890@s.whatsapp.net',
          to,
          type: MessageType.TEXT,
          content,
          timestamp: new Date(),
          isGroup: false,
        };
        return message;
      }),
      sendReaction: vi.fn(),
      isConnected: vi.fn(() => true),
      getPhoneNumber: vi.fn(() => '1234567890'),
    };

    // Create session
    await wasp.createSession('test-session', 'BAILEYS' as any, {
      mockProvider,
    } as any);

    // Wait for webhook delivery (fire-and-forget)
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Check that fetch was called
    expect(mockFetch).toHaveBeenCalled();

    const call = mockFetch.mock.calls[0];
    expect(call[0]).toBe('https://example.com/webhook');
    expect(call[1].method).toBe('POST');
    expect(call[1].headers['Content-Type']).toBe('application/json');
    expect(call[1].headers['X-WaSP-Signature']).toBeDefined();

    // Verify payload
    const payload = JSON.parse(call[1].body);
    expect(payload.type).toBe(EventType.SESSION_CONNECTED);
    expect(payload.sessionId).toBe('test-session');
  });

  it('should filter events by type', async () => {
    const mockFetch = global.fetch as any;
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
    });

    const wasp = new WaSP({
      webhooks: [
        {
          url: 'https://example.com/webhook',
          events: [EventType.MESSAGE_RECEIVED], // Only message events
        },
      ],
    });

    const eventHandlers = new Map<string, (...args: any[]) => void>();
    const mockProvider = {
      type: 'BAILEYS' as const,
      events: {
        on: vi.fn((event: string, handler: (...args: any[]) => void) => {
          eventHandlers.set(event, handler);
        }),
        emit: vi.fn(),
        removeAllListeners: vi.fn(),
      },
      connect: vi.fn(async () => {
        const handler = eventHandlers.get('connected');
        if (handler) {
          handler({ phone: '1234567890' });
        }
      }),
      disconnect: vi.fn(),
      sendMessage: vi.fn(),
      sendReaction: vi.fn(),
      isConnected: vi.fn(() => true),
      getPhoneNumber: vi.fn(() => '1234567890'),
    };

    await wasp.createSession('test-session', 'BAILEYS' as any, {
      mockProvider,
    } as any);

    // Wait a bit
    await new Promise((resolve) => setTimeout(resolve, 500));

    // SESSION_CONNECTED should NOT be delivered (filtered out)
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('should retry on failure', async () => {
    vi.useRealTimers(); // Use real timers for this test
    const mockFetch = global.fetch as any;
    let attempts = 0;

    mockFetch.mockImplementation(async () => {
      attempts++;
      if (attempts < 3) {
        throw new Error('Network error');
      }
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
      };
    });

    const wasp = new WaSP({
      webhooks: [
        {
          url: 'https://example.com/webhook',
          retries: 3,
        },
      ],
    });

    const eventHandlers = new Map<string, (...args: any[]) => void>();
    const mockProvider = {
      type: 'BAILEYS' as const,
      events: {
        on: vi.fn((event: string, handler: (...args: any[]) => void) => {
          eventHandlers.set(event, handler);
        }),
        emit: vi.fn(),
        removeAllListeners: vi.fn(),
      },
      connect: vi.fn(async () => {
        const handler = eventHandlers.get('connected');
        if (handler) {
          handler({ phone: '1234567890' });
        }
      }),
      disconnect: vi.fn(),
      sendMessage: vi.fn(),
      sendReaction: vi.fn(),
      isConnected: vi.fn(() => true),
      getPhoneNumber: vi.fn(() => '1234567890'),
    };

    await wasp.createSession('test-session', 'BAILEYS' as any, {
      mockProvider,
    } as any);

    // Wait for retries (exponential backoff: 1s + 2s = 3s total)
    await new Promise((resolve) => setTimeout(resolve, 4000));

    // Should have retried 3 times before succeeding on 3rd attempt
    expect(attempts).toBeGreaterThanOrEqual(3);
  }, 10000); // 10 second timeout
});

describe('Health stats', () => {
  it('should return health statistics', async () => {
    const wasp = new WaSP();

    const mockProvider = {
      type: 'BAILEYS' as const,
      events: {
        on: vi.fn(),
        emit: vi.fn(),
        removeAllListeners: vi.fn(),
      },
      connect: vi.fn(async () => {
        mockProvider.events.emit('connected', { phone: '1234567890' });
      }),
      disconnect: vi.fn(),
      sendMessage: vi.fn(async (to: string, content: string) => {
        const message: Message = {
          id: 'msg-1',
          from: '1234567890@s.whatsapp.net',
          to,
          type: MessageType.TEXT,
          content,
          timestamp: new Date(),
          isGroup: false,
        };
        return message;
      }),
      sendReaction: vi.fn(),
      isConnected: vi.fn(() => true),
      getPhoneNumber: vi.fn(() => '1234567890'),
    };

    // Create session
    await wasp.createSession('test-session', 'BAILEYS' as any, {
      mockProvider,
    } as any);

    // Send a message
    await wasp.sendMessage('test-session', '9876543210', 'Hello', { immediate: true });

    // Get health stats
    const health = wasp.getHealth();

    expect(health).toBeDefined();
    // >= 0: uptime is Date.now() - startTime in ms, which is legitimately 0
    // when the assertion runs within the same millisecond the server started.
    expect(health.uptime).toBeGreaterThanOrEqual(0);
    expect(health.sessions.total).toBe(1);
    expect(health.sessions.connected + health.sessions.disconnected).toBe(1);
    expect(health.messages.sent).toBe(1);
    expect(health.messages.received).toBe(0);
    expect(health.memory.heapUsed).toBeGreaterThan(0);
    expect(health.memory.heapTotal).toBeGreaterThan(0);
  });

  it('should track message counts', async () => {
    const wasp = new WaSP();

    const mockProvider = {
      type: 'BAILEYS' as const,
      events: {
        on: vi.fn((event, handler) => {
          // Store handlers for later invocation
          if (event === 'message') {
            mockProvider._messageHandler = handler;
          }
        }),
        emit: vi.fn(),
        removeAllListeners: vi.fn(),
      },
      _messageHandler: null as any,
      connect: vi.fn(async () => {
        mockProvider.events.emit('connected', { phone: '1234567890' });
      }),
      disconnect: vi.fn(),
      sendMessage: vi.fn(async (to: string, content: string) => {
        const message: Message = {
          id: 'msg-1',
          from: '1234567890@s.whatsapp.net',
          to,
          type: MessageType.TEXT,
          content,
          timestamp: new Date(),
          isGroup: false,
        };
        return message;
      }),
      sendReaction: vi.fn(),
      isConnected: vi.fn(() => true),
      getPhoneNumber: vi.fn(() => '1234567890'),
    };

    await wasp.createSession('test-session', 'BAILEYS' as any, {
      mockProvider,
    } as any);

    // Send 3 messages
    await wasp.sendMessage('test-session', '9876543210', 'Hello 1', { immediate: true });
    await wasp.sendMessage('test-session', '9876543210', 'Hello 2', { immediate: true });
    await wasp.sendMessage('test-session', '9876543210', 'Hello 3', { immediate: true });

    // Simulate receiving 2 messages
    if (mockProvider._messageHandler) {
      const incomingMessage: Message = {
        id: 'incoming-1',
        from: '9876543210@s.whatsapp.net',
        to: '1234567890@s.whatsapp.net',
        type: MessageType.TEXT,
        content: 'Hi',
        timestamp: new Date(),
        isGroup: false,
      };
      mockProvider._messageHandler(incomingMessage);
      mockProvider._messageHandler(incomingMessage);
    }

    const health = wasp.getHealth();

    expect(health.messages.sent).toBe(3);
    expect(health.messages.received).toBe(2);
  });
});
