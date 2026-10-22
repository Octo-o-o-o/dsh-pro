# dsh-pro 设计文档

状态：设计稿 v0.1 · 2026-10-22 · **未实施**
范围：第一阶段交付 Pro 调研（`dsh-pro-research`）；Pro 设计（`dsh-pro-design`）复用同一核心，验证后再发布。整套 OctoWorkFlow 约定与交付/评审技能排在第三阶段。

## 1. 要解决的问题

1. **时间**：一轮十几到几十分钟、可能多轮，人不能守着；手动发经常被打断、被忘掉。
2. **成本**：希望用订阅额度而不是 API token，通道必须是真实网页会话，不能换成模型代理。
3. **材料**：有时是一组文件，准备和上传都麻烦；上传后还需要确认真的传上去了。
4. **历史**：每轮问了什么、带了哪些文件、答了什么、采纳还是驳回，要能按项目/主题串起来。

因此产品形态不是聊天窗口，而是**可恢复的研究任务**：有状态、有轮次上限、断了能接、结束有产物、卡住才叫人。

## 2. 目标与非目标

目标：

- DSH 里一条命令发起，后台无人值守跑完多轮；侧边栏可看状态与历史。
- 材料一次列清、逐文件核对；已提交内容可选让 ChatGPT 自己读仓库，未提交内容才上传。
- 记录按项目归档，覆盖选项可配置（仓库内或本机），follow-up 串在同一条主题下。
- 单通道起步：一个浏览器 profile、一条会话链、一个执行队列。

非目标（第一阶段不做）：

- 不做通用聊天 UI、不做 API provider、不做模型路由。
- 不做双账号扇出、不做按账号预算。
- 不自动 push、不自动外发未确认材料、不代替用户做授权决定。
- 不抓取其他站点，不与风控对抗，不实现验证码/2FA 绕过。

反面目标（发生即视为失败）：

- 提交状态未知时自动重发。
- 没有答复文件却把任务标成完成。
- 把密钥或凭据写进仓库、日志或截图。
- 同一主题出现两份互相矛盾的记录。

## 3. 用户用法

### 3.1 调研

```text
/pro-research 我要决定 X，先调研社区现状、已有方案和风险
```

DSH 先给一张**研究卡**：问题、要验证的假设、材料清单（文件、理由、是否敏感）、通道、轮次上限、产物路径。用户点「开始」后进入后台；期间不在会话里刷消息。

### 3.2 设计

```text
/pro-design 登录页改版，给我三个方向、取舍和反例
```

产物是 `design.md`（决策、开放问题、未采纳及理由）与 `options.md`（方向对比），不是把 Pro 的稿子直接当结论。

### 3.3 追问

```text
在这个主题上继续，只送变化
```

优先续原会话；续不上则新开会话并带上一轮结论摘要。轮次累加在同一主题下。

### 3.4 回看

侧边栏按项目列出主题：状态、第几轮、耗时、产物。点开是轮次时间线：问题、材料、答复、裁决、最终文档。

### 3.5 打断与恢复

退出 DSH 或合上电脑后任务停在原地；重开后显示「待恢复」，从回执继续，不重发、不新增轮次。

## 4. 形态与包结构

```text
dsh-pro/
  packages/
    core/        # 引擎：主题、轮次、状态机、队列、记录、传输接口（无浏览器依赖）
    transport/   # ChatGPT 网页驱动：登录、提交、附件、轮询、回执（独立子进程）
    research/    # 插件入口 + pro-research 技能 + 调研产物模板
    design/      # 第二阶段：Pro 设计技能 + 设计产物模板
  docs/
```

- `core` 不依赖 Playwright，可用假传输做完整测试。
- `transport` 单独进程：页面崩溃/浏览器被关不会拖垮 DSH host，也方便重启与单测。
- `research` / `design` 是两个独立 npm 包，共用 `core` 与 `transport`；市场里是两个入口。
- 客户端面板第一版放在 `research` 包内，`design` 复用同一组件；稳定后再抽 `ui` 包。

## 5. 运行时架构

```text
DSH host (Cordis)
  ├─ proResearch service  ── queue ── worker (child process)
  │      │                            └─ Playwright → chatgpt.com
  │      ├─ store (project | local)
  │      ├─ tools: pro_research(action)
  │      └─ remote API: list / detail / resume / cancel
  ├─ skills provider: pro-research / pro-design
  └─ client panel: 列表 + 详情 + 恢复/取消
```

### 5.1 传输层（worker）

stdin/stdout 逐行 JSON 协议，命令：

| 命令 | 作用 | 返回 |
|---|---|---|
| `login` | 打开有头窗口等待用户登录 | `{ok, profileDir}` |
| `probe` | 自检：模型选择器、输入框、登录态 | `{ok, model, loggedIn}` |
| `submit` | 送 brief 与附件、发送、等待逐文件卡片 | `{submissionId, fingerprint, attachments[]}` |
| `poll` | 等待本轮答复完成 | `{state: waiting|answered|unknown}` |
| `fetch` | 取回答复正文与页面快照 | `{answerPath, snapshotPath}` |
| `cancel` | 停止轮询（不撤回已发消息） | `{ok}` |

worker 每 15 秒发一次 `heartbeat{phase, domFingerprint}`。所有选择器集中在 `selectors.ts`，按「角色/文本优先，CSS 兜底」排列，并带版本指纹；页面状态不明时宁可报 `unknown`，不猜。

完成判定三条同时满足才算 `answered`：生成指示（停止按钮）消失、复制按钮出现、答复正文连续两次轮询（间隔 3 秒）哈希一致。任一不满足超过阈值报 `stalled(ui)`，不取半截答案。回执指纹 `fingerprint = sha256(conversationId + userMessageOrdinal + 答复正文前 4KB)`；页面不暴露消息 id 时不伪造，直接按 `unknown` 处理。

### 5.2 引擎

- 单 worker、FIFO 队列；同一 profile 同时只跑一个主题，其余排队。
- 原子写：临时文件 + rename；回执 append-only。
- 状态每次变更写 `events.ndjson`，用于恢复与审计。
- 看门狗：心跳缺失 3 次 → `failed(worker)`；页面级无进展 → `stalled(timeout)`。进入 `stalled` 或 `failed` 会释放 worker，队列继续下一个主题；被挂起主题的计时从 `resume` 重新开始，不累计。

### 5.3 DSH 插件

- `apply(ctx)` 注册服务、工具、设置页与远程方法；`ctx.effect()` 负责停 worker、关队列。
- 工具只有一个入口：`pro_research(action: start|status|cancel|resume|list, ...)`，减少模型的选择面。
- 技能通过 `ctx.skills.registerProvider` 注册（rank 350），body 从包内 `resources/skills/` 读取，不写用户目录、不复制文件。
- 设置用 Schemastery schema；登录态只存在独立浏览器 profile，不进配置。

## 6. 配置

### 6.1 设置项（profile 级）

| 键 | 默认 | 说明 |
|---|---|---|
| `channel` | `web-pro` | 第一阶段固定 |
| `model` | `pro` | `pro` / `thinking`；启动时 `probe` 校验，不可用直接拒绝启动，不静默降级 |
| `rounds` | `3` | 1–10，主题默认轮次上限 |
| `stallMinutes` | `45` | 无进展判定：仅在生成指示消失且无完整答复时计时 |
| `maxRoundMinutes` | `90` | 单轮墙钟上限，到点按 `stalled(timeout)` 处理 |
| `store` | `project` | `project` / `local` |
| `autoStart` | `false` | 研究卡直接开跑（跳过点击） |
| `notify` | `stall-only` | `stall-only` / `all` |
| `maxFiles` | `12` | 单轮附件上限 |
| `maxTotalMB` | `24` | 单轮附件总大小 |
| `secretGlobs` | 见 6.4 | 禁止外发的路径模式 |
| `rawAnswers` | `local` | 原始答复保存位置：`local` / `repo`；公开仓库强制 `local` |
| `rawAnswersDir` | `~/.dsh/pro-research/raw` | `local` 模式的原文目录，可改绝对路径 |
| `browser.profileDir` | `~/.dsh/pro-research/browser` | 独立 profile |
| `browser.headless` | `false` | 无头仅用于自检，默认关闭 |

### 6.2 项目覆盖

项目根可放 `.dsh/pro-research.json`，只允许覆盖 `rounds`、`store`、`notify`。项目根按 `git rev-parse --show-toplevel` 解析，找不到时用当前工作目录。

### 6.3 单次覆盖

工具参数 `{rounds?, store?}` 只对本次生效。优先级：单次 > 项目 > profile。

### 6.4 密钥与敏感材料

`secretGlobs` 默认包含 `.env*`、`*.pem`、`*.key`、`id_rsa*`、`.npmrc`、`.credentials*`、`**/secrets/**`。命中做两件事：研究卡标红、提交前内容扫描阻断。扫描失败按失败处理，不静默放行。

### 6.5 设置页说明

设置页固定展示三条，不可关闭：

1. 本插件驱动网页会话，不是官方 API；存在 ToS、风控与账号风险。
2. 运行期间 DSH 需保持运行（可最小化）；关闭后任务暂停，重开从回执恢复；锁屏尽力而为，不承诺关机跑完。
3. `rawAnswers=repo` 会把完整答复写进项目；公开仓库禁止该组合。

## 7. 轮次语义

- **一轮 = 一次提交 + 一份完整答复**。
- 研究卡必须写**成功判据**；每轮裁决后由宿主判断是否满足：满足即 `completed`，停止依据写进 `final.md`；不满足继续，直到 `rounds` 上限转 `capped`。无人值守期间不为此询问用户。
- 复核续问（只送变化）也算一轮；这样上限可审计。
- 达到上限且无结论：状态 `capped`，交付阶段结论 + 未决项；加一轮必须用户明确确认。
- 同一轮内重试（例如上传失败后重传）不新增轮次，但必须留下重试记录。

## 8. 状态机

```text
draft → queued → uploading → submitted → waiting → answered → adjudicating
                                                    ├→ queued（下一轮）
                                                    ├→ completed
                                                    └→ capped
任意阶段 → stalled | failed | cancelled
```

| 状态 | 含义 | 恢复动作 |
|---|---|---|
| `draft` | 研究卡已生成，等确认 | 确认或修改 |
| `queued` | 排队等 worker | 自动 |
| `uploading` | 上传/核对附件 | 重开页面核对，不重发 |
| `submitted` | 已发送，等待生成 | 重开会话核对回执 |
| `waiting` | 生成中 | 继续轮询 |
| `answered` | 答复已取回 | 进入裁决 |
| `adjudicating` | 宿主整理裁决与产物 | 继续 |
| `completed` | 有结论与产物 | 只读 |
| `capped` | 到轮次上限 | 需用户确认加轮 |
| `stalled` | 卡住，需人处理 | 修复后 `resume` |
| `failed` | worker 崩溃或不可恢复 | 保留现场，重开 |
| `cancelled` | 用户取消 | 已发消息不撤回 |

## 9. 卡住判定与通知

| 信号 | 判定 | 状态 | 处理 |
|---|---|---|---|
| 登录失效 | 出现登录页/输入框消失 | `stalled(login)` | 提示重新登录后恢复 |
| 附件不符 | 发送后 120 秒文件卡片少于清单 | `stalled(upload)` | 保留清单，不重发；人工确认 |
| 无进展 | 生成指示消失、无完整答复，持续 `stallMinutes`；或单轮达到 `maxRoundMinutes` | `stalled(timeout)` | 提示查看窗口，可恢复 |
| 页面状态不明 | 关键选择器缺失 | `stalled(ui)` | 保留快照，等待修选择器 |
| worker 崩溃 | 心跳缺失 3 次 | `failed(worker)` | 重启 worker，保留会话目录 |
| 提交状态未知 | 重开后回执指纹不匹配 | `stalled(unknown_submission)` | **绝不自动重发**，人工核对 |
| 轮次到顶 | 达到 `rounds` | `capped` | 交付阶段结论 |

通知策略：只有 `stalled` / `failed` / `capped` 向发起会话追加一条提醒，并在侧边栏标橙；`completed` 默认静默（可配 `notify=all`）。

### 9.1 人工核对

`stalled(upload)` 与 `stalled(unknown_submission)` 只能由人退出：侧边栏提供「我已核对」动作，必须填结论（已提交 / 未提交 / 需重开）和依据；写入 `human-check.json`（时间、结论、备注），随后转 `waiting` / `submitted` / `failed`。没有这条记录，主题不能离开 `stalled`；宿主不得代替人填写。

## 10. 材料策略

1. 宿主根据目标挑选文件，每个给出理由；用户可在研究卡里增删。默认上限 `maxFiles` / `maxTotalMB`。
2. 复制到运行目录 `materials/`，保留相对路径，写 `manifest.json`（path、bytes、sha256、来源）。
3. 发送前扫描密钥；命中即阻断，不提供「强制发送」快捷方式。
4. 上传后核对逐文件卡片（数量 + 文件名）；缺件按 `stalled(upload)` 处理。
5. **GitHub 是可选补充**：brief 里可以附仓库地址、提交号、路径清单，让 ChatGPT 自己判断要不要读；不自动 push、不传 token。未提交的改动仍然打包上传。
6. 不把摘要当原文：原始答复整份落盘——始终写 `rawAnswersDir/<topic-id>/NN-answer.md`；`rawAnswers=repo` 时再复制一份进主题目录。摘要只作为裁决材料。
7. follow-up 只送变化：原会话仍在时，送上一轮裁决 + 变化后的 brief + 新增/修改的附件，未变化的附件不重传；会话丢失时，由宿主生成 `context.md`（目标、已确认结论、未决问题、变化清单），连同当前仍需的附件重开一轮。`context.md` 进主题目录，生成它的是宿主，不是 Pro。

## 11. 记录与索引

### 11.1 目录

`store=project`（`rawAnswers=local`，默认）：

```text
<project>/docs/research/<slug>/
  topic.json
  materials/manifest.json
  rounds/01-question.md
  rounds/01-verdict.md
  receipts/01.json
  final.md
```

原文始终写 `rawAnswersDir/<topic-id>/NN-answer.md`（本机，路径可配）；`rawAnswers=repo` 时再复制到主题目录 `rounds/NN-answer.md`。`store=local` 时主题目录在 `~/.dsh/pro-research/projects/<project-slug>/<slug>/`，结构相同。

`slug` 由标题生成 ASCII kebab；非 ASCII 标题回退 `topic-<hash4>`，`topic.json` 保存原标题。

### 11.2 `topic.json`

```json
{
  "schema": 1,
  "id": "topic-9f3a",
  "title": "DSH 插件是否值得做",
  "type": "research",
  "parent": null,
  "created": "2026-10-22T08:00:00Z",
  "updated": "2026-10-22T08:42:00Z",
  "status": "completed",
  "roundsCap": 3,
  "rounds": [
    {
      "n": 1,
      "submittedAt": "2026-10-22T08:01:00Z",
      "answeredAt": "2026-10-22T08:31:00Z",
      "verdict": "partial",
      "files": 3
    }
  ],
  "channel": "web-pro",
  "model": "pro",
  "artifacts": ["final.md"]
}
```

`verdict` 取值固定为 `accepted | partial | rejected`；`rejected` 必须带理由，中文只用于展示。

### 11.3 本地侧车

会话 URL、消息指纹、profile 位置只写本机 `~/.dsh/pro-research/sessions/<topic-id>.json`，不进仓库；仓库里的 `receipts/NN.json` 只放哈希与时间。侧车不随仓库走：换机器或清空本机状态后，恢复不可自证，按 `stalled` 交人工核对。

### 11.4 索引

每个研究根有 `index.json`：`{schema, updated, topics: [{id, title, type, status, rounds, parent, updated, artifact}]}`，扫描 `topic.json` 重建。侧边栏读索引，按项目分组；follow-up 通过 `parent` 连成树。

### 11.5 公共仓库保护

`store=project` 且远端是公开仓库时，研究卡与研究记录都必须提示「答复会进入公开仓库」；默认建议改用 `store=local`，除非用户确认。

## 12. 侧边栏

- 面板「Pro」：按项目分组列表；每行状态点、标题、类型、第几轮、耗时、产物。
- 详情：时间线（问题/材料/答复/裁决）、回执、产物链接、恢复/取消按钮。
- 过滤：项目、状态、类型；搜索标题。
- 第一版只读 + 恢复/取消 + 「我已核对」，不做拖拽、不做富文本编辑。
- 打开详情时每 2 秒轮询一次远程方法；面板关闭即停。

## 13. 交互协议（技能）

技能名 `pro-research`，用户可调用，模型也可在用户明确说「用 Pro 调研」时调用。正文约束：

1. 只在用户明确要求 Pro 调研/设计，或用户同意提议时启动；不因「任务看起来重要」自动开跑。
2. 先给研究卡，字段齐全（问题、成功判据、材料、轮次上限、产物路径）才允许 `start`；`autoStart=true` 时也至少显示卡片与材料清单。
3. 运行期间不在会话里逐轮汇报；用户主动问才查状态。
4. 答复回来后逐条裁决（采纳/部分采纳/有依据驳回），写 `verdict.md`；不以 Pro 的身份或一致性当证据。
5. 最终文档由宿主写，Pro 的原文不直接当交付物。
6. 绝不自动 push、绝不重发提交状态未知的轮次、绝不发送扫描命中的文件。

## 14. 安全与合规

- 这是网页自动化，不是官方 API；ToS、风控与账号风险写进 README 首屏与设置页。
- 登录态只存在独立浏览器 profile（权限 700），不进仓库、不进设置、不进日志。
- 日志脱敏：不记录完整 prompt/答复，只记录哈希、长度与路径；调试快照保存在本机运行目录，默认 7 天后清理。
- 插件声明最小能力：`fs-read`、`fs-write`（记录与材料）、`network`（浏览器）、`shell`（启动 worker）。
- 不绕过验证码、2FA、付费墙；登录必须由用户手动完成。
- 取消不撤回已发送消息；提交状态未知时只能人工核对。

## 15. 发布与社区

- 仓库 `dsh-pro` 公开；v0.1 只发布 `dsh-pro-research`，核心与传输作为 workspace 内部包随它打包，避免过早承诺公共 API。`dsh-pro-design` 落地前再决定是否单独发布 core（名称发布前查重，冲突则改 scope）。
- README 首屏：风险提示、适用/不适用、安装、登录、示例、故障排查。
- 兼容：peer 依赖声明 DSH 范围；在桌面 nightly 与 web 各跑一次冒烟，记录版本。
- 市场：发布后向 awesome-dsh-plugin 提交收录；之后再做 `dsh-pro-design`，最后才是 OctoWorkFlow 约定包。
- 许可证：发布前必须落定（倾向 MIT），否则不发布。

## 16. 里程碑

| 阶段 | 内容 | 退出条件 |
|---|---|---|
| M0 | 设计评审 | 已完成：文档获批，许可证 MIT，包名 `dsh-pro-research` |
| M1 | 传输 spike（CLI） | 真实登录一次，完成 1 轮提交与取回；注入坏选择器能干净地 `stalled` |
| M2 | 引擎 + CLI | 假传输下 3 轮、到顶、恢复、两种 store 全通过；原子写与脱敏测试通过 |
| M3 | DSH host 插件 + 技能 | 会话里发起一个真实主题，工具、设置、技能可用，无 UI |
| M4 | 侧边栏 | 列表/详情/恢复/取消可用；跨会话回看 |
| M5 | 发布 0.1.0 | npm、Release、README、风险提示、许可证齐备 |
| M6 | Pro 设计 | 复用核心，产物模板与入口独立；0.2.0 |
| M7 | OctoWorkFlow 包 | 约定 + 交付/评审技能，独立插件，不依赖传输 |

粗估：M1–M2 约一周，M3–M4 约一周，M5 一到两天；以实际为准。

## 17. 验证计划

- 单测：状态机全转移、队列、原子写、slug、密钥扫描、脱敏。
- 假传输：脚本化答复、登录失效、附件缺卡、超时、崩溃，逐个断言状态与落盘。
- 真实冒烟：一个无害主题跑 2 轮，产出 receipt、answer、final；截图与日志留证。
- 证据分级：单测通过 ≠ 真实网页可用；真实冒烟只证明当次、当版本、当账号。
- 跨平台：Windows 先验收；macOS 只做冒烟，不宣称等价。

## 18. 待定与我的默认

| 问题 | 结论 | 备注 |
|---|---|---|
| 许可证 | **MIT** | 见 `LICENSE` |
| npm 包名/scope | **`dsh-pro-research`** | 发布前查重，冲突改 scope |
| 提前完成的判据 | **研究卡写成功判据，宿主判断，满足即停** | 停止依据写进 `final.md` |
| DSH 关闭时是否继续 | **v1 需 DSH 运行；关闭后暂停，重开恢复** | 设置页固定说明 |
| 原始答复 | **默认本机 `rawAnswersDir`；`repo` 可选** | 公开仓库禁止 repo |
| 有头/无头 | 有头（可最小化）；无头仅自检 | 可改 |
| ChatGPT Projects | 第一版不支持 | 后续评估 |
| 公开仓库保护强度 | 提醒 + 默认建议 local，不强制 | 后续可收紧 |

## 19. 未验证

- DSH 0.2.x 的客户端面板注入、远程方法注册与设置卡片 API 细节；M3 前需按实际版本核对，接口差异以实测为准。
- ChatGPT 网页的选择器、模型选择器与流式完成判定；M1 用真实页面校准。
- 长任务在桌面版休眠/锁屏后的行为；M1 记录，必要时提示保持唤醒。
