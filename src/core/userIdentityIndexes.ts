export const formNonceKey = (nonce: string): string => `form_nonce:${nonce}`;

export const viewContextKey = (token: string): string =>
  `view_context:${token}`;

export const userFormNonceIndexKey = (userKey: string): string =>
  `user:${userKey}:form_nonces`;

export const userViewContextIndexKey = (userKey: string): string =>
  `user:${userKey}:view_contexts`;
