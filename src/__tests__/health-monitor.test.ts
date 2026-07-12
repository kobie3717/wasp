/**
 * Health monitor tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WaSP } from '../wasp.js';
import { WaspHealthMonitor } from '../observability/health-monitor.js';
import { MemoryStore } from '../stores/memory.js';
import { MockProvider } from '../providers/mock.js';
import { ProviderType } from '../types.js';

describe('WaspHealthMonitor', () => {
  let wasp: WaSP;
  let monitor: WaspHealthMonitor;

  beforeEach(() => {
    wasp = new WaSP({
      debug: false,
      store: new MemoryStore(),
    });
  });

  afterEach(() => {
    if (monitor) {
      monitor.stop();
    }
  });

  // Helper to create session with mock provider
  const createMockSession = async (id: string) => {
    const mockProvider = new MockProvider({ connectionDelay: 10, sendDelay: 5 });
    return await wasp.createSession(id, 'BAILEYS' as ProviderType, {
      mockProvider,
    });
  };

  describe('Initialization', () => {
    it('should create health monitor with default options', () => {
      monitor = new WaspHealthMonitor(wasp);
      expect(monitor).toBeInstanceOf(WaspHealthMonitor);
    });

    it('should create health monitor with custom options', () => {
      monitor = new WaspHealthMonitor(wasp, {
        intervalMs: 10000,
        stalenessThresholdMs: 30000,
        logMemory: true,
      });
      expect(monitor).toBeInstanceOf(WaspHealthMonitor);
    });

    it('should auto-start when configured in WaSP config', () => {
      const waspWithMonitor = new WaSP({
        debug: false,
        store: new MemoryStore(),
        healthMonitor: true,
      });

      expect(waspWithMonitor.healthMonitor).toBeInstanceOf(WaspHealthMonitor);
    });

    it('should accept custom health monitor options in WaSP config', () => {
      const waspWithMonitor = new WaSP({
        debug: false,
        store: new MemoryStore(),
        healthMonitor: {
          intervalMs: 60000,
          stalenessThresholdMs: 120000,
          logMemory: true,
        },
      });

      expect(waspWithMonitor.healthMonitor).toBeInstanceOf(WaspHealthMonitor);
    });
  });

  describe('Start/Stop', () => {
    it('should start monitoring', () => {
      monitor = new WaspHealthMonitor(wasp, {
        intervalMs: 1000,
      });

      monitor.start();
      // No error means success
    });

    it('should be safe to call start multiple times', () => {
      monitor = new WaspHealthMonitor(wasp, {
        intervalMs: 1000,
      });

      monitor.start();
      monitor.start();
      monitor.start();
      // No error means success
    });

    it('should stop monitoring', () => {
      monitor = new WaspHealthMonitor(wasp, {
        intervalMs: 1000,
      });

      monitor.start();
      monitor.stop();
      // No error means success
    });

    it('should be safe to call stop when not started', () => {
      monitor = new WaspHealthMonitor(wasp);
      monitor.stop();
      // No error means success
    });
  });

  describe('Health events', () => {
    it('should emit health:tick events', async () => {
      monitor = new WaspHealthMonitor(wasp, {
        intervalMs: 100, // Fast tick for testing
        stalenessThresholdMs: 5000,
      });

      const tickPromise = new Promise((resolve) => {
        wasp.on('health:tick' as any, (event) => {
          expect(event.data).toHaveProperty('sessions');
          expect(Array.isArray(event.data.sessions)).toBe(true);
          resolve(event.data);
        });
      });

      monitor.start();
      await tickPromise;
    });

    it('should emit health:degraded when session becomes stale', async () => {
      // Create session
      await createMockSession('test-session');

      // Set lastActivityAt to old timestamp
      await wasp.sessions.update('test-session', {
        lastActivityAt: new Date(Date.now() - 10 * 60 * 1000), // 10 minutes ago
      });

      monitor = new WaspHealthMonitor(wasp, {
        intervalMs: 100,
        stalenessThresholdMs: 5 * 60 * 1000, // 5 minutes
      });

      const degradedPromise = new Promise((resolve) => {
        wasp.on('health:degraded' as any, (event) => {
          expect(event.data.sessionId).toBe('test-session');
          expect(event.data.staleSinceMs).toBeGreaterThan(5 * 60 * 1000);
          expect(event.data.lastActivityAt).toBeInstanceOf(Date);
          resolve(event.data);
        });
      });

      monitor.start();
      await degradedPromise;
    }, 10000);

    it('should emit health:recovered when stale session becomes fresh', async () => {
      // Create session with old activity
      await createMockSession('test-session');
      await wasp.sessions.update('test-session', {
        lastActivityAt: new Date(Date.now() - 10 * 60 * 1000), // 10 minutes ago
      });

      monitor = new WaspHealthMonitor(wasp, {
        intervalMs: 100,
        stalenessThresholdMs: 5 * 60 * 1000, // 5 minutes
      });

      const recoveredPromise = new Promise((resolve) => {
        let degradedEmitted = false;

        wasp.on('health:degraded' as any, async () => {
          degradedEmitted = true;
          // Update activity to recent
          await wasp.sessions.update('test-session', {
            lastActivityAt: new Date(),
          });
        });

        wasp.on('health:recovered' as any, (event) => {
          expect(degradedEmitted).toBe(true); // Should only recover after degraded
          expect(event.data.sessionId).toBe('test-session');
          resolve(event.data);
        });
      });

      monitor.start();
      await recoveredPromise;
    }, 10000);

    it('should not spam degraded events for already-stale sessions', async () => {
      // Create session with old activity
      await createMockSession('test-session');
      await wasp.sessions.update('test-session', {
        lastActivityAt: new Date(Date.now() - 10 * 60 * 1000), // 10 minutes ago
      });

      monitor = new WaspHealthMonitor(wasp, {
        intervalMs: 50, // Very fast ticks
        stalenessThresholdMs: 5 * 60 * 1000,
      });

      let degradedCount = 0;
      wasp.on('health:degraded' as any, () => {
        degradedCount++;
      });

      monitor.start();

      // Wait for multiple ticks
      await new Promise((resolve) => setTimeout(resolve, 250));

      // Should only emit degraded once
      expect(degradedCount).toBe(1);
    }, 10000);
  });

  describe('Staleness calculation', () => {
    it('should not mark disconnected sessions as stale', async () => {
      // Create and disconnect session
      await createMockSession('test-session');
      await wasp.sessions.update('test-session', {
        status: 'DISCONNECTED' as any,
        lastActivityAt: new Date(Date.now() - 10 * 60 * 1000),
      });

      monitor = new WaspHealthMonitor(wasp, {
        intervalMs: 100,
        stalenessThresholdMs: 5 * 60 * 1000,
      });

      const tickPromise = new Promise((resolve) => {
        wasp.on('health:tick' as any, (event) => {
          const session = event.data.sessions.find((s: any) => s.id === 'test-session');
          if (session) {
            expect(session.staleSinceMs).toBeNull();
            resolve(session);
          }
        });
      });

      monitor.start();
      await tickPromise;
    });

    it('should handle sessions without lastActivityAt', async () => {
      // Create session without lastActivityAt
      await createMockSession('test-session');
      await wasp.sessions.update('test-session', {
        lastActivityAt: undefined,
      });

      monitor = new WaspHealthMonitor(wasp, {
        intervalMs: 100,
        stalenessThresholdMs: 5 * 60 * 1000,
      });

      const tickPromise = new Promise((resolve) => {
        wasp.on('health:tick' as any, (event) => {
          const session = event.data.sessions.find((s: any) => s.id === 'test-session');
          if (session) {
            // Should fallback to connectedAt or null
            resolve(session);
          }
        });
      });

      monitor.start();
      await tickPromise;
    });
  });

  describe('Memory logging', () => {
    it('should include memory stats when logMemory is true', async () => {
      monitor = new WaspHealthMonitor(wasp, {
        intervalMs: 100,
        logMemory: true,
      });

      const tickPromise = new Promise((resolve) => {
        wasp.on('health:tick' as any, (event) => {
          expect(event.data).toHaveProperty('memory');
          expect(event.data.memory).toHaveProperty('heapUsed');
          expect(event.data.memory).toHaveProperty('heapTotal');
          expect(typeof event.data.memory.heapUsed).toBe('number');
          expect(typeof event.data.memory.heapTotal).toBe('number');
          resolve(event.data);
        });
      });

      monitor.start();
      await tickPromise;
    });

    it('should not include memory stats when logMemory is false', async () => {
      monitor = new WaspHealthMonitor(wasp, {
        intervalMs: 100,
        logMemory: false,
      });

      const tickPromise = new Promise((resolve) => {
        wasp.on('health:tick' as any, (event) => {
          expect(event.data.memory).toBeUndefined();
          resolve(event.data);
        });
      });

      monitor.start();
      await tickPromise;
    });
  });
});
