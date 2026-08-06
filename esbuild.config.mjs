import * as esbuild from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

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
  await Promise.all([
    copyFile(path.join('webview-ui', 'jsmpeg.min.js'), path.join('dist', 'jsmpeg.min.js')),
    copyFile(path.join('webview-ui', 'JSMPEG-LICENSE.txt'), path.join('dist', 'JSMPEG-LICENSE.txt')),
  ]);
  if (production) {
    const ffmpegPath = require('ffmpeg-static');
    const ffmpegPackageDir = path.dirname(require.resolve('ffmpeg-static/package.json'));
    const targetDir = path.join('dist', 'ffmpeg');
    await mkdir(targetDir, { recursive: true });
    await Promise.all([
      copyFile(ffmpegPath, path.join(targetDir, 'ffmpeg.exe')),
      copyFile(path.join(ffmpegPackageDir, 'ffmpeg.exe.LICENSE'), path.join(targetDir, 'LICENSE.txt')),
      copyFile(path.join(ffmpegPackageDir, 'ffmpeg.exe.README'), path.join(targetDir, 'README.txt')),
    ]);
  }
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
