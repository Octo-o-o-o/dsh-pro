# 使用说明

这份文档按「一次配置、四种日常用法、出问题怎么办」组织。设计取舍见 [design.md](design.md)。

## 1. 一次性配置

安装后打开 DSH 设置 → 插件 → `chatgpt-pro-research`（显示名 **ChatGPT Pro Research**）：

| 设置 | 默认 | 说明 |
|---|---|---|
| `rounds` | 3 | 每主题默认轮次上限，1–10 |
| `model` | pro | 页面上的 Pro / Thinking |
| `store` | project | 记录进仓库 `docs/research/`；`local` 进 `~/.dsh/chatgpt-pro-research/` |
| `rawAnswers` | local | 原始答复默认只在本机；公开仓库保持 local |
| `rawAnswersDir` | `~/.dsh/chatgpt-pro-research/raw` | 原文目录，可改绝对路径；设计插件默认 `~/.dsh/gpt-image-design/raw` |
| `headless` | false | 首次登录必须有头 |
| `stallMinutes` | 45 | 无进展判定；生成中不计时 |
| `maxRoundMinutes` | 90 | 单轮墙钟上限 |
| `maxFiles` / `maxTotalMB` | 12 / 24 | 单轮附件限制 |
| `autoStart` | false | 跳过研究卡确认（不建议首次开启） |
| `judgeProvider` / `judgeModel` | 空 | 自动裁决的 LLM 路由；留空使用 DSH 默认模型自动裁决，填 `off` 关闭。自动裁决失败时保留答复并停在「待判断」。 |

设计插件（`gpt-image-design`，显示名 **GPT-Image Design**）另有生图通道设置：`channel=web|api`，`api` 时填 `imageBaseUrl` / `imageApiKey` / `imageModel`（以及可选的 `imageSize` / `imageQuality` / `imageFormat` / `imageEdit` / `imageTimeoutSeconds`）。key 也可用环境变量 `GPT_IMAGE_API_KEY`；不需要登录，`gpt_image_design(action="probe")` 自检地址、key 与模型名。API 通道只出图片，不产出 HTML demo；`designs` 是每轮请求数（按服务商计费），未配置自动裁决时默认只跑 1 轮。详见 [gpt-image-design README](../packages/design/README.md)。

设置页固定提示：运行期间 DSH 要开着（可最小化）；关掉后任务暂停、重开从回执恢复；锁屏尽力而为，不承诺关机跑完。

网页通道固定为单账号、单会话：两个插件共用本机 Google Chrome 和同一个 profile `~/.dsh/pro-research/browser`，不提供多账号/多 profile 切换，也不合并多份答复。

### 登录一次

在会话里让 agent 调用：

```text
pro_research(action="login")
```

会弹出一个独立 Chrome 窗口，登录 ChatGPT；工具检测到输入框后关闭窗口。登录态保存在 profile 目录，不需要每天登录。

自检：

```text
pro_research(action="probe")
```

返回 `{ok, loggedIn, model, available}`。`ok=false` 时先排查登录或网络。

## 2. 日常用法

### 2.1 写大方案前调研

第一次使用先跑一个**不需要材料**的单轮主题，确认登录、提交、取回和面板都正常；确认后再带材料、加轮次。对话里说「先让 Pro 调研一下 X 的社区现状和风险」。

Agent 会先给研究卡：

- 主题与一句话问题；
- **成功判据**（自动裁决和提前停止都靠它）；
- 材料清单（路径、数量、是否敏感）；
- 通道、轮次上限、记录位置；
- 产物路径。

确认后 agent 调用：

```text
pro_research(action="start", confirmed=true, title=..., question=..., brief=...,
             criteria=[...], materials=["docs/a.md", "src/b.ts"], rounds=3)
```

工具会做密钥扫描、材料清单哈希、入队。之后不在会话里刷屏。

### 2.2 想不清楚时发散

同样走调研，但 brief 里要求「给 3 个方向 + 每个方向的反例 + 与现状冲突处」，成功判据写成可检查的句子。

### 2.3 Pro 设计

对话里说「让 Pro 给登录页改版出几个方向」，或直接 `/pro-design`。流程相同，改用 `gpt_image_design` 工具（主题类型由插件固定为 design），裁决表变成「方向 / 取舍 / 反例 / 未采纳理由」，产物是 `design.md`。

### 2.4 追问同一主题

用 `continue` 追加一轮（`completed` 或 `capped` 都可以）：

```text
pro_research(action="continue", topic_id="topic-xxxx",
             brief="只补充未决的部署风险，不要重复已确认结论",
             confirmed=true)
```

如果原会话还在，下一轮会回到同一个 ChatGPT 会话；新加的材料用 `materials=[...]` 传入，只上传这一轮新增的文件。原会话丢了会新开一个，并回退为整份材料清单。轮次到顶时，`continue` 会把上限加一并留下记录（显式加轮）。

新建主题时可以用 `parent` 指向父主题，把 follow-up 串成同一棵树。

不满意整版结果时用 `regenerate`（保留历史轮次，开新版本），可附 `note` 说明不满意点，也可附 `materials=[...]`（相对主题项目根目录）补充新材料：

```text
pro_research(action="regenerate", topic_id="topic-xxxx", note="配色太暗", materials=["docs/brand.md"], confirmed=true)
```

终态主题（完成/取消/到顶/失败/卡住）可以删除，目录、原始答复与面板记录一并清除：

```text
pro_research(action="delete", topic_id="topic-xxxx", confirmed=true)
```

## 3. 侧边栏

- 「Pro Research」/「Image Design」面板按项目列出主题：状态点、标题、第几轮、记录路径。
- 概览：Research 以宿主交付稿 `report.md` 为主；没有交付稿时显示「运行汇总（自动生成）」，不会把机械汇总当交付物。Design 以本版最新轮图片与 demo 为主，并显示「取回 X/Y 张、HTML 是否取回、视觉待人工确认」；旧成果标注来源版本。
- 轮次 / 产物标签：查看完整轮次、裁决、文件和原始回答；主题路径收在可折叠的主题信息中。
- 窄屏时在列表与详情间切换，可用“返回任务列表”回到原搜索和筛选。
- 操作：取消、恢复、删除、人工核对（已提交 / 未提交 / 需重开）；每轮可看裁决全文与原始回答，产物可打包下载 ZIP。
- 自动裁决失败时主题停在「待判断」：答复与产物保留，可以接受结果、继续一轮、重新生成，或修好裁决模型后「重试自动裁决」。
- 「继续一轮」/「重新生成」弹窗可以填本轮新增材料的路径（每行一个，相对项目根）；提交前会做路径、限额和密钥检查。
- 每 3 秒刷新；没有任务时提示用 `/pro-research` 开始。

## 4. 卡住与恢复

状态变 `stalled` 时才需要人：

| 原因 | 你要做的 |
|---|---|
| `login` | 重新 `login`，再 `resume` |
| `upload` | 看窗口里缺哪张文件卡；核对后「未提交」重发或「需重开」 |
| `ui` | 页面结构变了；保留现场，报 issue 或等选择器更新 |
| `timeout` | 看窗口是否还在生成；可 `resume` 续轮 |
| `unknown_submission` | 必须人工核对：已提交/未提交/需重开，写依据 |

`failed(worker)` 表示浏览器进程崩了；重启后 `resume`。

**绝不自动重发提交状态未知的轮次**——宁可停下等人。

## 5. 记录

- `store=project`：`<项目>/docs/research/<slug>/`
  - `topic.json`、`materials/manifest.json`
  - `rounds/NN-question.md`、`rounds/NN-verdict.md`
  - `receipts/NN.json`（哈希与时间）
  - `final.md`（运行汇总，自动生成）
  - `report.md`（宿主交付稿：结论、判据逐条、未决项、产物入口）
- `store=local`：`~/.dsh/chatgpt-pro-research/projects/<project>-<hash>/<slug>/`
- 原始答复：`rawAnswersDir/<topic-id>/NN-answer.md`；默认 `~/.dsh/chatgpt-pro-research/raw`，`rawAnswers=repo` 时才复制进项目。
- 会话 URL、消息指纹只写本机 `~/.dsh/chatgpt-pro-research/sessions/`，不进仓库。

公开仓库默认拒绝 `rawAnswers=repo`；研究记录会提示「答复将进入公开记录」。

## 6. 故障排查

| 现象 | 处理 |
|---|---|
| `composer not found` / 登录失效 | `login` 后 `resume` |
| 附件卡片缺失 | 确认 ChatGPT 页面上传成功；不要清空附件或用正文摘要替代 |
| 页面结构变了 | 记录 snapshot 与时间，报 issue；不要手改回执 |
| 轮次到顶没结论 | 状态是 `capped` 不是失败；确认后可显式加一轮 |
| 面板空白 | 先看 DSH 插件页是否加载成功；再看 `/chatgpt-pro-research/topics` 是否 200 |
| 启动报 `Cannot use import statement outside a module`，指向 `chatgpt-pro-research/client.js` | 插件前端产物格式错误；用修复后的源码运行 `npm run build` 和 `node scripts/smoke-bundle.mjs`，更新 profile 中的插件安装副本后重启。前端必须注册 DSH 的惰性模块 factory，不能直接分发 ESM |
| 启动报 `slot "main" is not declared` | 前端注册早于布局加载；更新到使用 `slots.inject()` 等待槽位声明的版本后重启 |

## 7. 边界

- 这是订阅网页自动化，不是官方 API；ToS、风控、账号风险由使用者承担。
- 不自动 push、不绕过验证码/2FA、不发送扫描命中的文件。
- 页面改版可能让它失效；选择器集中在 `packages/transport/src/selectors.ts`。
