# dsh-pro

两个 DeepSeek Harness（DSH）插件，共享同一套网页传输、本地记录和侧边栏工厂。源码在一个 monorepo 里维护，发布到两个独立的 Git 仓库/两个市场条目。

| 插件 | 包名 | 做什么 | 发布仓库 |
|---|---|---|---|
| **ChatGPT Pro Research** | `chatgpt-pro-research` | 用 ChatGPT Pro 网页会话做无人值守多轮调研；按主题记录问题、轮次、裁决和最终文档。 | [chatgpt-pro-research](https://github.com/Octo-o-o-o/chatgpt-pro-research) |
| **GPT-Image Design** | `gpt-image-design` | 用同一个网页会话，或 OpenAI 兼容生图 API，生成设计图与单文件 HTML demo；侧边栏画廊预览。 | [gpt-image-design](https://github.com/Octo-o-o-o/gpt-image-design) |

> ⚠️ `web` 通道驱动的是 ChatGPT 网页（订阅额度），不是官方 API。自动化网页可能违反服务条款、触发风控或导致账号受限；页面改版也会让它失效。`api` 通道按服务商条款计费，只产出图片、不产出 HTML demo。请自行评估风险，不要把凭据写进仓库或日志。

## 选哪个

- 要**调研/对比/出报告**：装 `chatgpt-pro-research`，看 [packages/research/README.md](packages/research/README.md)。
- 要**出设计图/落地页/HTML demo**：装 `gpt-image-design`，看 [packages/design/README.md](packages/design/README.md)。
- 两个都装：共用 `~/.dsh/pro-research/browser` 登录态，只需登录一次；网页通道固定单账号、单会话。

## 安装

发布仓库（Git/dsh.pub）：

```bash
npx dshpub add Octo-o-o-o/chatgpt-pro-research
npx dshpub add Octo-o-o-o/gpt-image-design
```

或原生 DSH：

```bash
dsh plugin --profile <profile> add github:Octo-o-o-o/chatgpt-pro-research#<40-char-commit>
dsh plugin --profile <profile> add github:Octo-o-o-o/gpt-image-design#<40-char-commit>
```

npm 上现有 `0.2.x`；本仓库的 `0.3.0` 以 Git/dsh.pub 分发为准：

```bash
dsh plugin --profile <profile> add chatgpt-pro-research
dsh plugin --profile <profile> add gpt-image-design
```

安装后重启 DSH，在 **设置 → 插件** 里启用。首次使用先登录一次：

```text
pro_research(action="login")        # 或 gpt_image_design(action="login")
```

设计插件改用 API 时不需要登录：把 `channel` 设为 `api`，填 `imageBaseUrl` / `imageApiKey` / `imageModel`（key 也可来自 `GPT_IMAGE_API_KEY`），然后 `gpt_image_design(action="probe")` 自检。

## 结构

```text
packages/
  core/        # 引擎、状态机、记录、材料、产物（无浏览器依赖）
  transport/   # chatgpt.com 驱动 + OpenAI 兼容生图传输 + 图片/代码抓取 + CLI
  research/    # ChatGPT Pro Research 插件入口
  design/      # GPT-Image Design 插件入口（复用 research 的 host/client 工厂）
docs/
  design.md    # 原始设计文档
  usage.md     # 研究插件的使用说明
scripts/
  build.mjs        # 构建两个插件的 lib/
  make-icons.mjs   # 从 R/X 标记生成市场图标
  sync-dist.mjs    # 生成两个发布仓库
```

## 开发

```bash
npm install
npm test
npm run typecheck
npm run build
node scripts/smoke-bundle.mjs
```

`smoke-bundle.mjs` 会按 DSH 的方式加载两个 host bundle 与两个前端 bundle（惰性 CJS factory、共享 React、等待槽位声明），断言每个插件 1 个工具、9 条路由、2 个前端槽位。

发布仓库由 `node scripts/sync-dist.mjs` 生成；`lib/`、`resources/`、`locale/`、`icon.svg` 和 README 从本仓库同步过去。**不要直接改发布仓库的 `lib/`**。

## 验证边界

- 真实 ChatGPT 页面已验证：登录、单轮提交、附件、同会话两轮、图片生成抓取（1448×1086 PNG 抓回并解码）。
- 当前源码版本为 `0.3.0`；本机 `desktop` profile 使用本地构建产物，重启 DSH 后才加载新 bundle。
- 重启 DSH 后两个入口与路由已确认：`/chatgpt-pro-research/topics`、`/gpt-image-design/topics` 均 200 且返回空列表；侧边栏 R/X 图标经 16/32px 黑白底渲染核对。
- 设计面板的画廊与 iframe demo 目前是静态渲染/路由测试，未在 GUI 里实际点开验证。
- API 生图通道已用本地假服务验证：请求体、b64/url 落盘、参考图 multipart、401/超时/部分失败映射、取消，以及插件→引擎→`artifacts/` 的整轮流程；**未对真实服务商**（OpenAI 等）出图与计费验证。
- 未覆盖：页面改版、超长回答、真实网页断线恢复、账号风控/ToS；本地消息锚点/fixture 只证明代码路径，不等于 chatgpt.com DOM 已验收。

## 许可证

MIT。
