# 0.3.5 — 安全边界与恢复一致性

本版同步更新 ChatGPT Pro Research 与 GPT-Image Design，以及两者共享的状态机、文件访问和传输实现。

## 主要改进

- **材料与文件边界**：校验真实路径及敏感原目标，固定已验证来源；预览、下载、原生打开、ZIP、返回产物和记录写入都拒绝越界链接。缺失附件明确失败，不悄悄按无附件继续；正常别名项目根仍受支持。
- **生图 API**：自检与提交统一校验配置；所有请求拒绝重定向，避免 key/提示词/参考图外带或自动重放。致命并发失败立即中止其他 lane 并等待清理；模型列表、错误、图 JSON、下载统一有界流式读取，按实际 key 脱敏。
- **授权与恢复**：已裁决轮与下轮间中断可继续，失败重试不扩张轮次预算；裁决及终态保存时取消均最终保持取消，不再被迟到结果覆盖。
- **汇总归属**：运行汇总带版本/轮次覆盖信息；新代失败后人工接受不套旧摘要，也不覆盖旧代归档；插件卸载等待引擎清理后再释放共享浏览器。

## 安装与兼容变化

使用本版完整 commit 安装（`<profile>` 换成 `desktop` 或你的 profile）：

```bash
dsh plugin --profile <profile> add github:Octo-o-o-o/chatgpt-pro-research#78efa99002f7d4843fcf78b876f1c0aada6a7a0c
dsh plugin --profile <profile> add github:Octo-o-o-o/gpt-image-design#1c23f937cd66c0e90a217cb74e54e36fd0fa4f49
```

两个公开仓库的 `v0.3.5` 为全新 tag，不移动旧 tag。npm 仍为 0.3.4，社区市场状态独立，本次 Git 发版不代表这些渠道已更新。

- DSH 实测 0.2.1-rc.3，兼容范围不变：`>=0.2.1-rc.3 <0.3.0`；Node 22+。
- **所有重定向（包括同源）都失败关闭**，需配置最终直达 endpoint/图片 URL；跨源 CDN 直链下载不带 key。远程 API 必须 HTTPS，本机 loopback 可用 HTTP。
- 文本预览 2,000,000 字节；单产物/逐轮 ZIP 100 MiB；模型列表 1 MiB、错误正文 8 KiB、图片下载 50 MiB；一方向只接受请求的 1 张图。
- 旧汇总仍可读；无有效覆盖信息时人工接受会保守重建，明确没有自动摘要，不臆造结论。

## 验证与边界

最终常规测试 **274 passed / 15 conditional skipped**，连续两遍；再显式启用 Chrome 条件测试 **15/15 passed**。类型检查、构建、两个 bundle smoke、真实 Cordis + Chrome + 替身服务的 10 组 acceptance 均通过。

本轮未重新调用真实 ChatGPT 或付费生图 API，不把替身测试视为真实服务或图片视觉质量验收；macOS/Linux 未实机验证。当前桌面进程的应用结果与远端发布回执以 [完整验证记录](https://github.com/Octo-o-o-o/dsh-pro/blob/main/docs/validation/release-0.3.5-2026-10-29.md) 为准。
