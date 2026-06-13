import { createHash } from 'node:crypto';

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }

  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([left], [right]) => left.localeCompare(right)
    );
    return Object.fromEntries(
      entries.map(([key, entryValue]) => [key, canonicalize(entryValue)])
    );
  }

  return value;
};

export const canonicalJson = (value: unknown): string =>
  JSON.stringify(canonicalize(value)) ?? 'undefined';

export const sha256Hex = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

export const hashCanonicalJson = (value: unknown): string =>
  sha256Hex(canonicalJson(value));
