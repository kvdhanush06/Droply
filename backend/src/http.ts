import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { pipeline } from 'node:stream/promises';
import type { AppConfig } from './config.js';
import type { Logger } from './logger.js';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

/** Cache-busted Vite assets live under /assets and may be cached forever. */
const IMMUTABLE_PREFIX = '/assets/';

function setSecurityHeaders(res: http.ServerResponse): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "worker-src 'self' blob:",
      "connect-src 'self' ws: wss:",
      "font-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; '),
  );
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

export function createHttpServer(
  config: AppConfig,
  logger: Logger,
  getStats: () => { rooms: number; connections: number },
): http.Server {
  const root = path.resolve(config.staticDir);

  const server = http.createServer((req, res) => {
    void handleRequest(req, res).catch((err) => {
      logger.error('http_error', { message: err instanceof Error ? err.message : 'unknown' });
      if (!res.headersSent) {
        setSecurityHeaders(res);
        sendJson(res, 500, { error: 'Internal server error' });
      } else {
        res.destroy();
      }
    });
  });

  async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    setSecurityHeaders(res);
    const method = req.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD') {
      sendJson(res, 405, { error: 'Method not allowed' });
      return;
    }

    let pathname: string;
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    } catch {
      sendJson(res, 400, { error: 'Bad request' });
      return;
    }

    if (pathname === '/health') {
      const stats = getStats();
      sendJson(res, 200, { status: 'ok', rooms: stats.rooms, connections: stats.connections });
      return;
    }

    if (pathname === '/api/config') {
      sendJson(res, 200, {
        iceServers: config.iceServers,
        maxRoomPeers: config.maxRoomPeers,
        roomTtlSeconds: Math.round(config.roomTtlMs / 1000),
      });
      return;
    }

    if (pathname.startsWith('/api/')) {
      sendJson(res, 404, { error: 'Not found' });
      return;
    }

    await serveStatic(pathname, method === 'HEAD', res);
  }

  async function serveStatic(pathname: string, headOnly: boolean, res: http.ServerResponse): Promise<void> {
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      sendJson(res, 400, { error: 'Bad request' });
      return;
    }

    // Normalize and confine to the static root (path traversal protection).
    const resolved = path.resolve(root, `.${decoded}`);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      sendJson(res, 403, { error: 'Forbidden' });
      return;
    }

    let filePath = resolved;
    let stat: fs.Stats | null = null;
    try {
      stat = await fs.promises.stat(filePath);
    } catch {
      stat = null;
    }

    if (stat?.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
      try {
        stat = await fs.promises.stat(filePath);
      } catch {
        stat = null;
      }
    }

    if (!stat || !stat.isFile()) {
      // SPA fallback: client-side routes serve index.html.
      const hasExtension = path.extname(decoded) !== '';
      if (!hasExtension) {
        const indexPath = path.join(root, 'index.html');
        try {
          const indexStat = await fs.promises.stat(indexPath);
          await streamFile(indexPath, indexStat, headOnly, res, 'no-cache');
          return;
        } catch {
          sendJson(res, 404, { error: 'Not found' });
          return;
        }
      }
      sendJson(res, 404, { error: 'Not found' });
      return;
    }

    const cacheControl = decoded.startsWith(IMMUTABLE_PREFIX)
      ? 'public, max-age=31536000, immutable'
      : path.basename(filePath) === 'index.html'
        ? 'no-cache'
        : 'public, max-age=3600';
    await streamFile(filePath, stat, headOnly, res, cacheControl);
  }

  async function streamFile(
    filePath: string,
    stat: fs.Stats,
    headOnly: boolean,
    res: http.ServerResponse,
    cacheControl: string,
  ): Promise<void> {
    const type = MIME_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': stat.size,
      'Cache-Control': cacheControl,
    });
    if (headOnly) {
      res.end();
      return;
    }
    await pipeline(fs.createReadStream(filePath), res);
  }

  return server;
}
