import * as esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** @type {esbuild.BuildOptions} */
const hostOptions = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'out/extension.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
};

/** @type {esbuild.BuildOptions} */
const webviewOptions = {
  entryPoints: ['webview-ui/main.ts'],
  bundle: true,
  outfile: 'dist/webview.js',
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  sourcemap: false,
  minify: production,
  logLevel: 'info',
};

/** @type {esbuild.BuildOptions} */
const cssOptions = {
  entryPoints: ['webview-ui/style.css'],
  outfile: 'dist/style.css',
  loader: { '.css': 'css' },
  minify: production,
  logLevel: 'info',
};

async function buildAll() {
  await Promise.all([
    esbuild.build(hostOptions),
    esbuild.build(webviewOptions),
    esbuild.build(cssOptions),
  ]);
  console.log('build done');
}

if (watch) {
  const ctxHost = await esbuild.context(hostOptions);
  const ctxWeb = await esbuild.context(webviewOptions);
  const ctxCss = await esbuild.context(cssOptions);
  await Promise.all([ctxHost.watch(), ctxWeb.watch(), ctxCss.watch()]);
  console.log('watching...');
} else {
  await buildAll();
}
