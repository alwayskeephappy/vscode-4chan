import type { Board, CatalogPage, Post } from '../src/types';
import { boardZh } from '../src/boards-zh';

declare const JSMpeg: {
  Player: new (url: string, options: Record<string, unknown>) => {
    play(): void;
    pause(): void;
    destroy(): void;
    paused: boolean;
  };
};

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
  let currentPage = 0; // 当前动态分页页码（0 起始）
  let catalogPageSize = 1; // 由当前可视区域的列数 × 行数实时计算
  let catalogColumns = 1;
  let catalogRows = 1;
  let catalogCardSize = 100;
  let catalogLoading = false; // 板块 catalog 请求进行中，用于显示加载占位
  let posts: Post[] = [];
  let threadBoard = state.currentBoard;
  let hideThreadImages = false; // 摸鱼模式：一键隐藏当前帖子的所有图片

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

  function catalogThreads() {
    return pages.flatMap((page) => page.threads);
  }

  function catalogPageCount() {
    return Math.max(1, Math.ceil(catalogThreads().length / catalogPageSize));
  }

  // 构建分页器页码序列，-1 代表省略号。
  // 恒定输出 maxSlots 个槽位（首 + 尾 + 省略号 + 中间窗口），保证恰好占满宽度。
  function paginationRange(current: number, total: number, maxSlots: number): number[] {
    if (total <= maxSlots) return Array.from({ length: total }, (_, i) => i);
    const last = total - 1;
    let ellL = 1, ellR = 1; // 先假设两侧都有省略号
    let winLen = Math.max(1, maxSlots - 2 - ellL - ellR);
    let start = current - Math.floor((winLen - 1) / 2);
    let end = start + winLen - 1;
    // 夹紧窗口并按需丢弃省略号，迭代两次直到稳定
    for (let iter = 0; iter < 2; iter++) {
      if (start < 1) start = 1;
      if (end > last - 1) end = last - 1;
      if (start <= 1) ellL = 0;
      if (end >= last - 1) ellR = 0;
      winLen = Math.max(1, maxSlots - 2 - ellL - ellR);
      start = current - Math.floor((winLen - 1) / 2);
      end = start + winLen - 1;
      if (start < 1) { start = 1; end = start + winLen - 1; }
      if (end > last - 1) { end = last - 1; start = end - winLen + 1; }
    }
    const r: number[] = [0];
    if (ellL) r.push(-1);
    for (let i = start; i <= end; i++) r.push(i);
    if (ellR) r.push(-1);
    r.push(last);
    return r;
  }

  // 实测 .pg-pages 的可用宽度与单个按钮宽度，精确计算能容纳几个页码（绝不溢出）
  // 上限 9：宽面板不贪婪填满，收敛到合理数量居中显示，留出余白
  function fitPaginator() {
    const total = catalogPageCount();
    if (total <= 1) return;
    const container = document.querySelector<HTMLElement>('.pg-pages');
    if (!container) return;
    const avail = container.clientWidth;
    const sample = container.querySelector<HTMLElement>('.pg-num');
    if (!sample) return; // 还没渲染出按钮，等下次
    const gap = 4;
    const slotW = sample.offsetWidth + gap;
    const measured = Math.floor((avail + gap) / slotW);
    // 中间区域过窄时只保留当前页，避免页码与上一页/下一页互相挤压。
    const nums = measured < 5
      ? [currentPage]
      : paginationRange(currentPage, total, Math.min(9, measured));
    container.innerHTML = nums
      .map((p) => {
        if (p === -1) return `<span class="pg-ellipsis">…</span>`;
        const active = p === currentPage ? 'active' : '';
        return `<button class="pg-btn pg-num ${active}" data-page="${p}">${p + 1}</button>`;
      })
      .join('');
    bindPgNums();
  }

  // 翻页：更新页码并重渲染（fitPaginator 会按新宽度重排）
  function gotoPage(p: number) {
    currentPage = Math.max(0, Math.min(p, catalogPageCount() - 1));
    paint();
    document.querySelector('.main')?.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // Catalog 卡片保持正方形并铺满每行。根据实际宽高计算能完整放下的列数和行数，
  // 然后将整个 4chan catalog 重新分页，而不使用 4chan 自带的页号。
  function fitCatalogPage() {
    if (state.view !== 'catalog' || catalogLoading || !pages.length) return;
    const main = document.querySelector<HTMLElement>('.main');
    if (!main) return;

    const padding = 8;
    const gap = 8;
    const minCardWidth = 100;
    const innerWidth = Math.max(1, main.clientWidth - padding * 2);
    const innerHeight = Math.max(1, main.clientHeight - padding * 2);
    const columns = Math.max(1, Math.floor((innerWidth + gap) / (minCardWidth + gap)));
    const cardSize = (innerWidth - gap * (columns - 1)) / columns;
    const rows = Math.max(1, Math.floor((innerHeight + gap) / (cardSize + gap)));
    const nextPageSize = Math.max(1, columns * rows);
    if (
      nextPageSize === catalogPageSize
      && columns === catalogColumns
      && rows === catalogRows
      && Math.abs(cardSize - catalogCardSize) < 0.5
    ) return;

    const firstVisibleItem = currentPage * catalogPageSize;
    catalogPageSize = nextPageSize;
    catalogColumns = columns;
    catalogRows = rows;
    catalogCardSize = cardSize;
    currentPage = Math.min(
      Math.floor(firstVisibleItem / catalogPageSize),
      catalogPageCount() - 1,
    );
    paint();
  }

  // 仅绑定数字按钮（fitPaginator 重渲染 .pg-pages 后调用）
  function bindPgNums() {
    document.querySelectorAll<HTMLElement>('.pg-pages .pg-num').forEach((el) => {
      el.addEventListener('click', () => gotoPage(Number(el.dataset.page) || 0));
    });
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

  /** NSFW 模式下允许显示的 NSFW 板块白名单 */
  const NSFW_WHITELIST = ['gif', 'wg'];

  function filteredBoards(): { favs: Board[]; rest: Board[] } {
    let list = state.boards;
    if (state.sfwOnly) {
      list = list.filter((b) => b.ws_board === 1);
    } else {
      list = list.filter((b) => b.ws_board === 1 || NSFW_WHITELIST.includes(b.board));
    }
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
    // 渲染后按实际可视宽高重新计算容量，再按实测宽度排布页码。
    window.requestAnimationFrame(fitCatalogPage);
    fitPaginator();
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
    currentPage = 0;
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
    let paginatorBar = '';
    if (state.view === 'thread' && state.currentThread) {
      main =
        `<div class="thread-back">
          <button id="back">← 返回</button>
          <div>
              <span class="thread-title">#${state.currentThread}</span>
              <button id="toggle-images" class="t-all">${hideThreadImages ? '显示图片' : '隐藏图片'}</button>
              <button id="translate-all" class="t-all" ${translatingAll ? 'disabled' : ''}>${translatingAll ? '翻译中…' : '翻译全部'}</button>
          </div>
        </div>` +
        `<div class="thread">${posts.map((p) => postHtml(p)).join('')}</div>`;
    } else {
      // 将接口返回的全量活跃主题展平，再按当前可视区域容量动态分页。
      const allThreads = catalogThreads();
      const start = currentPage * catalogPageSize;
      const threads = allThreads.slice(start, start + catalogPageSize);
      const fillsPage = threads.length === catalogPageSize;
      const cards = threads
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
      const catalogStyle = [
        `--catalog-columns:${catalogColumns}`,
        `--catalog-rows:${catalogRows}`,
        `--catalog-leading-rows:${Math.max(0, catalogRows - 1)}`,
        `--catalog-card-size:${catalogCardSize}px`,
      ].join(';');
      main = `<div class="catalog ${fillsPage ? 'fill-height' : ''}" style="${catalogStyle}">${
        cards || (catalogLoading ? '<div class="empty">加载中…</div>' : '<div class="empty">选择上方版块开始浏览</div>')
      }</div>`;
      const totalPages = catalogPageCount();
      if (totalPages > 1) {
        // 初始用一个较大窗口渲染（fitPaginator 会在 paint 后按实测宽度精确裁剪）
        const pgNums = paginationRange(currentPage, totalPages, 999);
        paginatorBar = `<div class="paginator-bar">
            <button class="pg-btn pg-prev" data-page="prev" ${currentPage <= 0 ? 'disabled' : ''}>‹ 上一页</button>
            <span class="pg-pages">${pgNums.map((p) => {
              if (p === -1) return `<span class="pg-ellipsis">…</span>`;
              const active = p === currentPage ? 'active' : '';
              return `<button class="pg-btn pg-num ${active}" data-page="${p}">${p + 1}</button>`;
            }).join('')}</span>
            <button class="pg-btn pg-next" data-page="next" ${currentPage >= totalPages - 1 ? 'disabled' : ''}>下一页 ›</button>
        </div>`;
      }
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
      ${paginatorBar}
      <div id="overlay" class="overlay hidden">
        <button id="overlay-close" class="overlay-close" title="关闭 (Esc)">✕</button>
        <button id="overlay-download" class="overlay-download" title="下载原图">⬇</button>
        <img id="overlay-img" referrerpolicy="no-referrer" alt="" />
        <video id="overlay-video" autoplay loop controls muted playsinline referrerpolicy="no-referrer"></video>
        <div id="overlay-jsmpeg-wrap" class="overlay-jsmpeg-wrap" hidden>
          <canvas id="overlay-jsmpeg" title="点击暂停/继续"></canvas>
          <button id="overlay-jsmpeg-toggle" class="overlay-jsmpeg-toggle" title="暂停" aria-label="暂停">⏸</button>
        </div>
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
    const img = !hideThreadImages && thumb
      ? `<div class="post-img-wrap">
          <img class="post-img" loading="lazy" src="${thumb}" data-full="${full ?? ''}" referrerpolicy="no-referrer" alt="" />
          <button class="post-img-dl" data-src="${full ?? ''}" title="下载原图">⬇</button>
        </div>`
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
        currentPage = 0;
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
            currentPage = 0;
            catalogLoading = true;
            persist();
            send({ type: 'catalog', board: state.currentBoard });
          } else {
            state.currentBoard = undefined;
            pages = [];
            currentPage = 0;
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

    document.getElementById('toggle-images')?.addEventListener('click', () => {
      hideThreadImages = !hideThreadImages;
      paint(true);
    });

    document.getElementById('translate-all')?.addEventListener('click', () => {
      const items = posts
        .map((p) => ({ no: p.no, text: htmlToText(p.com || '') }))
        .filter((it) => it.text);
      if (!items.length) return;
      translatingAll = true;
      items.forEach((it) => translating.add(pkey(it.no)));
      paint(true);
      send({ type: 'translate', posts: items });
    });

    document.querySelectorAll<HTMLElement>('.t-btn').forEach((el) => {
      el.addEventListener('click', () => {
        const no = Number(el.dataset.no);
        const p = posts.find((x) => x.no === no);
        const text = htmlToText(p?.com || '');
        if (!text) return;
        translating.add(pkey(no));
        paint(true);
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

    // 分页器（上一页/下一页/数字按钮）
    document.querySelectorAll<HTMLElement>('.pg-btn').forEach((el) => {
      el.addEventListener('click', () => {
        const page = el.dataset.page;
        if (page === 'prev') gotoPage(Math.max(0, currentPage - 1));
        else if (page === 'next') gotoPage(Math.min(catalogPageCount() - 1, currentPage + 1));
        else gotoPage(Number(page) || 0);
      });
    });

    document.querySelectorAll<HTMLElement>('.post-img').forEach((el) => {
      el.addEventListener('click', () => {
        const src = el.dataset.full;
        if (src) ovOpen(src);
      });
    });

    document.querySelectorAll<HTMLElement>('.post-img-dl').forEach((el) => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const src = el.dataset.src;
        if (src) {
          ovOrigSrc = src;
          void downloadCurrentMedia();
        }
      });
    });

    document.getElementById('overlay-close')?.addEventListener('click', (e) => {
      e.stopPropagation();
      ovClose();
    });

    document.getElementById('overlay-download')?.addEventListener('click', (e) => {
      e.stopPropagation();
      downloadCurrentMedia();
    });
    const jsmpegToggle = document.getElementById('overlay-jsmpeg-toggle') as HTMLButtonElement | null;
    const toggleJsmpeg = () => {
      if (!jsmpegPlayer || !jsmpegToggle) return;
      if (jsmpegPlayer.paused) {
        jsmpegPlayer.play();
        jsmpegToggle.textContent = '⏸';
        jsmpegToggle.title = '暂停';
        jsmpegToggle.setAttribute('aria-label', '暂停');
      } else {
        jsmpegPlayer.pause();
        jsmpegToggle.textContent = '▶';
        jsmpegToggle.title = '播放';
        jsmpegToggle.setAttribute('aria-label', '播放');
      }
    };
    jsmpegToggle?.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleJsmpeg();
    });
    document.getElementById('overlay-jsmpeg')?.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleJsmpeg();
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
  // 优先直连 i.4cdn.org；失败时由扩展宿主缓存文件并返回 Webview 本地资源 URI。
  const imageCache = new Map<string, string>(); // 原始 URL -> Webview 缓存资源 URI
  const compatibleCache = new Map<string, string>(); // 原始 URL -> MPEG-TS Blob URL
  const transcodeRequested = new Set<string>();
  let jsmpegPlayer: InstanceType<typeof JSMpeg.Player> | undefined;
  let jsmpegLoadTimer = 0;
  let pendingKey = ''; // 正在请求的原图 URL
  let pendingNsfwBoard = ''; // 待确认的成人板块
  let ovScale = 1, ovTx = 0, ovTy = 0;
  const ovMediaEls = () => {
    const img = document.getElementById('overlay-img');
    const vid = document.getElementById('overlay-video');
    const jsmpegWrap = document.getElementById('overlay-jsmpeg-wrap');
    return [img, vid, jsmpegWrap].filter(Boolean) as HTMLElement[];
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
      vid.onerror = null;
      vid.pause();
      vid.src = '';
    }
    jsmpegPlayer?.destroy();
    jsmpegPlayer = undefined;
    window.clearTimeout(jsmpegLoadTimer);
    const jsmpegWrap = document.getElementById('overlay-jsmpeg-wrap') as HTMLElement | null;
    if (jsmpegWrap) jsmpegWrap.hidden = true;
    document.getElementById('overlay')?.classList.add('hidden');
    ovReset();
    ovErr('');
    ovLoading(false);
    pendingKey = '';
  };
  const mediaOf = (url: string): 'video' | 'image' => (/\.(webm|mp4)(?:[?#]|$)/i.test(url) ? 'video' : 'image');
  const showMedia = (uri: string, media: 'video' | 'image', isFallback = false) => {
    const img = document.getElementById('overlay-img') as HTMLImageElement | null;
    const vid = document.getElementById('overlay-video') as HTMLVideoElement | null;
    if (!img || !vid) return;
    jsmpegPlayer?.destroy();
    jsmpegPlayer = undefined;
    window.clearTimeout(jsmpegLoadTimer);
    const jsmpegWrap = document.getElementById('overlay-jsmpeg-wrap') as HTMLElement | null;
    if (jsmpegWrap) jsmpegWrap.hidden = true;
    ovLoading(false);
    ovErr('');
    if (media === 'video') {
      img.hidden = true;
      vid.hidden = false;
      vid.onerror = () => {
        if (!isFallback) fallback(uri, 'video');
        else if (
          (vid.error?.code === MediaError.MEDIA_ERR_DECODE || vid.error?.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED)
          && ovOrigSrc
          && !transcodeRequested.has(ovOrigSrc)
        ) {
          transcodeRequested.add(ovOrigSrc);
          ovErr('');
          ovLoading(true);
          send({ type: 'transcodeMedia', url: ovOrigSrc });
        } else {
          ovErr(`⚠ 缓存资源仍无法播放（媒体错误 ${vid.error?.code ?? '未知'}）`);
        }
      };
      vid.src = uri;
      void vid.play().catch(() => {});
    } else {
      vid.hidden = true;
      vid.pause();
      vid.src = '';
      img.hidden = false;
      img.onload = () => ovErr('');
      img.onerror = () => (isFallback ? ovErr('⚠ 图片加载失败') : fallback(uri, 'image'));
      img.src = uri;
    }
  };
  const showJsmpeg = (uri: string) => {
    const img = document.getElementById('overlay-img') as HTMLImageElement | null;
    const vid = document.getElementById('overlay-video') as HTMLVideoElement | null;
    const canvas = document.getElementById('overlay-jsmpeg') as HTMLCanvasElement | null;
    const toggle = document.getElementById('overlay-jsmpeg-toggle') as HTMLButtonElement | null;
    const wrap = document.getElementById('overlay-jsmpeg-wrap') as HTMLElement | null;
    if (!img || !vid || !canvas || !toggle || !wrap) return;
    vid.onerror = null; // Prevent clearing the old native source from reporting a stale error.
    vid.pause();
    vid.src = '';
    vid.hidden = true;
    img.hidden = true;
    wrap.hidden = false;
    jsmpegPlayer?.destroy();
    window.clearTimeout(jsmpegLoadTimer);
    try {
      jsmpegPlayer = new JSMpeg.Player(uri, {
        canvas,
        autoplay: true,
        loop: true,
        audio: false,
        disableWebAssembly: true,
        progressive: false,
        throttled: false,
        onSourceEstablished: () => {
          ovLoading(true);
          const loading = document.getElementById('overlay-loading');
          if (loading) loading.textContent = '⏳ 正在解码…';
        },
        onVideoDecode: () => {
          window.clearTimeout(jsmpegLoadTimer);
          ovLoading(false);
          ovErr('');
        },
      });
      toggle.textContent = '⏸';
      toggle.title = '暂停';
      toggle.setAttribute('aria-label', '暂停');
      ovLoading(true);
      const loading = document.getElementById('overlay-loading');
      if (loading) loading.textContent = '⏳ 读取缓存…';
      ovErr('');
      jsmpegLoadTimer = window.setTimeout(() => {
        ovLoading(false);
        ovErr('⚠ 内置播放器等待首帧超时');
      }, 15_000);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ovLoading(false);
      ovErr('⚠ 内置播放器启动失败：' + message);
    }
  };
  const fallback = (url: string, media: 'video' | 'image') => {
    if (url !== pendingKey) return; // 已被更新的打开操作取代
    const cached = imageCache.get(url);
    if (cached) {
      showMedia(cached, media, true);
      return;
    }
    ovErr('');
    ovLoading(true);
    send({ type: 'img', url });
  };
  let ovOrigSrc = ''; // 当前查看器的原始 URL（用于原图下载）
  const ovOpen = (src: string) => {
    const overlay = document.getElementById('overlay');
    if (!overlay) return;
    ovErr('');
    pendingKey = src;
    ovOrigSrc = src;
    ovReset();
    overlay.classList.remove('hidden');
    const compatible = compatibleCache.get(src);
    if (compatible) showJsmpeg(compatible);
    else showMedia(src, mediaOf(src));
  };

  // 下载原图：交给宿主（Node 环境）fetch + 保存对话框
  const downloadCurrentMedia = () => {
    const src = ovOrigSrc;
    if (!src) return;
    const ext = src.match(/\.([a-z0-9]+)(?:[?#]|$)/i)?.[1].toLowerCase() || 'jpg';
    const filename = `${state.currentBoard ?? '4chan'}_${Date.now()}.${ext}`;
    send({ type: 'downloadFile', url: src, filename });
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
        currentPage = 0;
        catalogPageSize = 1;
        catalogColumns = 1;
        catalogRows = 1;
        catalogCardSize = 100;
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
        hideThreadImages = false;
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
        imageCache.set(m.url, m.src);
        if (m.url === pendingKey) {
          pendingKey = '';
          showMedia(m.src, mediaOf(m.url), true);
        }
        break;
      }
      case 'transcodedMedia': {
        const blobSrc = String(m.src);
        const previous = compatibleCache.get(m.url);
        compatibleCache.set(m.url, blobSrc);
        // Blob media is intentionally kept only for a small recency window; the disk
        // cache remains authoritative and can be read again without re-transcoding.
        if (compatibleCache.size > 8) {
          const oldest = compatibleCache.keys().next().value;
          if (oldest !== undefined && oldest !== m.url) {
            const oldSrc = compatibleCache.get(oldest);
            compatibleCache.delete(oldest);
            void oldSrc;
          }
        }
        if (m.url === ovOrigSrc && ovVisible()) {
          ovLoading(false);
          showJsmpeg(blobSrc);
        }
        break;
      }
      case 'transcodeError': {
        transcodeRequested.delete(m.url); // 关闭后重新打开时允许再次尝试
        if (m.url === ovOrigSrc && ovVisible()) {
          ovLoading(false);
          ovErr('⚠ 兼容转码失败：' + m.message);
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

  // 侧边栏宽高变化时，同时重算每页容量和页码布局。
  let resizeTimer = 0;
  const ro = new ResizeObserver(() => {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      fitCatalogPage();
      fitPaginator();
    }, 80);
  });
  ro.observe(app);

  send({ type: 'init' });
  paint();
}
