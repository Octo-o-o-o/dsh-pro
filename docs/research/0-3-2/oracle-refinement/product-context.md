# 项目事实与研究边界（2026-10-25）

## 定位与现有功能

同一个 DSH 插件 monorepo，research/design 共享 core、transport 和面板工厂，分别分发。用户目标是小而美、核心体验精，不扩大产品边界。

- Research：单账号网页 Pro 多轮研究、材料扫描/快照/哈希、问题/答复/裁决/回执落盘、续轮、重新生成、版本、取消/恢复、未知提交人工核对、侧边栏。
- Design：网页生成图片/HTML demo；API 只出图片。已有参考图片输入、API /images/edits、画廊、demo 查看、逐轮 ZIP，续轮可填新增材料路径和方向数。
- 现有 UI 是列表/详情三标签（概览/轮次/产物）；不考虑第三次重设计。
- 已有人工 accept，capped/reviewing/有产物的 failed/stalled 可接受，状态变 completed 并尝试唤醒原宿主会话。不能说“没有接受结果”。
- 0.3.2 已实现逐条判据输出、裁决异常重试一次后 reviewing、Research 优先展示 report.md、运行汇总 final.md 正名、Design 图片/HTML 取回状态和“视觉待人工确认”、材料路径弹窗、中文 slug 修正、首跑示例、examples、CHANGELOG。

## 代码核对中的疑点（请独立判断）

- JUDGE_SYSTEM 提示词要求 done 仅在 accepted 且所有判据 met；parseJudge 实际仅验证 accepted，未验证 criteria 完整性/全 met；engine 直接根据 result.done 转 completed。当前测试甚至包含 accepted+done=true+partial 判据（测试目的只是表格渲染）。
- judge 输入是 question、successCriteria、answer.slice(0,30000)，没有原附件内容和图片，不能称为独立事实核验或视觉验证。
- report.md 只有文件存在性，没有所属轮次、generation 或材料/答复指纹；Research 概览始终优先它。新轮或新版本后，现有代码看不出过期交付稿保护。
- DocumentContent 只渲染文本、列表、表格等；链接与 HTML 刻意保持惰性，现有安全测试断言没有 <a>。
- Design 图片卡片当前只有预览，继续/重做是主题级文本反馈加文件路径；没有结构化基础图片选择、保留/修改意图或并排比较。手动材料路径可实现部分参考图流程，不能说完全不能定向修改。
- Topic/Generation/Round 类型里未见 adopted/selectedArtifact/baseArtifact 等持久化字段；现有 accept 不接受版本或产物标识。新探索会让概览按最新版最新轮展示。
- 设计技能交付 design.md，Research 技能交付 report.md；共享 detail 读取 report.md，DesignOverview 主展示图和 demo。不要强行两插件交付语义完全相同。

## 既有研究与验证记录

旧研究已经给出五项：发布完整性、首次成功、完成语义、异常验收、续轮材料。docs/product-review.md 声称已在源码落地；但它的明细同时写明：未 sync-dist、未推送、未真实 chatgpt.com/API 重跑。

仓库 README 当前记录：源码 0.3.2；公开 Git 0.3.1；市场提交 0.3.0；npm 0.2.x。这是项目记录，当前宿主未联网重新确认市场实时状态。已有历史真实网页图/HTML 和多轮成果，不应说从没跑通过。当前版本单测/fixture 不等于当前真实网页完整验收。

旧评审记录单测 140 passed/2 skipped、typecheck/build/smoke 通过，是历史记录；本轮先静态核实，后续宿主如运行针对性检查会单独标记。当前源码工作区有既有修改，本轮不做产品变更、不新发产品测试请求、不发布。

## 信息与授权

对外只发此概要和经人工检查的必要源码片段；不发凭据、登录配置、Cookie、用户 profile、机器连接信息、原始私有研究任务。原料只含当前产品行为和常量/类型/函数代码。Oracle 主账号一个会话，历史同题 1 次已确认提交；本次 Oracle 最多 4 次，因此累计不超过 5 次。首轮充分即止。
