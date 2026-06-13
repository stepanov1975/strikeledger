import { Hono } from 'hono';
import {
  PRIVATE_PLACEHOLDERS,
  PUBLIC_PLACEHOLDERS,
  validateTemplatePlaceholders,
} from '../core/templates';
import {
  MAX_NATIVE_DECAY_INTERVAL_DAYS,
  MAX_NATIVE_TEMPLATE_BYTES,
} from '../core/nativeSettings';

type SettingsValidationRequest = {
  value?: unknown;
  isEditing?: boolean;
};

type SettingsValidationResponse =
  | { success: true }
  | { success: false; error: string };

export const settingsValidators = new Hono();

const utf8ByteLength = (value: string): number =>
  new TextEncoder().encode(value).byteLength;

const validateInteger = (
  value: unknown,
  min: number,
  max: number,
  label: string
): SettingsValidationResponse => {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return { success: false, error: `${label} must be an integer.` };
  }

  if (value < min || value > max) {
    return {
      success: false,
      error: `${label} must be from ${min} to ${max}.`,
    };
  }

  return { success: true };
};

const validateTemplate = (
  value: unknown,
  allowedPlaceholders: readonly string[]
): SettingsValidationResponse => {
  if (typeof value !== 'string' || !value.trim()) {
    return { success: false, error: 'Template is required.' };
  }

  if (value.length > 2000) {
    return {
      success: false,
      error: 'Template must be 2000 characters or fewer.',
    };
  }

  if (utf8ByteLength(value) > MAX_NATIVE_TEMPLATE_BYTES) {
    return {
      success: false,
      error: `Template must be ${MAX_NATIVE_TEMPLATE_BYTES} bytes or fewer.`,
    };
  }

  const [issue] = validateTemplatePlaceholders(
    'template',
    value,
    allowedPlaceholders
  );
  if (issue) {
    return { success: false, error: issue.message };
  }

  return { success: true };
};

settingsValidators.post('/validate-points', async (c) => {
  const input = await c.req.json<SettingsValidationRequest>();
  return c.json(validateInteger(input.value, 0, 100, 'Point value'));
});

settingsValidators.post('/validate-decay-amount', async (c) => {
  const input = await c.req.json<SettingsValidationRequest>();
  return c.json(validateInteger(input.value, 1, 100, 'Decay amount'));
});

settingsValidators.post('/validate-days', async (c) => {
  const input = await c.req.json<SettingsValidationRequest>();
  return c.json(
    validateInteger(input.value, 1, MAX_NATIVE_DECAY_INTERVAL_DAYS, 'Day value')
  );
});

settingsValidators.post('/validate-public-template', async (c) => {
  const input = await c.req.json<SettingsValidationRequest>();
  return c.json(validateTemplate(input.value, PUBLIC_PLACEHOLDERS));
});

settingsValidators.post('/validate-private-template', async (c) => {
  const input = await c.req.json<SettingsValidationRequest>();
  return c.json(validateTemplate(input.value, PRIVATE_PLACEHOLDERS));
});
