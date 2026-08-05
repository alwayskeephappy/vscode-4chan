import * as vscode from 'vscode';
import { PROVIDERS, type Provider } from './translate';

const CONFIG_NS = 'vscode-4chan.translate';
const secretKey = (p: Provider) => `${CONFIG_NS}.key.${p}`;
// 面板里展示的 AI 引擎（固定 4 个）
const AI_PROVIDERS: Provider[] = ['deepseek', 'glm', 'openai', 'qwen'];

interface ItemState {
  provider: Provider;
  label: string;
  configured: boolean;
  link?: string;
}

type PanelMsg =
  | { type: 'save'; provider: Provider; key: string }
  | { type: 'clear'; provider: Provider }
  | { type: 'openLink'; url: string };

/**
 * 高级设置 Webview 面板：单列展示各 AI 引擎，逐行配置 API Key。
 * Key 只存 SecretStorage，不下发明文、不在面板回显。
 */
export class SettingsPanel {
  private static current?: vscode.WebviewPanel;

  static async open(secrets: vscode.SecretStorage) {
    if (SettingsPanel.current) {
      SettingsPanel.current.reveal(vscode.ViewColumn.Active);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      '4chan.translateSettings',
      '4chan 翻译 · 高级设置',
      vscode.ViewColumn.Active,
      { enableScripts: true },
    );
    SettingsPanel.current = panel;
    panel.webview.html = SettingsPanel.html();

    const send = (m: unknown) => panel.webview.postMessage(m);
    send({ type: 'init', items: await SettingsPanel.readItems(secrets) });

    panel.webview.onDidReceiveMessage(async (m: PanelMsg) => {
      switch (m.type) {
        case 'save': {
          const key = m.key.trim();
          if (!key) return;
          await secrets.store(secretKey(m.provider), key);
          send({ type: 'updated', provider: m.provider, configured: true });
          break;
        }
        case 'clear':
          await secrets.delete(secretKey(m.provider));
          send({ type: 'updated', provider: m.provider, configured: false });
          break;
        case 'openLink':
          if (m.url) await vscode.env.openExternal(vscode.Uri.parse(m.url));
          break;
      }
    });

    panel.onDidDispose(() => {
      SettingsPanel.current = undefined;
    });
  }

  private static async readItems(secrets: vscode.SecretStorage): Promise<ItemState[]> {
    const items: ItemState[] = [];
    for (const p of AI_PROVIDERS) {
      const meta = PROVIDERS[p];
      items.push({
        provider: p,
        label: meta.label,
        configured: !!(await secrets.get(secretKey(p))),
        link: meta.keyLink,
      });
    }
    return items;
  }

  private static nonce(): string {
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let s = '';
    for (let i = 0; i < 32; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return s;
  }

  private static html(): string {
    const nonce = SettingsPanel.nonce();
    const csp = [`default-src 'none'`, `style-src 'unsafe-inline'`, `script-src 'nonce-${nonce}'`].join('; ');

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<title>4chan 翻译 · 高级设置</title>
<style>
  :root { color-scheme: light dark; }
  body {
    font-family: var(--vscode-font-family, sans-serif);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    margin: 0; padding: 24px 32px; max-width: 820px;
  }
  h2 { font-size: 16px; margin: 0 0 4px; font-weight: 600; }
  .hint { color: var(--vscode-descriptionForeground); font-size: 12px; margin-bottom: 18px; line-height: 1.6; }
  .row {
    display: grid;
    grid-template-columns: minmax(120px, 180px) 1fr;
    align-items: center;
    gap: 16px;
    padding: 14px 0;
    border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,.3));
  }
  .name { font-weight: 600; font-size: 13px; }
  .status { font-size: 12px; margin-top: 3px; }
  .status.on { color: var(--vscode-testing-iconPassed, #3fb950); }
  .status.off { color: var(--vscode-descriptionForeground); }
  .controls { display: flex; align-items: center; gap: 8px; min-width: 0; }
  input.key {
    flex: 1; min-width: 120px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent);
    padding: 6px 8px; border-radius: 2px;
    font-family: var(--vscode-editor-font-family, monospace); font-size: 13px;
    outline: none;
  }
  input.key:focus { border-color: var(--vscode-focusBorder); }
  input.key::placeholder { color: var(--vscode-input-placeholderForeground); }
  button {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none; padding: 6px 14px; border-radius: 2px;
    cursor: pointer; font-size: 13px; white-space: nowrap;
  }
  button:hover { background: var(--vscode-button-hoverBackground); }
  a.getlink {
    color: var(--vscode-textLink-foreground); font-size: 12px;
    text-decoration: none; white-space: nowrap; cursor: pointer;
  }
  a.getlink:hover { text-decoration: underline; }
  .toast {
    position: fixed; bottom: 24px; right: 32px;
    background: var(--vscode-notifications-background);
    color: var(--vscode-notifications-foreground);
    padding: 8px 14px; border-radius: 4px; font-size: 12px;
    opacity: 0; transition: opacity 0.2s; pointer-events: none;
  }
  .toast.show { opacity: 1; }
</style>
</head>
<body>
  <h2>AI 翻译引擎 · API Key</h2>
  <div class="hint">为要启用的引擎填入 API Key，保存后即出现在「选择翻译引擎」中。密钥安全存储于系统密钥库，不写入文件、不回显。</div>
  <div id="list"></div>
  <div class="toast" id="toast"></div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const list = document.getElementById('list');
    const toast = document.getElementById('toast');

    function showToast(msg) {
      toast.textContent = msg;
      toast.classList.add('show');
      setTimeout(function () { toast.classList.remove('show'); }, 1400);
    }

    function render(items) {
      list.innerHTML = items.map(function (it) {
        var sc = it.configured ? 'on' : 'off';
        var st = it.configured ? '● 已配置' : '○ 未配置';
        var clearBtn = it.configured ? '<button class="clear">清除</button>' : '';
        var linkBtn = it.link ? '<a class="getlink" data-link="' + it.link + '">获取 Key ↗</a>' : '';
        return '<div class="row" data-provider="' + it.provider + '">' +
          '<div><div class="name">' + it.label + '</div>' +
          '<div class="status ' + sc + '">' + st + '</div></div>' +
          '<div class="controls">' +
          '<input class="key" type="password" placeholder="填入 API Key" />' +
          '<button class="save">保存</button>' + clearBtn + linkBtn +
          '</div></div>';
      }).join('');
      bind();
    }

    function setStatus(provider, configured) {
      var row = list.querySelector('.row[data-provider="' + provider + '"]');
      if (!row) return;
      var stEl = row.querySelector('.status');
      stEl.className = 'status ' + (configured ? 'on' : 'off');
      stEl.textContent = configured ? '● 已配置' : '○ 未配置';
      var controls = row.querySelector('.controls');
      var clearBtn = controls.querySelector('.clear');
      if (configured && !clearBtn) {
        clearBtn = document.createElement('button');
        clearBtn.className = 'clear';
        clearBtn.textContent = '清除';
        controls.querySelector('.save').after(clearBtn);
        clearBtn.addEventListener('click', function () {
          vscode.postMessage({ type: 'clear', provider: provider });
          showToast('已清除');
        });
      } else if (!configured && clearBtn) {
        clearBtn.remove();
      }
    }

    function bind() {
      list.querySelectorAll('.row').forEach(function (row) {
        var provider = row.dataset.provider;
        var input = row.querySelector('.key');
        var saveBtn = row.querySelector('.save');
        saveBtn.addEventListener('click', function () {
          if (!input.value.trim()) { showToast('请先填入 API Key'); return; }
          vscode.postMessage({ type: 'save', provider: provider, key: input.value });
          input.value = '';
          showToast('已保存');
        });
        var cb = row.querySelector('.clear');
        if (cb) cb.addEventListener('click', function () {
          vscode.postMessage({ type: 'clear', provider: provider });
          showToast('已清除');
        });
        var lk = row.querySelector('.getlink');
        if (lk) lk.addEventListener('click', function () {
          vscode.postMessage({ type: 'openLink', url: lk.dataset.link });
        });
        input.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') saveBtn.click();
        });
      });
    }

    window.addEventListener('message', function (e) {
      var m = e.data;
      if (m.type === 'init') render(m.items);
      else if (m.type === 'updated') setStatus(m.provider, m.configured);
    });
  </script>
</body>
</html>`;
  }
}
