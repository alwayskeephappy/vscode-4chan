import * as vscode from 'vscode';
import { getBoards, getCatalog, getThread } from './api';
import { Store } from './store';
import { PROVIDERS, translate, type Provider, type TranslateConfig } from './translate';
import { SettingsPanel } from './settings-panel';
import { mediaBasename, mediaContentType } from './media';
import type { Board, CatalogPage, Post } from './types';

const VIEW_ID = '4chan.browser';
const CONFIG_NS = 'vscode-4chan.translate';
const secretKey = (p: Provider) => `${CONFIG_NS}.key.${p}`;

// 原图/视频兜底代理：webview 直连 i.4cdn.org 原图若被防盗链拦截(403)，
// 改由扩展宿主用 Node fetch（不带 referer）抓取，转 base64 data URL 回传（不落盘）。
const IMG_CACHE = new Map<string, { t: number; data: string }>();
const IMG_CACHE_TTL = 30 * 60_000;
const IMG_CACHE_MAX = 40;
async function fetchImgBase64(url: string): Promise<string> {
  const hit = IMG_CACHE.get(url);
  if (hit && Date.now() - hit.t < IMG_CACHE_TTL) return hit.data;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'vscode-4chan/0.1 (+developer tool)' },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  // Some CDNs/proxies return a generic or incorrect type (occasionally application/wasm).
  // The 4chan attachment extension is authoritative and lets Chromium select its decoder.
  const ct = mediaContentType(url, res.headers.get('content-type'));
  const buf = Buffer.from(await res.arrayBuffer());
  const data = `data:${ct};base64,${buf.toString('base64')}`;
  IMG_CACHE.set(url, { t: Date.now(), data });
  if (IMG_CACHE.size > IMG_CACHE_MAX) {
    const oldest = IMG_CACHE.keys().next().value;
    if (oldest !== undefined) IMG_CACHE.delete(oldest);
  }
  return data;
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
  | { type: 'img'; url: string; data: string }
  | { type: 'imgError'; url: string; message: string };

class FourChanViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private store: Store,
    private secrets: vscode.SecretStorage,
    private globalState: vscode.Memento,
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView) {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist')],
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
            const data = await fetchImgBase64(msg.url);
            await send({ type: 'img', url: msg.url, data });
          } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            await send({ type: 'imgError', url: msg.url, message });
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
    await SettingsPanel.open(this.secrets, this.globalState);
  }

  private getHtml(webview: vscode.Webview): string {
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'style.css'));
    const nonce = getNonce();
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} https://i.4cdn.org https://s.4cdn.org https://a.4cdn.org data:`,
      `media-src ${webview.cspSource} https://i.4cdn.org data:`,
      `connect-src https://i.4cdn.org https://a.4cdn.org data:`,
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
  const provider = new FourChanViewProvider(context.extensionUri, store, context.secrets, context.globalState);

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
