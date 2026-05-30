import { createHash } from 'node:crypto';
import type { StrikeAction } from './domain';

export const RETRY_WINDOW_MS = 10 * 60 * 1000;

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type DuplicateKeyInput = {
  targetId: string;
  action: StrikeAction;
  ruleId: string;
};

export type ModeratorRetryKeyInput = DuplicateKeyInput & {
  moderatorUsername: string;
  submittedAtMs: number;
};

export const getRetryBucket = (submittedAtMs: number): number =>
  Math.floor(submittedAtMs / RETRY_WINDOW_MS);

export const canonicalJson = (value: JsonValue): string => {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }

  const entries = Object.entries(value).sort(([left], [right]) =>
    left.localeCompare(right)
  );

  return `{${entries
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
    .join(',')}}`;
};

export const sha256Hex = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

export const hashCanonicalJson = (value: JsonValue): string =>
  sha256Hex(canonicalJson(value));

export const createDuplicateKey = (input: DuplicateKeyInput): string =>
  hashCanonicalJson({
    action: input.action,
    ruleId: input.ruleId,
    targetId: input.targetId,
  });

export const createModeratorRetryKey = (
  input: ModeratorRetryKeyInput
): string =>
  hashCanonicalJson({
    action: input.action,
    moderatorUsername: input.moderatorUsername,
    ruleId: input.ruleId,
    targetId: input.targetId,
    retryBucket: getRetryBucket(input.submittedAtMs),
  });

export const getDuplicateClaimKey = (input: DuplicateKeyInput): string =>
  `duplicate:${input.targetId}:${input.action}:${input.ruleId}`;

export const getRetryClaimKey = (input: ModeratorRetryKeyInput): string =>
  `retry:${input.targetId}:${input.action}:${input.ruleId}:${
    input.moderatorUsername
  }:${getRetryBucket(input.submittedAtMs)}`;
