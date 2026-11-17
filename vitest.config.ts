import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    env: { NODE_ENV: 'test', AI_MOCK_MODE: 'false', WORKER_ENABLED: 'false' },
  },
});
