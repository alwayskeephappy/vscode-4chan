import * as vscode from 'vscode';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { getBoards, getCatalog, getThread } from './api';
import { Store } from './store';
import { PROVIDERS, translate, type Provider, type TranslateConfig } from './translate';
import { SettingsPanel } from './settings-panel';
import { mediaBasename, mediaExtension } from './media';
import type { Board, CatalogPage, Post } from './types';

const VIEW_ID = '4chan.browser';
const CONFIG_NS = 'vscode-4chan.translate';
const secretKey = (p: Provider) => `${CONFIG_NS}.key.${p}`;

// 直连失败时下载到扩展专属缓存。相比把整个视频塞进 base64 消息，本地资源 URI
// 能由 Webview 正常分段读取，也避免大消息和 data URL 带来的内存/播放问题。
const MEDIA_CACHE_MAX_BYTES = 10 * 1024 * 1024 * 1024;
const TRANSCODE_TIMEOUT_MS = 5 * 60_000;

async function trimMediaCache(cacheRoot: vscode.Uri, keep: vscode.Uri): Promise<void> {
  const entries = await vscode.workspace.fs.readDirectory(cacheRoot);
  const files = await Promise.all(entries.map(async ([name, type]) => {
    const uri = vscode.Uri.joinPath(cacheRoot, name);
    if (type !== vscode.FileType.File) return { uri, size: 0, mtime: Number.MAX_SAFE_INTEGER };
    const stat = await vscode.workspace.fs.stat(uri);
    return { uri, size: stat.size, mtime: stat.mtime };
  }));
  const candidates = files
    .filter((item) => item.mtime !== Number.MAX_SAFE_INTEGER && item.uri.toString() !== keep.toString())
    .sort((a, b) => a.mtime - b.mtime);
  let bytes = files.reduce((sum, item) => sum + item.size, 0);
  for (const item of candidates) {
    if (bytes <= MEDIA_CACHE_MAX_BYTES) break;
    await vscode.workspace.fs.delete(item.uri);
    bytes -= item.size;
  }
}

async function fetchMediaFile(url: string, cacheRoot: vscode.Uri): Promise<vscode.Uri> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'i.4cdn.org') {
    throw new Error('不允许的媒体来源');
  }
  const ext = mediaExtension(url) || 'bin';
  const key = createHash('sha256').update(url).digest('hex');
  const file = vscode.Uri.joinPath(cacheRoot, `${key}.${ext}`);
  try {
    const stat = await vscode.workspace.fs.stat(file);
    if (stat.size > 0) return file;
    await vscode.workspace.fs.delete(file);
  } catch {
    // Cache miss.
  }
  const res = await fetch(url, {
    headers: { 'User-Agent': 'vscode-4chan/0.1 (+developer tool)' },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  await vscode.workspace.fs.createDirectory(cacheRoot);
  const partial = vscode.Uri.joinPath(cacheRoot, `${key}.download`);
  try { await vscode.workspace.fs.delete(partial); } catch { /* Missing partial download. */ }
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength === 0) throw new Error('服务器返回了空媒体文件');
  await vscode.workspace.fs.writeFile(partial, bytes);
  await vscode.workspace.fs.rename(partial, file, { overwrite: true });

  await trimMediaCache(cacheRoot, file);
  return file;
}

const pendingTranscodes = new Map<string, Promise<vscode.Uri>>();
function transcodeMedia(url: string, input: vscode.Uri, cacheRoot: vscode.Uri, ffmpegPath: string): Promise<vscode.Uri> {
  const existing = pendingTranscodes.get(url);
  if (existing) return existing;
  const job = (async () => {
    if (process.platform !== 'win32') throw new Error('内置转码器仅支持 Windows');
    const key = createHash('sha256').update(url).digest('hex');
    const output = vscode.Uri.joinPath(cacheRoot, `${key}.compat.ts`);
    try {
      await vscode.workspace.fs.stat(output);
      return output;
    } catch {
      // Cache miss.
    }
    // globalStorageUri 在桌面版 VS Code 中可能使用 vscode-userdata: scheme，
    // 但 fsPath 仍是可供内置 FFmpeg 访问的受控本地路径。
    if (!input.fsPath || !output.fsPath) throw new Error('无法解析媒体缓存的本地路径');
    const partial = vscode.Uri.joinPath(cacheRoot, `${key}.compat.part.ts`);
    try { await vscode.workspace.fs.delete(partial); } catch { /* Missing partial output. */ }
    await new Promise<void>((resolve, reject) => {
      const args = [
        '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', input.fsPath,
        '-map', '0:v:0', '-map', '0:a?',
        '-vf', "scale=w='if(gt(iw,ih),min(iw,960),-2)':h='if(gt(iw,ih),-2,min(ih,960))',fps=30",
        '-c:v', 'mpeg1video', '-b:v', '2500k', '-maxrate', '3000k', '-bufsize', '5000k', '-bf', '0',
        '-c:a', 'mp2', '-b:a', '128k', '-ar', '44100', '-ac', '2', '-f', 'mpegts', partial.fsPath,
      ];
      const child = spawn(ffmpegPath, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-8192);
      });
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error('转码超时（5 分钟）'));
      }, TRANSCODE_TIMEOUT_MS);
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(new Error(`无法启动内置 FFmpeg：${error.message}`));
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`FFmpeg 转码失败（退出码 ${code ?? '未知'}）：${stderr.trim() || '无详细信息'}`));
      });
    });
    await vscode.workspace.fs.rename(partial, output, { overwrite: true });
    await trimMediaCache(cacheRoot, output);
    return output;
  })().finally(() => pendingTranscodes.delete(url));
  pendingTranscodes.set(url, job);
  return job;
}

// Webview → Host
type InMsg =
  | { type: 'init' }
  | { type: 'catalog'; board: string }
  | { type: 'thread'; board: string; no: number }
  | { type: 'toggleFav'; board: string }
  | { type: 'setSfw'; value: boolean }
  | { type: 'openExternal'; url: string }
  | { type: 'translate'; posts: { no: number; text: string }[] }
  | { type: 'openTranslateMenu' }
  | { type: 'img'; url: string }
  | { type: 'transcodeMedia'; url: string }
  | { type: 'downloadFile'; url: string; filename?: string };

// Host → Webview
type OutMsg =
  | { type: 'init'; boards: Board[]; favorites: string[]; sfwOnly: boolean; lastBoard?: string }
  | { type: 'catalog'; board: string; pages: CatalogPage[] }
  | { type: 'thread'; board: string; posts: Post[] }
  | { type: 'favorites'; favorites: string[] }
  | { type: 'translated'; results: { no: number; text: string }[] }
  | { type: 'translateError'; no?: number; message: string }
  | { type: 'error'; message: string }
  | { type: 'img'; url: string; src: string }
  | { type: 'transcodedMedia'; url: string; src: string }
  | { type: 'transcodeError'; url: string; message: string }
  | { type: 'imgError'; url: string; message: string };

class FourChanViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private readonly mediaCacheUri: vscode.Uri;
  private readonly ffmpegPath: string;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private store: Store,
    private secrets: vscode.SecretStorage,
    private globalState: vscode.Memento,
    globalStorageUri: vscode.Uri,
  ) {
    // globalStorageUri may use vscode-userdata:, which workspace.fs can access but the
    // Webview media loader cannot reliably stream. On desktop Windows its fsPath is the
    // real extension-owned directory, so normalize it to file: for FFmpeg and range reads.
    this.mediaCacheUri = vscode.Uri.file(vscode.Uri.joinPath(globalStorageUri, 'media-cache').fsPath);
    this.ffmpegPath = vscode.Uri.joinPath(extensionUri, 'dist', 'ffmpeg', 'ffmpeg.exe').fsPath;
  }

  resolveWebviewView(webviewView: vscode.WebviewView) {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist'), this.mediaCacheUri],
    };
    webviewView.webview.html = this.getHtml(webviewView.webview);
    webviewView.webview.onDidReceiveMessage((msg: InMsg) => this.onMessage(msg));
  }

  private async onMessage(msg: InMsg) {
    const view = this.view;
    if (!view) return;
    const send = (m: OutMsg) => view.webview.postMessage(m);
    try {
      switch (msg.type) {
        case 'init':
          await send({
            type: 'init',
            boards: await getBoards(),
            favorites: this.store.getFavorites(),
            sfwOnly: this.store.getSfwOnly(),
            lastBoard: this.store.getLastBoard(),
          });
          break;
        case 'catalog':
          this.store.setLastBoard(msg.board);
          await send({ type: 'catalog', board: msg.board, pages: await getCatalog(msg.board) });
          break;
        case 'thread':
          await send({ type: 'thread', board: msg.board, posts: await getThread(msg.board, msg.no) });
          break;
        case 'toggleFav':
          await send({ type: 'favorites', favorites: this.store.toggleFavorite(msg.board) });
          break;
        case 'setSfw':
          this.store.setSfwOnly(msg.value);
          break;
        case 'openExternal':
          await vscode.env.openExternal(vscode.Uri.parse(msg.url));
          break;
        case 'translate':
          await this.handleTranslate(msg.posts, send);
          break;
        case 'openTranslateMenu':
          await this.openTranslateMenu();
          break;
        case 'img':
          try {
            const file = await fetchMediaFile(msg.url, this.mediaCacheUri);
            const src = view.webview.asWebviewUri(file).toString();
            await send({ type: 'img', url: msg.url, src });
          } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            await send({ type: 'imgError', url: msg.url, message });
          }
          break;
        case 'transcodeMedia':
          try {
            const input = await fetchMediaFile(msg.url, this.mediaCacheUri);
            const output = await transcodeMedia(msg.url, input, this.mediaCacheUri, this.ffmpegPath);
            // JSMpeg reads this URI as bytes through Ajax; it does not use Chromium's
            // native media decoder, so the local resource endpoint is safe here.
            const src = view.webview.asWebviewUri(output).toString();
            await send({ type: 'transcodedMedia', url: msg.url, src });
          } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            await send({ type: 'transcodeError', url: msg.url, message });
          }
          break;
        case 'downloadFile': {
          try {
            const res = await fetch(msg.url, {
              headers: { 'User-Agent': 'vscode-4chan/0.1 (+developer tool)' },
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const buf = Buffer.from(await res.arrayBuffer());
            const fn = msg.filename || mediaBasename(msg.url);
            const uri = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(fn) });
            if (uri) await vscode.workspace.fs.writeFile(uri, buf);
          } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            await vscode.window.showErrorMessage(`下载失败: ${message}`);
          }
          break;
        }
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await send({ type: 'error', message });
    }
  }

  private async handleTranslate(
    posts: { no: number; text: string }[],
    send: (m: OutMsg) => Thenable<boolean>,
  ) {
    const cfg = await this.buildTranslateConfig();
    const ok: { no: number; text: string }[] = [];
    for (const p of posts) {
      try {
        const zh = await translate(p.text, cfg);
        ok.push({ no: p.no, text: zh });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        await send({ type: 'translateError', no: p.no, message });
      }
    }
    if (ok.length) await send({ type: 'translated', results: ok });
  }

  private cfg() {
    return vscode.workspace.getConfiguration(CONFIG_NS);
  }

  private async buildTranslateConfig(): Promise<TranslateConfig> {
    const provider = (this.cfg().get<Provider>('provider') ?? 'free-google') as Provider;
    const meta = PROVIDERS[provider];
    const apiKey = meta.needsKey ? (await this.secrets.get(secretKey(provider))) ?? '' : '';
    const model = this.globalState.get<string>(`model.${provider}`) || meta.model;
    return { provider, baseUrl: meta.baseUrl, model, apiKey };
  }

  // 可选引擎 = 免费(Google/MyMemory) + 已配置 Key 的 AI
  private async availableEngines(): Promise<Provider[]> {
    const list: Provider[] = ['free-google', 'free-mymemory'];
    for (const p of Object.keys(PROVIDERS) as Provider[]) {
      if (!PROVIDERS[p].needsKey) continue;
      if (await this.secrets.get(secretKey(p))) list.push(p);
    }
    return list;
  }

  async openTranslateMenu() {
    const current = (this.cfg().get<Provider>('provider') ?? 'free-google') as Provider;
    const pick = await vscode.window.showQuickPick(
      [
        { label: '$(checklist) 选择翻译引擎', action: 'choose', description: PROVIDERS[current]?.label },
        { label: '$(settings-gear) 高级设置（配置 AI 模型）', action: 'advanced' },
      ],
      { placeHolder: '翻译设置' },
    );
    if (!pick) return;
    if (pick.action === 'choose') await this.chooseEngine();
    else if (pick.action === 'advanced') await this.advancedSettings();
  }

  private async chooseEngine() {
    const avail = await this.availableEngines();
    const current = (this.cfg().get<Provider>('provider') ?? 'free-google') as Provider;
    const items = avail.map((id) => {
      const isCurrent = id === current;
      return {
        label: (isCurrent ? '$(check)  ' : '') + PROVIDERS[id].label,
        id,
        description: isCurrent ? '当前使用' : PROVIDERS[id].needsKey ? 'AI' : '免费',
      };
    });
    // 用 createQuickPick 才能把焦点定位到当前引擎，避免默认聚焦首项 Google 造成误判
    const qp = vscode.window.createQuickPick();
    qp.items = items;
    qp.placeholder = '选择翻译引擎（仅显示已配置的 AI）';
    const currentIdx = avail.indexOf(current);
    const chosen = await new Promise<typeof items[number] | undefined>((resolve) => {
      if (currentIdx >= 0) qp.activeItems = [items[currentIdx]];
      qp.onDidAccept(() => resolve(qp.activeItems[0] as typeof items[number] | undefined));
      qp.onDidHide(() => resolve(undefined));
      qp.show();
    });
    qp.dispose();
    if (!chosen) return;
    const p = chosen.id as Provider;
    await this.cfg().update('provider', p, vscode.ConfigurationTarget.Global);
    void vscode.window.showInformationMessage(`已切换为：${PROVIDERS[p].label}`);
    // 选了需要 Key 的引擎但还没配 → 打开高级设置
    if (PROVIDERS[p].needsKey && !(await this.secrets.get(secretKey(p)))) {
      await this.advancedSettings();
    }
  }

  // 打开自定义高级设置面板（单列配置各 AI 引擎的 API Key）
  private async advancedSettings() {
    await SettingsPanel.open(this.secrets, this.globalState, this.mediaCacheUri, MEDIA_CACHE_MAX_BYTES);
  }

  private getHtml(webview: vscode.Webview): string {
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview.js'));
    const jsmpeg = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'jsmpeg.min.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'style.css'));
    const nonce = getNonce();
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} https://i.4cdn.org https://s.4cdn.org https://a.4cdn.org data:`,
      `media-src ${webview.cspSource} https://i.4cdn.org data: blob:`,
      `connect-src ${webview.cspSource} https://i.4cdn.org https://a.4cdn.org data: blob:`,
      `script-src 'nonce-${nonce}'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource}`,
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <!-- i.4cdn.org 防盗链：完整原图请求带 vscode-webview referer 会返回 403，必须 no-referrer -->
  <meta name="referrer" content="no-referrer" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>4chan</title>
  <link rel="stylesheet" href="${style}" />
</head>
<body>
  <div id="app"></div>
  <script nonce="${nonce}" src="${jsmpeg}"></script>
  <script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let s = '';
  for (let i = 0; i < 32; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

export function activate(context: vscode.ExtensionContext) {
  const store = new Store(context.globalState);
  const provider = new FourChanViewProvider(
    context.extensionUri,
    store,
    context.secrets,
    context.globalState,
    context.globalStorageUri,
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(VIEW_ID, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('4chan.openBrowser', () => {
      vscode.commands.executeCommand(`${VIEW_ID}.focus`);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('4chan.translate.menu', () => provider.openTranslateMenu()),
  );
}

export function deactivate() {}
