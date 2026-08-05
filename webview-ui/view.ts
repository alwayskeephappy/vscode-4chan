import type { Board, CatalogPage, Post } from '../src/types';
import { boardZh } from '../src/boards-zh';

export interface VsCodeApi {
  postMessage(msg: unknown): void;
  getState<T>(): T | undefined;
  setState(state: unknown): void;
}

const IMG = 'https://i.4cdn.org';

interface State {
  boards: Board[];
  favorites: string[];
  sfwOnly: boolean;
  currentBoard?: string;
  view: 'catalog' | 'thread';
  currentThread?: number;
}

interface OutThread {
  board: string;
  posts: Post[];
}

// 翻译缓存（会话级，不持久化）
const translations = new Map<string, string>();
const translating = new Set<string>();
let translatingAll = false;

export function render(vscode: VsCodeApi) {
  const app = document.getElementById('app')!;
  const saved = vscode.getState<State>();
  const state: State = saved ?? { boards: [], favorites: [], sfwOnly: true, view: 'catalog' };

  let pages: CatalogPage[] = [];
  let posts: Post[] = [];
  let threadBoard = state.currentBoard;

  const send = (m: unknown) => vscode.postMessage(m);
  const persist = () => vscode.setState(state);
  const pkey = (no: number) => `${threadBoard ?? state.currentBoard}:${no}`;

  function imgUrl(board: string, p: { tim?: number; ext?: string }, thumb = false): string | undefined {
    if (!p.tim || !p.ext) return undefined;
    return thumb ? `${IMG}/${board}/${p.tim}s.jpg` : `${IMG}/${board}/${p.tim}${p.ext}`;
  }

  function esc(s = ''): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function htmlToText(html: string): string {
    const tpl = document.createElement('template');
    tpl.innerHTML = html;
    return (tpl.content.textContent || '').trim();
  }

  // 4chan 的 com 字段是受信 HTML，仍做基本净化：去掉脚本/事件，链接转 data-href 由我们处理点击
  function sanitizeCom(html: string): string {
    const tpl = document.createElement('template');
    tpl.innerHTML = html;
    tpl.content.querySelectorAll('script,style,iframe,object,embed').forEach((n) => n.remove());
    tpl.content.querySelectorAll('*').forEach((el) => {
      const attrs = el.attributes;
      for (let i = 0; i < attrs.length; i++) {
        const a = attrs[i];
        if (/^on/i.test(a.name)) el.removeAttribute(a.name);
      }
      if (el.tagName === 'A') {
        el.setAttribute('data-href', el.getAttribute('href') || '');
        el.removeAttribute('href');
      }
    });
    return tpl.innerHTML;
  }

  function filteredBoards(): { favs: Board[]; rest: Board[] } {
    let list = state.boards;
    if (state.sfwOnly) list = list.filter((b) => b.ws_board === 1);
    const sortByName = (a: Board, b: Board) => a.board.localeCompare(b.board);
    return {
      favs: list.filter((b) => state.favorites.includes(b.board)).sort(sortByName),
      rest: list.filter((b) => !state.favorites.includes(b.board)).sort(sortByName),
    };
  }

  function paint(keepScroll = false) {
    const prev = document.querySelector('.main');
    const top = keepScroll && prev ? prev.scrollTop : 0;
    app.innerHTML = layout();
    bind();
    const next = document.querySelector('.main');
    if (next) next.scrollTop = top;
  }

  function boardOption(b: Board): string {
    const sel = b.board === state.currentBoard ? 'selected' : '';
    return `<option value="${b.board}" ${sel}>/${b.board}/ ${boardZh(b.board, b.title)}</option>`;
  }

  function layout(): string {
    const { favs, rest } = filteredBoards();
    let opts = '';
    if (favs.length) opts += `<optgroup label="★ 收藏">${favs.map(boardOption).join('')}</optgroup>`;
    opts += `<optgroup label="全部版块">${rest.map(boardOption).join('')}</optgroup>`;
    if (!opts) opts = '<option>加载中…</option>';

    const isFav = state.currentBoard ? state.favorites.includes(state.currentBoard) : false;

    let main: string;
    if (state.view === 'thread' && state.currentThread) {
      main =
        `<div class="thread-back">
          <button id="back">← 返回</button>
          <div>
              <span class="thread-title">#${state.currentThread}</span>
              <button id="translate-all" class="t-all" ${translatingAll ? 'disabled' : ''}>${translatingAll ? '翻译中…' : '翻译全部'}</button>
          </div>
        </div>` +
        `<div class="thread">${posts.map((p) => postHtml(p)).join('')}</div>`;
    } else {
      const cards = pages
        .flatMap((pg) => pg.threads)
        .map((t) => {
          const thumb = imgUrl(state.currentBoard!, t, true);
          const img = thumb ? `<img loading="lazy" src="${thumb}" />` : `<div class="no-img">无图</div>`;
          const title = esc((t.sub || t.com || '').replace(/<[^>]+>/g, '').slice(0, 140)) || '(无文字)';
          return `<div class="card" data-no="${t.no}">
            ${img}
            <div class="card-meta">
              <div class="card-title">${title}</div>
              <div class="card-stat">回复 ${t.replies ?? 0} · 图 ${t.images ?? 0}</div>
            </div>
          </div>`;
        })
        .join('');
      main = `<div class="catalog">${cards || '<div class="empty">选择上方版块开始浏览</div>'}</div>`;
    }

    return `
      <div class="topbar">
        <select id="board-select">${opts}</select>
        <button id="fav-btn" class="icon-btn ${isFav ? 'on' : ''}" title="收藏/取消收藏">${isFav ? '★' : '☆'}</button>
        <button id="refresh" class="icon-btn" title="刷新">↻</button>
        <label class="sfw" title="只看适合工作场合的版块"><input type="checkbox" id="sfw" ${state.sfwOnly ? 'checked' : ''} />SFW</label>
        <button id="translate-settings" class="icon-btn" title="翻译设置">⚙</button>
      </div>
      <div class="main">${main}</div>
      <div id="overlay" class="overlay hidden"><button id="overlay-close" class="overlay-close" title="关闭 (Esc)">✕</button><img id="overlay-img" alt="" /></div>
    `;
  }

  function postHtml(p: Post): string {
    const thumb = imgUrl(threadBoard!, p, true);
    const full = imgUrl(threadBoard!, p, false);
    const img = thumb
      ? `<img class="post-img" loading="lazy" src="${thumb}" data-full="${full ?? ''}" alt="" />`
      : '';
    const name = p.name || 'Anonymous';
    const com = p.com ? sanitizeCom(p.com) : '';
    const k = pkey(p.no);
    const busy = translating.has(k);
    const zh = translations.get(k);
    const zhBlock = zh ? `<div class="post-zh">${esc(zh)}</div>` : '';
    const trBtn = com
      ? `<button class="t-btn ${busy ? 'busy' : ''}" data-no="${p.no}" ${busy ? 'disabled' : ''}>${busy ? '译…' : zh ? '重译' : '译'}</button>`
      : '';
    return `<div class="post" id="p${p.no}">
      ${img}
      <div class="post-body">
        <div class="post-head">
          <span class="post-name">${esc(name)}</span>
          <span class="post-no">#${p.no}</span>
          <span class="post-time">${esc(p.now)}</span>
          <span class="post-actions">${trBtn}</span>
        </div>
        <div class="post-com">${com}</div>
        ${zhBlock}
      </div>
    </div>`;
  }

  function bind() {
    document.getElementById('board-select')?.addEventListener('change', (e) => {
      const board = (e.target as HTMLSelectElement).value;
      state.currentBoard = board;
      state.view = 'catalog';
      persist();
      send({ type: 'catalog', board });
      paint();
    });

    document.getElementById('fav-btn')?.addEventListener('click', () => {
      if (state.currentBoard) send({ type: 'toggleFav', board: state.currentBoard });
    });

    document.getElementById('refresh')?.addEventListener('click', () => {
      if (state.currentBoard) send({ type: 'catalog', board: state.currentBoard });
    });

    document.getElementById('translate-settings')?.addEventListener('click', () => {
      send({ type: 'openTranslateMenu' });
    });

    document.getElementById('sfw')?.addEventListener('change', (e) => {
      state.sfwOnly = (e.target as HTMLInputElement).checked;
      persist();
      paint();
    });

    document.getElementById('back')?.addEventListener('click', () => {
      state.view = 'catalog';
      persist();
      paint();
    });

    document.getElementById('translate-all')?.addEventListener('click', () => {
      const items = posts
        .map((p) => ({ no: p.no, text: htmlToText(p.com || '') }))
        .filter((it) => it.text);
      if (!items.length) return;
      translatingAll = true;
      items.forEach((it) => translating.add(pkey(it.no)));
      paint();
      send({ type: 'translate', posts: items });
    });

    document.querySelectorAll<HTMLElement>('.t-btn').forEach((el) => {
      el.addEventListener('click', () => {
        const no = Number(el.dataset.no);
        const p = posts.find((x) => x.no === no);
        const text = htmlToText(p?.com || '');
        if (!text) return;
        translating.add(pkey(no));
        paint();
        send({ type: 'translate', posts: [{ no, text }] });
      });
    });

    document.querySelectorAll<HTMLElement>('.card').forEach((el) => {
      el.addEventListener('click', () => {
        const no = Number(el.dataset.no);
        state.currentThread = no;
        state.view = 'thread';
        persist();
        send({ type: 'thread', board: state.currentBoard, no });
        paint();
      });
    });

    document.querySelectorAll<HTMLElement>('.post-img').forEach((el) => {
      el.addEventListener('click', () => {
        const src = el.dataset.full;
        if (src) ovOpen(src);
      });
    });

    document.getElementById('overlay-close')?.addEventListener('click', (e) => {
      e.stopPropagation();
      ovClose();
    });

    // 帖内引用链接：>>123456 跳转高亮；http 外链交给宿主用系统浏览器打开
    document.querySelectorAll<HTMLElement>('.post-com a[data-href]').forEach((el) => {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        const href = el.getAttribute('data-href') || '';
        const m = href.match(/^#p(\d+)$/);
        if (m) {
          const target = document.getElementById('p' + m[1]);
          if (target) {
            target.scrollIntoView({ behavior: 'smooth', block: 'center' });
            target.classList.remove('flash');
            void target.offsetWidth; // 触发重排以重启动画
            target.classList.add('flash');
          }
        } else if (/^https?:/i.test(href)) {
          send({ type: 'openExternal', url: href });
        }
      });
    });

  }

  // 图片预览查看器：缩放 / 拖拽 / 关闭（render 作用域注册一次，状态闭包持有）
  let ovScale = 1, ovTx = 0, ovTy = 0;
  const ovVisible = () => {
    const o = document.getElementById('overlay');
    return !!o && !o.classList.contains('hidden');
  };
  const ovApply = () => {
    const oi = document.getElementById('overlay-img');
    if (oi) oi.style.transform = `translate(${ovTx}px, ${ovTy}px) scale(${ovScale})`;
  };
  const ovReset = () => {
    ovScale = 1; ovTx = 0; ovTy = 0;
    const oi = document.getElementById('overlay-img');
    if (oi) oi.style.transform = '';
  };
  const ovClose = () => {
    document.getElementById('overlay')?.classList.add('hidden');
    ovReset();
  };
  const ovOpen = (src: string) => {
    const overlay = document.getElementById('overlay');
    const oi = document.getElementById('overlay-img') as HTMLImageElement | null;
    if (!overlay || !oi) return;
    oi.src = src;
    ovReset();
    overlay.classList.remove('hidden');
  };

  // ESC 关闭
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && ovVisible()) ovClose();
  });
  // 滚轮：阻止背景滚动 + 以鼠标位置为中心缩放
  document.addEventListener('wheel', (e) => {
    if (!ovVisible()) return;
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.12 : 0.89;
    const ns = Math.max(0.2, Math.min(8, ovScale * factor));
    const ox = window.innerWidth / 2, oy = window.innerHeight / 2;
    const cx = e.clientX - ox - ovTx, cy = e.clientY - oy - ovTy;
    ovTx = e.clientX - (cx * ns) / ovScale - ox;
    ovTy = e.clientY - (cy * ns) / ovScale - oy;
    ovScale = ns;
    ovApply();
  }, { passive: false });
  window.addEventListener('message', (e) => {
    const m = e.data;
    switch (m.type) {
      case 'init':
        state.boards = m.boards;
        state.favorites = m.favorites;
        state.sfwOnly = m.sfwOnly;
        if (!state.currentBoard && m.lastBoard) state.currentBoard = m.lastBoard;
        paint();
        if (state.currentBoard) send({ type: 'catalog', board: state.currentBoard });
        break;
      case 'catalog':
        pages = m.pages as CatalogPage[];
        state.view = 'catalog';
        persist();
        paint();
        break;
      case 'thread': {
        const t = m as unknown as OutThread;
        threadBoard = t.board;
        posts = t.posts;
        translatingAll = false;
        paint();
        break;
      }
      case 'favorites':
        state.favorites = m.favorites;
        persist();
        paint();
        break;
      case 'translated':
        (m.results as { no: number; text: string }[]).forEach((r) => {
          translations.set(pkey(r.no), r.text);
          translating.delete(pkey(r.no));
        });
        translatingAll = false;
        paint(true);
        break;
      case 'translateError': {
        if (m.no != null) translating.delete(pkey(m.no));
        translatingAll = false;
        paint(true);
        const mainEl = document.querySelector('.main');
        mainEl?.insertAdjacentHTML('afterbegin', `<div class="err">⚠ 翻译失败：${esc(m.message)}</div>`);
        break;
      }
      case 'error': {
        const mainEl = document.querySelector('.main');
        mainEl?.insertAdjacentHTML('afterbegin', `<div class="err">⚠ ${esc(m.message)}</div>`);
        break;
      }
    }
  });

  send({ type: 'init' });
  paint();
}
