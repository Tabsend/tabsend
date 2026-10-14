import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    // Several tests boot a real Fastify instance on a temp SQLite file; give
    // boot and HTTP the same room the relay's suite gets.
    testTimeout: 20000,
    hookTimeout: 20000,
  },
})
