# vscode-4chan

在 VSCode 内像刷知乎/TouchFish 一样浏览 4chan 论坛（只读，摸鱼专用）。

## 功能

- 富 UI 浏览：版块列表 + Catalog 卡片网格 + 帖子楼层流
- 图片内联显示：缩略图 + 点图大图预览
- 只看 SFW / 版块收藏（偏好持久化）

## 开发

```bash
npm install
npm run watch   # 或按 F5 启动扩展宿主
```

命令面板执行 `4chan: Open Browser`（快捷键 `Ctrl+Shift+Alt+4`）。

## 数据来源

4chan 公开只读 JSON API：https://a.4cdn.org
