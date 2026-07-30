/**
 * Session key convention: platform:chatType:chatId
 *
 * Mirrors the Hermes gateway routing schema for deterministic session lookup
 * across multi-platform deployments. Always build/parse via these helpers —
 * never hand-construct the string.
 *
 * Examples:
 *   whatsapp:private:27821234567
 *   whatsapp:group:120363000000000001@g.us
 *   telegram:private:123456789
 */

export type Platform = 'whatsapp' | 'telegram' | 'instagram' | (string & Record<never, never>);
export type ChatType = 'private' | 'group' | 'channel' | (string & Record<never, never>);

export interface SessionKeyParts {
  platform: Platform;
  chatType: ChatType;
  chatId: string;
}

export function buildSessionKey(platform: Platform, chatType: ChatType, chatId: string): string {
  return `${platform}:${chatType}:${chatId}`;
}

export function parseSessionKey(key: string): SessionKeyParts | null {
  const first = key.indexOf(':');
  if (first === -1) return null;
  const platform = key.slice(0, first);
  const rest = key.slice(first + 1);
  const second = rest.indexOf(':');
  if (second === -1) return null;
  const chatType = rest.slice(0, second);
  const chatId = rest.slice(second + 1);
  if (!platform || !chatType || !chatId) return null;
  return { platform, chatType, chatId };
}
