import { describe, expect, it } from 'vitest';
import {
  PUBLIC_PLACEHOLDERS,
  extractPlaceholders,
  renderTemplate,
  validateTemplatePlaceholders,
} from './templates';

describe('template utilities', () => {
  it('extracts unique placeholders in first-seen order', () => {
    expect(
      extractPlaceholders('{ruleLabel} {action} {ruleLabel} {targetPermalink}')
    ).toEqual(['ruleLabel', 'action', 'targetPermalink']);
  });

  it('rejects private placeholders in public templates', () => {
    expect(
      validateTemplatePlaceholders(
        'defaultPublicCommentTemplate',
        'Rule {ruleLabel}; total {activeTotal}',
        PUBLIC_PLACEHOLDERS
      )
    ).toEqual([
      {
        path: 'defaultPublicCommentTemplate',
        message: 'Unsupported placeholder {activeTotal}.',
      },
    ]);
  });

  it('renders placeholders with provided values', () => {
    expect(
      renderTemplate('Moderator notice: {ruleLabel} via {action}.', {
        ruleLabel: 'Spam',
        action: 'Warn',
      })
    ).toBe('Moderator notice: Spam via Warn.');
  });

  it('throws when a render value is missing', () => {
    expect(() => renderTemplate('Missing {ruleLabel}', {})).toThrow(
      'Missing template value for {ruleLabel}.'
    );
  });
});
