# dsh-pro 0.3.2 缺口分析与实施方案（已实施）

日期：2026-10-23。基线：`npm test` 95 passed / 1 skipped；typecheck / build / smoke-bundle 全绿。
范围：`packages/core`、`packages/transport`、`packages/research`、`packages/design`（两插件共享同一 `createPlugin(spec)`）。
参考：前次审计 [../dsh-pro-0-2-0/adjudication.md](../dsh-pro-0-2-0/adjudication.md)，本表只列**仍未闭合**与**新发现**项。

## A. 正确性缺陷

### A1 `find()` 回退路径把错误 root/mode 的 engine 和找到的 store 拼在一起
`packages/research/src/plugin.ts:443-464`。`storeFor(cwd)` 加载失败后的兜底循环里，返回 `{ store: candidate, engine: this.engineFor(cwd), topic }`：engine 是按**调用方 cwd** 的 root+mode 建的，store 却可能是另一个项目/另一种 mode。经此路径的 `resume/cancel/continue/human_check` 会操作错误的 store，轻则 `unknown topic`，重则串库。
修法：`stores` map 的 key 即 `${mode}:${root}`；兜底命中时反查 key，用 `engineFor(root, mode)` 返回配对正确的 engine。补测试。

### A2 `pump()` 的 run promise 没有 catch，host 进程可被打挂
`packages/core/src/engine.ts:469-481`。`runTopic` 自身 catch 到 `handleFailure`，但 `handleFailure` 内部还会 `store.load/save/transition`——磁盘满/权限错误时 promise reject，无人 await（`drain` 只在测试用）→ unhandledRejection。
修法：promise 链尾加 `.catch`（记日志，吞掉），或 `handleFailure` 自身 try/catch 兜底。补测试（让 save 失败，断言不抛未捕获异常）。

### A3 `readJsonBody` 按 chunk 解码 UTF-8，中文跨 chunk 必损坏；且无大小上限
`packages/research/src/plugin.ts:1273-1280`。`body += Buffer.from(chunk).toString('utf8')` 在多字节字符被切断时产生替换符；同时 body 无限缓冲。
修法：收集 Buffer → `Buffer.concat` → 一次性 `toString('utf8')`；超过 1MB 返回 413。补测试（把一个含中文的 JSON 按字节切成跨 chunk 的两半）。

### A4 `SEND_DEBUG` 把页面 URL 与输入框全文打到 stderr
`packages/transport/src/chatgpt.ts:273`。隐私足迹留在宿主日志里。前次 P2 已列，未修。
修法：删除该行，或改为只在 `DSH_PRO_DEBUG=1` 时输出**长度**而不是内容。

### A5 api 通道 `human_check=submitted` 在重启后空转回 stalled
`packages/core/src/engine.ts:403-440`。api transport 没有 `reattach`；round 有 `submissionId` 时 `hasUnobservedDispatch` 为 false，于是直接转 `waiting` 入队 → `poll` 查不到内存 job → `unknown` → 再次 stalled，形成死循环。`act('resume')` 已拦这个场景（plugin.ts:856-861），human_check 漏了。
修法：`humanCheck` 的 `submitted` 分支加同样的前置判断：`transport.reattach === undefined && last?.submissionId !== undefined` → 抛「API 请求无法接管」的明确错误。补测试。

### A6 `resolvePluginConfig` 从不跑 `assertConfig`
`packages/research/src/plugin.ts:224-256`。手改的设置文件（如 `stallMinutes: 0`、`maxRoundMinutes < stallMinutes`）静默通过，运行期行为退化。
修法：末尾 `return assertConfig(merged)`（`assertConfig` 只在 channel=api 时校验 image 字段，保持"设置加载不因一个 typo 崩掉"的既有口径）。补测试。

## B. 安全

### B1 `/file` 路由对 HTML/SVG 不加 CSP；`/asset`、`/raw` 不 sandbox SVG
`plugin.ts:1447-1467`（`/file` 可回 `text/html` 无 CSP）对比 `1350-1401`（`/asset`、`/raw` 只对 `text/html` 加 CSP）。SVG 以 `image/svg+xml` 直开可执行脚本。
修法：三条路由统一——`text/html` → `content-security-policy: sandbox allow-scripts`；`image/svg+xml` → `content-security-policy: sandbox`（禁脚本）。补路由测试。

### B2 `collectImages` 对 https 来源不校验 content-type/大小
`chatgpt.ts:498-507`。`page.request.get(source)` 的任何响应都进 artifacts。blob 路径也没有大小上限。
修法：https——要求 `image/*` content-type 或 magic bytes 命中（复用 magic 检测），并按流读取加 50MB 上限；blob——转换后同样限 50MB。补测试（抽出的校验 helper）。

### B3 zip 解包先全量解压进内存再限量
`packages/core/src/store.ts:444-472`。`unzipSync(bytes)` 会把所有条目解压完才轮到 count/total 检查，zip 炸弹先吃内存。
修法：换 fflate 流式 `Unzip`，逐文件 onfile + 累计字节，超过 50MB/100 条即中止。补测试（构造超限 zip）。

## C. 并发/所有权

### C1 两个插件可在共享 transport 上并发 `submit`
engine 队列是**每个插件服务**一条；`acquireSharedTransport` 让两插件共用一个 `ChatGptWebTransport`，但 `submit()` 没有串行化——research 和 design 可以同时驱动两个页面提交（前次 P1-1 的剩余项："同一 transport 的单活动任务队列仍未做"）。
修法：在 `ChatGptWebTransport` 内给 `submit()` 加 promise 链互斥（poll/fetch/cancel 保持并发；reattach 只在无活动 submit 的恢复场景发生，也入链以保安全）。补测试（假页面/或直接测串行 helper：两个并发 submit 的开始时间不重叠）。

## D. 恢复/状态

### D1 `answered/adjudicating` 的恢复不靠本地裁决，直接打断
`plugin.ts:1181-1183` + `engine.resume` 没有"答案已在本地、只差裁决"的免浏览器路径（前次 P1-2 剩余项）。
修法：`engine.resume` 前置分支：最后一轮 `answeredAt !== undefined && verdict === undefined` → 直接 `queued` 入队（`runTopic` 的裁决段是纯本地 LLM，不需要 transport）；`recoverActive` 对这两个状态改走 resume 而不是 interrupt。补测试（fake transport 的 reattach 被调用即失败 → 断言未被调用且主题完成裁决）。

### D2 扫描发现的主题不写回 registry，侧边栏永远看不到
`plugin.ts:488-506` `knownEntries()` 只在内存合并，registry 丢了就找不回展示入口（前次 P1-2 剩余项）。
修法：`recoverActive` 扫描后把新发现的 entry 合并写回 registry（走现有 `registryChain` 串行写）。补测试。

### D3 `store.load()` 无结构校验
`store.ts:275-278`：JSON.parse 后直接当 `Topic` 用，损坏/手改的 topic.json（status 非法、rounds 非数组等）会在引擎深处以奇怪方式炸（前次 P1-3 剩余项）。
修法：`load` 校验 `schema===1`、id/title/status 合法、rounds 数组、roundsCap 正整数；不合法抛"corrupt topic"错误；`list()` 保持跳过（已如此）。补测试。

## E. 功能/体验缺口

### E1 没有删除主题的入口
cancelled/completed 等终态主题与 registry 条目只增不减，面板越用越长。
修法：`action=delete`（工具 + `/action` 路由 + 面板"更多"菜单按钮，红色，二次确认用 `window.confirm`）。仅允许非 active 状态；删除 topic 目录、raw 答案目录、session locator、registry 条目。引擎/服务/路由/面板四层 + 测试。

### E2 面板看不到裁决全文
`RoundsView` 只显示 verdict 标签；`rounds/NN-verdict.md` 在盘上但没有入口。
修法：轮次操作列加「裁决」按钮，走现有 `/file` 路由（`rounds/${pad(n)}-verdict.md`）。无该文件时禁用。

### E3 工具 `regenerate` 不能附新材料
`engine.regenerate` 支持 `materials`，但 `plugin.ts:898-919` 的 act 路径不传。
修法：`handle`/`act` 的 regenerate 接受 `args.materials`（与 continue 相同的 buildManifest + 限额 + 密钥扫描）。补测试。

## F. 性能/行为

### F1 api 通道逐方向串行生图
`openai-images.ts:448-471`：3–6 次串行调用，每次最长 `timeoutSeconds`。
修法：有界并发（2），保持结果顺序与逐方向失败收集语义。补测试（假 fetchImpl 记录并发度）。

### F2 api 通道 poll 每次超时都报 `progress: true`
`openai-images.ts:384`：不断重置引擎的 stallDeadline，`stallMinutes` 对 api 通道失效，只剩 maxRoundMinutes 兜底。
修法：job 记录已完成方向数；poll 仅在计数增加时（或首次）报 progress。补测试。

## G. 清理（顺手）

- G1 `isHtmlSource` 在 plugin.ts / store.ts 重复 → core 导出一份共用。
- G2 `requestHash` 只写不读 → 保留字段（注释已声明用途），不动。
- G3 `store.index()` 仅测试在用 → 保留，不动。

## 实施顺序

1. core/engine 正确性：A1、A2、A5、A6、D1、D2、D3、G1（+测试）
2. transport：A4、B2、C1、F1、F2（+测试）
3. 路由安全：A3、B1（+测试）
4. store：B3（+测试）
5. 功能：E1 delete（store/service/route/tool/panel）、E2 裁决按钮、E3 regenerate materials（+测试）
6. 版本：`packages/*/package.json` → 0.3.2；README/usage 增补 delete 与 regenerate materials 口径
7. 全量验证：`npm test`、`npm run typecheck`、`npm run build`、`node scripts/smoke-bundle.mjs`
8. 不做：sync-dist、push、发布（需另行授权）

## 交叉评审合并结论（2026-10-23，2 个独立只读评审）

两份评审对 plan 全部条目予以确认（行号引用全部准确），无驳回。修订点：

**升级**：B1、B3、C1 → P1（/file 无 CSP 构成存储型 XSS 主链；zip 炸弹打爆宿主内存；共享 transport 并发窗口比 plan 所述更宽——同一插件跨项目根也会并发）。D1 → P1：现状 100% 可复现——judge 失败后 resume 走 reattach→waiting，runTopic 裁决时 `waiting → adjudicating` 非法，主题再次 failed。

**新发现并入实施**：
- 引擎：cancel/abort 检查点竞态滞留 queued（487/494 干净 return 改 throw）；api resume 护栏收窄到"待恢复轮在飞"；human_check=submitted 镜像漏洞（末轮无 dispatch 无 submissionId 时直接拒绝）。
- transport：reattach 补 copyBaseline（历史 copy 按钮会提前判完成）；reattach 锚点不唯一时挂起而非取最后；api 失败 job 清理；download 脱敏剥查询串 + 非图片字节拒绝落盘。
- 路由：connection 服务缺失时 loud log；POST 加 sec-fetch-site 深度防御；/file、/answer 补 nosniff。
- store：bundleRound 100MB 超限不再被 per-file catch 吞掉。

**实施陷阱记录**：
- A2 的 catch 必须挂在存进 this.active 的 promise 上（finally 传递 rejection）；先于 D3。
- A6 改为逐字段 clamp/回退默认（不 fail-loud，保持"设置 typo 不崩插件"口径）。
- A1 反查 key 按第一个冒号 split（Windows root 含盘符冒号），遍历时直接携带 {root, mode}。
- D1 新分支放在 api 挡板与 reattach 分支之前；resume 状态门放宽到 answered/adjudicating；recoverActive 直接调 resume。
- E1 拒绝 active 与 reviewing（提示先 review_cancel）；先删目录后删 registry；清 topicSessions；root/mode 取自 registry entry；工具侧纳入 confirmed=true 门。
- E3 在 handle 内联（有 exec cwd）；路由路径以 entry.root 为 buildManifest 基准。
- B2 不做真流式（Playwright 不支持）：content-length 预检 + body() 后验 + magic bytes；detectMime 提升为 transport 共享 helper。
- B3 用 fflate 流式 Unzip：originalSize 作第一道闸、ondata 累计作硬顶、超限不再 start 后续文件；验收断言"内存有界/条数受限"而非"立即中止"。
- C1 链尾吞错（chain.then(run, run)）；reattach 入链；poll/fetch/cancel 不入链；文档化 head-of-line 阻塞。
- F1 并发生图 + 429 方向级退避重试一次。
- D2 回写在 chain job 内重新 readRegistry 再 merge（保留已有 sessionId）。

**记录为已知、本轮不修**：面板模块级 config（bundle 独立打包已验证安全）、shared.ts 锁 TOCTOU 小窗、/open Windows 转义、轮询磁盘 churn、cli.ts 无扫描（开发工具）、judge 提示注入面（parseJudge 兜底 partial）。

- 真实 chatgpt.com DOM 验收、真实 API 服务商计费验收（需要 live 环境）。
- "点击前/点击后"更细的 dispatch 阶段区分（保守多停一次可接受）。
- 面板 continue/regenerate 弹窗的材料选择 UI（本轮只做工具侧）。
- 0.1 旧记录迁移脚本、index.json 重建（registry 已覆盖主流场景）。

## 实施记录（2026-10-23 完成）

**验收**：`npm test` **121 passed / 1 skipped**（+26）；`npm run typecheck` 通过；`npm run build` 通过；`node scripts/smoke-bundle.mjs` 两插件各 1 工具 / 9 路由 / 2 前端槽位通过。版本号 0.3.2（未发布、未 sync-dist、未 push）。

**落地清单**（对应上文条目 + 评审合并项）：

- core/engine：pump promise 尾挂 catch + `EngineOptions.onError`（A2）；resume 新增"答案已在盘上→本地裁决"分支并放宽状态门到 answered/adjudicating（D1，修复现状必达的 waiting→adjudicating 非法转换）；reattach 同款崩溃窗口分支；runTopic 两个 abort 检查点改 throw（cancel 竞态滞留 queued 修复）；handleFailure abort 分支跳过 capped/reviewing；cancel 无 run 分支补 cancelSubmission；human_check=submitted 三守卫（无提交记录拒绝 / 本地答案直接裁决 / 无 reattach 通道活体 poll 探测）；api resume 护栏收窄为"待恢复轮在飞 + 活体探测"（A5/N3/N4 组合）。
- core/store：`load()` 结构校验（schema/id/title/type/status/roundsCap/rounds/channel/criteria/artifacts），`list()` 同步跳过损坏主题（D3）；zip 改 fflate 流式 `Unzip`（register UnzipInflate/UnzipPassThrough），originalSize 预闸 + ondata 硬顶 50MB/100 条（B3）；`bundleRound` 100MB 超限不再被吞（评审 N9）；新增 `remove(topic)`（删目录/raw/locator）；`isHtmlSource` 导出共用（G1）。
- transport：`SerialGate` 串行化 submit/reattach（C1，链尾吞错）；reattach 用定位 user turn 的 assistant+copy 双基线、锚点不唯一拒绝附着（评审 B-N1/N2）；SEND_DEBUG 改为 `DSH_PRO_DEBUG=1` 且只输出长度（A4）；collectImages 的 data/blob/https 三路统一 50MB 上限 + magic/content-type 校验（B2）；`detectImageMime` 提到 assets.ts 共享；openai-images 方向级有界并发 2 + 429 退避重试一次（F1）；poll 仅方向完成时报 progress（F2）；失败 job 在 poll/fetch 首次暴露后释放（评审 B-N3）；download 脱敏剥查询串、非图片字节拒绝落盘（评审 B-N4）。
- research/plugin：`find()` 回退按 stores key 反解 (mode, root) 配对 engine（A1）；`readJsonBody` Buffer.concat 一次解码 + 1MB→413（A3）；`/file` `/answer` 补 nosniff，html/svg 与 /asset /raw 统一 sandbox CSP（B1）；POST 拒 `sec-fetch-site: cross-site` 深度防御 + connection 缺失 loud log（评审 B-N6）；`resolvePluginConfig` 数值字段 clamp/回退默认（A6，不 fail-loud）；registry 扫描发现写回（D2，chain 内重读合并）；`regenerate` 支持 materials（相对主题项目根；E3）；`action=delete` 全链路（终态限定、先目录后 registry、清 topicSessions、工具侧 confirmed=true 门；E1）。
- 面板：轮次表新增「裁决」查看按钮（E2）；「更多」菜单新增红色「删除主题…」（window.confirm 二次确认）。
- 文档：两个 SKILL.md、usage.md、README 清理口径同步；版本 0.3.2。

**评审结论索引**：两份独立只读评审的全部逐条裁决与新发现已并入上文「交叉评审合并结论」；原始报告在本仓库会话记录中。

**仍未做（维持）**：真实 chatgpt.com DOM 验收、真实服务商计费/429 验收、dispatch 点击前后阶段细分、面板材料选择 UI、0.1 迁移脚本、面板模块级 config 改造（bundle 级已验证安全）、shared.ts 锁 TOCTOU 小窗、轮询磁盘 churn 优化。
