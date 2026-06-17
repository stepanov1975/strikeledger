export const PUBLIC_PLACEHOLDERS = [
  'ruleLabel',
  'action',
  'actionEffect',
  'targetPermalink',
] as const;

export const PRIVATE_PLACEHOLDERS = [
  'subredditName',
  'ruleLabel',
  'action',
  'actionOutcome',
  'pointsAdded',
  'activeTotal',
  'targetPermalink',
] as const;

export type PublicPlaceholder = (typeof PUBLIC_PLACEHOLDERS)[number];
export type PrivatePlaceholder = (typeof PRIVATE_PLACEHOLDERS)[number];
export type Placeholder = PublicPlaceholder | PrivatePlaceholder;

const PLACEHOLDER_PATTERN = /\{([A-Za-z][A-Za-z0-9]*)\}/g;

export type TemplateValidationIssue = {
  path: string;
  message: string;
};

export type TemplateValues = Record<Placeholder, string | number>;

export const extractPlaceholders = (template: string): string[] => {
  const found = new Set<string>();
  for (const match of template.matchAll(PLACEHOLDER_PATTERN)) {
    const placeholder = match[1];
    if (placeholder) {
      found.add(placeholder);
    }
  }

  return Array.from(found);
};

export const validateTemplatePlaceholders = (
  path: string,
  template: string,
  allowedPlaceholders: readonly string[]
): TemplateValidationIssue[] => {
  const allowed = new Set(allowedPlaceholders);

  return extractPlaceholders(template)
    .filter((placeholder) => !allowed.has(placeholder))
    .map((placeholder) => ({
      path,
      message: `Unsupported placeholder {${placeholder}}.`,
    }));
};

export const renderTemplate = (
  template: string,
  values: Partial<TemplateValues>
): string =>
  template.replace(PLACEHOLDER_PATTERN, (match, rawPlaceholder: string) => {
    const placeholder = rawPlaceholder as Placeholder;
    const value = values[placeholder];

    if (value === undefined) {
      throw new Error(`Missing template value for ${match}.`);
    }

    return String(value);
  });
