# dsh-pro

用 ChatGPT Pro 网页会话做**无人值守的多轮调研与设计**的 DeepSeek Harness 插件。

状态：**v0.1 开发中**。核心引擎、网页传输、host 插件、侧边栏与研究记录已落地并通过单测；真实网页冒烟与 npm 发布还没完成。

> ⚠️ 风险提示：本插件驱动的是 ChatGPT 网页（订阅额度），不是官方 API。自动化网页可能违反服务条款、触发风控或导致账号受限；页面改版也会让它失效。请自行评估账号风险，不要把凭据写进仓库或日志。

## 目前能做什么

- **引擎**：主题/轮次/状态机/队列、两种记录位置（project / local）、原始答复本机保存、材料清单与密钥扫描、卡住判定、人工核对、恢复。
- **传输**：Playwright 驱动独立 Chrome profile；登录、自检、提交、附件逐文件核对、轮询、取回答复。可用独立 CLI 先跑通。
- **DSH host 插件**：`pro_research` 工具（start/status/list/resume/cancel/human_check/probe/login）、设置 schema、`pro-research` / `pro-design` 两个技能、只读 HTTP 路由。
- **侧边栏**：「Pro」面板列出主题、状态、轮次、记录路径；可恢复、取消、人工核对。
- **测试**：25 个单测覆盖状态机、材料、记录布局、引擎（多轮/提前停止/到顶/卡住/恢复/取消）、插件装配（工具、路由、技能）与 client 槽位注册。

## 开发

```bash
npm install
npm test
npm run typecheck
npm run build
```

独立跑一轮真实网页（需要本机 Chrome 和一个已登录的 ChatGPT 账号）：

```bash
node packages/transport/src/cli.ts login
node packages/transport/src/cli.ts probe
node packages/transport/src/cli.ts submit --brief-file brief.md --file README.md --out answer.md
```

## 结构

```text
packages/
  core/        # 引擎、状态机、记录、材料（无浏览器依赖）
  transport/   # chatgpt.com 驱动 + CLI
  research/    # DSH host 插件 + pro-research 技能
docs/
  design.md    # 设计文档
```

## 待办

- 真实网页冒烟：登录一次，跑通一轮提交/取回/坏选择器恢复（`node packages/transport/src/cli.ts login`）。
- 侧边栏在真实 DSH 会话里的加载验证（代码与打包已就绪）。
- npm 发布：包已可 `npm pack`（23.3 kB，8 个文件）；`publish_plugin` 目前被本机临时目录的 `EPERM` 挡住，且没有 npm 发布凭据。
- Pro 设计独立成包：当前是同一插件里的第二个技能，先观察使用反馈再拆。

## 许可证

MIT，见 [LICENSE](LICENSE)。
