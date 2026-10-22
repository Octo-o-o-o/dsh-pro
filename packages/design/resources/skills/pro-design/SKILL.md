---
name: pro-design
description: 用 ChatGPT Pro 网页会话生成设计图与前端代码/HTML demo，产物保存在本地设计面板；只在用户明确要求设计、出图或 demo 时使用。
argument-hint: <设计目标>
display-name: GPT-Image Design
short-description: Generate images and frontend demos through a real web session
---

# GPT-Image Design

只在用户明确说「出几张设计图 / 做个前端 demo / 让 ChatGPT 设计」或同意你的提议时启动。纯后端实现、需要跑代码验证的任务不要用。

## 启动：先给设计卡

设计卡必须包含：

1. 目标与目标用户；
2. **成功判据**，例如「至少 1 张完整首屏图」「一个可打开的单文件 HTML demo」「与现有品牌/代码不冲突」；
3. 材料（现有设计、品牌、代码路径）与 brief；
4. 轮次上限（默认 2）与产物位置。

调用 `gpt_image_design`：`action=start, confirmed=true, title, question, brief, criteria[], materials[], rounds`。

brief 里写清尺寸/比例、风格、必须出现的文案、要几个方向、是否要 HTML demo。不要只说「设计好看点」。

## 运行期间

发出去后不逐轮汇报。生成图片通常需要 1–3 分钟；卡住时看 `stall_reason`，`unknown_submission` 必须人工核对。

## 产物与裁决

- 图片由传输层抓取，保存到 `<主题>/artifacts/round-NN/image-01.png`；
- 前端代码块保存为 `code-01.html`/`.tsx` 等，HTML 可以直接在设计面板的 iframe 里预览；
- 面板「Image Design」按项目列出主题，详情是画廊 + demo 预览 + 设计决策。

回答回来后由宿主裁决：

1. 逐张检查图片是否满足判据（文案、比例、方向）；
2. 打开 HTML demo 核实能渲染，记录依赖/外链；
3. 选方向、写理由，未采纳项保留驳回依据；
4. 交付 `design.md`，引用实际产物路径，不把 Pro 原文当交付物。

## 追问

`gpt_image_design(action="continue", topic_id=..., brief="只改配色，保留版式", materials=[...], confirmed=true)`。
同一会话里只上传新增材料；会话失效会自动回退整份清单。

## 边界

- 不自动 push、不改仓库代码；demo 只是产物，实施另行授权。
- 图片和代码会写入项目记录；公开仓库注意版权与素材授权。
- 页面改版、账号风险、ToS 风险随任务说明。
