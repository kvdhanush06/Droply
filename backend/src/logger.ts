export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * Minimal operational logger. It only ever receives event names and safe
 * operational fields (counts, durations, ids). Signaling payloads, file
 * metadata, clipboard data and message contents must never be logged.
 */
export function createLogger(level: LogLevel = 'info'): Logger {
  const threshold = LEVEL_ORDER[level];
  const emit = (lvl: LogLevel, event: string, fields?: Record<string, unknown>) => {
    if (LEVEL_ORDER[lvl] < threshold) return;
    const line = {
      ts: new Date().toISOString(),
      level: lvl,
      event,
      ...(fields ?? {}),
    };
    const out = JSON.stringify(line);
    if (lvl === 'error') process.stderr.write(`${out}\n`);
    else process.stdout.write(`${out}\n`);
  };
  return {
    debug: (event, fields) => emit('debug', event, fields),
    info: (event, fields) => emit('info', event, fields),
    warn: (event, fields) => emit('warn', event, fields),
    error: (event, fields) => emit('error', event, fields),
  };
}

/** Logger that discards everything — used by tests. */
export function createSilentLogger(): Logger {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
}
