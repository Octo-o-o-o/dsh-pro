# 两个插件面板精修与本机部署结果

2026-10-23。已实施并部署本机，等待人工验收。部署完成时未提交、推送或公开发布；用户随后明确授权将完整更新提交到 GitHub，源码提交包含本轮面板和工作区已有的 0.3.2 更新，分发仓库与市场发布未执行。

## 设计与实现

沿用已有 Pro A 方向的主从结构，进一步减少套框和无效信息。任务列表统一为 288px（较窄容器 256px），轻量页头明确任务状态与下一步，次要动作收进“更多”，路径收进主题信息。Research 用蓝灰色、Design 用暖铜色，文字层级、间距、焦点和状态样式共用。

- Research：概览以总结正文为主，支持安全的标题、段落、列表、表格和代码阅读；旁边为最近活动、产物索引与折叠信息。完整轮次仍在独立标签中。
- Design：本版最新一轮图片完整 contain 展示，紧邻本轮 demo 入口；旧版图片不会补入当前画廊。历史产物有单独入口。
- 来源：优先使用 generation 对应的总结文件；旧总结、取消/失败任务均明确提示，文件存在和任务状态不等于人工验收。
- 交互：写操作统一防重入；表单验证位于弹窗内；原生 dialog、Esc、初始输入焦点、关闭后回焦；标签方向键/Home/End；图片/文档错误重试；减少动效。
- 异步：合并进行中的轮询；切主题及关闭/切换查看器后丢弃过期响应，避免旧内容覆盖当前选择。
- 响应式：以插件容器而非整窗宽度计算；小于 1200px 将摘要侧栏移到正文后，小于 720px 在任务列表和详情之间切换。

有意区别于旧方向板：研究正文成为首屏主内容，轮次表不再占据概览；设计图完整展示且严格归属当前版/轮；深色卡片更低对比，头部不再显示完整本地路径。

## 验证结果

| 项目 | 结果 | 证据/边界 |
| --- | --- | --- |
| 修改前基线 | 121 通过、1 跳过 | 原有工作未清理 |
| 首次修改后全量测试 | 123 通过、1 失败、1 跳过 | core engine 的取消场景 5 秒超时；保留 tests-after.log，原因未确证 |
| 原标准复跑 | 124 通过、1 跳过 | tests-recheck.log |
| 最终全量测试 | 124 通过、1 跳过 | tests-final.log；19 文件通过、1 跳过 |
| 最终类型检查 | 通过 | typecheck-final.log |
| 最终构建 | 通过 | build-final.log |
| 两插件 bundle smoke | 通过 | 各 1 tool、9 routes、2 slots；宿主 React |
| 独立方案与源码复核 | 已完成 | review.md，所发现问题已关闭 |
| Research 实际 React 界面 | 通过所列场景 | 正文、旧版提示、取消警告、文档失败重试、搜索空态/清除、reviewing 全部动作、标签方向键/Home、表单空输入、pending 禁用、Esc 回焦；合成 action 记录仅 1 次 |
| Design 实际 React 界面 | 通过所列场景 | 三张图完整显示、图片放大、当前版无图不混入旧图、失败重试入口、本轮 iframe 脚本交互 |
| 容器布局 | 所测无横向溢出 | Research 320/390/720/900/1080；Design 320/390/720/1080；浅深色截图、窄屏返回列表 |
| 本机 DSH | 两插件新版客户端已加载 | Research 真实 2 主题及总结正常；Design 当前为 0 任务，验证真实空态 |

浏览器验证直接加载实际 React 面板，使用标注“演示数据”的本机 fixture；未向真实任务提交继续、接受、取消或删除。fixture 的 HTML 示例首次检查因未声明 UTF-8 出现中文乱码，补充编码后重测，中文与按钮“交互已验证”均正常（design-demo-interaction.png）；产品代码未因此变更。本次没有完成真实设计任务生成链路或业务验收。

Pro 限额与旧 HTML 下载失败已记录：新请求未发送，旧 Pro 离线 HTML 仍缺失。用户明确授权本地实施，本地 fixture 不算 Pro 交付。

## 本机部署及回退

仅覆盖以下两个客户端文件，并核对构建与安装文件 SHA-256 一致：

- `~/.dsh/profiles/desktop/node_modules/chatgpt-pro-research/lib/client.js`：`066c88d62d93ee9643554583465733cfe06c7f610a908217285f003505298aaf`
- `~/.dsh/profiles/desktop/node_modules/gpt-image-design/lib/client.js`：`028be250c80f000065970ae825dac6ff9d56f611a3c52540978c2cddf9e86918`

两个已安装宿主 `lib/index.js` 哈希保持不变。DSH 刷新后通过侧栏点击验证。未更改包版本、真实任务数据、公开分发仓库或商店状态。

回退材料位于仓库 `.tmp/panel-refinement/baseline/`：`1-client.js` 对应 Research，`2-client.js` 对应 Design；manifest.json 记录原路径及哈希。复制回相应安装路径后刷新 DSH 即可回退界面。部署记录为 `.tmp/panel-refinement/deployment.json`。

## 截图与人工验收入口

证据都在仓库 `.tmp/panel-refinement/`：

- `installed-research.png`：真实 DSH 研究面板。
- `installed-design-empty.png`：真实 DSH 设计空态。
- `design-dark.png`、`design-light.png`：含演示数据的设计画廊。
- `research-light.png`、`research-320-dark.png`、`research-320-light.png`、`design-320-light.png`：主题及窄屏。
- `layout-research.json`、`layout-design.json`：测得的容器尺寸与溢出结果。

在 DSH 侧栏点击 Pro Research / Image Design 即可验收。优先看阅读层级、列表密度、更多菜单、轮次/产物切换及较窄窗口下的返回路径。Design 真数据当前为空，画廊的本机真实数据验收仍待有任务时完成。
