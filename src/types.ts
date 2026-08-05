// 4chan 公开 JSON API 的类型定义（只取用到的字段）

export interface Board {
  board: string; // 版块 id，如 "g"
  title: string;
  description: string;
  ws_board: number; // 1 = worksafe (SFW)
}

export interface Post {
  no: number;
  now: string; // 形如 "24/01/01(Wed)12:34:56"
  time: number;
  name?: string;
  sub?: string; // 主题
  com?: string; // 正文 HTML
  tim?: number; // 图片 id
  ext?: string; // 图片扩展名，如 ".jpg"
  w?: number;
  h?: number;
  replies?: number;
  images?: number;
  sticky?: number;
  id?: string; // poster id
}

// 目录里每个线程的 OP 帖子，携带汇总统计
export type Thread = Post;

export interface CatalogPage {
  page: number;
  threads: Thread[];
}
