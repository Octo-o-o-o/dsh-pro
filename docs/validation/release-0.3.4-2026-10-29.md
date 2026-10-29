# 0.3.4 真实裁决与 local 交付验证

日期：2026-10-29，Windows，官方桌面随附 DSH `0.2.1-rc.3`。

## 修复与依据

- 自动裁决：DeepSeek-V4-Pro 的推理与文本共用输出预算。使用同一实际答复通过 DSH 的真实模型服务对照，1,800 token 在 `max-tokens` 结束且 JSON 不完整；8,192 token 在 `stop` 结束且 JSON 完整。保留严格的结束原因、JSON 与逐条判据检查。默认模型的推理等级同时传入，超时改为 180 秒。见 [脱敏对照](release-0.3.4-2026-10-29/judge-budget-comparison.json)。
- 复合判据：实际设计第 2 轮首次裁决把单条复合判据拆开，完成校验正确拒绝。改用原文 JSON 数组并明确禁止拆分、合并和改写；修复后对已保存答案重试，返回一项原文判据的有效 `partial`，未再次提交 ChatGPT。
- local 交付：新增 `read_round`、`read_report`、`write_report`，经过已注册的 DSH 工具执行链。写入范围固定为当前工作区所属主题的 `report.md` / `design.md`；不接受任意路径，不要求扩展宿主文件权限。校验最新已回答轮次、代际、revision、目录链接、并发写入和 256 KiB 上限。
- 网页失败：系统 Chrome 中观察到 ChatGPT `data-dil-render-failed`，补充可见且属于当前轮次的错误检测，保留会话并停止等待。该分支有真实 DOM 结构回归；不把浏览器中的临时错误截图当成整个主题最终失败的证据。
- 恢复信息：`status.last_round` 暴露 `submissionState`，宿主可根据明确 `not_sent` 证据恢复已授权原轮一次，不必从错误文案猜测。提交不明仍须人工核对。

## 真实研究闭环

- 主题 `topic-4b26026a3f`，`store=local`，无材料，单轮、单条判据：解释蒸发、凝结、降水。
- 另一日常桌面实例持有 Chrome profile 时，start 正确拒绝且未创建主题；日常实例正常退出后重新 start。
- 导航超时发生在发送前，记录 `submissionState=not_sent`；resume 原主题后只有一次实际外发。
- 真实网页答复完整包含三步及 QA 标记。2026-10-29 07:22:51Z 保存答复，07:23:04Z 自动裁决 `accepted`、状态 `completed`，无人工 accept。
- DSH 对话保持“工作区内修改”。宿主调用 `status → read_round → read_report → write_report → read_report`，成功交付 local `report.md`，覆盖 generation 1 / round 1，状态 `current`。随后通过 revision 更新一处过程描述并回读成功。
- 原答案、裁决与交付稿的脱敏副本在同名目录；原记录留在本机用户数据目录，未提交账号、Cookie、会话凭据或浏览器资料。

## 自动回归

- `npm test`：193 通过，15 个真实 Chrome 条件用例默认跳过。
- 显式启用 `DSH_PRO_TRANSPORT_SMOKE=1`：15 个网页状态与传输测试通过。
- `npm run typecheck`、`npm run build`、bundle smoke 通过。
- `acceptance-smoke`：10 组通过，覆盖首次安装、研究/设计面板、恢复不重发、取消、responsive UI、图片和 HTML 预览、API 请求/编辑/错误恢复。外部服务为测试替身，与上方真实网页和真实裁决证据分开记录。
- `last_round` 补充后，25 个插件集成测试、typecheck、build、bundle smoke 再次通过。
- 最终代码提交 `3dab081` 的 [GitHub CI](https://github.com/Octo-o-o-o/dsh-pro/actions/runs/40839558237) 通过（Windows / Ubuntu，Node 24）。

## 真实设计闭环

- 主题 `topic-8aa600d87e`，`store=local`，真实 web/pro，同一主题两轮。
- 第 1 轮发送前导航超时，明确 `not_sent` 后恢复；真实网页只返回图片。重启候选后由原回执重新附着，未重发，成功取回 1254×1254 PNG。真实裁决正常返回 `partial`，指出 HTML 缺失；`design.md` 通过插件工具写入和回读，保留未完成状态。
- 在原主题明确追加第 2 轮，24 秒内保存完整 HTML。首次裁决触发复合判据映射校验；修复提示后只重判保存答案，轮次、答复哈希与外发次数不变。
- 重判返回有效 `partial`：完整单文件 HTML 的静态证据成立，图片视觉和交互不能由文本模型盖章。此结果不属于服务/JSON 失败，也未被改写为自动通过。
- 外部视觉工具读取实际 PNG：蓝色背景、四组白云，符合云朵主题。系统 Chrome 打开 DSH 的实际产物预览，点击 Start 后按钮变为 Done，出现“太棒了！水循环探索完成！”。见 [真实交互截图](release-0.3.4-2026-10-29/design-preview-done.jpg)。
- 最终交付与验收状态见 [真实流程回执](release-0.3.4-2026-10-29/real-flow.json)，包括原裁决、报告 revision 与产物哈希。
- 在实际视觉和点击验证后，宿主调用 accept 收口，主题为 `completed`；第 2 轮自动 verdict 仍为 `partial`。最终 `design.md` revision 为 `0170be8ccbca91d49633b6d5dbd18cf8f84c324a1ea37eae291db9a836a05cc2`，插件回读为 `current`。未把人工/宿主验收包装成自动裁决 accepted。

## 桌面恢复

验收 host 已停止。日常 `desktop` profile 从实体 tarball 升级两个插件至 0.3.4，原依赖与配置保留；安装后的 host bundle 哈希与验证候选相同：Research `b280f1a068ad01e9998f885d40b7fbd79feddf43daef4dd88ee115551064775b`，Design `eb7856f265861ee1bd0a2940a31acb8700077a537c7fdb33ba1efd8f5c907b2d`。

桌面 DSH 已重新打开，Image Design 面板显示当前 QA 主题完成、2/2 轮及原 HTML 产物。未删除浏览器锁或更改日常权限设置。

## 范围

本轮使用已有登录态。首次人工登录、付费图片 API、macOS/Linux 真实端到端未在本轮验证；不能用 Windows 或替身测试结果代替。

发布回执见 [marketplace.md](../marketplace.md)。
