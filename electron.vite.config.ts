import { defineConfig } from 'electron-vite';
import { resolve } from 'node:path';

export default defineConfig({
  main: {
    build: {
      outDir: 'dist/main',
      lib: {
        entry: resolve('src/main/index.ts'),
        formats: ['cjs'],
        fileName: 'index'
      }
    }
  },
  preload: {
    build: {
      outDir: 'dist/preload',
      lib: {
        entry: resolve('src/main/preload.ts'),
        formats: ['cjs'],
        fileName: 'index'
      }
    }
  },
  renderer: {
    root: 'src/renderer',
    build: {
      outDir: '../../dist/renderer'
    },
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    }
  }
});
