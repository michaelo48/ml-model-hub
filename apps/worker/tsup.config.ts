import { defineConfig } from 'tsup'

/**
 * Two entries: the process (index) and the training thread. @modelforge/ml is
 * a source-only workspace package, so it is bundled in; runtime deps stay
 * external and come from node_modules.
 */
export default defineConfig({
  entry: { index: 'src/index.ts', 'train-thread': 'src/train-thread.ts' },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  splitting: true,
  noExternal: ['@modelforge/ml'],
})
