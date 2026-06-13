import {
  canonicalJson,
  hashCanonicalJson,
  sha256Hex,
} from './canonicalJson';
import type { StrikeAction } from './domain';

export const RETRY_WINDOW_MS = 10 * 60 * 1000;

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
export { canonicalJson, hashCanonicalJson, sha256Hex };

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
