# dsh-pro 自审：宿主裁决

- 审计对象：Pro 主题 `topic-e6fc`（4 轮，2026-10-22 至 10-23）
- Pro 快照：`0.2.0` 的 12 个文件
- 复核基线：当前 `0.3.0` 工作区（`reviewing`、自动裁决、dispatch、消息锚点、材料快照已提交）
- 本地验证：`npm test` 95 passed / 1 skipped，`npm run typecheck` 通过；`npm run build`、bundle smoke、`DSH_PRO_TRANSPORT_SMOKE=1` 的 fixture 浏览器 smoke 通过。
- 结论：Pro 的三条 P0 主链仍然成立；发送意图、消息锚点、材料快照已经补上第一版，但跨进程所有权、损坏记录、审计和面板竞态仍未闭合。
- Pro 0.3.0 复核：`topic-9cda` 在 9 秒后返回 1607 字节的“结论开头”就停止，疑似被旧 transport 的完成判定截断（正是 P0-2 的现场）；没有 accept。它的优先级表仍确认“P0-2 前置，P1-1/P1-3/P1-5/P1-7 提升”，本裁决采纳这个调整。

## 一、Pro 给出的三条 P0

Pro 的原始答复把问题收敛为三句话，宿主复核后同意：

1. **发送结果不确定时，程序不能再点一次发送。**
2. **答复和产物必须能证明属于本轮，而不是上一轮。**
3. **扫描、哈希、复制、上传必须是同一份不可变字节。**

这三条不是“再加一个判断”能补上的，它们分别对应提交协议、网页消息绑定和材料快照三条链路。

## 二、已经补掉或收窄的部分

以下项在 Pro 审计时成立，但当前代码已经处理，不再作为未决缺陷重复：

- 冷启动恢复：新增 `recoverActive()`、`engine.reattach()`、`unknown_submission`；`human_check=submitted` 会先尝试重新附着，而不是直接 poll。仍有两个缺口，见 P1-2。
- 发送意图：`RoundRecord.dispatch` 在提交前落盘，未观察的 dispatch 会阻止 `resume` / `continue` / `submitRound` 自动重发；人工 `not_submitted` 才清除。阶段区分仍待补，见 P0-1。
- 本轮消息锚点：`submit()` 记录提交前的 assistant/user 基线，点击后必须观察到新增 user turn（或新增 assistant turn）；`poll`/`fetch`/图片/代码/zip 只读取基线之后的 assistant turn；`reattach` 用 prompt 定位并计算 assistant 基线；没有 `/c/<uuid>` 的 live URL 不再回退为当前页 URL。见 P0-2 的剩余边界。
- 材料快照：`stageMaterials()` 复制后复核 sha256/size，manifest 改为相对路径；最终正文（title/question/criteria/brief/regenerate note/material reasons）在发送前做内容扫描；无斜杠 `secretGlobs` 按 basename 匹配嵌套路径。见 P0-3 的剩余边界。
- 损坏记录失败关闭（第一版）：`readQuestion` / `readMaterialPaths` / `readLocator` / `readRoundMaterials` 现在把“损坏/无权限”和“缺失”分开，损坏时拒绝发送；`submitRound()` 不再把缺失问题当空 prompt。`load()` 的结构校验仍未做。
- 面板动作身份：`act()` / `submitRegenerate()` 现在要求当前显示的 `detail.topic_id` 等于 `selected`，避免 A 的内容配 B 的动作；交互测试仍未补。
- 跨进程 profile lease（第一版）：`acquireSharedTransport()` 在创建 transport 前获取 `${profileDir}.dsh-pro.lock`（PID + token），第二个进程看到活 PID 直接 `config` 失败；释放最后一个引用时删锁；死 PID 可回收。同进程仍复用全局 slot。
- API 边界：远程 `imageBaseUrl` 强制 https（loopback 例外）；图片下载/base64 有 50MB 上限并按流读取；错误体脱敏补 `api-key`/AIza/GitHub token。
- continue 预算：`Topic.runThrough` 让一次 `continue` 只授权一轮，即使原 cap 还有余量；`regenerate` 使用本版本 budget；`RoundRecord.designs` + `nextDesigns` 让设计续轮携带本轮方向数。`continue` 的 `designs` 参数已接入工具和引擎。
- 恢复扫描：`knownEntries()` 在 registry 之外扫描当前项目根和 registry 已记录的根（project/local 两种 store），registry 丢失时仍能发现未完成主题。
- 审计（第一版）：`transition()` 追加 `events.ndjson`；答案落盘返回 sha256 并 patch 进 receipt（`answerSha256/answeredAt`）；`receipts/history.ndjson` 和 `human-checks.ndjson` 追加历史，`human-check.json` 保留最新值。
- 产物按轮隔离：`collectImages()` / `collectCodeBlocks()` 现在只取最后一条 assistant turn；代码块支持文件名和多文件；新增 zip 产物与 `bundle` 路由。
- 同一进程共享浏览器：`acquireSharedTransport()` 用 `Symbol.for` 跨 bundle 共享一个 `ChatGptWebTransport`，`ensureContext()` 也缓存了启动 Promise。
- `stallMinutes`、`autoStart`、`notify=all`：已有实际分支，不再只是设置里的死字段。
- 多版本：`generations`、`finals/attempt-NN.md`、`accept` / `regenerate` / `review` / `wake` 已落地；`final.md` 保留为最新入口。
- 材料路径：`buildManifest()` 已拒绝绝对路径和 `..`，并接入了 `secretGlobs`；follow-up 的 `writeRoundMaterials()` 保存 staged 引用。
- 面板：新增回答、final、产物、ZIP、iframe 预览，以及内联的重新生成/人工核对/继续一轮表单和自检/登录入口；新增 `reviewing` 状态和“请原会话判断/返回待接受”。
- 文档口径：`README` 与设计插件 README 已说明单账号、单会话、共享 profile，以及 API 通道的边界。

Pro 自己在第一轮里也纠正了几条过度判断，宿主接受这些纠正：

- “存储没有原子写”不成立；`store.ts` 已有临时文件 + `rename`，Windows 下还有 EPERM 重试。
- “没有 HTML 隔离/画廊/确认”不成立；现有 CSP sandbox、`confirmed=true` 校验和画廊。
- “多个 cwd 必然争抢同一个输入框”不成立；每次提交是独立 page。真正的问题是所有权和队列，不是输入框复用。
- “final.md 必须是专业方案”不成立；技能已说明它是机械汇总。该修的是历史、来源和可核对性，不是再加一个报告生成器。

## 三、仍然成立的问题

### P0

#### P0-1 发送没有持久化“可能已经点过”的意图

> 2026-10-23：已补最小块（见下），仍未区分“点击前失败”和“点击后失败”。

当前顺序是：`submitRound()` 先调用 `transport.submit()`（其中已经 `send.click()`），成功返回后才写 `submissionId`、locator 和 receipt。见 [engine.ts](../../../packages/core/src/engine.ts) 的 `submitRound()`，以及 [chatgpt.ts](../../../packages/transport/src/chatgpt.ts) 的 `submit()`。

崩溃窗口：

- 点击后、`submissionId` 写入前崩溃：round 仍没有 `submissionId`。
- 重启后 `recoverActive()` 会把 `uploading` 等状态转 `unknown_submission`，这是安全的。
- 但人工核对如果选“未提交”，`humanCheck()` 会清掉提交字段并重新入队；而网页上其实已经发出去了。没有 `dispatching` 检查点，人工只能靠肉眼判断。

最小修法：在点击前持久化 `dispatching`（attemptId、requestHash、materialSetHash），点击后观察到新 user turn 再写 `observed`；任何“已写 dispatching、未观察到”的轮次禁止自动重发。故障注入点：写 dispatching 后、点击后、拿到 URL 后、写 locator 后分别杀进程。

**2026-10-23 补丁（P0-1 最小块）**：`RoundRecord` 新增 `dispatch: {attemptId, at, requestHash, observedAt?}`；`submitRound()` 在 `transport.submit()` 前落盘，成功后写 `observedAt`；`resume()` / `continue()` / `submitRound()` / `human_check=submitted` 都会在 `dispatch` 未观察时拒绝自动重发；人工核对 `not_submitted` 才清掉 dispatch。回归用例见 `engine.test.ts` 的 “persists dispatch intent before submit…”。仍未做的是“点击前/点击后”更细的阶段区分：目前 transport 启动失败也会留下未观察的 dispatch，需要人工核对（保守但可能多停一次）。

#### P0-2 没有证明“这一轮”的网页消息锚点

`submit()` 点击后调用 `waitForConversationUrl()`；超时后它直接返回 `page.url()`，不保证已经进入新会话。见 [chatgpt.ts](../../../packages/transport/src/chatgpt.ts) 的 `waitForConversationUrl()`。

`poll()` 的标准是“停止按钮不可见 + 最后一条 assistant 文本连续两次不变”；在复用旧会话时，最后一条 assistant 可能还是上一轮的答案，于是旧答案会被当成本轮完成。`fetch()` 现在虽然把图片/代码限制到最后一条 assistant turn，但这个 turn 本身没有被证明是“本轮新增的”。

`reattach()` 用 brief 的文本片段在 `document.body.innerText` 里查找；如果历史里有相同或相似的 prompt，它会把旧轮误认成本轮。见 [chatgpt.ts](../../../packages/transport/src/chatgpt.ts) 的 `reattach()`。

最小修法：点击前记录当前 user/assistant 消息数量和文本哈希；点击后必须观察到新增 user turn，并把它之后的 assistant 输出作为本轮范围；没有原生消息 id 时，至少用边界 + 文本 + 附件多重匹配，匹配不唯一就挂起。验收用例：旧文本、旧图片、旧代码都在页面上，新轮延迟生成或发送未成功，不得完成。

**2026-10-23 补丁（P0-2 第一版）**：`submit()` 在点击前记录 user/assistant/copy 基线；点击后 `waitForNewTurn()` 必须看到新增 user turn（匹配 brief）或新增 assistant turn；`poll` 仅在文本稳定且最后一条 assistant turn 出现 copy 终态时返回 answered（无 copy 控件时退化为 4 次稳定轮询）；`fetch` / 图片 / 代码 / zip 都只读取基线之后的 assistant turn；`reattach()` 用 user turn 定位并计算 assistant 基线；live 页面没有 `/c/<uuid>` 时不再回退为当前 URL。fixture 浏览器 smoke 里放了旧 `OLD ANSWER`，断言只能取到新答案。仍缺：真实页面的 user selector 校准、模型侧“答复本身被截断”的检测；这次 `topic-9cda` 的 1607 字节开头就是现场证据。

#### P0-3 材料快照与上传字节不是同一份

`buildManifest()` 读文件、扫描、算哈希；到 `stageMaterials()` 才 `copyFile(ref.source, target)`。两者之间源文件可以变化；复制后也没有用 `ref.sha256` / `ref.bytes` 复核。见 [materials.ts](../../../packages/core/src/materials.ts) 与 [store.ts](../../../packages/core/src/store.ts)。

另外：

- project store 的 manifest 仍把 staged 绝对路径写进 `path`，本机路径会进仓库；`stageMaterials()` 的注释也还写着“keeps absolute stored paths”。
- `title` / `question` / `criteria` / `brief` 没有和材料一起扫描；`confirmed=true` 只证明一个布尔值，没绑定实际卡片版本。
- 默认 `secretGlobs` 里 `.env`、`*.pem` 这类无斜杠规则只匹配根目录；`config/.env` 这类嵌套路径不会命中（[config.ts](../../../packages/core/src/config.ts) 的 `DEFAULT_SECRET_GLOBS`）。

最小修法：一次打开源文件，对有界字节做扫描/计数/哈希；把同一份字节写入本机快照，后续只传快照引用；manifest 只存逻辑相对路径 + digest；最终组装正文也进 `planDigest`；glob 统一成 basename 或 `**/` 语义。验收：扫描后改源文件，上传仍是旧快照或明确失败。

**2026-10-23 补丁（P0-3 第一版）**：`stageMaterials()` 复制后复核 sha256/size，不匹配就删除并拒绝；manifest 改存相对路径（旧绝对路径仍可读）；`start` / `continue` / `regenerate` 在发送前扫描 title/question/criteria/brief/note/material reasons；无斜杠 `secretGlobs` 按 basename 匹配嵌套路径；`start` 的 `materials: []` 与 `continue` 一致。仍缺：读文件前的大小预算、二进制/容器格式的“未扫描”标记、symlink 的 realpath 约束，以及把 `MaterialRef` 真正变成“快照引用”而不是“复制后再验证”。

### P1

#### P1-1 单账号/单会话没有跨进程所有权

`acquireSharedTransport()` 只解决同一 DSH 进程内两个 bundle 的共享；它不跨 DSH 进程，也没有“当前谁在占用 profile”的 lease。每个 cwd 的 `ResearchEngine` 有自己的队列，但共用同一个 transport；两个主题可以各开一个 page 并发提交，和“单会话、一个执行队列”不一致。见 [shared.ts](../../../packages/transport/src/shared.ts)、[engine.ts](../../../packages/core/src/engine.ts) 的 `pump()`、[plugin.ts](../../../packages/research/src/plugin.ts) 的 `transportFor()`。

最小修法：profile 级独占锁（锁文件 + owner PID/heartbeat + 明确 busy 状态）；锁覆盖 login/probe/完整网页任务；第二个宿主返回 busy，而不是自行 launch。先做非抢占独占，不要求跨进程公平队列。

**2026-10-23 补丁（P1-1 第一版）**：`acquireSharedTransport()` 创建 transport 前获取 `${profileDir}.dsh-pro.lock`，写入 PID + token；活 PID 的第二个进程直接 `config` 失败，死 PID 可回收，最后一个引用释放时删锁。同进程双插件仍走全局 slot。仍未做：同一个 transport 的**单活动任务队列**（两个 cwd 仍可各开 page 并发提交）、lease heartbeat/超时接管、以及真实双宿主验收。

#### P1-2 恢复仍是启发式，且只扫描 registry

`recoverActive()` 只遍历 `registry.json`；registry 丢失或 0.1 旧主题不在其中时，磁盘上的 `waiting/submitted` 不会被发现。`recoverActive()` 对 `answered/adjudicating` 直接 `interrupt`，没有尝试本地裁决；`resume()` 在 reattach 失败时抛错，而不是把主题落到 `unknown_submission` 等人工核对。手工 `resume` 也因此可能只看到一条 400 错误。

最小修法：启动时同时扫描 registry + 已知项目根；把“恢复本地已提交结果”和“重新定位网页消息”分开；无法证明时统一进 `unknown_submission`，而不是抛错后保持原状态；旧的无锚点记录只做只读导入。

**2026-10-23 补丁（P1-2 第一版）**：`knownEntries()` 除 registry 外扫描当前项目根和 registry 记录的根（project/local 两种 store），registry 丢失时仍能发现未完成主题。仍未做：`answered/adjudicating` 没有尝试本地裁决恢复（仍 interrupt）、旧 0.1 记录导入、扫描发现的主题不会自动回写 registry（侧边栏仍可能看不到）。

#### P1-3 损坏的持久化文件被当成“空”

`readQuestion()` 捕获所有异常返回 `undefined`，engine 随后用空 brief 继续；`readMaterialPaths()` 捕获后返回 `[]`，等于没有附件；`readLocator()` 捕获后返回 `undefined`，等于新会话；`addMaterials()` 在 manifest 解析失败时用新 refs 覆盖；`load()` 只 `JSON.parse` 后直接断言 `Topic`。见 [store.ts](../../../packages/core/src/store.ts)。

最小修法：区分 present / missing / corrupt / io_error；必需文件异常时禁止 submit；`schema: 1` 之外做运行时结构校验（id、cap、轮号、状态与提交凭证相容）；旧 manifest 损坏时保持原字节，不要覆盖。

**2026-10-23 补丁（P1-3 第一版）**：上述读方法已区分 missing/corrupt，`submitRound()` 对缺失问题拒绝发送；manifest/locator/round-materials 损坏会抛错而不是静默变空。仍未做：`load()` 的 schema 结构校验、`list()` 对损坏主题的隔离展示、以及 `readFinal/readVerdict` 等展示路径的错误分类。

#### P1-4 记录与审计还不能复盘

- 没有 `events.ndjson`；状态只覆盖 `topic.json`。
- `receipts/NN.json` 固定覆盖，`human-check.json` 固定覆盖；同一轮重试/两次人工核对只留最后一份。
- `Receipt` 有 `answerSha256/answeredAt` 字段，但写入时没填；`writeAnswer()` 也不返回 hash。
- `index.json` 只在测试里调用 `store.index()`；侧边栏读 registry，不读 index。
- `final.md` 的 generation 归档已补，但 `accept` 仍会重写 `final.md`；机械汇总没有结论时也能把状态改成 `completed`。

最小修法：以 checkpoint/attemptId 为执行事实，事件追加写；receipt/人工核对按 attempt 追加；答案落盘时写 hash；`accept` 要求已有结论或明确标注“人工接受但未生成结论”，不要把空摘要包装成 completed。

**2026-10-23 补丁（P1-4 第一版）**：`events.ndjson` 追加 status/answered/verdict；答案 sha256 写进 receipt；`receipts/history.ndjson`、`human-checks.ndjson` 追加历史。仍未做：`index.json` 重建/侧边栏读取、attemptId 级事件回放、`accept` 对空摘要的阻断。

#### P1-5 面板动作可能作用到错误主题

`act()` 用的是 `selected`，而屏幕上的 `detail` 可能还是上一个主题：`loadDetail()` 只在 `current === undefined || current.topic_id === id` 时更新，所以从 A 切到 B 的加载窗口里，A 的内容仍显示，按钮却按 B 执行。见 [panel.tsx](../../../packages/research/client/panel.tsx) 的 `loadDetail()` / `act()`。

最小修法：动作绑定 `detail.topic_id + revision`，`detail.topic_id !== selected` 时禁用按钮；切换时清空旧 detail；列表和详情错误分开；轮询一次完成后再排下一次；给主题行加键盘/焦点语义。

**2026-10-23 补丁（P1-5 第一版）**：`act()` / `submitRegenerate()` 现在以 `detail.topic_id` 为准，并要求它等于 `selected`；主题切换窗口里的动作会被拒绝并提示“等详情加载完成”；面板新增“继续一轮”表单（design 可改本轮方向数）和“自检/登录”入口（走 `/action` 的 probe/login，不需要 topic_id）。仍未做：清空旧 detail、错误分区、交互回归测试、键盘语义/轮询退避。

面板还缺：`continue`（加一轮研究）和 `login/probe` 的入口。`regenerate` 不是 `continue` 的替代；一个是新版本，一个是同一版本追加一轮。现在这两个动作只能让 agent 调工具。

#### P1-6 轮次与配置语义

- `continue()` 从提前 `completed` 的主题继续时，仍可能使用原 cap 的剩余额度；一次 `continue` 不一定只跑一轮。Pro Δ01 仍成立。
- `continue` 不读取 `args.designs`；设计插件续轮仍用 `topic.designs`。见 [plugin.ts](../../../packages/research/src/plugin.ts) 的 `continue` 分支。
- `start` 与 `continue` 的空 materials 语义已统一；`materialReasons` 已进工具 schema 并参与扫描。仍缺：`continue` 不读取 `args.designs`，设计续轮仍用 `topic.designs`；一次 `continue` 仍可能消耗原 cap 的剩余额度。
- `resolveConfig()` 的项目覆盖仍未被插件入口使用；`rawAnswersDir` 文档写 `~/.dsh/pro-research/raw`，实际默认是 `~/.dsh/chatgpt-pro-research/raw`。

最小修法：把一次 continue 的授权终点持久化；每轮保存 `requestedDesigns/observedDesigns`；统一 materials 空集合/理由字段的接口；要么接入 resolver，要么从文档撤回项目覆盖。

**2026-10-23 补丁（P1-6 第一版）**：`Topic.runThrough` 持久化本次授权终点，`continue` 只授权一轮，`regenerate` 使用本版本 budget；`RoundRecord.designs` + `Topic.nextDesigns` 让设计续轮携带本轮方向数，工具 `continue` 已读取 `args.designs`；空 materials/materialReasons 已统一。仍未做：`resolveConfig()` 项目覆盖、`rawAnswersDir` 历史定位/文档口径、`continue` 的中途重启边界。

#### P1-7 API 通道的安全与边界

- `assertImageApiConfig()` 允许 `http:` 和任意 host；`imageApiKey` 会以明文发到该地址。对远程服务商应只允许 https；如果确实要支持本机/内网 HTTP，应显式 opt-in 并限制到 loopback。
- `download()` 用 `arrayBuffer()` 一次性读完整响应，没有大小上限；`decodeBase64()` 也没有上限。
- `redact()` 只处理 `sk-` 和 `Bearer`，不覆盖 `api-key` 值或其他厂商 key 形态。
- 只对本地假服务验证过；没有真实 OpenAI/兼容服务商的出图、计费、429/5xx 记录。

最小修法：https 默认 + loopback 例外；图片下载/解码加 50MB 级上限；错误体脱敏补 `api-key`；用一个真实服务商做一次最小出图验收并记录版本。

**2026-10-23 补丁（P1-7 第一版）**：`assertImageApiConfig()` 与 transport 都拒绝非 loopback 的 `http:`；`download()` 先看 content-length、再流式读取并在超过 50MB 时取消；`decodeBase64()` 同样有 base64/字节上限；错误体脱敏补 `api-key`、AIza、GitHub token。仍未做：真实服务商出图/计费/429 验收、非 https 图片源的真实兼容性评估。

### P2

- `readJsonBody()` 仍逐 chunk 做 UTF-8 解码再拼接，中文 note 跨 chunk 会损坏；也没有 body 大小上限（[plugin.ts](../../../packages/research/src/plugin.ts)）。
- `SEND_DEBUG` 仍把 `composerText` 和 URL 打到 stderr（[chatgpt.ts](../../../packages/transport/src/chatgpt.ts)）。
- `collectImages()` 对 `https:`/`blob:` 来源不做 magic/MIME/大小校验；`writeArtifacts()` 先完整 `unzipSync` 再检查条目数和总量，zip 炸弹可以先把内存吃掉（[store.ts](../../../packages/core/src/store.ts)）。
- `/asset` 与 `/file` 对 SVG/HTML 的响应策略不一致：`/asset` 只给 `text/html` 加 CSP，SVG 直开没有 sandbox；`/file` 可以返回 `text/html` 且不加 CSP（[plugin.ts](../../../packages/research/src/plugin.ts) 的路由）。
- 面板 `config` 仍是模块级可变变量，`showViewer` 是模块级函数；如果两个 bundle 真的共享模块，后一次 `configure()` 可能改掉前一个插件的路由。需要打包实测。
- `design.md` 仍以当前口吻写“worker 子进程 / 心跳 / events.ndjson / index.json / 2 秒轮询 / profile 700 / 项目 `.dsh/pro-research.json`”（[design.md](../../design.md)）；这些在当前代码里没有对应实现。保留为设计目标可以，但应标明“规划中”，不能和已实现能力混在一起。
- `README.md` 仍写 npm `0.2.0`，而两个包已经是 `0.3.0`；README 的“未覆盖断线恢复”也落后于当前 `reattach` 代码。发布前需要统一版本、验证边界和 action 列表。
- 0.1 → 0.2 的 registry / local store 迁移没有脚本；旧 `~/.dsh/pro-research/registry.json` 不会再被读取。
- 测试缺口：没有 cold reattach/recoverActive 的测试，没有跨进程 profile 所有权测试，没有嵌套 `.env`、JSON 分块、zip 炸弹、`/file` CSP、面板 A→B 切换的回归；真实浏览器 smoke 默认跳过。

## 四、Pro 结论与本地判断的分歧

- Pro 说“重启后先遇到的是没有恢复调度”，这点在 0.2.0 成立；当前 `recoverActive()` 已补，但仍只扫 registry，且 reattach 是文本启发式，所以“恢复”只能算部分成立。
- Pro 说“human_check=submitted 必然导致双发”，过强；当前代码会先 `tryAttach()`，失败才报错。但失败时没有落到 `unknown_submission`，仍是一个动作语义缺口。
- Pro 说“多个 cwd 争抢同一个输入框”，不成立；每个 submission 是独立 page。真正的问题是 profile 所有权和每-engine 队列。
- Pro 说“存储没有原子写”，不成立；已有 atomic + Windows 重试。
- Pro 说“没有 CI / 双包版本失配”，在附件范围内证据不足；当前仓库有 CI，版本已到 0.3.0，但 README 没同步。
- Pro 第 4 轮说“已生成验收矩阵文件”，但主题 `artifacts` 只有 `final.md`；这正好说明文件/canvas 类产物仍可能漏抓，不能把“Pro 说生成了”当成已保存。

## 五、建议的两周顺序

1. **发送许可 + 本轮绑定**（P0-1/P0-2，约 3 天）：dispatching checkpoint、新 user turn 锚点、poll/fetch 同范围、故障注入。没有这两条，不要扩大“可恢复”的承诺。**dispatch 意图与消息锚点第一版已补；真实页面 selector 与文本终态仍未验收。**
2. **材料快照 + 最终正文扫描**（P0-3，约 2 天）：一次读、一次扫、一次哈希、一次复制；manifest 相对路径；glob 语义；验收“改源文件仍传旧快照”。**staging 校验、相对 manifest、最终正文扫描、嵌套 glob 已补；读前预算/symlink 仍未做。**
3. **持久化校验 + 执行所有权**（P1-1/P1-3，约 2 天）：present/missing/corrupt 区分；schema 校验；profile lease + busy；先做非抢占独占。**corrupt 区分、profile 锁已补第一版；load schema 与单活动任务队列仍未做。**
4. **审计 + 面板动作正确性**（P1-4/P1-5，约 2 天）：events/receipt 追加、answer hash；动作绑定 detail id + revision；补 continue/login 入口；键盘可用性。**events/receipt/answer hash 与面板身份绑定已补第一版；continue/login 入口、index 重建仍未做。**
5. **发布口径 + 真实浏览器验收**（P2，约 1 天）：design.md 标规划/现状；README 版本与验证边界；真实浏览器跑“旧会话第二轮、点击后中断、两插件同时用、续轮附件、图片缺件”；API 通道用真实服务商跑一次最小出图。

明确不做/后置：独立 worker 进程、心跳看门狗、跨进程公平队列、通用二进制秘密扫描、服务器原始 Markdown 无损还原、完整 `design.md/options.md` 生成器、多账号并行。

## 六、证据边界

- 本裁决基于源码与本地测试，不等于真实浏览器验收；`npm test` 覆盖假传输与本地 HTTP fixture，`DSH_PRO_TRANSPORT_SMOKE=1` 覆盖本地 Chrome + 假页面（含旧答案干扰），均不等于 chatgpt.com 真实 DOM。
- 真实网页行为、账号风控、ToS、页面改版仍需在目标机器上单独验收。
- 以上行号以本次复核时的工作区为准；`reviewing` 相关改动仍在进行中，若继续修改，需要重新跑一遍面板/恢复回归。

## 七、最终验收（2026-10-23）

本地实现与验收记录：

- `npm test`：**95 passed / 1 skipped**
- `npm run typecheck`：通过
- `npm run build`：通过
- `node scripts/smoke-bundle.mjs`：两个插件各 1 工具、9 条路由、2 个前端槽位，通过
- `DSH_PRO_TRANSPORT_SMOKE=1`：本地 Chrome + 假页面 + 旧 `OLD ANSWER` 干扰，通过
- 覆盖的 P0：dispatch 发送意图、本轮消息锚点、材料 staging 校验/最终正文扫描
- 覆盖的 P1：profile lease、registry 外恢复扫描、损坏记录失败关闭、events/receipt/answer hash 审计、面板动作身份、continue 一轮授权/每轮 designs、API https/下载上限/脱敏
- Pro 记录：`topic-e6fc` 已接受；`topic-9cda` 因 1607 字节截断答复被 `cancel`，未冒充完成

**交付边界**：

- 真实 `chatgpt.com` 仍需在重装/重启 DSH 后用一个小主题验收；当前会话里的 host bundle 是旧的。
- 本轮代码改动尚未提交（最后检查时 `git diff` 约 +621/−48，涉及 18 个文件）；P0 补丁在 `198ae0e` / `bb977a6`。
- 仍未做：`index.json` 重建/侧边栏合并、`listAll` 对扫描主题的安全展示、`resolveConfig` 项目覆盖、`continue` 中途重启边界、面板键盘/交互回归、真实 API 服务商计费验收。

因此，本轮交付的是“本地测试/构建/审计闭环 + 明确的 live 边界”，不是“真实网页已验收”。
