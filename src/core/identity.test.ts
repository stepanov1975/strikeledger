import { describe, expect, it } from 'vitest';
import { getUserKey, normalizeUsername } from './identity';

describe('identity helpers', () => {
  it('normalizes fallback usernames', () => {
    expect(normalizeUsername(' u/Alex ')).toBe('alex');
  });

  it('prefers user ID when available', () => {
    expect(getUserKey({ userId: ' t2_abc ', username: 'SomeUser' })).toBe(
      'id:t2_abc'
    );
  });

  it('falls back to normalized username', () => {
    expect(getUserKey({ username: 'u/SomeUser' })).toBe('name:someuser');
  });

  it('blocks deleted or missing usernames without a user ID', () => {
    expect(getUserKey({ username: '[deleted]' })).toBeNull();
    expect(getUserKey({})).toBeNull();
  });
});
