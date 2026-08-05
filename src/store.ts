import * as vscode from 'vscode';

const KEY_FAV = 'favorites';
const KEY_SFW = 'sfwOnly';
const KEY_LAST = 'lastBoard';

// 偏好持久化（收藏版块 / SFW 开关 / 上次版块），走 globalState
export class Store {
  constructor(private memento: vscode.Memento) {}

  getFavorites(): string[] {
    return this.memento.get<string[]>(KEY_FAV, []);
  }

  toggleFavorite(board: string): string[] {
    const set = new Set(this.getFavorites());
    if (set.has(board)) set.delete(board);
    else set.add(board);
    const arr = [...set];
    void this.memento.update(KEY_FAV, arr);
    return arr;
  }

  getSfwOnly(): boolean {
    return this.memento.get<boolean>(KEY_SFW, true);
  }

  setSfwOnly(v: boolean) {
    void this.memento.update(KEY_SFW, v);
  }

  getLastBoard(): string | undefined {
    return this.memento.get<string>(KEY_LAST);
  }

  setLastBoard(board: string) {
    void this.memento.update(KEY_LAST, board);
  }

  // AI 引擎的模型/BaseUrl（按引擎分别保存；非敏感，放 globalState）
  getTranslateOpt(provider: string): { model: string; baseUrl: string } {
    return this.memento.get<{ model: string; baseUrl: string }>(`translateOpt.${provider}`, {
      model: '',
      baseUrl: '',
    });
  }

  setTranslateOpt(provider: string, opt: { model: string; baseUrl: string }) {
    void this.memento.update(`translateOpt.${provider}`, opt);
  }

  getCurrentProvider(): string | undefined {
    return this.memento.get<string>('translateProvider');
  }

  setCurrentProvider(provider: string) {
    void this.memento.update('translateProvider', provider);
  }
}
