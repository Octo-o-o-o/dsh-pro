# Marketplace and publication receipts

更新日期：2026-10-30（Asia/Shanghai）。**0.3.6** Pro 优先与免费回退更新正在发布 Git 与 npm，[当前验证及逐渠道回执](validation/issue-1-free-account-2026-10-30.md)另记。本轮不刷新社区市场，以下 0.3.5 / 0.3.4 记录为历史回执，不能由新 Git/npm 发版推定市场版本已更新。

本日后续跟进：已通过 dsh.so 站内反馈入口取得两份“已收到”回执，补交既有条目更新到 0.3.4 的请求。其检查器仍限流/超时；0.3.4 正式扫描与收录尚未确认。[结构化回执及截图](validation/marketplace-0.3.4-2026-10-29/receipts.json)保存本次结果。

开发流程见 [RELEASING.md](RELEASING.md)，真实验证见 [0.3.4 记录](validation/release-0.3.4-2026-10-29.md)，发布文案见 [release notes](release-notes-0.3.4.md)。

## Git 0.3.5 历史回执（2026-10-29）

| 插件 | main / v0.3.5 commit | Release |
| --- | --- | --- |
| Research | `78efa99002f7d4843fcf78b876f1c0aada6a7a0c` | [v0.3.5](https://github.com/Octo-o-o-o/chatgpt-pro-research/releases/tag/v0.3.5) |
| Design | `1c23f937cd66c0e90a217cb74e54e36fd0fa4f49` | [v0.3.5](https://github.com/Octo-o-o-o/gpt-image-design/releases/tag/v0.3.5) |

当时本机 desktop 两包均为 0.3.5，安装器均返回 `applied`；npm 为 0.3.4，市场记录未据 Git 发版而改写。0.3.5 阶段未再投稿或新建市场 issue/PR。

## 0.3.4 历史发布与市场对应版本

以下提交和 CI 均为 0.3.4 阶段，不是当前 main。

| 插件 | 发布仓库与 tag | v0.3.4 commit（历史） | npm |
| --- | --- | --- | --- |
| Research | [chatgpt-pro-research v0.3.4](https://github.com/Octo-o-o-o/chatgpt-pro-research/releases/tag/v0.3.4) | `4bd32826d1d471d091609758206e15840ba0c8f2` | [chatgpt-pro-research@0.3.4](https://www.npmjs.com/package/chatgpt-pro-research/v/0.3.4) |
| Design | [gpt-image-design v0.3.4](https://github.com/Octo-o-o-o/gpt-image-design/releases/tag/v0.3.4) | `8ef116847c9955413be98009704ac5b7e24be723` | [gpt-image-design@0.3.4](https://www.npmjs.com/package/gpt-image-design/v/0.3.4) |

- [开发仓库](https://github.com/Octo-o-o-o/dsh-pro) 发布代码提交为 `3dab0810c8ac70592cdce7cc014d04edb1c80363`；后续测试夹具稳定性修正到 `046a13dfde37c08eee584dae271f01287f65e4ab` 的 [Windows / Ubuntu Node 24 CI](https://github.com/Octo-o-o-o/dsh-pro/actions/runs/40845440100) 全部通过，发布 bundle 未变。本轮市场跟进仅修改文档与证据。
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
| dsh.pub | Design 公开页为 0.3.2；Research 源目录有记录但公开精确搜索为 0；两项刷新待处理 | [#163 及本轮补充](https://github.com/dsh-pub/dsh-pub/issues/163#issuecomment-6492758719) |
| DSH Plugin Hub | 两个公开详情页已收录，仍显示旧版本信息；已请求刷新与修正文案 | [刷新请求 #526](https://github.com/dshplugin/dsh-plugin-hub/issues/526) |
| 开放插件市场 | 两个 0.3.4 收录申请已提交，待审核 | [Research #132](https://github.com/polang233/dsh-plugin-index/issues/132)、[Design #133](https://github.com/polang233/dsh-plugin-index/issues/133) |
| DSHX | 网页验证组件未出现、提交按钮禁用；人工收录申请已提交，待审核 | [两插件申请 #10](https://github.com/liyown/dshx/issues/10) |
| dsh.so | 已有两项 0.3.2，检查器仍限流/超时；两份站内反馈已收到，0.3.4 刷新待处理 | 下方反馈编号、截图及既有条目链接 |
| DSH 官方 Discussions | 0.3.4 兼容性实测报告已公开 | [报告 #11430](https://github.com/deepseek-ai/deepseek-harness/discussions/11430) |

### dsh.pub

- [投稿规则](https://dsh.pub/zh/submit/)要求公开根 bundle、提交运行时文件。源目录 `packages/catalog/src/community.generated.json` 已包含两项，均为 `distribution.installable: true`，当前固定版本均为 0.3.2。
- Design 原 [PR #153](https://github.com/dsh-pub/dsh-pub/pull/153) 已合并。原格式问题 [#155](https://github.com/dsh-pub/dsh-pub/issues/155) 已由 [#157](https://github.com/dsh-pub/dsh-pub/pull/157) 修复，不能继续当作当前阻塞。
- Research 已通过 GitHub `dsh-plugin` topic 自动发现。更新原 PR #152 分支后，[新验证](https://github.com/dsh-pub/dsh-pub/actions/runs/40840115393) 返回 `already_listed`，因此关闭了重复的新条目 [PR #152](https://github.com/dsh-pub/dsh-pub/pull/152)，改用 #163 跟踪刷新。
- Chrome 实测 Research 旧详情链接返回 404、英文插件页精确搜索为 0。源目录收录不等于公开站点可见，#163 同时附上这一差异；本轮未声称 0.3.4 已在 dsh.pub 展示。
- 后续刷新并等待搜索完成：Research 仍为 0 个结果，Design 为 1 个结果。[Design 详情](https://dsh.pub/en/plugins/gpt-image-design/)可访问，版本 0.3.2，固定 commit `9706c6e4af3c428a0875a66ef36b2c9b33bc021b`。已在 #163 补充这一区别；初次核对时该 issue 仍 open、无维护者回复。

### DSH Plugin Hub

- 已存在：[Research](https://dsh-plugin.org/zh/plugins/octo-o-o-o/chatgpt-pro-research)、[Design](https://dsh-plugin.org/zh/plugins/octo-o-o-o/gpt-image-design)。路径中的 owner 为小写。
- [投稿说明](https://dsh-plugin.org/zh/submit)支持 topic/npm 自动索引；两个仓库保留 `dsh-plugin` topic。Research 详情仍显示 v0.3.2，因此提交 #526 请求刷新两个条目，并澄清 API 只生成图片、实际报告文件为 `report.md` / `design.md`。
- 网站自己的“已验证”标签不作为本项目独立运行验收的证据。
- 本轮重新加载两个详情页，版本均仍为 v0.3.2，页面最后更新 2026-10-26；#526 仍 open、无回复，未重复创建刷新申请。

### dsh.so

- [提交页](https://www.dsh.so/zh/submit/)接受仓库或 npm 包名；提交前服务端重新扫描，只有独立验收后才可标为 Verified。
- 历史 2026-10-23 的两个 0.3.0 投稿曾显示“提交成功”，安全扫描为 0 critical、2 warnings（打开文件/目录使用 spawn）、10 info。这些是旧版本记录，不适用于 0.3.4。
- 本轮 Research 仓库检查报平台 API 限流，npm 检查超时；Design npm 检查报限流。站点链接的 `ihuajiu/dsh-plugin-submissions` 对已登录 GitHub 账户创建 issue 返回 404。
- 按提交页“报告兼容性实测”提供的官方 General Discussions 入口，发布了 #11430，写明实测步骤、证据、限制和投稿阻塞。保留自动发现 topic。
- 后续在全部验证等级中搜索，确认两个既有条目均已公开：[Research](https://www.dsh.so/zh/artifact/chatgpt-pro-research/)、[Design](https://www.dsh.so/zh/artifact/gpt-image-design/)。安装命令、安全扫描及页面的 L5 记录绑定 **v0.3.2**，不能据此声称 0.3.4 已收录或验证。
- 本轮重新提交检查：Research GitHub URL 返回“平台 API 触发限流”，Design GitHub URL 返回“请求超时”；已登录 `gh` 再次访问站点链接的投稿仓库仍为 404。
- 找到可用的[站内反馈入口](https://www.dsh.so/zh/feedback/)，网站确认已收到：
  - `01a186eb-d8a8-7638-af3b-1e8fd96f714c`：检查器阻塞、投稿仓库 404、两个发布坐标及正常人工审核请求。[回执截图](validation/marketplace-0.3.4-2026-10-29/dsh-so-feedback-received.jpg)
  - `01a186f0-ae03-79d5-ba45-62194ad1bedf`：关联上一编号，补充两个既有 0.3.2 条目，明确请求刷新到 0.3.4，重新采集 manifest 并执行正常扫描/验证，避免重复条目。[回执截图](validation/marketplace-0.3.4-2026-10-29/dsh-so-refresh-received.jpg)
- 两次只提交公开的 Git/npm 坐标、兼容范围、作者实测链接及公开 GitHub 联系方式。站内反馈送达已完成；正式投稿成功、0.3.4 版本刷新和平台独立验证仍待维护者处理，不能由作者侧盖章完成。

### DSHX 与开放插件市场

- [DSHX 投稿页面](https://dshx.io/zh/plugins)精确搜索未找到两个包。Chrome 中打开投稿弹窗并输入仓库 URL 后，人机验证组件未显示，按钮禁用；未绕过验证。#10 是维护者人工收录申请，不是网页表单成功回执。
- 开放插件市场按其 `plugin-add` 模板分别提交 #132 / #133，包含版本 commit、安装方式、真实流程、权限边界和平台限制。npm 发布后已更新两份正文为公开的 0.3.4 坐标。
- 本轮 GitHub 读取 #132、#133 和 DSHX #10 均为 open、0 条回复。DSHX 刷新后的两个包名精确搜索均为 0；重新打开投稿弹窗并填写 Research URL 后仍提示人机验证失败，未显示可操作的验证组件且按钮禁用。[阻塞截图](validation/marketplace-0.3.4-2026-10-29/dshx-verification-blocked.jpg)。保留已有人工申请。

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
