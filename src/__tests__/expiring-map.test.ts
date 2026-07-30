/**
 * ExpiringMapCache tests
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { createExpiringMapCache } from '../cache/expiring-map.js';
import type { ExpiringMapCache } from '../cache/expiring-map.js';

describe('ExpiringMapCache', () => {
  let cache: ExpiringMapCache<string, { sessionId: string; jid: string }>;

  afterEach(() => {
    if (cache) {
      cache.stop();
    }
  });

  it('should set and get values', () => {
    cache = createExpiringMapCache({
      ttlMs: 5 * 60_000,
    });

    cache.set('key1', { sessionId: 's1', jid: 'j1' });
    const value = cache.get('key1');

    expect(value).toEqual({ sessionId: 's1', jid: 'j1' });
  });

  it('should return undefined for non-existent keys', () => {
    cache = createExpiringMapCache({
      ttlMs: 5 * 60_000,
    });

    const value = cache.get('non-existent');
    expect(value).toBeUndefined();
  });

  it('should expire entries on lazy access', () => {
    let currentTime = 1000;
    const clock = vi.fn(() => currentTime);

    cache = createExpiringMapCache({
      ttlMs: 100,
      clock,
    });

    // Set value at time 1000
    cache.set('key1', { sessionId: 's1', jid: 'j1' });
    expect(cache.get('key1')).toEqual({ sessionId: 's1', jid: 'j1' });

    // Advance time past expiry (1000 + 100 = 1100)
    currentTime = 1101;

    // Should be expired on access
    expect(cache.get('key1')).toBeUndefined();
    expect(cache.has('key1')).toBe(false);
  });

  it('should prune expired entries on interval', async () => {
    vi.useFakeTimers();

    let currentTime = 1000;
    const clock = vi.fn(() => currentTime);

    cache = createExpiringMapCache({
      ttlMs: 100,
      pruneIntervalMs: 50,
      clock,
    });

    // Set value at time 1000
    cache.set('key1', { sessionId: 's1', jid: 'j1' });
    cache.set('key2', { sessionId: 's2', jid: 'j2' });

    // Advance time past expiry
    currentTime = 1101;

    // Before prune runs, size still includes expired entries
    // Run prune interval
    await vi.advanceTimersByTimeAsync(50);

    // After prune, expired entries should be removed
    expect(cache.get('key1')).toBeUndefined();
    expect(cache.get('key2')).toBeUndefined();

    vi.useRealTimers();
  });

  it('should handle has() correctly with expiry', () => {
    let currentTime = 1000;
    const clock = vi.fn(() => currentTime);

    cache = createExpiringMapCache({
      ttlMs: 100,
      clock,
    });

    cache.set('key1', { sessionId: 's1', jid: 'j1' });
    expect(cache.has('key1')).toBe(true);

    // Advance time past expiry
    currentTime = 1101;
    expect(cache.has('key1')).toBe(false);
  });

  it('should delete entries', () => {
    cache = createExpiringMapCache({
      ttlMs: 5 * 60_000,
    });

    cache.set('key1', { sessionId: 's1', jid: 'j1' });
    expect(cache.has('key1')).toBe(true);

    cache.delete('key1');
    expect(cache.has('key1')).toBe(false);
  });

  it('should report accurate size after lazy cleanup', () => {
    let currentTime = 1000;
    const clock = vi.fn(() => currentTime);

    cache = createExpiringMapCache({
      ttlMs: 100,
      clock,
    });

    cache.set('key1', { sessionId: 's1', jid: 'j1' });
    cache.set('key2', { sessionId: 's2', jid: 'j2' });
    cache.set('key3', { sessionId: 's3', jid: 'j3' });

    expect(cache.size).toBe(3);

    // Advance time past expiry
    currentTime = 1101;

    // Size should trigger lazy cleanup
    expect(cache.size).toBe(0);
  });

  it('should stop prune interval on stop()', () => {
    vi.useFakeTimers();

    cache = createExpiringMapCache({
      ttlMs: 100,
      pruneIntervalMs: 50,
    });

    cache.stop();

    // Should be safe to call stop() again
    cache.stop();

    vi.useRealTimers();
  });

  it('should use default pruneIntervalMs when not specified', () => {
    cache = createExpiringMapCache({
      ttlMs: 5000,
    });

    // No error, just verify it works
    cache.set('key1', { sessionId: 's1', jid: 'j1' });
    expect(cache.get('key1')).toBeDefined();
  });
});
