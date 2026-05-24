/**
 * Anti-ban message queue
 *
 * Implements human-like delays, rate limiting, and priority lanes
 * to prevent WhatsApp from flagging accounts as spam/bots.
 */

import { EventEmitter } from 'events';
import type { QueueOptions, QueueItem, Message } from './types.js';
import { QueueFullError } from './errors.js';

/**
 * Default queue configuration
 */
const DEFAULT_QUEUE_OPTIONS: QueueOptions = {
  minDelay: 2000, // 2 seconds
  maxDelay: 5000, // 5 seconds
  maxConcurrent: 1, // Process one message at a time per session
  priorityLanes: true,
  maxQueueSize: 1000, // Default max queue size
};

/**
 * Anti-ban message queue
 *
 * Queues messages per session with human-like random delays
 * to avoid WhatsApp rate limiting and ban detection.
 */
export class MessageQueue extends EventEmitter {
  private options: QueueOptions;
  private queues: Map<string, QueueItem[]> = new Map();
  private processing: Map<string, boolean> = new Map();
  private lastSent: Map<string, number> = new Map();
  private timelocked: Map<string, { expiresAt?: Date; enforcementType?: string }> = new Map();
  private sleepAbortHandlers: Map<string, (() => void)[]> = new Map();

  constructor(options?: Partial<QueueOptions>) {
    super();
    this.options = { ...DEFAULT_QUEUE_OPTIONS, ...options };
  }

  /**
   * Add message to queue
   *
   * @param item Queue item
   * @returns Promise that resolves when message is sent
   */
  async enqueue(item: QueueItem): Promise<Message> {
    // Get or create session queue
    let queue = this.queues.get(item.sessionId);
    if (!queue) {
      queue = [];
      this.queues.set(item.sessionId, queue);
    }

    // Check queue size limit
    const maxSize = this.options.maxQueueSize ?? 0;
    if (maxSize > 0 && queue.length >= maxSize) {
      throw new QueueFullError(item.sessionId, maxSize);
    }

    // Create a promise that will be resolved when the item is processed
    const promise = new Promise<Message>((promiseResolve, promiseReject) => {
      // Store the original callbacks
      const originalResolve = item.resolve;
      const originalReject = item.reject;

      // Wrap resolve to capture the result
      item.resolve = (message?: Message) => {
        // Call the original resolve
        const result = originalResolve(message);

        // If originalResolve returns a promise, wait for it and resolve with the result
        if (result && typeof result === 'object' && 'then' in result) {
          (result as Promise<Message>).then((msg) => {
            promiseResolve(msg || ({} as Message));
          }).catch(promiseReject);
          return result;
        } else {
          // If it returns void, resolve with the message parameter or empty object
          promiseResolve(message || ({} as Message));
          return result;
        }
      };

      // Wrap reject
      item.reject = (error: Error) => {
        originalReject(error);
        promiseReject(error);
      };
    });

    // Add to queue, sorted by priority (higher first)
    queue.push(item);
    queue.sort((a, b) => b.priority - a.priority);

    this.emit('enqueued', { sessionId: item.sessionId, queueSize: queue.length });

    // Start processing if not already
    if (!this.processing.get(item.sessionId)) {
      this.processQueue(item.sessionId).catch((error) => {
        this.emit('error', { sessionId: item.sessionId, error });
      });
    }

    return promise;
  }

  /**
   * Process queue for a session
   *
   * @param sessionId Session ID
   */
  private async processQueue(sessionId: string): Promise<void> {
    // Mark as processing
    this.processing.set(sessionId, true);

    try {
      const queue = this.queues.get(sessionId);
      if (!queue || queue.length === 0) {
        this.processing.set(sessionId, false);
        return;
      }

      // Peek at next item (don't remove it yet)
      const item = queue[0];

      // Calculate delay
      const delay = this.calculateDelay(sessionId, item);

      // Wait for delay BEFORE removing from queue
      // This allows higher priority items to jump ahead
      if (delay > 0) {
        this.emit('delay', { sessionId, delay, queueSize: queue.length });
        await this.sleep(delay, sessionId);
      }

      // Queue may have been interrupted/cleared during the sleep window
      if (!this.queues.has(sessionId)) {
        this.processing.set(sessionId, false);
        return;
      }

      // Re-sort queue (in case higher priority items arrived during delay)
      // and remove the highest priority item
      queue.sort((a, b) => b.priority - a.priority);
      const itemToSend = queue.shift();
      if (!itemToSend) {
        this.processing.set(sessionId, false);
        return;
      }

      // Send message (will be handled by the caller's sendFn)
      try {
        this.emit('sending', { sessionId, to: itemToSend.to });

        // Call the resolve function which does the actual work
        // In tests, this might just resolve immediately
        // In WaSP, this calls provider.sendMessage
        const result = itemToSend.resolve();

        // If resolve returns a promise, await it to get the message
        if (result && typeof result === 'object' && 'then' in result) {
          const message = await result;
          this.lastSent.set(sessionId, Date.now());
          this.emit('sent', { sessionId, queueSize: queue.length, message });
        } else {
          this.lastSent.set(sessionId, Date.now());
          this.emit('sent', { sessionId, queueSize: queue.length });
        }
      } catch (error) {
        itemToSend.reject(error as Error);
        this.emit('error', { sessionId, error });
      }

      // Continue processing if queue not empty
      if (queue.length > 0) {
        // Don't await - let it run async
        this.processQueue(sessionId).catch((error) => {
          this.emit('error', { sessionId, error });
        });
      } else {
        this.processing.set(sessionId, false);
      }
    } catch (error) {
      this.processing.set(sessionId, false);
      this.emit('error', { sessionId, error });
    }
  }

  /**
   * Calculate delay before sending next message
   *
   * @param sessionId Session ID
   * @param item Queue item
   * @returns Delay in milliseconds
   */
  private calculateDelay(sessionId: string, item: QueueItem): number {
    // Immediate messages skip delay (use with caution)
    if (item.options?.immediate) {
      return 0;
    }

    // Priority messages have reduced delay
    const isPriority = item.priority > 0;
    if (isPriority && this.options.priorityLanes) {
      const minDelay = Math.floor(this.options.minDelay * 0.5);
      const maxDelay = Math.floor(this.options.maxDelay * 0.5);
      return this.randomDelay(minDelay, maxDelay);
    }

    // Check time since last message
    const lastSent = this.lastSent.get(sessionId);

    // If this is the first message or enough time has passed since last message
    if (!lastSent) {
      // First message - use full delay
      return this.randomDelay(this.options.minDelay, this.options.maxDelay);
    }

    const timeSinceLastSent = Date.now() - lastSent;

    // If enough time has passed, use reduced delay
    if (timeSinceLastSent >= this.options.maxDelay) {
      return this.randomDelay(
        Math.floor(this.options.minDelay * 0.3),
        Math.floor(this.options.minDelay * 0.7)
      );
    }

    // Otherwise, full random delay
    return this.randomDelay(this.options.minDelay, this.options.maxDelay);
  }

  /**
   * Generate random delay with human-like distribution
   *
   * Uses a slight bias toward the middle of the range
   * to mimic human typing patterns.
   *
   * @param min Minimum delay (ms)
   * @param max Maximum delay (ms)
   * @returns Random delay
   */
  private randomDelay(min: number, max: number): number {
    // Generate two random numbers and average them
    // This creates a slight bell curve distribution
    const rand1 = Math.random();
    const rand2 = Math.random();
    const avg = (rand1 + rand2) / 2;

    return Math.floor(min + avg * (max - min));
  }

  /**
   * Sleep for specified duration, interruptible via interrupt()
   */
  private sleep(ms: number, sessionId?: string): Promise<void> {
    return new Promise((resolve) => {
      let abortFn: (() => void) | undefined;

      const timer = setTimeout(() => {
        if (sessionId && abortFn) {
          const handlers = this.sleepAbortHandlers.get(sessionId);
          if (handlers) {
            const idx = handlers.indexOf(abortFn);
            if (idx > -1) handlers.splice(idx, 1);
          }
        }
        resolve();
      }, ms);

      if (sessionId) {
        abortFn = () => {
          clearTimeout(timer);
          resolve();
        };
        if (!this.sleepAbortHandlers.has(sessionId)) {
          this.sleepAbortHandlers.set(sessionId, []);
        }
        this.sleepAbortHandlers.get(sessionId)!.push(abortFn);
      }
    });
  }

  /**
   * Interrupt all pending and in-flight messages for a session.
   *
   * Wakes any sleeping processQueue, drains the queue (rejecting all items),
   * and emits 'interrupted'. Use for /stop or bid-conflict resolution.
   */
  interrupt(sessionId: string): void {
    const handlers = this.sleepAbortHandlers.get(sessionId) ?? [];
    handlers.forEach((abort) => abort());
    this.sleepAbortHandlers.delete(sessionId);

    const queue = this.queues.get(sessionId);
    if (queue) {
      queue.forEach((item) => item.reject(new Error('Queue interrupted')));
      queue.length = 0;
    }
    this.queues.delete(sessionId);
    this.processing.set(sessionId, false);

    this.emit('interrupted', { sessionId });
  }

  /**
   * Bypass the queue and execute a QueueItem immediately.
   *
   * For priority commands (/stop, /approve, /deny) that must not wait
   * behind pending messages. Does not affect the existing queue.
   */
  async bypass(sessionId: string, item: QueueItem): Promise<Message> {
    this.emit('bypass', { sessionId, to: item.to });
    try {
      const result = item.resolve();
      if (result && typeof result === 'object' && 'then' in result) {
        return await (result as Promise<Message>);
      }
      return {} as Message;
    } catch (error) {
      item.reject(error as Error);
      throw error;
    }
  }

  /**
   * Mark a session as timelocked — new-contact messages will be held
   */
  setTimelocked(sessionId: string, expiresAt?: Date, enforcementType?: string): void {
    this.timelocked.set(sessionId, { expiresAt, enforcementType });
    this.emit('timelocked', { sessionId, expiresAt, enforcementType });
  }

  /**
   * Clear timelock for a session
   */
  clearTimelocked(sessionId: string): void {
    this.timelocked.delete(sessionId);
    this.emit('timelock-lifted', { sessionId });
  }

  /**
   * Check if a session is timelocked
   */
  isSessionTimelocked(sessionId: string): boolean {
    const tl = this.timelocked.get(sessionId);
    if (!tl) return false;
    // Auto-clear if expired
    if (tl.expiresAt && Date.now() >= tl.expiresAt.getTime()) {
      this.timelocked.delete(sessionId);
      this.emit('timelock-lifted', { sessionId });
      return false;
    }
    return true;
  }

  /**
   * Get queue size for a session
   *
   * @param sessionId Session ID
   * @returns Queue size
   */
  getQueueSize(sessionId: string): number {
    return this.queues.get(sessionId)?.length ?? 0;
  }

  /**
   * Clear queue for a session
   *
   * @param sessionId Session ID
   */
  clearQueue(sessionId: string): void {
    const handlers = this.sleepAbortHandlers.get(sessionId) ?? [];
    handlers.forEach((abort) => abort());
    this.sleepAbortHandlers.delete(sessionId);

    const queue = this.queues.get(sessionId);
    if (queue) {
      queue.forEach((item) => {
        item.reject(new Error('Queue cleared'));
      });
      this.queues.delete(sessionId);
    }
    this.processing.delete(sessionId);
    this.lastSent.delete(sessionId);
    this.timelocked.delete(sessionId);
  }

  /**
   * Clear all queues
   */
  clearAll(): void {
    for (const sessionId of this.queues.keys()) {
      this.clearQueue(sessionId);
    }
    // Ensure all maps are cleared
    this.queues.clear();
    this.processing.clear();
    this.lastSent.clear();
    this.timelocked.clear();
    this.sleepAbortHandlers.clear();
  }

  /**
   * Get statistics
   */
  getStats(): {
    totalQueued: number;
    sessionCount: number;
    processingCount: number;
  } {
    let totalQueued = 0;
    for (const queue of this.queues.values()) {
      totalQueued += queue.length;
    }

    let processingCount = 0;
    for (const processing of this.processing.values()) {
      if (processing) processingCount++;
    }

    return {
      totalQueued,
      sessionCount: this.queues.size,
      processingCount,
    };
  }
}
