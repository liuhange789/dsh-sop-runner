/**
 * Build the two shipped faces from the same sources:
 * - lib/index.js  — host ESM plugin (core SOP logic inlined);
 * - lib/client.js — browser loader bundle (`window.__ModuleLoader__.load`),
 *   with react/react-jsx-runtime left external for the shell module table.
 */

import { build } from 'esbuild'
import { mkdir, writeFile } from 'node:fs/promises'

const PACKAGE_ID = '@liuhange/dsh-sop-runner'

await mkdir('lib', { recursive: true })

const shared = {
  bundle: true,
  logLevel: 'warning',
  minify: false,
  legalComments: 'none',
}

await build({
  ...shared,
  entryPoints: ['src/host/index.js'],
  outfile: 'lib/index.js',
  format: 'esm',
  platform: 'node',
  target: 'node20',
  external: ['@deepseek-ai/*', 'react', 'react/jsx-runtime'],
})

const client = await build({
  ...shared,
  entryPoints: ['src/client/index.jsx'],
  write: false,
  format: 'cjs',
  platform: 'browser',
  target: 'es2020',
  jsx: 'automatic',
  external: ['react', 'react/jsx-runtime'],
})

const body = client.outputFiles[0].text.trim()

const wrapped = `window.__ModuleLoader__.load({
	id: ${JSON.stringify(PACKAGE_ID)},
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
${body}
		return module.exports;
	},
});
`

await writeFile('lib/client.js', wrapped)
console.info('built: lib/index.js, lib/client.js')
