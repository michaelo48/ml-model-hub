import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Integration tests make dozens of round trips to a remote Supabase
    // project; one slow one must not fail the run.
    testTimeout: 90_000,
    hookTimeout: 90_000,
    fileParallelism: false,
  },
})
