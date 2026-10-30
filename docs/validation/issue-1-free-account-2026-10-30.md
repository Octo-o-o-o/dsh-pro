# Research #1：0.3.6 Pro 优先与免费回退

日期：2026-10-30（Asia/Shanghai）。基线 `f774b89`；本轮按用户授权提交、发布，并在发布后回复关闭 [Research #1](https://github.com/Octo-o-o-o/chatgpt-pro-research/issues/1)。

## 修复行为

Issue 仅有“free 账号不能用”标题，无正文或报错日志。代码原先默认强制 `pro`，模型不可用或没有选择器时停止发送。

| model | 行为 |
| --- | --- |
| `prefer-pro`（默认） | 已选 Pro 时保留；否则选择可用 Pro；没有可用 Pro 才沿用网页当前模型 |
| `auto` 或旧空白值 | 保留页面当前模型，不打开模型菜单 |
| 显式 `pro`、`thinking` 等 | 按模型匹配规则核验，不可用时停止发送 |

Pro 的禁用项、锁定项与升级/定价入口不作为可用模型；候选项需可操作且不含升级标记。点击可用 Pro 后未核验选中时返回 `ui / not_sent`，保留现场，不静默回退或重复发送。没有选择器的页面回退时不编造模型标签。

Research、Design 的网页通道与传输 CLI 使用同一默认策略。Design API 仍使用独立的 `imageModel`。已有显式设置和主题模型保留；需要默认策略时设置 `model=prefer-pro` 后新建主题。

## 本地验证

Windows，Node.js `24.22.1`，本机 Google Chrome，本地页面和模型/API 替身。

| 检查 | 结果 |
| --- | --- |
| Pro 策略定向回归 | 17 passed / 19 skipped（按测试名筛选） |
| `$env:DSH_PRO_TRANSPORT_SMOKE='1'; npm test` | 36 个文件、312 项全部通过，138.75 秒 |
| `npm run typecheck` | 通过 |
| `npm run build` | 通过，生成 5 个 bundle |
| `node scripts/smoke-bundle.mjs` | 两插件各 1 工具、9 路由、2 前端槽位，均通过 |
| `node scripts/acceptance-smoke.mjs` | Research、Design、预览交互、窄窗、恢复/取消、API 编辑与故障流程全部通过 |

Chrome 回归覆盖：已选 Pro、切换可用 Pro、带版本号的 Pro、无 Pro、无选择器、aria/data/native 禁用、锁定、升级按钮、定价链接、禁用重复项后的可用 Pro、升级标题，以及可用 Pro 选择失败后的禁止发送。显式 auto 与显式模型原有行为亦通过完整回归。

本次修复构建写出：esbuild 原生写文件曾返回 Windows Access is denied，Node 可写同一目标。`scripts/build.mjs` 统一保留原构建配置，以 `write: false` 输出到内存后由 Node 保存。常规 build、release-dist 和 npm prepack 共用这一流程，无需临时包装脚本或更改系统权限。

## 发布回执

- 源码：[80cffb24ce404b23999a5ffb823c42ce458681ad](https://github.com/Octo-o-o-o/dsh-pro/commit/80cffb24ce404b23999a5ffb823c42ce458681ad)，已快进并推送 monorepo main。以下发布产物基于该代码提交；后续回执更新只改文档。
- [GitHub CI 41014497875](https://github.com/Octo-o-o-o/dsh-pro/actions/runs/41014497875)：Windows / Ubuntu、Node 24，两项 job 全部 success，均含 typecheck、测试、构建、bundle smoke、Chrome 回归和完整模拟验收。
- `release-dist --apply --skip-tests` / `--push --release --skip-tests` 成功；跳过脚本内重复测试前已完成上述完整验证。生成差异经检查，无其他本地提交夹带推送，已发布 tag 未移动。

| 插件 | main / 全新 v0.3.6 tag | Release | npm |
| --- | --- | --- | --- |
| Research | `4885c28ace9822de6199b8ef33c7fa8189de451d` | [v0.3.6](https://github.com/Octo-o-o-o/chatgpt-pro-research/releases/tag/v0.3.6) | [0.3.6](https://www.npmjs.com/package/chatgpt-pro-research/v/0.3.6) |
| Design | `48d02d20f231101d61b5865d0723dddf671aad38` | [v0.3.6](https://github.com/Octo-o-o-o/gpt-image-design/releases/tag/v0.3.6) | [0.3.6](https://www.npmjs.com/package/gpt-image-design/v/0.3.6) |

远端 main 与 tag 均核对到上表完整 commit。npm 由已验证的同一构建打包为两个 tarball（各 11 个文件），包内两份运行时 bundle 与发布仓库逐字节一致。用户完成 npm 登录与发布安全验证后，两个 `npm publish` 均成功；公共 registry 的 `0.3.6` / latest、SHA-1 与 SHA-512 均已核对。

| npm 包 | SHA-1 shasum | SHA-512 integrity |
| --- | --- | --- |
| chatgpt-pro-research | `8dfc6043c321ac9826784ed7d9975e548fc0d8a9` | `sha512-TOXQlk0uv7d+MiB7Pq0BbXBDWYynliqJxTkRLhF43T+ZGu/82JHeILRa1L0wwjdey/txVuxPUdqAXBge4tYL+w==` |
| gpt-image-design | `6023ad01e426599b405e1cb6aae91f46ea71aabe` | `sha512-zNbPqlZnf/cub0P2okhtWpsa6YdEjNv5VPhcjIvdN7F40q4gf1EZlaRE3hHN4zBaopye65mOZfHGJ30kM1WQsA==` |

Research host/client SHA-256：`faf601d53825791784fa014c9c42783ec852cb33d663c3e6002594077011379d` / `4f4b630e6a889c652644f71113c6f4b3041933415f56740fdd1ce3759c934ad3`。Design host/client：`af86d04767ad0f71c4a9677af1066aa19519b3e208054842d5a7088509bc142a` / `1405c9443f268fd547541585763b028919f325937ac2177348477860d55c445d`。

[Issue 回复](https://github.com/Octo-o-o-o/chatgpt-pro-research/issues/1#issuecomment-6516754525)已发布，包含规则、升级命令、旧配置/主题迁移、验证及真实账号边界。2026-10-30 14:47（Asia/Shanghai）按 `completed` 关闭，并重新读取确认 `closed / completed`、1 条评论。

## 验证边界

未登录或调用真实 Free 账号，未重跑真实网页问答或付费生图；真实账号的功能与额度由服务端决定。模拟与浏览器 fixture 不作为真实服务验收；托管 CI 覆盖上方 Windows / Ubuntu，不代表真实账号或 macOS 端到端验收。本机 desktop 本轮未重新部署。

本轮不刷新社区市场；既有固定版本和维护者审核状态按历史记录保留。任务开始前已有的 `artifacts/` 未改动，不进入本次提交。
