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
  let catalogLoading = false; // 板块 catalog 请求进行中，用于显示加载占位
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
    if (pendingNsfwBoard) showNsfwModal(pendingNsfwBoard); // 重建后保持确认框显示
  }

  function boardOption(b: Board): string {
    const sel = b.board === state.currentBoard ? 'selected' : '';
    return `<option value="${b.board}" ${sel}>/${b.board}/ ${boardZh(b.board, b.title)}</option>`;
  }

  // 切换到指定板块并加载 catalog（清掉上个板块内容避免残留）
  function loadBoard(board: string) {
    state.currentBoard = board;
    state.view = 'catalog';
    state.currentThread = undefined;
    pages = [];
    catalogLoading = true;
    persist();
    paint();
    send({ type: 'catalog', board });
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
          const img = thumb ? `<img loading="lazy" src="${thumb}" referrerpolicy="no-referrer" />` : `<div class="no-img">无图</div>`;
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
      main = `<div class="catalog">${
        cards || (catalogLoading ? '<div class="empty">加载中…</div>' : '<div class="empty">选择上方版块开始浏览</div>')
      }</div>`;
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
      <div id="overlay" class="overlay hidden">
        <button id="overlay-close" class="overlay-close" title="关闭 (Esc)">✕</button>
        <img id="overlay-img" referrerpolicy="no-referrer" alt="" />
        <video id="overlay-video" autoplay loop controls muted playsinline referrerpolicy="no-referrer"></video>
        <div id="overlay-loading" class="overlay-loading">⏳ 加载中…</div>
        <div id="overlay-err" class="overlay-err hidden"></div>
      </div>
      <div id="nsfw-modal" class="nsfw-modal hidden">
        <div class="nsfw-dialog">
          <div class="nsfw-title">⚠ 成人内容提示</div>
          <div class="nsfw-text">你即将进入 <span id="nsfw-board">/xxx/</span> 版块，该版块可能包含成人及敏感内容。</div>
          <div class="nsfw-text2">本工具仅供技术演示学习，所有内容均来自 4chan，版权归原发布者所有，与本扩展开发者无关。</div>
          <div class="nsfw-btns">
            <button id="nsfw-cancel">取消</button>
            <button id="nsfw-ok">仍然进入</button>
          </div>
        </div>
      </div>
    `;
  }

  function postHtml(p: Post): string {
    const thumb = imgUrl(threadBoard!, p, true);
    const full = imgUrl(threadBoard!, p, false);
    const img = thumb
      ? `<img class="post-img" loading="lazy" src="${thumb}" data-full="${full ?? ''}" referrerpolicy="no-referrer" alt="" />`
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
      const b = state.boards.find((x) => x.board === board);
      if (b && b.ws_board === 0) {
        // 成人板块：先弹页内遮罩确认，确认后由 #nsfw-ok 执行切换
        pendingNsfwBoard = board;
        paint(); // 立即把下拉框恢复为当前板块，同时 paint 里会重新显示确认框
        return;
      }
      loadBoard(board);
    });

    document.getElementById('fav-btn')?.addEventListener('click', () => {
      if (state.currentBoard) send({ type: 'toggleFav', board: state.currentBoard });
    });

    document.getElementById('refresh')?.addEventListener('click', () => {
      if (state.currentBoard) {
        pages = [];
        catalogLoading = true;
        paint();
        send({ type: 'catalog', board: state.currentBoard });
      }
    });

    document.getElementById('translate-settings')?.addEventListener('click', () => {
      send({ type: 'openTranslateMenu' });
    });

    document.getElementById('sfw')?.addEventListener('change', (e) => {
      state.sfwOnly = (e.target as HTMLInputElement).checked;
      persist();
      // 重新开启 SFW 后，当前成人版块会被下拉框隐藏：自动切到第一个可见板块并立即加载
      if (state.sfwOnly && state.currentBoard) {
        const stillSafe = state.boards.some((b) => b.board === state.currentBoard && b.ws_board === 1);
        if (!stillSafe) {
          const { favs, rest } = filteredBoards();
          const next = favs[0] ?? rest[0];
          if (next) {
            state.currentBoard = next.board;
            pages = [];
            catalogLoading = true;
            persist();
            send({ type: 'catalog', board: state.currentBoard });
          } else {
            state.currentBoard = undefined;
            pages = [];
          }
        }
      }
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

    document.getElementById('nsfw-ok')?.addEventListener('click', () => {
      const board = pendingNsfwBoard;
      hideNsfwModal();
      if (board) loadBoard(board);
    });
    document.getElementById('nsfw-cancel')?.addEventListener('click', () => {
      hideNsfwModal();
    });
    document.getElementById('nsfw-modal')?.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) hideNsfwModal(); // 点击遮罩取消
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

  // 图片/视频预览查看器：缩放 / 拖拽 / 关闭（render 作用域注册一次，状态闭包持有）
  // 优先直连 i.4cdn.org（webm/mp4 用 <video> 渲染）；直连被防盗链拦截时走扩展宿主兜底（base64 data URL，不落盘）
  const imageCache = new Map<string, string>(); // url -> base64 data url（兜底缓存）
  let pendingKey = ''; // 正在请求的原图 URL
  let pendingNsfwBoard = ''; // 待确认的成人板块
  let ovScale = 1, ovTx = 0, ovTy = 0;
  const ovMediaEls = () => {
    const img = document.getElementById('overlay-img');
    const vid = document.getElementById('overlay-video');
    return [img, vid].filter(Boolean) as HTMLElement[];
  };
  const ovVisible = () => {
    const o = document.getElementById('overlay');
    return !!o && !o.classList.contains('hidden');
  };
  const ovApply = () => {
    for (const el of ovMediaEls()) el.style.transform = `translate(${ovTx}px, ${ovTy}px) scale(${ovScale})`;
  };
  const ovReset = () => {
    ovScale = 1; ovTx = 0; ovTy = 0;
    for (const el of ovMediaEls()) el.style.transform = '';
  };
  const ovErr = (msg = '') => {
    const oe = document.getElementById('overlay-err');
    if (!oe) return;
    oe.textContent = msg;
    oe.classList.toggle('hidden', !msg);
  };
  const ovLoading = (show: boolean) => {
    document.getElementById('overlay-loading')?.classList.toggle('hidden', !show);
  };
  const showNsfwModal = (board: string) => {
    const modal = document.getElementById('nsfw-modal');
    if (!modal) return;
    const name = document.getElementById('nsfw-board');
    if (name) name.textContent = `/${board}/`;
    modal.classList.remove('hidden');
  };
  const hideNsfwModal = () => {
    pendingNsfwBoard = '';
    document.getElementById('nsfw-modal')?.classList.add('hidden');
  };
  const ovClose = () => {
    const vid = document.getElementById('overlay-video') as HTMLVideoElement | null;
    if (vid) {
      vid.pause();
      vid.src = '';
    }
    document.getElementById('overlay')?.classList.add('hidden');
    ovReset();
    ovErr('');
    ovLoading(false);
    pendingKey = '';
  };
  const mediaOf = (url: string): 'video' | 'image' => (/\.(webm|mp4)$/i.test(url) ? 'video' : 'image');
  const showMedia = (uri: string, media: 'video' | 'image') => {
    const img = document.getElementById('overlay-img') as HTMLImageElement | null;
    const vid = document.getElementById('overlay-video') as HTMLVideoElement | null;
    if (!img || !vid) return;
    ovLoading(false);
    ovErr('');
    if (media === 'video') {
      img.hidden = true;
      vid.hidden = false;
      // 直连失败 → 走扩展宿主兜底；data URL 失败则直接报错（避免循环重试）
      vid.onerror = () => (uri.startsWith('data:') ? ovErr('⚠ 视频加载失败') : fallback(uri, 'video'));
      vid.src = uri;
      void vid.play().catch(() => {});
    } else {
      vid.hidden = true;
      vid.pause();
      vid.src = '';
      img.hidden = false;
      img.onload = () => ovErr('');
      img.onerror = () => (uri.startsWith('data:') ? ovErr('⚠ 图片加载失败') : fallback(uri, 'image'));
      img.src = uri;
    }
  };
  const fallback = (url: string, media: 'video' | 'image') => {
    if (url !== pendingKey) return; // 已被更新的打开操作取代
    const cached = imageCache.get(url);
    if (cached) {
      showMedia(cached, media);
      return;
    }
    ovErr('');
    ovLoading(true);
    send({ type: 'img', url });
  };
  const ovOpen = (src: string) => {
    const overlay = document.getElementById('overlay');
    if (!overlay) return;
    ovErr('');
    pendingKey = src;
    ovReset();
    overlay.classList.remove('hidden');
    showMedia(src, mediaOf(src)); // 优先直连加载，被防盗链拦截时自动降级
  };

  // ESC 关闭（图片预览 / 成人确认框）
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (ovVisible()) ovClose();
    else if (!document.getElementById('nsfw-modal')?.classList.contains('hidden')) hideNsfwModal();
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
        // 永不默认加载成人内容：lastBoard 缺失或为成人板块时，一律回退到第一个安全板块。
        // 成人板块只能由用户显式选择（并经二次确认）进入。
        const curBoard = state.boards.find((x) => x.board === state.currentBoard);
        if (!curBoard || curBoard.ws_board === 0) {
          const safeFirst = [...state.boards]
            .filter((x) => x.ws_board === 1)
            .sort((a, b) => a.board.localeCompare(b.board))[0];
          state.currentBoard = safeFirst?.board;
        }
        if (state.currentBoard) {
          catalogLoading = true;
          send({ type: 'catalog', board: state.currentBoard });
        }
        paint();
        break;
      case 'catalog':
        if (m.board !== state.currentBoard) break; // 过期响应（快速切换板块时）直接忽略，避免串板块
        pages = m.pages as CatalogPage[];
        catalogLoading = false;
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
        catalogLoading = false;
        const mainEl = document.querySelector('.main');
        mainEl?.insertAdjacentHTML('afterbegin', `<div class="err">⚠ ${esc(m.message)}</div>`);
        break;
      }
      case 'img': {
        imageCache.set(m.url, m.data);
        if (m.url === pendingKey) {
          pendingKey = '';
          showMedia(m.data, mediaOf(m.url));
        }
        break;
      }
      case 'imgError': {
        if (m.url === pendingKey) {
          pendingKey = '';
          ovLoading(false);
          ovErr('⚠ 加载失败：' + m.message);
        }
        break;
      }
    }
  });

  send({ type: 'init' });
  paint();
}
