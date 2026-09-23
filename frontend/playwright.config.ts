import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test/e2e',
  timeout: 120_000,
  retries: 0,
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:8091',
    headless: true,
  },
  webServer: {
    command: 'node ../backend/dist/server.js',
    url: 'http://127.0.0.1:8091/health',
    env: { PORT: '8091', NODE_ENV: 'production' },
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
