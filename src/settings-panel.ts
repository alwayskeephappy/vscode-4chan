import * as vscode from 'vscode';
import { PROVIDERS, type Provider } from './translate';

const CONFIG_NS = 'vscode-4chan.translate';
const secretKey = (p: Provider) => `${CONFIG_NS}.key.${p}`;
const modelKey = (p: Provider) => `model.${p}`;
// 面板里展示的 AI 引擎（固定 4 个）
const AI_PROVIDERS: Provider[] = ['deepseek', 'glm', 'openai', 'qwen'];

interface ItemState {
  provider: Provider;
  label: string;
  configured: boolean;
  models?: string[];
  model: string;
  link?: string;
}

interface CacheInfo {
  path: string;
  bytes: number;
  files: number;
  maxBytes: number;
}

type PanelMsg =
  | { type: 'save'; provider: Provider; key: string }
  | { type: 'clear'; provider: Provider }
  | { type: 'setModel'; provider: Provider; model: string }
  | { type: 'clearCache' }
  | { type: 'openLink'; url: string };

/**
 * 高级设置 Webview 面板：单列展示各 AI 引擎，逐行配置 API Key + 选择模型。
 * Key 只存 SecretStorage，不下发明文、不在面板回显（已配置时仅以密文占位提示）。
 */
export class SettingsPanel {
  private static current?: vscode.WebviewPanel;

  static async open(
    secrets: vscode.SecretStorage,
    globalState: vscode.Memento,
    cacheUri: vscode.Uri,
    maxCacheBytes: number,
  ) {
    if (SettingsPanel.current) {
      SettingsPanel.current.reveal(vscode.ViewColumn.Active);
      SettingsPanel.current.webview.postMessage({
        type: 'cacheInfo',
        cache: await SettingsPanel.readCacheInfo(cacheUri, maxCacheBytes),
      });
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
    send({
      type: 'init',
      items: await SettingsPanel.readItems(secrets, globalState),
      cache: await SettingsPanel.readCacheInfo(cacheUri, maxCacheBytes),
    });

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
        case 'setModel':
          await globalState.update(modelKey(m.provider), m.model);
          break;
        case 'clearCache': {
          const confirm = await vscode.window.showWarningMessage(
            '确定要清理全部媒体缓存吗？',
            {
              modal: true,
              detail: `将永久删除以下目录中的全部缓存文件：\n${cacheUri.fsPath}`,
            },
            '确认清理',
          );
          if (confirm !== '确认清理') break;
          try {
            try {
              await vscode.workspace.fs.delete(cacheUri, { recursive: true, useTrash: false });
            } catch (error) {
              if (!(error instanceof vscode.FileSystemError && error.code === 'FileNotFound')) throw error;
            }
            await vscode.workspace.fs.createDirectory(cacheUri);
            send({
              type: 'cacheCleared',
              cache: await SettingsPanel.readCacheInfo(cacheUri, maxCacheBytes),
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            send({ type: 'cacheError', message });
          }
          break;
        }
        case 'openLink':
          if (m.url) await vscode.env.openExternal(vscode.Uri.parse(m.url));
          break;
      }
    });

    panel.onDidDispose(() => {
      SettingsPanel.current = undefined;
    });
  }

  private static async readItems(
    secrets: vscode.SecretStorage,
    globalState: vscode.Memento,
  ): Promise<ItemState[]> {
    const items: ItemState[] = [];
    for (const p of AI_PROVIDERS) {
      const meta = PROVIDERS[p];
      const saved = globalState.get<string>(modelKey(p));
      items.push({
        provider: p,
        label: meta.label,
        configured: !!(await secrets.get(secretKey(p))),
        models: meta.models,
        model: saved || meta.model,
        link: meta.keyLink,
      });
    }
    return items;
  }

  private static async readCacheInfo(cacheUri: vscode.Uri, maxBytes: number): Promise<CacheInfo> {
    let bytes = 0;
    let files = 0;
    try {
      for (const [name, type] of await vscode.workspace.fs.readDirectory(cacheUri)) {
        if (type !== vscode.FileType.File) continue;
        const stat = await vscode.workspace.fs.stat(vscode.Uri.joinPath(cacheUri, name));
        bytes += stat.size;
        files += 1;
      }
    } catch {
      // The cache directory is created lazily after the first media fallback.
    }
    return { path: cacheUri.fsPath, bytes, files, maxBytes };
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
  select.model {
    box-sizing: border-box;
    flex: 0 0 150px;
    width: 150px;
    min-width: 150px;
    max-width: 150px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent);
    padding: 6px 4px; border-radius: 2px;
    font-size: 12px; font-family: var(--vscode-editor-font-family, monospace);
    outline: none;
  }
  select.model:focus { border-color: var(--vscode-focusBorder); }
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
  input.key[readonly] { opacity: 0.85; cursor: default; }
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
  .cache-card {
    margin-top: 18px; padding: 14px 16px;
    border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.3));
    border-radius: 4px;
    background: var(--vscode-sideBar-background, transparent);
  }
  .cache-title { font-size: 13px; font-weight: 600; margin-bottom: 10px; }
  .cache-line { display: flex; gap: 10px; margin-top: 6px; font-size: 12px; line-height: 1.5; }
  .cache-label { flex: 0 0 68px; color: var(--vscode-descriptionForeground); }
  .cache-value { min-width: 0; word-break: break-all; }
  .cache-path { font-family: var(--vscode-editor-font-family, monospace); }
  .cache-note { color: var(--vscode-descriptionForeground); margin-top: 10px; font-size: 11px; }
  .cache-actions { display: flex; justify-content: flex-end; margin-top: 12px; }
  button.danger {
    background: var(--vscode-testing-iconFailed, #c42b1c);
    color: #fff;
  }
  button.danger:hover { background: #a1261a; }
</style>
</head>
<body>
  <h2>AI 翻译引擎 · API Key 与模型</h2>
  <div class="hint">为要启用的引擎填入 API Key（密文存储，不回显），并在下拉中选择官方模型。保存后该引擎即出现在「选择翻译引擎」中。</div>
  <div id="list"></div>
  <div class="cache-card">
    <div class="cache-title">媒体缓存</div>
    <div class="cache-line"><span class="cache-label">缓存路径</span><span id="cache-path" class="cache-value cache-path">读取中…</span></div>
    <div class="cache-line"><span class="cache-label">缓存体积</span><span id="cache-size" class="cache-value">读取中…</span></div>
    <div class="cache-note">缓存硬上限为 10 GB，达到上限后自动删除最旧文件。</div>
    <div class="cache-actions"><button id="clear-cache" class="danger">一键清理缓存</button></div>
  </div>
  <div class="toast" id="toast"></div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const list = document.getElementById('list');
    const toast = document.getElementById('toast');
    document.getElementById('clear-cache').addEventListener('click', function () {
      vscode.postMessage({ type: 'clearCache' });
    });

    function showToast(msg) {
      toast.textContent = msg;
      toast.classList.add('show');
      setTimeout(function () { toast.classList.remove('show'); }, 1400);
    }

    function formatBytes(bytes) {
      if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
      var units = ['B', 'KB', 'MB', 'GB'];
      var index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
      return (bytes / Math.pow(1024, index)).toFixed(index >= 2 ? 2 : 1) + ' ' + units[index];
    }

    function renderCache(cache) {
      if (!cache) return;
      document.getElementById('cache-path').textContent = cache.path;
      document.getElementById('cache-size').textContent =
        formatBytes(cache.bytes) + ' / ' + formatBytes(cache.maxBytes) + '（' + cache.files + ' 个文件）';
    }

    function render(items) {
      list.innerHTML = items.map(function (it) {
        var sc = it.configured ? 'on' : 'off';
        var st = it.configured ? '● 已配置' : '○ 未配置';
        var modelField = '';
        if (it.models && it.models.length) {
          var inList = it.models.indexOf(it.model) !== -1;
          var opts = it.models.map(function (m) {
            return '<option value="' + m + '"' + (inList && m === it.model ? ' selected' : '') + '>' + m + '</option>';
          }).join('');
          // 当前模型不在官方列表（自定义/旧值）时追加一项，保证可见可选
          if (!inList) opts = '<option value="' + it.model + '" selected>' + it.model + '</option>' + opts;
          modelField = '<select class="model" title="选择模型">' + opts + '</select>';
        } else {
          modelField = '<input class="model" value="' + it.model + '" title="模型" />';
        }
        var inputAttrs = it.configured
          ? 'type="password" placeholder="密钥已配置（密文存储）" readonly'
          : 'type="password" placeholder="填入 API Key"';
        // 保存按钮默认隐藏：仅当用户在输入框中填入内容时才出现
        var saveBtn = '<button class="save" style="display:none">保存</button>';
        var clearBtn = it.configured ? '<button class="clear">清除</button>' : '';
        var linkBtn = it.link ? '<a class="getlink" data-link="' + it.link + '">获取 Key ↗</a>' : '';
        return '<div class="row" data-provider="' + it.provider + '">' +
          '<div><div class="name">' + it.label + '</div>' +
          '<div class="status ' + sc + '">' + st + '</div></div>' +
          '<div class="controls">' +
          modelField +
          '<input class="key" ' + inputAttrs + ' />' +
          saveBtn + clearBtn + linkBtn +
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
      var input = row.querySelector('.key');
      var saveBtn = row.querySelector('.save');
      var controls = row.querySelector('.controls');
      if (configured) {
        input.value = '';
        input.placeholder = '密钥已配置（密文存储）';
        input.readOnly = true;
        saveBtn.style.display = 'none';
        var clearBtn = controls.querySelector('.clear');
        if (!clearBtn) {
          clearBtn = document.createElement('button');
          clearBtn.className = 'clear';
          clearBtn.textContent = '清除';
          saveBtn.after(clearBtn);
          clearBtn.addEventListener('click', function () {
            vscode.postMessage({ type: 'clear', provider: provider });
            showToast('已清除');
          });
        }
      } else {
        input.placeholder = '填入 API Key';
        input.readOnly = false;
        saveBtn.style.display = 'none';
        var clearBtn = controls.querySelector('.clear');
        if (clearBtn) clearBtn.remove();
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
        // 输入内容时才显示保存按钮；清空则隐藏
        input.addEventListener('input', function () {
          saveBtn.style.display = input.value.trim() ? '' : 'none';
        });
        var cb = row.querySelector('.clear');
        if (cb) cb.addEventListener('click', function () {
          vscode.postMessage({ type: 'clear', provider: provider });
          showToast('已清除');
        });
        var sel = row.querySelector('select.model');
        if (sel) sel.addEventListener('change', function () {
          vscode.postMessage({ type: 'setModel', provider: provider, model: sel.value });
          showToast('模型已切换为 ' + sel.value);
        });
        var lk = row.querySelector('.getlink');
        if (lk) lk.addEventListener('click', function () {
          vscode.postMessage({ type: 'openLink', url: lk.dataset.link });
        });
        input.addEventListener('keydown', function (e) {
          if (e.key === 'Enter' && saveBtn.style.display !== 'none') saveBtn.click();
        });
      });
    }

    window.addEventListener('message', function (e) {
      var m = e.data;
      if (m.type === 'init') { render(m.items); renderCache(m.cache); }
      else if (m.type === 'cacheInfo') renderCache(m.cache);
      else if (m.type === 'cacheCleared') { renderCache(m.cache); showToast('缓存已清理'); }
      else if (m.type === 'cacheError') showToast('清理失败：' + m.message);
      else if (m.type === 'updated') setStatus(m.provider, m.configured);
    });
  </script>
</body>
</html>`;
  }
}
