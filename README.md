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

> 当前 Git 版本为 `0.3.3`，包含恢复、网页完成识别与交付稿修复。使用两个公开仓库的 `v0.3.3` tag；npm 本次暂缓更新。验证范围和剩余缺口见[复核记录](docs/validation/release-0.3.3-2026-10-29.md)。

| 渠道 | 当前版本 | 状态 |
|---|---|---|
| 本仓库源码 | `0.3.3` | 与本次验证构建一致 |
| 公开 Git 仓库 | `0.3.3` | 两个仓库的 `v0.3.3` tag |
| dsh.pub | `0.3.0` 提交 | 待收录；受上游格式问题阻塞 |
| npm | `0.2.6` | 本次暂缓发布；不包含本版改进 |

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

## 当前验证（0.3.3）

见 [2026-10-29 复核与发布记录](docs/validation/release-0.3.3-2026-10-29.md)。本轮包含单元/集成、真实 Chrome 本地网页与双插件隔离流程；不是独立第三方验收。真实账号首次登录、设计裁决异常根因和付费 API 仍待验证。

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
