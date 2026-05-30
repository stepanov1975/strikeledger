export type LogDetails = Record<
  string,
  string | number | boolean | null | undefined
>;

type LogLevel = 'info' | 'warn' | 'error';

const PREFIX = 'StrikeLedger';

const shouldSkipLogs = (): boolean =>
  typeof process !== 'undefined' && process.env.NODE_ENV === 'test';

const cleanDetails = (details: LogDetails): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(details).filter(([, value]) => value !== undefined)
  );

const writeLog = (
  level: LogLevel,
  event: string,
  details: LogDetails,
  error?: unknown
): void => {
  if (shouldSkipLogs()) {
    return;
  }

  const cleanedDetails = cleanDetails(details);
  const hasDetails = Object.keys(cleanedDetails).length > 0;
  const message = `${PREFIX} ${event}`;

  if (error !== undefined) {
    console[level](
      message,
      ...(hasDetails ? [JSON.stringify(cleanedDetails)] : []),
      error
    );
    return;
  }

  console[level](
    message,
    ...(hasDetails ? [JSON.stringify(cleanedDetails)] : [])
  );
};

export const logInfo = (event: string, details: LogDetails = {}): void => {
  writeLog('info', event, details);
};

export const logWarn = (event: string, details: LogDetails = {}): void => {
  writeLog('warn', event, details);
};

export const logError = (
  event: string,
  details: LogDetails = {},
  error?: unknown
): void => {
  writeLog('error', event, details, error);
};
