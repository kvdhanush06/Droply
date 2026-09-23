import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export interface IceServerConfig {
  urls: string[];
  username?: string;
  credential?: string;
}

export interface RateLimitConfig {
  connectionsPerMinute: number;
  roomCreatesPerMinute: number;
  roomJoinsPerMinute: number;
  messagesPerSecond: number;
}

export type NodeEnv = 'development' | 'production' | 'test';

export interface AppConfig {
  env: NodeEnv;
  port: number;
  host: string;
  allowedOrigins: string[];
  allowLocalhostOrigins: boolean;
  roomTtlMs: number;
  roomSweepIntervalMs: number;
  maxRoomPeers: number;
  maxRooms: number;
  maxConnections: number;
  maxWsMessageBytes: number;
  maxMalformedMessages: number;
  heartbeatIntervalMs: number;
  rateLimits: RateLimitConfig;
  iceServers: IceServerConfig[];
  staticDir: string;
  trustProxy: boolean;
}

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * Every environment variable is parsed through a strict runtime schema.
 * Invalid values are configuration errors and stop the process instead of
 * being silently clamped or ignored.
 */
const intSetting = (min: number, max: number) =>
  z
    .string()
    .optional()
    .transform((raw) => raw ?? '')
    .superRefine((raw, ctx) => {
      if (raw.trim() === '') return;
      const parsed = Number.parseInt(raw, 10);
      if (
        !Number.isFinite(parsed) ||
        String(parsed) !== raw.trim() ||
        parsed < min ||
        parsed > max
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `must be an integer between ${min} and ${max}, got "${raw}"`,
        });
      }
    })
    .transform((raw) => (raw.trim() === '' ? undefined : Number.parseInt(raw, 10)));

const listSetting = z
  .string()
  .optional()
  .transform((raw) =>
    (raw ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  );

const httpUrl = z
  .string()
  .refine(
    (value) => {
      try {
        const url = new URL(value);
        return (url.protocol === 'https:' || url.protocol === 'http:') && url.origin === value;
      } catch {
        return false;
      }
    },
    { message: 'must be an absolute origin, e.g. https://droply.example.com' },
  );

const stunUrl = z.string().refine((value) => /^stun:[^\s]+$/.test(value), {
  message: 'must be a stun: URL',
});

const turnUrl = z.string().refine((value) => /^turns?:[^\s]+$/.test(value), {
  message: 'must be a turn: or turns: URL',
});

const boolSetting = (name: string, fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((raw) => {
      const value = (raw ?? '').trim().toLowerCase();
      if (value === '') return fallback;
      if (value === 'true') return true;
      if (value === 'false') return false;
      throw new Error(`Environment variable ${name} must be "true" or "false", got "${raw}".`);
    });

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).optional(),
  PORT: intSetting(0, 65535),
  HOST: z.string().optional(),
  ALLOWED_ORIGINS: listSetting,
  ROOM_TTL_SECONDS: intSetting(5, 86400),
  ROOM_SWEEP_INTERVAL_MS: intSetting(1000, 600000),
  MAX_ROOM_PEERS: intSetting(2, 16),
  MAX_ROOMS: intSetting(1, 1000000),
  MAX_CONNECTIONS: intSetting(1, 100000),
  MAX_WS_MESSAGE_BYTES: intSetting(1024, 1024 * 1024),
  MAX_MALFORMED_MESSAGES: intSetting(1, 100),
  HEARTBEAT_INTERVAL_MS: intSetting(5000, 300000),
  RATE_LIMIT_CONNECTIONS_PER_MINUTE: intSetting(1, 100000),
  RATE_LIMIT_ROOM_CREATES_PER_MINUTE: intSetting(1, 100000),
  RATE_LIMIT_ROOM_JOINS_PER_MINUTE: intSetting(1, 100000),
  RATE_LIMIT_MESSAGES_PER_SECOND: intSetting(1, 10000),
  STUN_SERVERS: listSetting,
  TURN_URLS: listSetting,
  TURN_USERNAME: z.string().optional(),
  TURN_CREDENTIAL: z.string().optional(),
  STATIC_DIR: z.string().optional(),
  TRUST_PROXY: z.string().optional(),
});

function buildIceServers(
  stunUrls: string[],
  turnUrls: string[],
  username: string | undefined,
  credential: string | undefined,
  warn: (msg: string) => void,
): IceServerConfig[] {
  const servers: IceServerConfig[] = [];

  const validatedStun: string[] = [];
  for (const url of stunUrls) {
    const parsed = stunUrl.safeParse(url);
    if (!parsed.success) {
      warn(`STUN_SERVERS entry ignored: "${url}" is not a stun: URL.`);
      continue;
    }
    validatedStun.push(url);
  }
  servers.push({ urls: validatedStun.length > 0 ? validatedStun : ['stun:stun.l.google.com:19302'] });

  const validatedTurn: string[] = [];
  for (const url of turnUrls) {
    const parsed = turnUrl.safeParse(url);
    if (!parsed.success) {
      warn(`TURN_URLS entry ignored: "${url}" is not a turn:/turns: URL.`);
      continue;
    }
    validatedTurn.push(url);
  }
  if (validatedTurn.length > 0) {
    if (username && username.length > 0 && credential && credential.length > 0) {
      servers.push({ urls: validatedTurn, username, credential });
    } else {
      warn('TURN_URLS is set but TURN_USERNAME/TURN_CREDENTIAL are missing; the TURN entry was ignored.');
    }
  }
  return servers;
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  warn: (msg: string) => void = (msg) => console.warn(`[config] ${msg}`),
): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(env)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const e = parsed.data;

  // Some shells and toolchains export PORT=0 (or an empty PORT). Port 0 makes
  // the OS pick a random ephemeral port, which breaks the dev proxy and any
  // fixed-URL deployment, so treat it as "no preference" and use the default.
  const port = e.PORT === 0 ? undefined : e.PORT;
  if (e.PORT === 0) {
    warn('PORT=0 is not a usable fixed port; falling back to the default 3000.');
  }

  const nodeEnv: NodeEnv = e.NODE_ENV ?? 'development';
  const allowedOrigins: string[] = [];
  for (const origin of e.ALLOWED_ORIGINS) {
    const check = httpUrl.safeParse(origin);
    if (!check.success) {
      throw new Error(`Environment variable ALLOWED_ORIGINS contains an invalid origin: "${origin}".`);
    }
    allowedOrigins.push(origin);
  }

  return {
    env: nodeEnv,
    port: port ?? 3000,
    host: e.HOST?.trim() || '0.0.0.0',
    allowedOrigins,
    allowLocalhostOrigins: nodeEnv !== 'production',
    roomTtlMs: (e.ROOM_TTL_SECONDS ?? 1800) * 1000,
    roomSweepIntervalMs: e.ROOM_SWEEP_INTERVAL_MS ?? 15000,
    maxRoomPeers: e.MAX_ROOM_PEERS ?? 4,
    maxRooms: e.MAX_ROOMS ?? 10000,
    maxConnections: e.MAX_CONNECTIONS ?? 500,
    maxWsMessageBytes: e.MAX_WS_MESSAGE_BYTES ?? 64 * 1024,
    maxMalformedMessages: e.MAX_MALFORMED_MESSAGES ?? 5,
    heartbeatIntervalMs: e.HEARTBEAT_INTERVAL_MS ?? 30000,
    rateLimits: {
      connectionsPerMinute: e.RATE_LIMIT_CONNECTIONS_PER_MINUTE ?? 120,
      roomCreatesPerMinute: e.RATE_LIMIT_ROOM_CREATES_PER_MINUTE ?? 30,
      roomJoinsPerMinute: e.RATE_LIMIT_ROOM_JOINS_PER_MINUTE ?? 60,
      messagesPerSecond: e.RATE_LIMIT_MESSAGES_PER_SECOND ?? 30,
    },
    iceServers: buildIceServers(e.STUN_SERVERS, e.TURN_URLS, e.TURN_USERNAME, e.TURN_CREDENTIAL, warn),
    staticDir: e.STATIC_DIR?.trim() || path.resolve(moduleDir, '../../frontend/dist'),
    trustProxy: boolSetting('TRUST_PROXY', false).parse(e.TRUST_PROXY),
  };
}
