/**
 * Browser client bundle for dsh-universal-vision-analysis.
 *
 * Emits `lib/client.js` in the DeepSeek Harness module-loader format: a
 * closure factory handed to `window.__ModuleLoader__.load({ id, factory })`
 * with the shared platform modules left external (the loader's module table
 * provides them). Everything else the client half imports is inlined into the
 * single artifact.
 * @module dsh-universal-vision-analysis/tsdown
 */

import { defineConfig } from 'tsdown'

/** Platform seed modules the browser module table shares (must stay external). */
const PLATFORM_MODULES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
]

export default defineConfig({
  name: 'dsh-universal-vision-analysis/client',
  // Pack the tsc-emitted client half (JS at lib/client/index.js; the
  // declaration lives at lib/types/client). `clean: false` keeps the node
  // half intact.
  entry: { client: 'lib/client/index.js' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2024',
  dts: false,
  sourcemap: true,
  clean: false,
  external: PLATFORM_MODULES,
  // Anything that is NOT a platform module must be inlined — the loader
  // module table has no answer for it.
  noExternal: (id: string): boolean | undefined => (PLATFORM_MODULES.includes(id) ? undefined : true),
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
  },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: 'window.__ModuleLoader__.load({ id: "dsh-universal-vision-analysis", factory: (require) => {',
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
})
