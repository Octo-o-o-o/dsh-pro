---
name: pro-design
description: 用 ChatGPT Pro 网页会话做有界的设计征询（方向、取舍、反例）；只在用户明确要求 Pro 设计或同意提议时使用。
argument-hint: <设计目标>
display-name: Pro Design
short-description: Bounded web-Pro design consult with recorded decisions
---

# Pro 设计

只在用户明确说「Pro 设计 / 让 Pro 出几个方向」或同意你的提议时启动。纯实现任务、需要跑代码验证的任务不要用。

## 启动：先给研究卡

字段与 Pro 调研相同，但成功判据换成设计判据，例如：

- 给出至少 3 个可区分的方向；
- 每个方向写清取舍、失败模式和一个反例；
- 明确指出与现有产品/代码冲突的地方；
- 不输出无法落地的泛泛建议。

调用 `pro_research`：`action=start, confirmed=true, type=design, title, question, brief, criteria[], materials[], rounds`。

brief 里写清：目标用户、现有约束、不能动的部分、希望它挑战的假设。材料只给必要文件；密钥不外发。

## 运行与裁决

发出去后不逐轮汇报；卡住时按 `stall_reason` 处理，`unknown_submission` 必须人工核对。

答复回来后由宿主裁决：

1. 把方向、取舍、反例拆成决策表；
2. 标出与仓库现状冲突或无法落地的部分；
3. 选出方向并写理由，保留未采纳项及驳回依据；
4. 产物是 `design.md`（决策、开放问题、未采纳及理由），不是 Pro 原文。

## 边界

- 不把 Pro 的稿子直接当设计交付；不自动改代码、不自动 push。
- 同一主题只有一份记录；跨主题引用用 parent，不复制结论。
- 页面改版、账号风险、ToS 风险随任务说明。
