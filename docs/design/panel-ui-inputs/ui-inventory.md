# 两个插件的列表 / 详情现状清单（设计输入）

采集时间：2026-10-23。对象：`chatgpt-pro-research` 与 `gpt-image-design` 共用客户端面板
`packages/research/client/panel.tsx`；设计插件只通过 `configure({ designMode: true })` 切换文案与产物区。

## 1. 现状截图

- `materials/current-research.png`：Pro Research 详情。左侧主题列表 + 右侧轮次表 / 全部产物。
- `materials/current-design.jpg`：GPT-Image Design 详情。左侧主题列表 + 右侧轮次表 / 全部图片 / 前端 demo。

## 2. 现有布局

```text
Panel (height 100%, flex row)
├─ list: 固定 240px，右边框，overflow-y auto
│  ├─ 标题（插件名，13px / 600 / 0.8）
│  └─ 主题行（padding 8/12，底部分隔线）
│     ├─ 8px 状态点 + 标题（13px / 500 / 单行省略）
│     └─ 状态文案 · n/cap 轮（11px / 0.65）
└─ detail: flex 1，overflow-y auto，padding 14，13px / 1.6
   ├─ 标题 h3 17px + 状态 pill
   ├─ 元信息行（轮次 / 类型 / 通道 / 模型 / 方向数 / 更新时间）
   ├─ 卡住原因、停止依据、路径
   ├─ 按钮行（自检、登录、取消、恢复、重新生成、继续一轮、接受结果、请原会话判断、撤回、唤醒、人工核对）
   ├─ 内联表单（重新生成 / 继续一轮 / 人工核对）
   ├─ 轮次：按“第 N 版”分组，每组一张 7 列表格
   │  └─ 每轮下方可展开图片缩略图 / 文件 chips
   └─ 产物：
      ├─ research：全部产物 chips
      └─ design：全部图片网格（minmax 220px）、前端 demo iframe（高 420px）、代码与文件 chips
```

模态查看器：图片 / iframe / 文本三种；底部动作“复制图片 / 复制路径 / 打开原文件 / 在文件夹中显示”。

## 3. 真实数据（不能凭空新增字段）

### TopicRow（`/topics`）

| 字段 | 说明 |
|---|---|
| `topic_id` | 主题 id |
| `title` | 标题 |
| `type` | `research` / `design` |
| `status` | 见状态表 |
| `channel` | `web` / `api`（设计插件可能为 api） |
| `model` | 例如 `pro` |
| `judge_enabled` | 是否配置自动裁决 |
| `stall_reason` | 卡住原因，可能为 null |
| `rounds` / `rounds_cap` | 已用轮次 / 上限 |
| `designs` | 设计插件每轮方向数，可能为 null |
| `stop_reason` | 完成/停止依据，可能为 null |
| `review_from` | 复核来源状态，可能为 null |
| `artifacts` | 产物相对路径数组 |
| `updated` | ISO 时间 |
| `root` / `store` | 项目根 / `project`、`local` |

### TopicDetail（`/topic`）追加

| 字段 | 说明 |
|---|---|
| `created` | 创建时间 |
| `generations` | `{ n, createdAt, rounds?, reason?, final? }[]` |
| `artifact_details` | `{ path, kind: image / demo / code / archive / file }[]` |
| `path` | 主题目录绝对路径 |
| `rounds_detail` | 见下 |

### RoundRow

`{ n, generation?, verdict?, files, submittedAt?, answeredAt?, attempts?, artifacts? }`

- `verdict` 取值为 `accepted | partial | rejected`；`partial` 在截图中显示为“partial”。
- `attempts` 大于 1 时显示重试次数（`attempts - 1`）。
- `artifacts` 缺省时，从主题 `artifacts` 里按 `/round-NN/` 前缀过滤。

### GenerationRow

`{ n, createdAt, rounds?, reason?, final? }`；`final` 是本版总结文件（如 `final.md`），按钮“本版总结”。

## 4. 状态与颜色

| status | 中文 | 颜色 | 是否进行中 |
|---|---|---|---|
| `draft` | 草稿 | 默认灰 | 否 |
| `queued` | 排队 | 默认灰 | 是 |
| `uploading` | 上传中 | 默认灰 | 是 |
| `submitted` | 已提交 | 默认灰 | 是 |
| `waiting` | 等待答复 | 默认灰 | 是 |
| `answered` | 已答复 | 默认灰 | 是 |
| `adjudicating` | 裁决中 | 默认灰 | 是 |
| `completed` | 完成 | `#2e7d32` | 否 |
| `capped` | 待接受 | `#6a1b9a` | 否 |
| `reviewing` | 待原会话判断 | `#3f7fbf` | 否 |
| `stalled` | 卡住 | `#ed6c02` | 否 |
| `failed` | 失败 | `#c62828` | 否 |
| `cancelled` | 已取消 | `#757575` | 否 |

卡住原因：`login` 登录失效、`upload` 材料上传不完整、`timeout` 超时或无进展、`ui` 页面结构变化、`config` 配置或请求参数被拒、`worker` 浏览器进程崩溃、`unknown_submission` 提交状态未知。

## 5. 现有动作与触发条件

| 动作 | 条件 | 现有文案 |
|---|---|---|
| `probe` | 始终 | 自检 |
| `login` | 始终 | 登录 |
| `cancel` | 进行中 | 取消 |
| `resume` | stalled / failed | 恢复 |
| `regenerate` | completed / capped / reviewing / failed / stalled | 重新生成（可填备注） |
| `continue` | 同上 | 继续一轮（可填 brief；设计插件可填方向数 1–6） |
| `accept` | capped；reviewing 且 review_from=capped 或已有产物；failed/stalled 且已有产物 | 接受结果 / 接受已有产物 |
| `review` | capped / reviewing；failed/stalled 且已有产物 | 请原会话判断 / 再次提醒原会话 |
| `review_cancel` | reviewing | 撤回判断请求 |
| `wake` | completed | 唤醒原会话 |
| `human_check` | stalled | 已提交 / 未提交 / 需重开 + 必填依据 |

注意：自检/登录是工具动作，不是当前主题的主操作。设计上应把它们降级，避免和“接受/恢复/继续”抢同一视觉层级。

## 6. 两个插件的内容差异

| 维度 | Research | Design |
|---|---|---|
| 主题类型 | research | design |
| 核心产物 | `final.md`、轮次回答、回执、ZIP | 图片、`code-01.html` demo、源码/压缩包 |
| 详情重点 | 轮次表 + 裁决 + 最终文档 | 本轮图片画廊 + demo + 文件 |
| 轮次表缩略图 | 无（只有文件 chips） | 148×96 缩略图 |
| 产物区 | “全部产物” chips | “全部图片”网格 + “前端 demo” iframe + “代码与文件” |
| 每轮方向数 | 无 | `designs`（1–6） |
| 通道 | 固定 web | web / api |
| 现有截图文案 | “dsh-pro 0.3.0 复核：从裁决到可实施补丁”等 | “dsh-pro website”等 |

## 7. 当前可用示例数据（来自截图 / 本机记录）

```text
Design:
- dsh-pro website · design · web · pro · 3/3 · completed · artifacts: 7 张图 + code-01.html
  rounds: 1-1 partial 5 files, 1-2 partial 0, 1-3 partial 0
- dsh-pro 0.3.0 复核：从裁决到可实施补丁 · research · web · pro · 1/1 · cancelled
  rounds: 1-1 partial 12 files · final.md
- dsh-pro 0.2.0 自审：两个插件的... · research · 4/4 · completed
```

## 8. 现有视觉问题（设计要解决）

1. 240px 列表只有状态点 + 单行标题 + 轮次，长标题全部截断；没有类型、更新时间、产物数、卡住标记；选中态只有一层浅灰。
2. 列表没有搜索/筛选/分组；主题多时无法扫读。
3. 详情首屏被元信息、路径、工具按钮占据；“下一步该做什么”不突出。
4. 动作按钮全部同权重，`自检/登录` 与 `接受/恢复/继续` 混排；危险动作（取消）也没有区分。
5. 轮次表 7 列大量留白，`重试` 常为空；每轮产物挤在表格下方，层级弱。
6. 设计插件的图片网格和 420px demo iframe 直接铺在详情里，浏览节奏被打断；demo 没有独立入口/收起。
7. 研究插件的 `final.md` 只是一个小 chip，最终交付物不突出。
8. 没有空态/加载态设计；两个插件看起来完全一样，只有图标和产物区不同。

## 9. 设计约束

- 运行在 DSH Web GUI 的主区域，左侧还有 DSH 自己的应用侧栏；面板宽度可能从 ~900px 到 ~1600px。
- 必须同时适配浅色/深色；现有代码用 `rgba(127,127,127,...)`、`Canvas/CanvasText` 做中性色。
- 不引入网络字体、外部图片、CDN；HTML demo 单文件可离线打开。
- 中文界面；标题可能很长（中文/英文/路径），要能截断或换行。
- 不新增后端字段/接口；只重排现有数据与动作。
- 设计稿要能对应到 `createElement` 可实现的 DOM/CSS（flex/grid、border、背景、伪元素；不依赖组件库）。
- 不改变轮询、选择、动作语义；只改呈现与信息层级。

## 10. 设计探索方向（供 Pro 参考，不限定）

- A. 紧凑控制台：列表 = 可扫描的行 + 左侧状态条；详情 = 顶部粘性标题/主操作 + 双栏（主内容 + 右侧产物/上下文栏）。
- B. 工作台：列表按“需处理 / 进行中 / 已完成”分组；详情用“概览 / 轮次 / 产物”分段或 tabs，减少滚动。
- C. 档案/画廊：设计插件用封面缩略图列表，详情以画廊为主；研究插件以文档/时间线为主，两个插件共享外壳但内容气质不同。

三个方向都要回答：列表如何扫读、详情如何做决策、两个插件如何区分但不分裂。
