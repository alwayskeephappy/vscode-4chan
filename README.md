# vscode-4chan

<p align="center">
  <b>在 VS Code 内直接浏览 4chan，像刷知乎一样摸鱼。</b>
</p>

<p align="center">
  一个基于 VS Code Extension API 开发的轻量级、非官方只读 4chan 客户端，内置免费 / AI 帖子翻译。
</p>

---

## 📖 项目介绍

**vscode-4chan** 可以让你直接在 Visual Studio Code 的侧边栏中浏览 4chan 各个论坛板块。

无需在浏览器和编辑器之间频繁切换，通过原生 VS Code 界面浏览 4chan 内容，支持：

- 侧边栏板块浏览与切换
- Catalog 卡片式帖子展示
- 帖子楼层阅读与引用跳转
- 图片内联预览（点击放大，`Esc` 关闭）
- 收藏板块与 SFW 过滤
- **帖子翻译**（免费 Google / MyMemory，或 DeepSeek、智谱 GLM、OpenAI、通义千问等 AI 引擎）

专为希望在编码环境中快速浏览论坛内容的开发者设计。

> ⚠️ 本扩展是 **非官方第三方客户端（Unofficial third-party client）**，与 4chan 官方没有任何关联。

---

## ✨ 功能特性

### 🗂 板块浏览

- 浏览 4chan 可用板块
- 收藏常用板块，置顶快速切换
- SFW 过滤（默认只显示工作场合适宜的板块）

### 🧱 Catalog 卡片视图

- 现代化卡片布局
- 每张卡片展示：
  - 帖子标题 / 预览文字
  - 回复数量 / 图片数量
  - 图片缩略图

### 💬 帖子阅读

- 查看完整帖子内容
- 按楼层顺序浏览
- 帖内引用 `>>123456` 点击跳转高亮
- 外链交给系统浏览器打开

### 🖼 图片预览

- 缩略图内联展示
- 点击查看原始大图
- 按 `Esc` 或点击遮罩关闭

### 🌐 帖子翻译

- **免费引擎**：Google 翻译、MyMemory（开箱即用，无需配置）
- **AI 引擎**：DeepSeek、智谱 GLM、OpenAI、通义千问（自带 API Key 即可用）
- 单帖翻译：点击楼层上的「译」按钮
- 批量翻译：帖子页一键「翻译全部」

### ⭐ 个性化设置

- 收藏常用板块
- 本地保存用户偏好（收藏 / SFW / 上次板块）
- 当前翻译引擎选择

---

## 🚀 快速开始

### 安装

从 VS Code Marketplace 安装：

> 搜索 **vscode-4chan**

或者手动安装 `.vsix` 扩展包。

---

### 使用方式

安装后，活动栏会出现 **4chan 浏览器** 图标，点击即可打开侧边栏。

也可通过命令面板（`Ctrl + Shift + P`）执行：

```
4chan: 打开浏览器
```

默认快捷键聚焦侧边栏：

```
Ctrl + Shift + Alt + 4
```

---

## 🌍 翻译配置

点击侧边栏顶部的 ⚙ 图标，打开「翻译设置」：

1. **选择翻译引擎**：默认仅列出 2 个免费引擎；配置过 API Key 的 AI 引擎会自动出现在列表中。
2. **高级设置**：打开设置面板，为各 AI 引擎逐行填入 API Key。

支持的 AI 引擎及获取 Key 的入口：

| 引擎 | 获取 API Key |
| --- | --- |
| DeepSeek | https://platform.deepseek.com/api_keys |
| 智谱 GLM | https://open.bigmodel.cn/usercenter/apikeys |
| OpenAI | https://platform.openai.com/api-keys |
| 通义千问 | https://dashscope.console.aliyun.com/apiKey |

> 🔐 API Key 通过 VS Code 的 `SecretStorage` 安全存储于系统密钥库，**不会写入文件、不会回显**，仅在本机本扩展中使用。

---

## 🛠 开发

### 环境要求

- Node.js >= 18
- VS Code >= 1.80

### 安装依赖

```bash
npm install
```

### 常用脚本

```bash
npm run watch   # 监听构建（esbuild）
npm run build   # 生产构建
npm run check   # TypeScript 类型检查（tsc --noEmit）
npm test        # 运行测试（vitest）
```

开发调试：执行 `npm run watch` 后按 `F5` 启动 VS Code 扩展开发宿主。

---

## 📡 数据来源

- 4chan 内容：使用 4chan 官方公开的只读 JSON API

  ```
  https://a.4cdn.org
  ```

- 翻译：免费引擎走 Google / MyMemory 公开接口；AI 引擎走对应服务商官方接口（见上表）。

本扩展：

- 不修改 4chan 内容
- 不上传用户数据
- 不在外部服务器存储论坛内容
- 仅展示公开可访问的数据

---

## 🔒 隐私说明

本扩展重视用户隐私。

- 无需注册账号
- 不收集个人信息
- 不进行数据分析追踪
- 用户偏好仅保存在 VS Code 本地环境中
- **AI 翻译时**：待翻译的帖子文本会发送给你所选的翻译服务（Google / MyMemory / 对应 AI 服务商）以完成翻译；请勿在涉密内容上使用 AI 翻译。
- **API Key**：仅存储于本机系统密钥库，不会随设置同步、不会包含在仓库中。

---

## ⚠️ 免责声明

本项目是：

> 用于浏览 4chan 内容的非官方第三方客户端。

本项目：

- 并非由 4chan 开发
- 与 4chan 没有任何关联
- 未获得 4chan 官方授权或认可

扩展展示的内容均来自 4chan 用户发布的数据。

由于 4chan 是开放式讨论平台，部分板块可能包含：

- 成人内容
- 敏感话题
- 用户生成内容

用户需自行承担使用过程中的责任，并遵守所在地法律法规以及相关平台规则。

---

## 🧩 开发计划

- [x] 侧边栏 Catalog / 帖子浏览
- [x] 图片预览（点击放大 + `Esc` 关闭）
- [x] 免费 / AI 帖子翻译
- [x] 高级设置面板（API Key 集中配置）
- [ ] 高级内容过滤功能
- [ ] 主题样式自定义
- [ ] 更多阅读模式（如只看楼主、折叠楼层）
- [ ] 改进图片查看器（多图切换 / 缩放）

---

## 🤝 参与贡献

欢迎参与项目贡献！

你可以：

- 提交 Issue
- 提交 Pull Request
- 提出功能建议

如果是较大的功能调整，建议先通过 Issue 进行讨论。

---

## 📜 开源协议

本项目基于 **MIT License** 开源。

你可以自由：

- 使用
- 修改
- 分发
- Fork
- 创建衍生项目

详细信息请查看：

[LICENSE](./LICENSE)

---

## ⭐ 支持项目

如果你觉得这个扩展有帮助：

- 给项目点一个 Star ⭐
- 提交 Bug 反馈
- 分享你的使用体验

感谢你支持开源开发！
