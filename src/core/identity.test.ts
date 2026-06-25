import { describe, expect, it } from 'vitest';
import {
  getTargetAuthorUserKey,
  getUserKey,
  normalizeUsername,
} from './identity';

describe('identity helpers', () => {
  it('uses Reddit user IDs and rejects username-only identities', () => {
    expect(normalizeUsername(' u/Alex ')).toBe('alex');
  });

  it('prefers user ID when available', () => {
    expect(getUserKey({ userId: ' t2_abc ', username: 'SomeUser' })).toBe(
      'id:t2_abc'
    );
  });

  it('rejects non-Reddit-user IDs', () => {
    expect(getUserKey({ userId: 'abc', username: 'SomeUser' })).toBeNull();
    expect(getUserKey({ userId: 't3_post', username: 'SomeUser' })).toBeNull();
    expect(
      getTargetAuthorUserKey({
        userKey: 'id:abc',
        authorId: 'abc',
      })
    ).toBeNull();
  });

  it('does not create durable user keys from usernames', () => {
    expect(getUserKey({ username: 'u/SomeUser' })).toBeNull();
  });

  it('blocks deleted, unknown, or missing users without a user ID', () => {
    expect(getUserKey({ username: '[deleted]' })).toBeNull();
    expect(getUserKey({ username: '[unknown]' })).toBeNull();
    expect(getUserKey({})).toBeNull();
  });

  it('requires target-author IDs from nonce snapshots', () => {
    expect(getTargetAuthorUserKey({ authorName: 'u/SomeUser' })).toBeNull();
    expect(
      getTargetAuthorUserKey({
        userKey: 'name:existing',
        authorName: 'u/SomeUser',
      })
    ).toBeNull();
    expect(
      getTargetAuthorUserKey({
        authorId: 't2_user',
        authorName: 'u/SomeUser',
      })
    ).toBe('id:t2_user');
  });
});
