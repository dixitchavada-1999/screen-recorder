import { existsSync, readFileSync } from 'node:fs'
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
/**
 * The uninstall password's hash, written by `npm run uninstall-password`. Only
 * the hash is built in; without the file the uninstaller asks for nothing.
 */
function uninstallPassword(): { salt: string; hash: string } {
  const file = resolve(__dirname, 'build/uninstall-password.json')
  if (!existsSync(file)) return { salt: '', hash: '' }
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as { salt?: string; hash?: string }
  return { salt: parsed.salt ?? '', hash: parsed.hash ?? '' }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    define: {
      __UNINSTALL_PASSWORD__: JSON.stringify(uninstallPassword())
    },
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
        input: {
          index: resolve(__dirname, 'electron/preload/index.ts'),
          floating: resolve(__dirname, 'electron/preload/floating.ts')
        },
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
    // The root is the whole project, so without this the dev server watches
    // `release/` too — thousands of packaged files, and a crash when one of
    // them is deleted mid-watch.
    server: {
      watch: { ignored: ['**/release/**'] }
    },
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
