# dsh-pro panel UI v2 — 设计决策与落地映射

状态：已按方向 A 落地并验证。2026-10-23。
来源：ChatGPT Pro 网页会话（共享 Chrome），一轮生成三方向方向板。
设计板：`artifacts/round-01/design-board.png`（1647×955，A/B/C 三方向，每个方向含 Research + Design）。

## 运行记录（如实）

- 第一次提交（topic-1914）在 upload 阶段卡住：ChatGPT 把图片附件渲染成缩略图而不是文件卡片，`attachment card missing for current-research.png`；已取消。
- 第二次提交（topic-509c）改用 `current-ui.pdf` 作为截图载体，消息提交成功，但 `ui` 阶段被 transport 的 user-message 选择器误判（当前 ChatGPT 页面 DOM 里用户消息不再带 `data-message-author-role="user"`），主题被标成 stalled；已人工确认提交，但 `reattach` 仍无法按旧选择器确认。
- 从共享 Chrome 会话里人工回收了完整方向板与部分回答；模型生成的单文件 HTML demo 在回答里被截断（两个 code block 均未闭合），不能作为可运行交付。
- 因此：方向板作为设计输入，最终落地由宿主按方向板重写；截断的 HTML demo 不作为交付物（实际实现即两个插件的真实面板）。

## 三个方向

### A. 紧凑控制台（推荐）

- 列表：280px，搜索 + 全部/进行中/需处理/已结束筛选；行内左侧状态条、两行标题、类型/轮次/更新时间/产物数、选中强调；适合 900–1600px。
- 详情：顶部粘性标题/状态/元信息/路径 + 主操作；主内容 + 右侧产物栏；Research 用轮次表 + final.md，Design 用图片画廊 + demo。
- 优点：共用外壳最稳，列表扫读密度最高，详情动作层级最清楚；A 本身已经包含概览/轮次/产物分段，接近 B 的减滚动目标。
- 风险：右侧栏在 900–1100px 需要折叠；列表 280px 在窄面板要缩到 240px。

### B. 工作台

- 列表按“需处理 / 进行中 / 已完成”分组；详情用“概览 / 轮次 / 产物”分段（tabs），Research 的轮次表更结构化，Design 的画廊更突出。
- 优点：主题多时分组更好找；详情首屏更短。
- 风险：分组头 + 筛选同时存在会重复；列表行密度略低；两个插件的分组语义要统一（cancelled 归到哪里）。

### C. 档案 / 画廊

- Design 列表用封面缩略图，详情以画廊为主；Research 以文档/时间线为主；共享外壳但内容气质不同。
- 优点：Design 的“先看图”最直接；Research 更像档案。
- 风险：两个插件的列表结构分叉，维护和扫读一致性变差；封面图会让列表加载更重。

## 推荐：A

理由：

1. 用户的核心路径是“先找到任务，再处理任务”；A 的列表行能在 280px 内同时给出状态、两行标题、轮次、时间、产物数，这是 B/C 都不如的。
2. A 的详情头把“下一步”主操作放在第一屏，右侧栏固定放 final.md/图片/demo，Research 与 Design 只换内容区，不换操作模型。
3. A 已经用 tabs 解决长详情滚动，B 的主要收益被覆盖；C 的封面缩略图可以作为后续可选增强（设计插件列表右侧 40×40 缩略图），不作为第一版。
4. A 最接近现有 `panel.tsx` 的 `createElement` 结构：列表行、详情头、轮次表、产物区都能在原组件内重排，不需要新后端字段。

## 落地映射

### 列表

| UI 信息 | 现有字段/来源 | 说明 |
|---|---|---|
| 状态点/左侧状态条/状态文案 | `TopicRow.status` | 颜色 + 文案，不只靠颜色；`STALL_LABEL[stall_reason]` |
| 标题两行 | `TopicRow.title` | CSS `-webkit-line-clamp: 2`；完整标题进 `title` 属性 |
| 类型标签 | `type` / `config.designMode` | 研究/设计；两个插件分别用 R/D 小标签 |
| 轮次 | `rounds` / `rounds_cap` | `n/cap 轮`；capped 时高亮 |
| 更新时间 | `updated` | 相对时间（刚刚/分钟/小时/天） |
| 产物数 | `artifacts.length` | 0 不显示；设计插件显示图片/文件总数 |
| 待处理/卡住标记 | `status` + `stall_reason` | capped/reviewing → 待处理；stalled/failed → 卡住/失败 |
| 选中 | 本地 `selected` | `markTopicSeen` 保留 |
| 搜索/筛选 | 新增本地 `query` / `filter` | 纯前端；不新增接口 |

### 详情头

| UI 信息 | 现有字段/来源 |
|---|---|
| 标题、状态 | `detail.title` / `detail.status` |
| 轮次、类型、通道、模型、方向数、更新时间 | `rounds/rounds_cap`、`type`、`channelLabel(channel)`、`model`、`designs`、`updated` |
| 主题路径 | `detail.path`；复制按钮走 `navigator.clipboard` |
| 主操作 | `canAccept` / `canRegenerate` / `canContinue` / `status` 现有条件 |
| 次操作 | `review`、`review_cancel`、`wake`、`continue` |
| 工具/危险 | `probe`、`login` 进“更多”；`cancel` 独立 danger |
| 人工核对 | `stalled` 时 `human_check` + `submitted/not_submitted/reopen` |
| 下一步提示 | 由 status + stall/submit 条件派生，不新增字段 |

### 详情内容

| UI 区块 | 现有字段/动作 |
|---|---|
| 概览·Research | 最新 `generation.final`（final.md）、最近轮次、产物摘要 |
| 概览·Design | 最新轮图片（`artifacts` + `artifact_details.kind=image`）、demo 预览、文件摘要 |
| 轮次 | `generations[]` + `rounds_detail[]`；每轮 `查看回答` → `/answer`，`下载 ZIP` → `/bundle` |
| 产物 | `artifacts[]` + `artifact_details`；图片 `/asset`，demo `/raw`，文件 `/file`，打开/定位 `/open` |
| 图片查看器 | 现有 image viewer；`/asset` + 复制图片/复制路径/打开原文件/在文件夹中显示 |
| demo 查看器 | 现有 frame viewer；`/raw` + 新窗口打开 |
| 文本查看器 | 现有 text viewer；`/file`、`/answer` |
| 表单 | `regenerate`（备注）、`continue`（brief + 设计方向数 1–6）、`human_check`（结论 + 依据） |

### 新增的前端状态（不改后端）

- `query`：标题搜索。
- `filter`：`all | active | attention | done`（已结束包含 completed/cancelled）。
- `tab`：`overview | rounds | artifacts`。
- `dialog`：`regenerate | continue | check` + 表单字段（复用现有 `regenNote` / `continueNote` / `continueDesigns` / `checkNote`）。
- `listLoading`：首次/刷新列表的骨架；`detail` 未加载时的详情骨架。
- `notice`：操作成功/错误提示（现有，改为 toast/banner）。

## 实施（已完成）

- 只改 `packages/research/client/panel.tsx`（两个插件共用）；两个 `client/index.tsx` 不改。
- 用一段 scoped CSS（class 前缀 `dshpro-`）实现布局、状态色、选中/悬停、响应式；组件改为 JSX（构建仍走 React `jsx-runtime`），不引入组件库。
- 保留 3s 轮询、选择逻辑、所有 action 语义、viewer 的 `/asset` `/raw` `/file` `/answer` `/bundle` `/open` 路由。
- 同步两个插件的 `lib/client.js` 到 desktop profile；本机 profile 的 `client.js` 与仓库构建产物硬链接一致，刷新 GUI 即可加载，不需要重启 DSH。
- 不 push，不改发布仓库（`chatgpt-pro-research` / `gpt-image-design` 的生成目录）。

## 验证结果

- `npm run typecheck`：通过。
- `npm test`：17 个测试文件通过、1 个跳过；95 个测试通过、1 个跳过。
- `npm run build`：两个插件 host/client 四个 bundle 均生成，client 约 130KB。
- `node scripts/smoke-bundle.mjs`：两个插件均 1 工具 / 9 路由 / 2 前端槽位，`react` + `react/jsx-runtime`。
- 实际 desktop GUI（本名 profile，1722×997 与 900×900）：
  - Design `dsh-pro website`：列表 3 条主题、搜索/筛选、完成态；详情 7 张图片（按轮次 R 标记）、当前 demo、`final.md`；图片查看器可打开。
  - Research `dsh-pro 0.2.0 自审`：2 个版本 / 4 轮；轮次 tab 显示 `1-1..1-3` 与 `2-1`；`final.md` 在右侧“最终文档”与“全部产物”里；继续一轮弹窗可打开/取消。
  - 窄屏 900：列表折到顶部、详情全宽；390 也验证过（此前截图）。
- 验证截图保存在本机（`.tmp` / profile），没有提交到仓库：截图包含本机侧栏、用户名和路径，不适合公开仓库。
- 原始 `current-ui.pdf` 与两张现状截图含本机侧栏，未随仓库提交；字段清单保留在 `docs/design/panel-ui-inputs/ui-inventory.md`。
- topic-509c 仍标记 `cancelled`（工具生命周期如实），已人工把 `artifacts/round-01/design-board.png` 与 `design.md` 挂到该主题的 artifacts；没有伪造 `completed`。

## 未采纳

- B：分组列表+分段详情。分组与筛选重复，列表密度下降；A 已用 tabs 覆盖减滚动。
- C：封面/画廊。两个插件列表分叉，Research 不需要封面；Design 可在后续作为可选缩略图。
- 模型给出的 HTML demo：代码块被截断、Python 执行失败，不采用；按方向板重写为实际 React 实现。
