# 0.3.5 双插件审查与实施方案

日期：2026-10-29（Asia/Shanghai）。范围：`chatgpt-pro-research`、`gpt-image-design` 及共享 core/transport。用户已授权审查、实施、复审、本机部署及三个 GitHub 仓库完整推送。

## 基线与原则

- 三个仓库 main 工作区干净；源码当前提交 `3978670`，两个发布仓库为 0.3.4。
- Windows 11 / Node 24.22.1 / DSH 0.2.1-rc.3；本机 desktop 已启用两个 0.3.4 实体包。
- 基线：`npm test` 为 193 passed / 15 skipped。跳过项是需显式启用的 Chrome 条件测试，不算已通过。
- 唯一源码为 monorepo；两个公开发布仓库只通过 sync-dist/release-dist 生成，不直接修生成文件。
- 不覆盖用户改动、不移动旧 tag、不提交凭据/用户数据/tarball。保留原 topic 和登录态。
- 本次不自动发布 npm、不提交或刷新社区市场；其既有版本状态独立记录。

## 经源码/本地复现确认的缺口与修法

| 优先级 | 缺口 | 实施与验收 |
| --- | --- | --- |
| P1 | 材料仅做词法范围/secretGlobs 检查；symlink/junction 可指向工作区外或敏感原目标 | 校验真实根与文件路径，对原始名和真实名均做敏感路径检查，保留已验证来源；测越界目录链接、敏感目标别名和正常材料 |
| P1 | HTTP 文件/产物/本机打开与逐轮 ZIP 未覆盖真实路径逃逸；部分大小限制发生在完整读取后 | 共享真实路径与有界读取策略；预览、asset、raw、open、ZIP 拒绝越界链接，先检查/限制读取；保留正常 HTML sandbox 与下载行为 |
| P1 | 交叉复审发现写侧仍可通过 rounds/artifacts/raw 目录链接覆盖根外文件，ZIP 写入错误还会被当成坏压缩包吞掉 | 将原子写入、返回代码/图片/解压文件、暂存材料和追加记录接入真实目录边界；逐级检查后才创建子目录，边界错误不能吞掉；新回归旧源码 4 failed / 1 passed |
| P1 | API probe 不执行 submit 的协议校验，远程 HTTP 可明文发送 key | 请求前共用配置检查，非法 URL/远程 HTTP/非 HTTP(S) 不发生 fetch；本机 loopback HTTP 仍可用于测试/本地服务 |
| P1 | Node fetch 默认跨源重定向保留自定义 api-key，连同 prompt 可能发往非配置来源 | 显式控制所有 API/probe/edit/download 重定向，不自动外带鉴权或重放生成请求；测跨端口 302/307 和非法降级 |
| P1 | 并发生图一个 lane 致命失败后，其他 lane 可能继续发付费请求 | 失败时终止同 job 其余工作并等待清理，不丢弃已按既定规则返回的部分成功结果；测试后续方向零外发及无遗留 runner |
| P2 | API JSON/错误正文先整体读取，图片解码上限不能限制此前 JSON 内存 | 为 models、generation/edit JSON、错误正文设置独立流式字节上限，超限取消 reader，保持清晰错误；测无 content-length/chunked 响应 |
| P1 | 已裁决轮与下轮之间中断，resume 错接已回答旧轮，出现 waiting→uploading 非法转换 | 已回答且已裁决轮恢复为排队的下一步，不重新接回旧轮；测只新增授权下轮、不重发旧轮 |
| P1 | 同代后段失败后 continue 重试，以最后轮次重新给予完整代际预算，可能超出授权轮次 | 预算以本代首轮为基点，不给已消费轮次重新发额度；保留有效 runThrough，显式单轮继续仍只加一轮；测第 3 轮失败重试不变成第 3–5 轮 |
| P1 | 末轮裁决期间取消，后到的裁决或挂起终态 save 仍可能写 completed/capped/reviewing | signal 贯穿模型与终态提交；同一仍拥有的已取消 run 可撤回其迟到完成，不放宽全局状态机；首试/重试 6 分支及终态 save 前/返回前 6 个屏障都保持 cancelled，无迟到 finished/judge_failed |
| P2 | regenerate/continue 后裁决失败再 accept，可能把旧 final 摘要归档到新代 | 核对当前 generation/轮次的运行汇总归属，必要时重建无自动摘要的真实汇总；测新旧代隔离、轮次表与人工接受语义 |
| P2 | 插件清理未向 Cordis 返回可等待 Promise，卸载/测试清理可与迟到落盘并发 | 返回并 await 有界 engine settle，再释放共享浏览器；测试替身按逆序 await disposer，不靠重试/放宽业务断言遮盖 ENOTEMPTY |
| P2 | 根 README、CHANGELOG 的当前版本/渠道口径落后于实际发布 | 补 0.3.4 历史变更和 0.3.5 当前说明，分开 Git/npm/市场，记录本轮验证边界与实际回执 |

## 实施分工

1. 共享引擎/材料：修复来源校验、恢复、裁决取消与接受后汇总；补 core 回归。
2. 设计传输：修复 probe、重定向、流式响应上限、并发失败清理；补纯替身与本机 HTTP 回归，不调用真实付费服务。
3. 主宿主：修复共享文件访问/ZIP/HTTP 路由，整合裁决取消 signal，更新版本与文档；审查两个子任务的实现和证据。

## 复审与验证门槛

- 每项有针对性回归，优先先确认旧行为确实失败，再验证修复。
- 完整 `npm test`、`npm run typecheck`、`npm run build`、`node scripts/smoke-bundle.mjs`。
- 显式运行 Chrome DOM/transport 条件测试，以及构建后真实 Cordis + Chrome + 替身服务 acceptance；与真实 ChatGPT/真实付费 API 验证分开描述。
- 再次独立审查差异，特别检查取消/恢复不重复外发、错误正文不泄露 key、链接不能离开授权根、并发清理已 await。
- 校验实际 npm pack 文件清单，图标/locale/patch/lib 完整；保持 DSH engines/peer 兼容范围不放宽。

## 本机部署与发布顺序

1. 最终测试通过后，构建并打两个 0.3.5 实体安装包；通过 plugin_manager 安装，不直接写 profile 清单、不转成源码 link。
2. 按安装结果区分 live-applied / restart-required。保留现有配置和 topic；核对安装版本与 host/client 哈希、运行注册和元数据。当前可用 Playwright 页面访问 GUI 返回 401，不能寻找凭据绕过；若实际页面不可控，明确报告视觉验证边界。
3. `release-dist --check` → `--apply`，检查两个生成仓库完整差异、包清单和本地 commit。
4. 提交源码，推送源码 main；通过发布脚本推送两个发布仓库 main 和全新 `v0.3.5` tag，并创建 GitHub Release（已有 gh 权限）。
5. 核验三个远端 main SHA、两个 tag/Release、GitHub CI 结果；修复实际发现的失败，不把本机测试代替远端 CI。
6. 记录最终测试数字、部署运行结果、提交/tag/Release 链接及未覆盖的真实服务边界，再交付。

## 不纳入此次扩张的事项

- 不增加模型/通道/多账号、画布或视觉评分，不把文本裁决表述为图片验收。
- 不自动删除来源不明的旧 `.report.lock`；其保守拒绝不会覆盖数据，崩溃锁恢复策略需独立设计并验证并发所有权。
- 不把旧版本市场独立验证标记沿用到 0.3.5。

## 执行结果

实施与两轮交叉复审已完成。确定性补漏包括终态落盘取消、新代首轮前失败归档、写侧目录链接，以及别名项目根兼容；每项均补回归。最终常规测试连续两遍各 274 passed / 15 conditional skipped，再显式 Chrome 15/15 通过；类型、构建、双 bundle smoke、10 组真实 Cordis/Chrome 替身 acceptance 全通过。

两个 0.3.5 实体包已安装至本机 desktop，管理器均返回 applied，12 个既有 topic.json 哈希未变；三个仓库与两个新 tag/Release 已推送。远端 Windows CI 发现短路径期望未 canonicalize 的测试问题，修正精确预期后，[Windows / Ubuntu 完整 CI](https://github.com/Octo-o-o-o/dsh-pro/actions/runs/40904197249) 均通过；不改运行 bundle、不移动已发布 tag。完整部署/发布/CI 回执见 [0.3.5 验证记录](validation/release-0.3.5-2026-10-29.md)；不把文件已安装等同于进程已切换，不把替身测试等同真实服务验收。
