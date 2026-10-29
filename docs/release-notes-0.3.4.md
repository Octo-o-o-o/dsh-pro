# 0.3.4 — 可靠裁决与本地交付

本版修复真实推理模型裁决时输出预算不足导致的 JSON 截断，并让宿主在原有“工作区内修改”权限下交付 local 主题报告。

- 裁决输出预算改为 8,192 token，继承默认模型推理等级，超时 180 秒；异常仍保留原答复，不把截断 JSON 当成功。
- 复合判据按原文一一对应，避免模型拆分后无法通过完成校验；已保存答案可单独重判，不重复外发。
- 新增 `read_round`、`read_report`、`write_report`：按当前主题、代际和轮次写入固定 `report.md` / `design.md`，带 revision 和并发覆盖保护。
- 识别 ChatGPT 无法加载回复的页面状态；恢复时保留原会话。状态工具返回 `last_round`，明确区分未发送与提交不明。
- 改善技能说明和市场文案：Research 用于网页调研与报告；Design 的 web 通道支持图片和 HTML，API 通道只产图片。视觉与交互必须另外验收。

兼容 DSH `>=0.2.1-rc.3 <0.3.0`、Node.js 22+。Windows 真实单轮、自动裁决和 local 交付结果及限制见 [完整验证记录](https://github.com/Octo-o-o-o/dsh-pro/blob/main/docs/validation/release-0.3.4-2026-10-29.md)。市场审核与 npm/GitHub 发版独立。

安装：`dsh plugin --profile <profile> add <package>@0.3.4`，将 `<package>` 替换为 `chatgpt-pro-research` 或 `gpt-image-design`；重启目标 profile 后启用插件。
