import * as vscode from 'vscode';
import { getBoards, getCatalog, getThread } from './api';
import { Store } from './store';
import { PROVIDERS, translate, type Provider, type TranslateConfig } from './translate';
import type { Board, CatalogPage, Post } from './types';

const VIEW_ID = '4chan.browser';
const CONFIG_NS = 'vscode-4chan.translate';
const secretKey = (p: Provider) => `${CONFIG_NS}.key.${p}`;

// Webview → Host
type InMsg =
  | { type: 'init' }
  | { type: 'catalog'; board: string }
  | { type: 'thread'; board: string; no: number }
  | { type: 'toggleFav'; board: string }
  | { type: 'setSfw'; value: boolean }
  | { type: 'openExternal'; url: string }
  | { type: 'translate'; posts: { no: number; text: string }[] }
  | { type: 'openTranslateMenu' };

// Host → Webview
type OutMsg =
  | { type: 'init'; boards: Board[]; favorites: string[]; sfwOnly: boolean; lastBoard?: string }
  | { type: 'catalog'; board: string; pages: CatalogPage[] }
  | { type: 'thread'; board: string; posts: Post[] }
  | { type: 'favorites'; favorites: string[] }
  | { type: 'translated'; results: { no: number; text: string }[] }
  | { type: 'translateError'; no?: number; message: string }
  | { type: 'error'; message: string };

class FourChanViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private store: Store,
    private secrets: vscode.SecretStorage,
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
    return {
      provider,
      baseUrl: this.cfg().get<string>('aiBaseUrl') || meta.baseUrl,
      model: this.cfg().get<string>('aiModel') || meta.model,
      apiKey,
    };
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
        { label: '$(settings-gear) 高级设置（打开设置页）', action: 'advanced' },
        { label: '$(key) 设置 API Key', action: 'apikey' },
        { label: '$(beaker) 测试当前引擎', action: 'test' },
      ],
      { placeHolder: '翻译设置' },
    );
    if (!pick) return;
    if (pick.action === 'choose') await this.chooseEngine();
    else if (pick.action === 'advanced') await this.advancedSettings();
    else if (pick.action === 'apikey') await this.setApiKey();
    else if (pick.action === 'test') await this.testEngine();
  }

  private async chooseEngine() {
    const avail = await this.availableEngines();
    const current = (this.cfg().get<Provider>('provider') ?? 'free-google') as Provider;
    const items = avail.map((id) => ({
      label: PROVIDERS[id].label,
      id,
      picked: id === current,
      description: PROVIDERS[id].needsKey ? 'AI' : '免费',
    }));
    const chosen = await vscode.window.showQuickPick(items, {
      placeHolder: '选择翻译引擎（仅显示已配置的 AI）',
    });
    if (!chosen) return;
    const p = chosen.id as Provider;
    await this.cfg().update('provider', p, vscode.ConfigurationTarget.Global);
    void vscode.window.showInformationMessage(`已切换为：${PROVIDERS[p].label}`);
    // 选了需要 Key 的引擎但还没配 → 直接引导配置
    if (PROVIDERS[p].needsKey && !(await this.secrets.get(secretKey(p)))) {
      await this.setApiKey();
    }
  }

  // 打开 VSCode 原生设置页，集中配置 provider / 模型 / BaseUrl（API Key 走命令安全存储）
  private async advancedSettings() {
    await vscode.commands.executeCommand(
      'workbench.action.openSettings',
      '@ext:vscode-4chan.translate',
    );
  }

  // API Key 走 SecretStorage（不进明文 settings.json）；针对当前 provider 设置
  async setApiKey() {
    const current = (this.cfg().get<Provider>('provider') ?? 'free-google') as Provider;
    const meta = PROVIDERS[current];
    if (!meta.needsKey) {
      void vscode.window.showInformationMessage(`${meta.label} 为免费引擎，无需 API Key`);
      return;
    }
    const key = await vscode.window.showInputBox({
      prompt: `${meta.label} · API Key（清空并回车 = 清除）`,
      password: true,
      placeHolder: 'sk-...',
      ignoreFocusOut: true,
    });
    if (key === undefined) return; // Esc 取消
    if (!key.trim()) {
      await this.secrets.delete(secretKey(current));
      void vscode.window.showInformationMessage(`已清除 ${meta.label} 的 API Key`);
      return;
    }
    await this.secrets.store(secretKey(current), key.trim());
    void vscode.window.showInformationMessage(`已保存 ${meta.label} 的 API Key`);
  }

  private async testEngine() {
    const cfg = await this.buildTranslateConfig();
    const meta = PROVIDERS[cfg.provider];
    try {
      const out = await translate('Hello, this is a translation test.', cfg);
      void vscode.window.showInformationMessage(`✓ ${meta.label} 测试成功：${out}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      void vscode.window.showErrorMessage(`✗ ${meta.label} 测试失败：${msg}`);
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'style.css'));
    const nonce = getNonce();
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} https://i.4cdn.org https://s.4cdn.org https://a.4cdn.org data:`,
      `script-src 'nonce-${nonce}'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource}`,
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
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
  const provider = new FourChanViewProvider(context.extensionUri, store, context.secrets);

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

  context.subscriptions.push(
    vscode.commands.registerCommand('4chan.translate.setApiKey', () => provider.setApiKey()),
  );
}

export function deactivate() {}
