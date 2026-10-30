import { fileURLToPath } from 'node:url'
import type { UserConfig } from 'tsdown'

const PLUGIN_ID = "@dsh-external/session-timeline"

const CLIENT_EXTERNALS = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
  'cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-runtime/client',
]

const clientBundle: UserConfig = {
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  dts: false,
  sourcemap: true,
  clean: false,
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
  },
  deps: {
    neverBundle: [...CLIENT_EXTERNALS],
    alwaysBundle: (id: string) => !CLIENT_EXTERNALS.includes(id),
  },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: 'window.__ModuleLoader__.load({ id: ' + JSON.stringify(PLUGIN_ID) + ', factory: (require) => {',
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    codeSplitting: false,
  },
}

/* Dictionaries as a standalone ESM module (lib/locales.js): the client bundle
 * inlines them through its own import, while node:test imports this artifact to
 * verify key/placeholder parity across the eight languages. ESM because the
 * package is "type": "module" (a CJS artifact would be misread as ESM). */
const localesBundle: UserConfig = {
  entry: { locales: 'src/client/locales.ts' },
  outDir: 'lib',
  format: 'esm',
  platform: 'neutral',
  dts: false,
  sourcemap: false,
  clean: false,
  outputOptions: {
    entryFileNames: 'locales.js',
    codeSplitting: false,
  },
}

export default [clientBundle, localesBundle] satisfies UserConfig[]
