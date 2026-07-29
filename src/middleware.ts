/**
 * Middleware exports
 */

export { logger } from './middleware/logger.js';
export type { LoggerOptions } from './middleware/logger.js';

export { autoReconnect } from './middleware/autoReconnect.js';
export type { AutoReconnectOptions } from './middleware/autoReconnect.js';

export { errorHandler } from './middleware/errorHandler.js';
export type { ErrorCallback } from './middleware/errorHandler.js';

export { rateLimit } from './middleware/rateLimit.js';
export type { RateLimitOptions } from './middleware/rateLimit.js';

export { findTrigger, advancedOperatorsSearch } from './middleware/triggerRouter.js';
export type {
  TriggerDefinition,
  TriggerMatch,
  TriggerType,
  TriggerOperator,
} from './middleware/triggerRouter.js';
