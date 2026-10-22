# dsh-pro

用 ChatGPT Pro 网页会话做**无人值守的多轮调研与设计**的 DeepSeek Harness 插件。

状态：**v0.1 开发中，尚不可安装**。核心引擎、网页传输和 host 插件已落地；侧边栏、Pro 设计入口、真实网页冒烟与 npm 发布还没完成。

> ⚠️ 风险提示：本插件驱动的是 ChatGPT 网页（订阅额度），不是官方 API。自动化网页可能违反服务条款、触发风控或导致账号受限；页面改版也会让它失效。请自行评估账号风险，不要把凭据写进仓库或日志。

## 目前能做什么

- **引擎**：主题/轮次/状态机/队列、两种记录位置（project / local）、原始答复本机保存、材料清单与密钥扫描、卡住判定、人工核对、恢复。
- **传输**：Playwright 驱动独立 Chrome profile；登录、自检、提交、附件逐文件核对、轮询、取回答复。可用独立 CLI 先跑通。
- **DSH host 插件**：`pro_research` 工具（start/status/list/resume/cancel/human_check/probe/login）与 `pro-research` 技能；研究卡确认、成功判据、无人值守。
- **测试**：18 个单测覆盖状态机、材料、记录布局与引擎的多轮/提前停止/到顶/卡住/恢复/取消。

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

- 侧边栏研究列表与详情（host 记录已就绪，缺 client 面板）。
- Pro 设计入口（复用同一引擎，只换 brief 与产物模板）。
- 真实网页冒烟：登录一次，跑通一轮提交/取回/坏选择器恢复。
- npm 发布与市场收录；发布前确认包名与许可证。

## 许可证

MIT，见 [LICENSE](LICENSE)。
