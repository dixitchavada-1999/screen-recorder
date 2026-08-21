import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/**
 * electron-vite builds three independent bundles:
 *  - main     -> out/main/index.js      (Node/CommonJS, runs in the Electron main process)
 *  - preload  -> out/preload/index.js   (CommonJS, sandboxed context bridge)
 *  - renderer -> out/renderer/*         (ESM, runs in Chromium)
 *
 * `externalizeDepsPlugin` keeps runtime dependencies (ffmpeg-static, fluent-ffmpeg)
 * out of the main bundle so electron-builder can ship them unpacked from the asar.
 */
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'electron/main/index.ts') },
        output: { format: 'cjs', entryFileNames: '[name].js' }
      }
    },
    resolve: {
      alias: { '@shared': resolve(__dirname, 'shared') }
    }
  },

  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'electron/preload/index.ts') },
        output: { format: 'cjs', entryFileNames: '[name].js' }
      }
    },
    resolve: {
      alias: { '@shared': resolve(__dirname, 'shared') }
    }
  },

  renderer: {
    root: '.',
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src'),
        '@shared': resolve(__dirname, 'shared')
      }
    },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'index.html') }
      }
    }
  }
})
