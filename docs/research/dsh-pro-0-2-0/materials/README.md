# dsh-pro

两个 DeepSeek Harness 插件，共享同一套网页传输与本地记录：

| 插件 | npm 包 | 做什么 |
|---|---|---|
| **ChatGPT Pro Research** | `chatgpt-pro-research` | 用 ChatGPT Pro 网页会话做无人值守多轮调研；按项目/主题记录问题、轮次、裁决和最终文档。 |
| **GPT-Image Design** | `gpt-image-design` | 用同一个网页会话生成设计图与前端 HTML demo；图片和代码保存到本地，在设计面板里画廊预览、iframe 打开 demo。 |

> ⚠️ 两者驱动的是 ChatGPT 网页（订阅额度），不是官方 API。自动化网页可能违反服务条款、触发风控或导致账号受限；页面改版也会让它失效。请自行评估账号风险，不要把凭据写进仓库或日志。

## 安装

```bash
dsh plugin --profile desktop add chatgpt-pro-research
dsh plugin --profile desktop add gpt-image-design
```

两个插件共用 `~/.dsh/pro-research/browser` 登录态，只需登录一次：

```text
pro_research(action="login")        # 或 gpt_image_design(action="login")
```

## 结构

```text
packages/
  core/        # 引擎、状态机、记录、材料、产物（无浏览器依赖）
  transport/   # chatgpt.com 驱动 + 图片/代码抓取 + CLI
  research/    # ChatGPT Pro Research 插件入口
  design/      # GPT-Image Design 插件入口（复用 research 的 host/client 工厂）
docs/
  design.md    # 原始设计文档
  usage.md     # 研究插件的使用说明
```

## 开发

```bash
npm install
npm test
npm run typecheck
npm run build
node scripts/smoke-bundle.mjs
```

`smoke-bundle.mjs` 会按 DSH 的方式加载两个 host bundle 与两个前端 bundle（惰性 CJS factory、共享 React、等待槽位声明），断言每个插件 1 个工具、4 条路由、2 个前端槽位。

## 验证边界

- 真实 ChatGPT 页面已验证：登录、单轮提交、附件、同会话两轮、图片生成抓取（1448×1086 PNG 抓回并解码）。
- npm 已发布 `chatgpt-pro-research@0.2.0` 与 `gpt-image-design@0.2.0`；`desktop` profile 已切到 npm 版本。
- 重启 DSH 后两个入口与路由已确认：`/chatgpt-pro-research/topics`、`/gpt-image-design/topics` 均 200 且返回空列表；侧边栏 R/X 图标经 16/32px 黑白底渲染核对。
- 设计面板的画廊与 iframe demo 目前是静态渲染/路由测试，未在 GUI 里实际点开验证。
- 未覆盖：页面改版、超长回答、断线恢复、账号风控/ToS。

## 许可证

MIT。
