/**
 * Weighted Baileys credential scorer and best-creds selector
 *
 * Scores authentication credentials based on completeness and criticality.
 * Selects the best credential source from multiple candidates.
 */

import { initAuthCreds, type AuthenticationCreds } from '@whiskeysockets/baileys';

export type CredsSource = 'postgres' | 'redis' | 'disk' | 'init';

export type CredsCandidate = {
  source: CredsSource;
  creds: AuthenticationCreds | null;
};

export type CredsScore = {
  score: number;
  missingCritical: string[];
};

// Internal validators
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const isBinary = (v: unknown): v is Uint8Array => v instanceof Uint8Array;
const hasBinaryData = (v: unknown): boolean => isBinary(v) && v.length > 0;
const isKeyPair = (v: unknown): boolean => isRecord(v) && hasBinaryData((v as any).public) && hasBinaryData((v as any).private);
const isSignedPreKey = (v: unknown): boolean => isRecord(v) && isRecord((v as any).keyPair) && isKeyPair((v as any).keyPair) && hasBinaryData((v as any).signature);
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isNonNegativeNumber = (v: unknown): boolean => isNumber(v) && (v as number) >= 0;
const isBoolean = (v: unknown): boolean => typeof v === 'boolean';
const isNonEmptyString = (v: unknown): boolean => typeof v === 'string' && v.trim().length > 0;
const isArray = (v: unknown): boolean => Array.isArray(v);
const isObject = (v: unknown): boolean => isRecord(v);
const hasId = (v: unknown): boolean => isRecord(v) && isNonEmptyString((v as any).id);

// Critical checks with weights
const CRITICAL_CHECKS = [
  { key: 'noiseKey', check: isKeyPair, weight: 3 },
  { key: 'signedIdentityKey', check: isKeyPair, weight: 3 },
  { key: 'signedPreKey', check: isSignedPreKey, weight: 3 },
  { key: 'registrationId', check: isNonNegativeNumber, weight: 2 },
  { key: 'advSecretKey', check: isNonEmptyString, weight: 3, shouldCheck: (c: AuthenticationCreds) => isObject((c as any).account) },
];

const IMPORTANT_CHECKS = [
  { key: 'pairingEphemeralKeyPair', check: isKeyPair, weight: 1 },
  { key: 'processedHistoryMessages', check: isArray, weight: 1 },
  { key: 'nextPreKeyId', check: isNumber, weight: 1 },
  { key: 'firstUnuploadedPreKeyId', check: isNumber, weight: 1 },
  { key: 'accountSyncCounter', check: isNumber, weight: 1 },
  { key: 'accountSettings', check: isObject, weight: 1 },
  { key: 'registered', check: isBoolean, weight: 1 },
  { key: 'me', check: hasId, weight: 1 },
  { key: 'account', check: isObject, weight: 1 },
];

/**
 * Normalize credentials by merging with fresh init creds
 *
 * Ensures all required fields are present with valid defaults.
 */
export const normalizeCreds = (input: AuthenticationCreds | null | undefined): AuthenticationCreds => {
  const base = initAuthCreds();
  if (!input || typeof input !== 'object') return base;
  return {
    ...base,
    ...input,
    noiseKey: input.noiseKey ?? base.noiseKey,
    pairingEphemeralKeyPair: input.pairingEphemeralKeyPair ?? base.pairingEphemeralKeyPair,
    signedIdentityKey: input.signedIdentityKey ?? base.signedIdentityKey,
    signedPreKey: input.signedPreKey ?? base.signedPreKey,
    processedHistoryMessages: Array.isArray(input.processedHistoryMessages) ? input.processedHistoryMessages : base.processedHistoryMessages,
    signalIdentities: Array.isArray(input.signalIdentities) ? input.signalIdentities : base.signalIdentities,
    accountSettings: { ...base.accountSettings, ...(input.accountSettings ?? {}) },
    me: input.me ?? base.me,
    account: input.account ?? base.account,
  };
};

/**
 * Score credentials based on completeness and criticality
 *
 * Returns a score (higher = better) and list of missing critical fields.
 * Score = -1 indicates completely invalid credentials.
 */
export const scoreCreds = (creds: AuthenticationCreds | null | undefined): CredsScore => {
  if (!creds || typeof creds !== 'object') return { score: -1, missingCritical: CRITICAL_CHECKS.map(c => c.key) };

  let score = 0;
  const missingCritical: string[] = [];

  for (const check of CRITICAL_CHECKS) {
    if (check.shouldCheck && !check.shouldCheck(creds)) continue;
    if (check.check((creds as any)[check.key])) {
      score += check.weight;
    } else {
      missingCritical.push(check.key);
    }
  }

  for (const check of IMPORTANT_CHECKS) {
    if ((check as any).shouldCheck && !(check as any).shouldCheck(creds)) continue;
    if (check.check((creds as any)[check.key])) score += check.weight;
  }

  return { score, missingCritical };
};

/**
 * Select the best credentials from multiple candidates
 *
 * Prioritizes by:
 * 1. Completeness (no missing critical fields)
 * 2. Score (higher is better)
 * 3. Source priority (as specified in priority array)
 *
 * Falls back to fresh init creds if all candidates are invalid.
 */
export const selectBestCreds = (
  candidates: CredsCandidate[],
  priority: CredsSource[]
): { creds: AuthenticationCreds; meta: { source: string; score: number; missingCritical: string[] } } => {
  const scored = candidates.map(c => {
    const { score, missingCritical } = scoreCreds(c.creds);
    return {
      ...c,
      score,
      missingCritical,
      priorityIndex: priority.indexOf(c.source) >= 0 ? priority.indexOf(c.source) : Infinity
    };
  });

  const valid = scored.filter(e => e.score >= 0);
  if (!valid.length) {
    return {
      creds: initAuthCreds(),
      meta: { source: 'init', score: 0, missingCritical: CRITICAL_CHECKS.map(c => c.key) }
    };
  }

  const complete = valid.filter(e => e.missingCritical.length === 0);
  const pool = complete.length ? complete : valid;

  pool.sort((a, b) => b.score !== a.score ? b.score - a.score : a.priorityIndex - b.priorityIndex);

  const best = pool[0]!;
  return {
    creds: normalizeCreds(best.creds),
    meta: { source: best.source, score: best.score, missingCritical: best.missingCritical }
  };
};
