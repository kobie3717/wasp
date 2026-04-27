/**
 * SessionStoreCache tests
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createSessionStoreCache } from '../stores/store-cache.js';
import type { SessionStoreCache, FsAdapter } from '../stores/store-cache.js';

describe('SessionStoreCache', () => {
  let cache: SessionStoreCache;
  let mockFs: FsAdapter;
  let fileStats: Map<string, { mtimeMs: number; size: number }>;
  let fileContents: Map<string, string>;

  beforeEach(() => {
    fileStats = new Map();
    fileContents = new Map();

    mockFs = {
      stat: vi.fn(async (path: string) => {
        const stats = fileStats.get(path);
        if (!stats) {
          const error: NodeJS.ErrnoException = new Error('ENOENT');
          error.code = 'ENOENT';
          throw error;
        }
        return stats;
      }),
      readFile: vi.fn(async (path: string) => {
        const content = fileContents.get(path);
        if (content === undefined) {
          const error: NodeJS.ErrnoException = new Error('ENOENT');
          error.code = 'ENOENT';
          throw error;
        }
        return content;
      }),
    };

    cache = createSessionStoreCache({ fs: mockFs });
  });

  it('should cache hit on unchanged file', async () => {
    const path = '/tmp/session.json';
    const data = { sessionId: 's1', jid: 'j1@s.whatsapp.net' };

    fileStats.set(path, { mtimeMs: 1000, size: 100 });
    fileContents.set(path, JSON.stringify(data));

    // First read
    const result1 = await cache.read(path);
    expect(result1).toEqual(data);
    expect(mockFs.readFile).toHaveBeenCalledTimes(1);

    // Second read - should use cache
    const result2 = await cache.read(path);
    expect(result2).toEqual(data);
    expect(mockFs.readFile).toHaveBeenCalledTimes(1); // Still 1, not 2
  });

  it('should cache miss on mtime change', async () => {
    const path = '/tmp/session.json';
    const data1 = { sessionId: 's1', jid: 'j1@s.whatsapp.net' };
    const data2 = { sessionId: 's2', jid: 'j2@s.whatsapp.net' };

    fileStats.set(path, { mtimeMs: 1000, size: 100 });
    fileContents.set(path, JSON.stringify(data1));

    // First read
    const result1 = await cache.read(path);
    expect(result1).toEqual(data1);

    // Change mtime
    fileStats.set(path, { mtimeMs: 2000, size: 100 });
    fileContents.set(path, JSON.stringify(data2));

    // Second read - should detect change and re-read
    const result2 = await cache.read(path);
    expect(result2).toEqual(data2);
    expect(mockFs.readFile).toHaveBeenCalledTimes(2);
  });

  it('should cache miss on size change', async () => {
    const path = '/tmp/session.json';
    const data1 = { sessionId: 's1' };
    const data2 = { sessionId: 's2', jid: 'j2@s.whatsapp.net' };

    fileStats.set(path, { mtimeMs: 1000, size: 20 });
    fileContents.set(path, JSON.stringify(data1));

    // First read
    const result1 = await cache.read(path);
    expect(result1).toEqual(data1);

    // Change size
    fileStats.set(path, { mtimeMs: 1000, size: 50 });
    fileContents.set(path, JSON.stringify(data2));

    // Second read - should detect change
    const result2 = await cache.read(path);
    expect(result2).toEqual(data2);
    expect(mockFs.readFile).toHaveBeenCalledTimes(2);
  });

  it('should implement LRU eviction', async () => {
    cache = createSessionStoreCache({ maxEntries: 2, fs: mockFs });

    // Add 3 files
    for (let i = 1; i <= 3; i++) {
      const path = `/tmp/session${i}.json`;
      fileStats.set(path, { mtimeMs: 1000, size: 100 });
      fileContents.set(path, JSON.stringify({ sessionId: `s${i}` }));
      await cache.read(path);
    }

    // Cache should only hold 2 entries (LRU eviction)
    expect(cache.size).toBe(2);

    // First file should have been evicted
    // Reading it again should trigger a fresh load
    await cache.read('/tmp/session1.json');
    expect(mockFs.readFile).toHaveBeenCalledTimes(4); // 3 initial + 1 re-read
  });

  it('should update LRU on access', async () => {
    cache = createSessionStoreCache({ maxEntries: 2, fs: mockFs });

    // Add 2 files
    fileStats.set('/tmp/session1.json', { mtimeMs: 1000, size: 100 });
    fileContents.set('/tmp/session1.json', JSON.stringify({ sessionId: 's1' }));
    fileStats.set('/tmp/session2.json', { mtimeMs: 1000, size: 100 });
    fileContents.set('/tmp/session2.json', JSON.stringify({ sessionId: 's2' }));

    await cache.read('/tmp/session1.json');
    await cache.read('/tmp/session2.json');

    // Access session1 again to make it most recent
    await cache.read('/tmp/session1.json');

    // Add a third file - should evict session2 (least recent)
    fileStats.set('/tmp/session3.json', { mtimeMs: 1000, size: 100 });
    fileContents.set('/tmp/session3.json', JSON.stringify({ sessionId: 's3' }));
    await cache.read('/tmp/session3.json');

    // session1 should still be cached (accessed recently)
    await cache.read('/tmp/session1.json');
    expect(mockFs.readFile).toHaveBeenCalledTimes(4); // 3 unique loads + 1 for session3

    // session2 should have been evicted (needs re-read)
    await cache.read('/tmp/session2.json');
    expect(mockFs.readFile).toHaveBeenCalledTimes(5); // Re-read session2
  });

  it('should cache raw content separately', async () => {
    const path = '/tmp/session.json';
    const data = { sessionId: 's1', jid: 'j1@s.whatsapp.net' };

    fileStats.set(path, { mtimeMs: 1000, size: 100 });
    fileContents.set(path, JSON.stringify(data));

    // Read raw
    const raw1 = await cache.readRaw(path);
    expect(raw1).toBe(JSON.stringify(data));
    expect(mockFs.readFile).toHaveBeenCalledTimes(1);

    // Read parsed - should use cached raw
    const parsed = await cache.read(path);
    expect(parsed).toEqual(data);
    expect(mockFs.readFile).toHaveBeenCalledTimes(1); // Still 1, not 2
  });

  it('should manually invalidate entries', async () => {
    const path = '/tmp/session.json';
    const data = { sessionId: 's1' };

    fileStats.set(path, { mtimeMs: 1000, size: 100 });
    fileContents.set(path, JSON.stringify(data));

    // First read
    await cache.read(path);
    expect(mockFs.readFile).toHaveBeenCalledTimes(1);

    // Invalidate
    cache.invalidate(path);

    // Next read should re-load
    await cache.read(path);
    expect(mockFs.readFile).toHaveBeenCalledTimes(2);
  });

  it('should handle missing files gracefully', async () => {
    const path = '/tmp/nonexistent.json';

    // Should throw since we're not catching ENOENT in the implementation
    await expect(cache.read(path)).rejects.toThrow();
  });

  it('should report accurate size', async () => {
    expect(cache.size).toBe(0);

    fileStats.set('/tmp/session1.json', { mtimeMs: 1000, size: 100 });
    fileContents.set('/tmp/session1.json', JSON.stringify({ sessionId: 's1' }));
    await cache.read('/tmp/session1.json');

    expect(cache.size).toBe(1);

    fileStats.set('/tmp/session2.json', { mtimeMs: 1000, size: 100 });
    fileContents.set('/tmp/session2.json', JSON.stringify({ sessionId: 's2' }));
    await cache.read('/tmp/session2.json');

    expect(cache.size).toBe(2);
  });
});
