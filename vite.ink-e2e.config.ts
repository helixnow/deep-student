import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

/**
 * Builds only the dedicated native Ink E2E client. The entry imports the
 * production render bridge and the shared board renderer; it never duplicates
 * the renderer or embeds a pre-rendered PNG.
 */
export default defineConfig({
  root: path.resolve(projectRoot, 'tests/e2e/ink-board-render'),
  base: './',
  publicDir: false,
  resolve: {
    alias: {
      '@': path.resolve(projectRoot, 'src'),
    },
  },
  build: {
    target: 'esnext',
    sourcemap: true,
    emptyOutDir: true,
    outDir: path.resolve(projectRoot, 'src-tauri/target/ink-e2e-client'),
    rollupOptions: {
      input: path.resolve(projectRoot, 'tests/e2e/ink-board-render/index.html'),
    },
  },
});
