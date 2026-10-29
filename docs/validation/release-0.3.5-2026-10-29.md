# 0.3.5 双插件验证与发布记录

日期：2026-10-29，Asia/Shanghai。范围：两个插件及共享 core/transport。用户授权了审查、实施、复审、本机部署和三个 GitHub 仓库推送；未授权本轮真实付费生成、npm 或市场重提，因此没有进行这些操作。

> 本机最终复审、实体安装和三个仓库/两个 Release 已完成；当前收尾为远端 CI。运行应用结论来自安装器明确的 applied，不由磁盘版本推断；当前桌面 GUI 视觉及本轮真实服务验证仍明确不覆盖。

## 基线与环境

- Windows 11 x64；Node 24.22.1；npm 11.19.1；DSH 0.2.1-rc.3，desktop profile。
- 源码基线 `3978670`；研究分发基线 `4bd32826d1d471d091609758206e15840ba0c8f2`；设计分发基线 `8ef116847c9955413be98009704ac5b7e24be723`。三个工作区开始时干净。
- 原安装版本均 0.3.4，实体目录而非开发链接；保留既有配置、主题、原始答复和浏览器登录态。
- 基线完整测试 193 passed / 15 skipped。15 项为条件 Chrome 测试，不算基线通过。

## 发现与实施

完整方案在 [双插件审查](../review-0.3.5.md)。优先处理已复现的实际问题，非扩展新功能：

1. 材料真实路径逃逸、敏感目标别名、已验证来源被覆盖。
2. 预览/产物/原生打开/ZIP 的目录链接越界、有界读取落在分配之后；同时校验被替换的缓存主题目录，拒绝缺失的清单附件。
3. API probe 明文 HTTP/配置检查缺口、跨源重定向携带 `api-key`、致命并发错误遗留外发、无界响应与错误密钥脱敏。
4. 已裁决轮与下轮间恢复错误、失败重试额外发放轮次预算、裁决取消被后到结果覆盖、接受新结果误用旧 final 摘要。
5. 版本与渠道文档失真；本轮 Git 0.3.5 与 npm 0.3.4、市场独立版本明确分开。GitHub Release 安装命令固定实际发布 commit。

## 回归证据

- 引擎/材料新增 17 项：旧实现 15 failed / 2 passed；修复后 17 passed。相关 core 78/78 通过。
- HTTP/ZIP 真实目录链接两项：旧实现能读取/打包越界内容，新增回归先得到 2 failed；修复后通过。只在唯一临时目录写入非敏感 marker，无用户数据。
- API 新安全用例最初 23/23 在旧实现失败；自审还复现了返回响应头时恰逢超时的分类窗口。最终安全 34 项、有界 reader 9 项；transport/design 范围 91 passed / 15 skipped。
- 第一轮完整整合：32 文件通过/2 文件跳过，259 passed / 15 skipped（274 总项）；typecheck、build、两个 bundle smoke 全通过。
- **最终完整整合连续两遍**：34 文件通过/2 条件文件跳过，每遍 **274 passed / 15 skipped（289 总项）**，相较基线新增 81 项；无改 skip、无删除业务断言。之后 typecheck、build、两个 bundle smoke 全通过，显式 Chrome 与 acceptance 也重跑通过。
- 显式启用 `DSH_PRO_TRANSPORT_SMOKE=1`：Chrome page-state 11 项与 transport 4 项，共 15 passed（71.99 秒），不再把条件 skip 当通过。
- 构建后真实 Cordis + Chrome + 替身网页/图片 API 的 acceptance 10 组全通过：首用确认、研究裁决/报告、UI 单轮继续、PNG/HTML 实际按钮、定向改图与窄屏弹窗、进程恢复零重发、显式恢复、取消、检索/明暗/布局、API 进程丢失与明确再生成。证据在忽略的本机临时目录，不提交浏览器/账号数据。
- 交叉复审补发现并修复：裁决终态 save 挂起时取消，completed/capped/reviewing 三分支仍可能覆盖取消。新增三分支 × save 前/已落盘但返回前共 6 个 barrier 回归，旧实现 6 failed，修复后全通过；无 runner 的已完成主题取消仍幂等。引擎范围 74/74 通过，并已纳入最终两遍全套。
- 归档边界：新代首个 RoundRecord 记入前 I/O 失败再接受，旧代码覆盖上一代 attempt-01；真实目录回归先 red，优先当前 generation 修复后 green，上一代字节与新代 final 指针均验证。
- 写侧边界：目录链接下的代码/问题/raw 写入、ZIP 解压与暂存材料 5 项，旧实现 4 failed / 1 passed，修复后 5 passed。原子写、返回产物及追加记录采用真实父目录，逐级校验后创建目录，最终文件链接拒绝；ZIP 只容错解析错误，不吞写入边界错误。相关 26/26 通过。
- 别名项目根正向兼容：复审发现材料先 canonicalize 再按 lexical 根二次授权会误拒正常 junction 项目。新正向回归先 red，维持真实路径预检、原子写入传原词法目标后 green；写边界合计 6/6。
- 最终整合曾出现一次 `judge-runtime/provider-error` 清理时 ENOTEMPTY，业务断言已通过，但 disposer 未被等待，运行器仍在落盘。修为 service.dispose 返回 Cordis 可等待 Promise，settle 后才释放浏览器；替身也按 Cordis 的逆序 await 清理，不增加删除重试、不改业务期望。随后最终全套重复运行。

## 读取上限与兼容变化

- 文本预览 2,000,000 字节；单产物和逐轮 ZIP 共 100 MiB；原始答复读取 16 MiB；元数据/报告/裁决有单独上限。先检查 stat，仍限制实际读取以覆盖读取中增长。
- API：模型列表 1 MiB，错误正文 8 KiB，下载图片 50 MiB；图片 JSON 按一张 50 MiB 图片的 base64 预算另留有限 metadata。无 Content-Length、虚假小长度及解压后字节也受限制。
- 每方向请求 `n=1`，拒绝响应返回多项；并发仍为 2，已有非致命部分成功和 429 一次回退规则保留。
- 所有 API/图片下载重定向（包括同源）都失败关闭；使用最终直达 endpoint/图片 URL。跨源 CDN 直链不带 API key。只有本机回环允许 HTTP，远程必须 HTTPS。
- 新运行汇总带 generation/throughRound 归属；legacy/过期 final 在人工接受时保守重建，不臆造自动摘要；当前匹配摘要保留。

## 已验证构建 SHA256

| 产物 | SHA256 |
| --- | --- |
| research `lib/index.js` | `10216ad81d5e8b72f503795af8d1e2cdd6a4842e1a4f01fa52f4df58d8c55413` |
| research `lib/client.js` | `4f4b630e6a889c652644f71113c6f4b3041933415f56740fdd1ce3759c934ad3` |
| design `lib/index.js` | `387c08245da17bfed536d38790b10017b93498f539334533a73d91e48ed0df98` |
| design `lib/client.js` | `1405c9443f268fd547541585763b028919f325937ac2177348477860d55c445d` |

本表绑定最终两遍完整测试后构建、显式 Chrome 15/15（71.69 秒）和 10 组 acceptance 的同一份 bundle。最终隔离证据目录 `.tmp/acceptance-20261028/run-TJ9vp1` 被忽略，不提交用户/浏览器数据。

## 本机安装与运行状态

最终复审通过后，从两个已生成发布仓库执行 `npm pack --ignore-scripts`，每包实际 11 个文件，均包含 Host/Client lib、两语言 locale、图标、根 bundle patch、README、MIT LICENSE、面板截图和技能资源；无 node_modules、git、环境文件或其他 tarball。

| 包 | tarball 字节 | tarball SHA256 | 安装结果 |
| --- | --- | --- | --- |
| chatgpt-pro-research 0.3.5 | 255260 | `f022dcc79612afed167f233642f373899a094bcb56ebb2e8b809a6b295a1dd15` | `application: applied`，exitCode 0，warnings `[]` |
| gpt-image-design 0.3.5 | 273386 | `3dfeab000e0c4f8f3931a7ea597ed971391311b8cba26448d760c7349eeebe93` | `application: applied`，exitCode 0，warnings `[]` |

两包在 23:30/23:31 经 `plugin_manager install_bundle` 安装至当前 desktop profile，实体目录而非 link。未手写 profile 清单，未手动执行 profile 包管理器，未放宽版本范围/添加豁免。安装器明确返回 applied（不是 restart-required），据此记录运行应用状态，而非由磁盘版本或 Slot id 推断。

安装后：

- 两个安装 manifest 都回读为 0.3.5；Host/Client lib、locale、icon、patch 与已验证源码构建逐字节 SHA256 一致。
- 两个 Config live entry 仍为 schema 状态；Client `main` 和 `sidebar.panellist` 中两个插件均有 active 注册。此处只证明注册，不据此证明浏览器已加载新字节或视觉结果。
- 两个已存在 local 主题的 `status` 调用成功；进一步回读 local 交付稿。部署前后全部 12 个既有 topic.json 哈希未变，既有配置和登录态未手动修改，没有新发外部任务。
- 安装日志有 Electron crashpad 管道提示及 pnpm peer-dependency 警告；两次包管理退出 0、管理器无应用 warnings，非激活失败。peer/engine 约束未变，不宣称整个 profile 的依赖诊断全无警告。
- 图标/双语言元数据保留原有产品内容，实际 pack 与安装资源均核对；没有默认模板资源替换。实际桌面页的图标与主题视觉仍未目视验收。

当前 Playwright 能访问 GUI URL，但未认证页面返回 401；不读取或搜寻认证凭据。隔离 acceptance 的 UI 证据不等同于当前 desktop 进程的真实页面视觉验收。

## GitHub 回执

| 仓库 | 对应提交 | 远端结果 |
| --- | --- | --- |
| [源码 dsh-pro](https://github.com/Octo-o-o-o/dsh-pro) | 运行源码 `5ccd44d1e50ec3e0800dbcfb37ea10d2f1fd313f`；初次部署回执 `0deb22bf8833b89931daa22c4e06308bbd0c5f6a` | main 已推送；后续只补路径测试期望与本验证记录 |
| [chatgpt-pro-research](https://github.com/Octo-o-o-o/chatgpt-pro-research) | `78efa99002f7d4843fcf78b876f1c0aada6a7a0c` | main / v0.3.5 同 SHA，[正式 Release](https://github.com/Octo-o-o-o/chatgpt-pro-research/releases/tag/v0.3.5) 已公开 |
| [gpt-image-design](https://github.com/Octo-o-o-o/gpt-image-design) | `1c23f937cd66c0e90a217cb74e54e36fd0fa4f49` | main / v0.3.5 同 SHA，[正式 Release](https://github.com/Octo-o-o-o/gpt-image-design/releases/tag/v0.3.5) 已公开 |

两个全新 tag 均未修改旧 tag。两个 Release 均非 draft、非 prerelease，并上传了实际安装的 tgz 和 SHA256SUMS；GitHub API 的 asset digest 与上表 tarball SHA256 完全相同。tgz 不进 Git；不提交浏览器/用户数据。npm 官方 registry 再查两包最新仍为 0.3.4，本轮没有 npm 发布或市场重提。

远端首轮 [CI 40903297873](https://github.com/Octo-o-o-o/dsh-pro/actions/runs/40903297873)：Ubuntu 的 npm ci、类型、常规测试、build、bundle smoke、Chrome 15 项和 acceptance 全部通过。Windows 273 passed / 1 failed：旧测试期望 `RUNNER~1` 短路径字符串，新安全接口正确返回规范长路径；失败是期望未 canonicalize，而非越界访问或附件缺失。将期望改为 `await realpath(具体预期文件)` 的精确比较，保留文件内容/manifest 断言；未改运行代码、未 skip、未放宽路径包含判断。后续完整 CI 重跑，结果待核实后补齐。

## 不覆盖与保留事项

- 本轮未新开真实 ChatGPT 调研/设计主题，未调用真实付费图片服务；旧版 0.3.4 的真实服务证据不迁移为本版验收。
- macOS/Linux 未实机验证；文本裁决不证明图片视觉质量。
- 不自动清理未知所有权 `.report.lock`；保守拒绝优先于覆盖其他写入者。
- npm 仍为 0.3.4；社区市场记录见 [渠道回执](../marketplace.md)。
