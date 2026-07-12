/**
 * Trigger Router DSL
 *
 * Priority-ordered trigger matching system for message content routing.
 * Framework-agnostic utility with no database dependencies.
 */

/**
 * Type of trigger matching strategy
 */
export type TriggerType = 'all' | 'none' | 'advanced' | 'keyword';

/**
 * Operator for keyword-based triggers
 */
export type TriggerOperator = 'equals' | 'regex' | 'startsWith' | 'endsWith' | 'contains';

/**
 * Trigger definition with optional user payload
 *
 * @template T - Type of the user-attached payload data
 */
export interface TriggerDefinition<T = unknown> {
  /** Type of trigger matching strategy */
  triggerType: TriggerType;
  /** Operator for keyword triggers (required if triggerType is 'keyword') */
  triggerOperator?: TriggerOperator;
  /** Value to match against (required for keyword and advanced triggers) */
  triggerValue?: string;
  /** Whether this trigger is enabled (default: true) */
  enabled?: boolean;
  /** User-attached data, returned with the match */
  payload?: T;
}

/**
 * Result of a successful trigger match
 *
 * @template T - Type of the user-attached payload data
 */
export interface TriggerMatch<T = unknown> {
  /** The matching trigger definition */
  trigger: TriggerDefinition<T>;
  /** Which matching strategy succeeded */
  matchedBy: 'all' | 'none' | 'advanced' | 'equals' | 'regex' | 'startsWith' | 'endsWith' | 'contains';
}

/**
 * Normalize text for accent-insensitive comparison
 *
 * Converts to NFD, strips combining characters, and lowercases.
 *
 * @param text - Text to normalize
 * @returns Normalized text
 */
function normalizeText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // Strip combining diacritical marks
    .toLowerCase();
}

/**
 * Advanced DSL matcher
 *
 * Parses boolean operator DSL strings like:
 * - `contains:word,other notcontains:bad startswith:hello`
 * - Space-separated key:value pairs
 * - Comma within value = AND (all must match)
 * - Multiple keys = OR (at least one must match)
 *
 * Supported operators:
 * - `contains:word` - data must contain "word"
 * - `notcontains:word` - data must NOT contain "word"
 * - `startswith:word` - data must start with "word"
 * - `endswith:word` - data must end with "word"
 * - `equals:word` - data must equal "word"
 *
 * @param data - Content to search in
 * @param query - DSL query string
 * @returns true if the query matches the data
 *
 * @example
 * ```typescript
 * advancedOperatorsSearch('hello world', 'contains:hello') // true
 * advancedOperatorsSearch('hello world', 'contains:hello,world') // true (AND)
 * advancedOperatorsSearch('hello world', 'notcontains:bad') // true
 * advancedOperatorsSearch('hello world', 'startswith:hello endswith:world') // true (OR)
 * ```
 */
export function advancedOperatorsSearch(data: string, query: string): boolean {
  const normalizedData = normalizeText(data);
  const operators = query.trim().split(/\s+/);

  for (const operator of operators) {
    const [op, value] = operator.split(':');
    if (!op || !value) continue;

    const values = value.split(',').map(v => normalizeText(v.trim()));

    switch (op.toLowerCase()) {
      case 'contains': {
        // All comma-separated values must be present (AND)
        if (values.every(v => normalizedData.includes(v))) {
          return true; // At least one operator matched (OR across operators)
        }
        break;
      }

      case 'notcontains': {
        // None of the comma-separated values should be present (AND)
        if (values.every(v => !normalizedData.includes(v))) {
          return true;
        }
        break;
      }

      case 'startswith': {
        // Data must start with at least one of the values (OR within comma)
        if (values.some(v => normalizedData.startsWith(v))) {
          return true;
        }
        break;
      }

      case 'endswith': {
        // Data must end with at least one of the values (OR within comma)
        if (values.some(v => normalizedData.endsWith(v))) {
          return true;
        }
        break;
      }

      case 'equals': {
        // Data must equal at least one of the values (OR within comma)
        if (values.some(v => normalizedData === v)) {
          return true;
        }
        break;
      }

      default:
        // Unknown operator, skip
        continue;
    }
  }

  // No operator matched
  return false;
}

/**
 * Find the first matching trigger for the given content
 *
 * Checks triggers by type specificity (most specific first), respecting array order within each level.
 * The checking order is optimized for typical bot use-cases where specific triggers should match
 * before generic fallbacks:
 *
 * Check order (most specific to least specific):
 * 1. keyword:equals - exact match
 * 2. keyword:regex - pattern match
 * 3. advanced - boolean operator DSL
 * 4. keyword:startsWith - prefix match
 * 5. keyword:endsWith - suffix match
 * 6. keyword:contains - substring match
 * 7. all/none - matches any message (fallback)
 *
 * Within each level, triggers are evaluated in the order they appear in the array.
 * Skips triggers where `enabled` is false.
 *
 * @template T - Type of the user-attached payload
 * @param triggers - Array of trigger definitions to check
 * @param content - Message content to match against
 * @returns First matching trigger, or null if none match
 *
 * @example
 * ```typescript
 * interface BotConfig {
 *   id: string;
 *   name: string;
 * }
 *
 * const triggers: TriggerDefinition<BotConfig>[] = [
 *   {
 *     triggerType: 'keyword',
 *     triggerOperator: 'equals',
 *     triggerValue: '/start',
 *     payload: { id: 'bot-1', name: 'Welcome Bot' },
 *   },
 *   {
 *     triggerType: 'advanced',
 *     triggerValue: 'contains:help,support',
 *     payload: { id: 'bot-2', name: 'Support Bot' },
 *   },
 *   {
 *     triggerType: 'all',
 *     payload: { id: 'bot-3', name: 'Fallback Bot' },
 *   },
 * ];
 *
 * const match = findTrigger(triggers, '/start');
 * if (match) {
 *   console.log(`Matched by: ${match.matchedBy}`);
 *   console.log(`Bot: ${match.trigger.payload?.name}`);
 * }
 * ```
 */
export function findTrigger<T = unknown>(
  triggers: TriggerDefinition<T>[],
  content: string
): TriggerMatch<T> | null {
  const normalizedContent = normalizeText(content);

  // Helper to check if trigger matches
  const checkTrigger = (trigger: TriggerDefinition<T>): TriggerMatch<T> | null => {
    if (trigger.enabled === false) return null;

    // Priority 1: all/none
    if (trigger.triggerType === 'all' || trigger.triggerType === 'none') {
      return {
        trigger,
        matchedBy: trigger.triggerType,
      };
    }

    // Priority 2: advanced
    if (trigger.triggerType === 'advanced' && trigger.triggerValue) {
      if (advancedOperatorsSearch(content, trigger.triggerValue)) {
        return {
          trigger,
          matchedBy: 'advanced',
        };
      }
    }

    // Priority 3-7: keyword operators
    if (trigger.triggerType === 'keyword' && trigger.triggerOperator && trigger.triggerValue) {
      const normalizedValue = normalizeText(trigger.triggerValue);

      switch (trigger.triggerOperator) {
        case 'equals':
          if (normalizedContent === normalizedValue) {
            return { trigger, matchedBy: 'equals' };
          }
          break;

        case 'regex':
          try {
            const regex = new RegExp(trigger.triggerValue, 'i');
            if (regex.test(content)) {
              return { trigger, matchedBy: 'regex' };
            }
          } catch {
            // Invalid regex, skip
          }
          break;

        case 'startsWith':
          if (normalizedContent.startsWith(normalizedValue)) {
            return { trigger, matchedBy: 'startsWith' };
          }
          break;

        case 'endsWith':
          if (normalizedContent.endsWith(normalizedValue)) {
            return { trigger, matchedBy: 'endsWith' };
          }
          break;

        case 'contains':
          if (normalizedContent.includes(normalizedValue)) {
            return { trigger, matchedBy: 'contains' };
          }
          break;
      }
    }

    return null;
  };

  // Define priority order for trigger checking (lower number = checked first)
  const priorityOrder: Array<(trigger: TriggerDefinition<T>) => number> = [
    // 1: keyword:equals - exact match (most specific)
    (t) => (t.triggerType === 'keyword' && t.triggerOperator === 'equals' ? 1 : 0),
    // 2: keyword:regex - pattern match
    (t) => (t.triggerType === 'keyword' && t.triggerOperator === 'regex' ? 2 : 0),
    // 3: advanced - boolean operator DSL
    (t) => (t.triggerType === 'advanced' ? 3 : 0),
    // 4: keyword:startsWith
    (t) => (t.triggerType === 'keyword' && t.triggerOperator === 'startsWith' ? 4 : 0),
    // 5: keyword:endsWith
    (t) => (t.triggerType === 'keyword' && t.triggerOperator === 'endsWith' ? 5 : 0),
    // 6: keyword:contains - substring match
    (t) => (t.triggerType === 'keyword' && t.triggerOperator === 'contains' ? 6 : 0),
    // 7: all/none - matches any message (least specific, fallback)
    (t) => (t.triggerType === 'all' || t.triggerType === 'none' ? 7 : 0),
  ];

  // Check each priority level in order (1 first, 7 last)
  for (let priority = 1; priority <= 7; priority++) {
    for (const trigger of triggers) {
      // Calculate this trigger's priority
      let triggerPriority = 0;
      for (const getPriority of priorityOrder) {
        const p = getPriority(trigger);
        if (p > 0) {
          triggerPriority = p;
          break;
        }
      }

      // If this trigger matches the current priority level, check it
      if (triggerPriority === priority) {
        const match = checkTrigger(trigger);
        if (match) {
          return match;
        }
      }
    }
  }

  // No match found
  return null;
}
