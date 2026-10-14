import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    // Each integration test file boots a real server on a temp SQLite DB; keep
    // them serial-friendly and give boot/HTTP room.
    testTimeout: 20000,
    hookTimeout: 20000,
  },
})
