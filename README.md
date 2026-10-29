# dsh-pro

两个 DeepSeek Harness（DSH）插件，共享同一套网页传输、本地记录和侧边栏工厂。源码在一个 monorepo 里维护，发布到两个独立的 Git 仓库/两个市场条目。

| 插件 | 包名 | 做什么 | 发布仓库 |
|---|---|---|---|
| **ChatGPT Pro Research** | `chatgpt-pro-research` | 用 ChatGPT Pro 网页会话做无人值守多轮调研；按主题记录问题、轮次、裁决、运行汇总与宿主交付稿。 | [chatgpt-pro-research](https://github.com/Octo-o-o-o/chatgpt-pro-research) |
| **GPT-Image Design** | `gpt-image-design` | 用同一个网页会话，或 OpenAI 兼容生图 API，生成设计图与单文件 HTML demo；侧边栏画廊预览。 | [gpt-image-design](https://github.com/Octo-o-o-o/gpt-image-design) |

> ⚠️ `web` 通道驱动的是 ChatGPT 网页（订阅额度），不是官方 API。自动化网页可能违反服务条款、触发风控或导致账号受限；页面改版也会让它失效。`api` 通道按服务商条款计费，只产出图片、不产出 HTML demo。请自行评估风险，不要把凭据写进仓库或日志。

## 选哪个

- 要**调研/对比/出报告**：装 `chatgpt-pro-research`，看 [packages/research/README.md](packages/research/README.md)。
- 要**出设计图/落地页/HTML demo**：装 `gpt-image-design`，看 [packages/design/README.md](packages/design/README.md)。
- 两个都装：共用 `~/.dsh/pro-research/browser` 登录态，只需登录一次；网页通道固定单账号、单会话。

## 安装

> 当前源码版本为 `0.3.5`：材料与文件真实路径校验、API 密钥/重定向/响应上限、计费任务清理、恢复/预算/取消及汇总归属加固。完整方案见[双插件审查](docs/review-0.3.5.md)，结果见[本轮验证](docs/validation/release-0.3.5-2026-10-29.md)。

| 渠道 | 当前版本 | 状态 |
|---|---|---|
| 本仓库源码 | `0.3.5` | 本轮候选构建，验证后发布 |
| 公开 Git 仓库 | `0.3.4` → `0.3.5` | 本轮验证通过后推送两个全新 `v0.3.5` tag |
| npm | `0.3.4` | 已公开；本轮不发布 npm，尚不包含 0.3.5 加固 |
| 社区市场 | 各渠道独立 | 不能由 Git 发版推定市场更新；见[逐渠道回执](docs/marketplace.md) |

发布仓库（Git/dsh.pub）当前可用的安装方式：

```bash
npx dshpub add Octo-o-o-o/chatgpt-pro-research
npx dshpub add Octo-o-o-o/gpt-image-design
```

或原生 DSH（把 `<40-char-commit>` 换成公开仓库 Release/提交记录里的完整 SHA）：

```bash
dsh plugin --profile <profile> add github:Octo-o-o-o/chatgpt-pro-research#<40-char-commit>
dsh plugin --profile <profile> add github:Octo-o-o-o/gpt-image-design#<40-char-commit>
```

已发布的 Git 版本见 [发布记录](docs/RELEASING.md)；版本变更见 [CHANGELOG](CHANGELOG.md)。

安装后重启 DSH，在 **设置 → 插件** 里启用。首次使用先登录一次：

```text
pro_research(action="login")        # 或 gpt_image_design(action="login")
```

设计插件改用 API 时不需要登录：把 `channel` 设为 `api`，填 `imageBaseUrl` / `imageApiKey` / `imageModel`（key 也可来自 `GPT_IMAGE_API_KEY`），然后 `gpt_image_design(action="probe")` 自检。

## 第一次用

先跑一个不需要准备材料的单轮主题，确认登录、提交、取回和面板都正常：

- Research：两个方案 + 一张取舍表 + 一个未决问题，`rounds=1`，不传 `materials`。
- Design（web）：一张首屏图 + 一个带按钮交互的单文件 HTML，`rounds=1, designs=1`。
- Design（api）：一张图，`rounds=1, designs=1`；此通道不产出 HTML。

可复制的命令见两个包的 README；真实产物入口见 [examples](examples/README.md)。

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
  product-review.md  # 0.3.2 之后的产品补强评审与实施顺序
scripts/
  build.mjs          # 构建两个插件的 lib/
  make-icons.mjs     # 从 R/X 标记生成市场图标
  sync-dist.mjs      # 生成两个发布仓库
  release-dist.mjs   # 校验/构建/同步/提交/推送发布仓库
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

完整开发/发版流程、版本与 tag 规则、市场重新提交步骤见 [docs/RELEASING.md](docs/RELEASING.md)。常用命令：

```bash
node scripts/release-dist.mjs --check    # 校验 + 测试，不写文件
node scripts/release-dist.mjs --apply    # build + smoke + sync + 本地提交
node scripts/release-dist.mjs --push     # 推送两个发布仓库 + v<version> tag
```

## 当前验证（0.3.5）

本轮安全/恢复修复方案见 [审查与实施方案](docs/review-0.3.5.md)，自动回归、Chrome 替身验证、本机部署与 Git 发布回执见 [0.3.5 记录](docs/validation/release-0.3.5-2026-10-29.md)。未因代码加固重新调用真实 ChatGPT 或付费生图服务，不把替身测试冒充真实服务验收。

## 历史验证（0.3.4 / 0.3.3）

[0.3.4 记录](docs/validation/release-0.3.4-2026-10-29.md)包含真实研究自动裁决、真实设计图片/HTML 与实际交互，以及 local 交付；[0.3.3 记录](docs/validation/release-0.3.3-2026-10-29.md)保留更早的恢复与网页识别复核。历史结果只绑定其版本，不替代 0.3.5 验证。

## 历史验证（0.3.2）

完整证据与限制见 [独立复核与发布验收](docs/validation/release-0.3.2-2026-10-25.md)。

| 项 | 结果 | 边界 |
|---|---|---|
| 回归测试 | 172 passed / 2 skipped；另启用浏览器 smoke 2/2 通过 | 假服务与浏览器 fixture 不代表真实服务商质量 |
| 类型、构建、bundle | 通过 | 每个插件 1 工具、9 路由、2 前端槽位 |
| 干净 profile | 两个 0.3.2 安装包加载通过 | 与源码 bundle 哈希一致 |
| 本机 DSH 客户端 | 约 520–2560 像素窗口，含短窗、深浅主题、长标题、多轮、坏图和旧交付稿 | Windows，DSH 0.2.1-rc.3 |
| 真实网页闭环 | 1 轮提交、回答取回、逐条自动裁决通过 | 重裁决复用保存答案，未重复网页提交 |
| API 定向改图 | 本地假服务验证选定底图、请求、错误与恢复 | 未对真实生图服务商质量或计费验收 |

本轮没有重跑真实网页图片 + HTML 生成，也未覆盖所有账号风控、页面改版和真实断线场景。设计图的视觉质量仍由用户确认。

## 许可证

MIT。
