// VSCode 注入的 webview 全局
declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
  getState<T>(): T | undefined;
  setState(state: unknown): void;
};
