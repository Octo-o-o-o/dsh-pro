# Marketplace and publication receipts

核验日期：2026-10-29（Asia/Shanghai）。两个插件 **0.3.4 已发布到 GitHub Releases 和 npm**；社区市场状态逐项见下表。投稿、作者实测、市场独立验证是不同状态。

开发流程见 [RELEASING.md](RELEASING.md)，真实验证见 [0.3.4 记录](validation/release-0.3.4-2026-10-29.md)，发布文案见 [release notes](release-notes-0.3.4.md)。

## 公开版本

| 插件 | 发布仓库与 tag | main / v0.3.4 commit | npm |
| --- | --- | --- | --- |
| Research | [chatgpt-pro-research v0.3.4](https://github.com/Octo-o-o-o/chatgpt-pro-research/releases/tag/v0.3.4) | `4bd32826d1d471d091609758206e15840ba0c8f2` | [chatgpt-pro-research@0.3.4](https://www.npmjs.com/package/chatgpt-pro-research/v/0.3.4) |
| Design | [gpt-image-design v0.3.4](https://github.com/Octo-o-o-o/gpt-image-design/releases/tag/v0.3.4) | `8ef116847c9955413be98009704ac5b7e24be723` | [gpt-image-design@0.3.4](https://www.npmjs.com/package/gpt-image-design/v/0.3.4) |

- [开发仓库](https://github.com/Octo-o-o-o/dsh-pro) 代码提交 `3dab0810c8ac70592cdce7cc014d04edb1c80363` 已推送 main；[Windows / Ubuntu Node 24 CI](https://github.com/Octo-o-o-o/dsh-pro/actions/runs/40839558237) 通过。后续发布回执作为文档提交保存。
- 三个仓库均只有 main 和一个 worktree，无待合并分支、stash 或额外 worktree。两个发布仓库仍由 monorepo 生成，已提交运行时 `lib/`。
- 两个 GitHub 仓库描述已更新；README、安装说明、权限边界、图标、locale、截图、MIT LICENSE 和根 bundle 一并发布。已发布 tag 未移动。
- npm 账户认证及发布时的安全密钥认证由用户完成。两个 `npm publish --access public` 均成功，公共 registry 的 0.3.4 元数据与本机 pack 校验值一致。

| npm 包 | SHA-1 shasum | SHA-512 integrity |
| --- | --- | --- |
| chatgpt-pro-research | `1285c2cc63c79b0949bc537034b65360223d8f0b` | `sha512-NnuOFr86TT2xiRpUUon2Lp6Qqc4lDSKvVwTrDdCVRW1sa+J5407kPb6dbbjWhsB7H0Kmu64QdUhcjXCrYLd1vA==` |
| gpt-image-design | `ee4da2dca362f7abaeb27a70d4175a2dd03699ec` | `sha512-xeVwFzdN89MBS5YJD0We7/vXw991PTThZ3MhNeoGlrvyfEm5BK72nT1870cdQGyHg+ud3Y6w9aa1kQQbl728HA==` |

```sh
dsh plugin --profile <profile> add chatgpt-pro-research@0.3.4
dsh plugin --profile <profile> add gpt-image-design@0.3.4
```

安装后重启 DSH 并启用插件。声明范围 DSH `>=0.2.1-rc.3 <0.3.0`，Node.js 22+；本轮真实验收为 Windows / DSH 0.2.1-rc.3。

## 渠道回执

| 渠道 | 当前证据与状态 | 本次操作 / 回执 |
| --- | --- | --- |
| GitHub Releases | 两个 v0.3.4 均已发布 | 上方 release 链接 |
| npm | 两个 0.3.4 均已公开 | 上方 npm 链接及校验值 |
| dsh.pub | 源目录已收录两个 0.3.2；0.3.4 刷新和公开页面展示待维护者处理 | [刷新问题 #163](https://github.com/dsh-pub/dsh-pub/issues/163) |
| DSH Plugin Hub | 两个公开详情页已收录，仍显示旧版本信息；已请求刷新与修正文案 | [刷新请求 #526](https://github.com/dshplugin/dsh-plugin-hub/issues/526) |
| 开放插件市场 | 两个 0.3.4 收录申请已提交，待审核 | [Research #132](https://github.com/polang233/dsh-plugin-index/issues/132)、[Design #133](https://github.com/polang233/dsh-plugin-index/issues/133) |
| DSHX | 网页验证组件未出现、提交按钮禁用；人工收录申请已提交，待审核 | [两插件申请 #10](https://github.com/liyown/dshx/issues/10) |
| dsh.so | 本轮网页检查限流/超时，链接的投稿仓库返回 404；未取得 0.3.4 投稿成功回执 | 按其指引发布下方兼容性报告；不声称扫描通过或独立 Verified |
| DSH 官方 Discussions | 0.3.4 兼容性实测报告已公开 | [报告 #11430](https://github.com/deepseek-ai/deepseek-harness/discussions/11430) |

### dsh.pub

- [投稿规则](https://dsh.pub/zh/submit/)要求公开根 bundle、提交运行时文件。源目录 `packages/catalog/src/community.generated.json` 已包含两项，均为 `distribution.installable: true`，当前固定版本均为 0.3.2。
- Design 原 [PR #153](https://github.com/dsh-pub/dsh-pub/pull/153) 已合并。原格式问题 [#155](https://github.com/dsh-pub/dsh-pub/issues/155) 已由 [#157](https://github.com/dsh-pub/dsh-pub/pull/157) 修复，不能继续当作当前阻塞。
- Research 已通过 GitHub `dsh-plugin` topic 自动发现。更新原 PR #152 分支后，[新验证](https://github.com/dsh-pub/dsh-pub/actions/runs/40840115393) 返回 `already_listed`，因此关闭了重复的新条目 [PR #152](https://github.com/dsh-pub/dsh-pub/pull/152)，改用 #163 跟踪刷新。
- Chrome 实测 Research 旧详情链接返回 404、英文插件页精确搜索为 0。源目录收录不等于公开站点可见，#163 同时附上这一差异；本轮未声称 0.3.4 已在 dsh.pub 展示。

### DSH Plugin Hub

- 已存在：[Research](https://dsh-plugin.org/zh/plugins/octo-o-o-o/chatgpt-pro-research)、[Design](https://dsh-plugin.org/zh/plugins/octo-o-o-o/gpt-image-design)。路径中的 owner 为小写。
- [投稿说明](https://dsh-plugin.org/zh/submit)支持 topic/npm 自动索引；两个仓库保留 `dsh-plugin` topic。Research 详情仍显示 v0.3.2，因此提交 #526 请求刷新两个条目，并澄清 API 只生成图片、实际报告文件为 `report.md` / `design.md`。
- 网站自己的“已验证”标签不作为本项目独立运行验收的证据。

### dsh.so

- [提交页](https://www.dsh.so/zh/submit/)接受仓库或 npm 包名；提交前服务端重新扫描，只有独立验收后才可标为 Verified。
- 历史 2026-10-23 的两个 0.3.0 投稿曾显示“提交成功”，安全扫描为 0 critical、2 warnings（打开文件/目录使用 spawn）、10 info。这些是旧版本记录，不适用于 0.3.4。
- 本轮 Research 仓库检查报平台 API 限流，npm 检查超时；Design npm 检查报限流。站点链接的 `ihuajiu/dsh-plugin-submissions` 对已登录 GitHub 账户创建 issue 返回 404。
- 按提交页“报告兼容性实测”提供的官方 General Discussions 入口，发布了 #11430，写明实测步骤、证据、限制和投稿阻塞。保留自动发现 topic；0.3.4 的正式扫描/收录仍须平台恢复后完成。

### DSHX 与开放插件市场

- [DSHX 投稿页面](https://dshx.io/zh/plugins)精确搜索未找到两个包。Chrome 中打开投稿弹窗并输入仓库 URL 后，人机验证组件未显示，按钮禁用；未绕过验证。#10 是维护者人工收录申请，不是网页表单成功回执。
- 开放插件市场按其 `plugin-add` 模板分别提交 #132 / #133，包含版本 commit、安装方式、真实流程、权限边界和平台限制。npm 发布后已更新两份正文为公开的 0.3.4 坐标。

## 对外文案

- **Research：** DSH 中可恢复的 ChatGPT Pro 多轮网页调研，按原始成功判据逐条裁决，保存原始答复并通过工作区范围内的插件工具交付本地报告。提供侧边栏管理、恢复/取消和提交状态核对。
- **Design：** DSH 中生成设计图和 HTML demo，并保存到本地画廊。web 通道支持图片与 HTML；OpenAI 兼容 API 通道只生成图片。支持参考图迭代、可恢复轮次和 local/project 设计交付稿。
- 本轮真实研究自动 accepted；设计自动 partial 后，经实际视觉与 Start→Done 交互验证再验收。不能把设计的外部验收写成自动裁决 accepted。
- 首次登录、付费图片 API、macOS/Linux 真实端到端不在本轮验证范围。

## 后续发版

1. 更新 monorepo 源码和版本，完成测试、typecheck、build、bundle smoke 以及必要的真实流程。
2. 用 release-dist 生成两个发布仓库，检查差异后推送 main、全新 tag 和 Release；发布 npm 并核对公共 registry。
3. 先查询市场已有条目和投稿。已收录条目走刷新；不要因 `already_listed` 重复创建新条目 PR。按具体平台完成扫描、更新或审核请求。
4. 将真实成功回执、待审核状态和外部阻塞分别记录。不要移动旧 tag，不提交凭据、浏览器状态或 tarball。
