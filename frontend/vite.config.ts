import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

/**
 * Backend port for the dev proxy. Resolution order:
 *   BACKEND_PORT -> PORT -> 3000. Port 0 (exported by some shells) is not a
 * usable fixed port, so it falls through to the default.
 */
const rawPort = process.env.BACKEND_PORT ?? process.env.PORT ?? '3000';
const backendPort = Number.parseInt(rawPort, 10);
const port = Number.isFinite(backendPort) && backendPort > 0 && backendPort <= 65535 ? backendPort : 3000;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5000,
    // 0.0.0.0 serves BOTH http://127.0.0.1:5000 (this PC) and
    // http://<PC-LAN-IP>:5000 (phone on the same hotspot) from one listener.
    // Binding to 127.0.0.1 alone would make the phone unable to connect, since
    // its traffic arrives addressed to the PC's LAN IP, not loopback.
    host: true,
    strictPort: true,
    proxy: {
      '/api': { target: `http://127.0.0.1:${port}`, changeOrigin: false },
      '/health': { target: `http://127.0.0.1:${port}`, changeOrigin: false },
      '/ws': { target: `ws://127.0.0.1:${port}`, ws: true },
    },
  },
  build: {
    target: 'es2020',
    sourcemap: true,
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./test/setup.ts'],
    css: false,
    include: ['test/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['test/e2e/**', 'node_modules/**', 'dist/**'],
  },
});
