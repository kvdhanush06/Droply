import type { Server } from 'node:http';
import { pathToFileURL } from 'node:url';
import { loadConfig, type AppConfig } from './config.js';
import { createLogger, type Logger } from './logger.js';
import { RoomManager } from './rooms.js';
import { SignalingServer } from './signaling.js';
import { createHttpServer } from './http.js';

export interface DroplyServer {
  httpServer: Server;
  rooms: RoomManager;
  signaling: SignalingServer;
  close: () => Promise<void>;
}

export function createDroplyServer(config: AppConfig, logger: Logger): DroplyServer {
  const rooms = new RoomManager({
    ttlMs: config.roomTtlMs,
    maxRoomPeers: config.maxRoomPeers,
    maxRooms: config.maxRooms,
    sweepIntervalMs: config.roomSweepIntervalMs,
    logger,
  });

  const signaling = new SignalingServer({ config, rooms, logger });
  const httpServer = createHttpServer(config, logger, () => ({
    rooms: rooms.size,
    connections: signaling.connectionCount,
  }));

  httpServer.on('upgrade', (req, socket, head) => {
    signaling.handleUpgrade(req, socket, head);
  });

  const close = () =>
    new Promise<void>((resolve) => {
      signaling.close();
      rooms.dispose();
      httpServer.close(() => resolve());
      // close() only fires once open sockets drain; don't hang forever.
      setTimeout(() => resolve(), 250).unref();
    });

  return { httpServer, rooms, signaling, close };
}

/* istanbul ignore next -- process entry point */
function main(): void {
  const logger = createLogger(process.env.LOG_LEVEL === 'debug' ? 'debug' : 'info');
  const config = loadConfig(process.env, (msg) => logger.warn('config_warning', { message: msg }));
  const { httpServer, close } = createDroplyServer(config, logger);

  httpServer.listen(config.port, config.host, () => {
    logger.info('server_started', { port: config.port, host: config.host, env: config.env });
  });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('server_shutdown', { signal });
    void close().then(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === invokedPath) {
  main();
}
