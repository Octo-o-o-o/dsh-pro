# 0.3.2 独立复核与发布验收

日期：2026-10-25。范围仍是完成判定、Research 交付稿覆盖范围、Design 指定底图续改三项，以及已有界面的尺寸适配。用户随后授权本机安装与 GitHub 发布，另明确暂缓 npm。

## 独立复核与修复

两位 subagent 使用独立上下文只读检查，分别复核修复后的候选。发现并最小修复：

- 裁决失败后明确继续或重新生成，不能再次卡在旧轮裁决；跳过记录与原错误均保留，恢复后继续新问题。
- `reviewing / answered` 在宿主重启后保留人工处理入口，不变成孤立的已回答状态。
- 已自动完成的研究仍可明确人工接受；界面据 `acceptedAt` 显示人工接受，而非猜测自动停止理由。
- 所选底图强制验证单图身份、哈希、大小及真实目录归属。编辑关闭、材料被篡改或目录跳出时在发送前拒绝，不能悄悄退化为无底图生成。
- 真实裁决服务需要稳定 sessionId。补齐发起会话／主题回退标识；服务错误和 aborted 终态保留真实原因，超时前收到完整 JSON 也不得接受。

最后的运行时增量经两位独立复评通过。定向测试覆盖原会话与主题回退、提供方报错、无输出超时、合法 JSON 后超时；失败仍只有原一轮、一次提交尝试。

## 自动化与真实闭环

- 完整回归：172 passed / 2 skipped。另显式启用真实浏览器驱动的本地 transport fixture：2/2 passed。
- 类型检查、构建、bundle smoke 通过；每个插件注册 1 工具、9 路由和 2 前端槽位。
- 干净 DSH profile 安装两个 0.3.2 打包产物，研究和设计面板均可加载，既有项目记录可读。
- 本机 DSH 0.2.1-rc.3 发起一次真实 ChatGPT 网页任务：15:21 提交并取回回答，答复包含 `DSH-PRO-032-OK` 并说明 2+2=4。15:37 用已保存答案重试自动裁决，两项判据均满足，状态 completed / accepted。始终 1 轮、1 次提交尝试，没有再次发送网页问题。
- 真实答复、回执与会话记录只保存在本地。本文不发布账户、浏览器状态或原会话链接。

## 本机前端验收

实际使用 Windows DSH 客户端，覆盖约 520、640、900、1280、2560 像素宽的窗口，最短约 600 像素高；包含宿主侧栏展开时约 240–360 像素的插件可用区域，以及浅色／深色主题。

检查长标题、多版本、24 轮表格、旧稿与未知覆盖信息、文件原地更新、搜索无结果、零轮次、零产物、横竖方图及坏图。表格内部横向滚动可到回答／裁决操作；短窗弹窗字段可滚动、底部按钮可达。选择第 2 张图时，缩略图与文件名一致；坏图禁用续改。普通续轮、空输入校验、Escape 退出和焦点恢复均检查。外观设置恢复为原来的“跟随系统”。

本地截图在 `.tmp/release-review-20261025/`，含 `research-520x600-accepted.jpg`、`research-520x600-validation.jpg`、`research-640-round-actions.jpg`、`design-520x600-base2.jpg`、两个深色面板与 `real-web-accepted.jpg`。六个人工夹具已从日常 registry 移除；原有主题与本次真实验收主题保留。

## 安装处理记录

从旧 `link:` 安装切换到打包安装时，pnpm 在 Windows junction 上误清理了两个包的源码目录。随后从 Git 基线、独立评审保存的完整 diff、逐次编辑记录及已验证安装包恢复；共享源码未受影响。

重建后的四个 host/client bundle 与事故前安装包 SHA-256 完全一致，前端主文件也与独立评审预先记录的哈希一致。最后缺失的连接守卫测试及两个测试 fixture 从原 DSH 成功编辑记录精确恢复，16:01 完整复测仍为 172 passed / 2 skipped，类型、构建、bundle smoke 通过。日常 profile 使用实际安装内容，不再指向源码目录；安装前 profile 清单、锁文件与恢复材料保留在本地 `.tmp`，不随发布提交。

| bundle | SHA-256 |
|---|---|
| Research host | `382e08ae8a22bfeb06bdd773449afbaa9bd401152e936ef665602ad66796c231` |
| Research client | `aa3253ea35ffdc44c4515e74998bc6b25219b11add7c8615c20a7fbf23d745bb` |
| Design host | `5bec51b60f6d498f919f9e86d6630dce5c1f8a024343d4e44a8d7c3d2b12c413` |
| Design client | `05d4e5ecf3461b56c3b22aea9e085b0f69602563786c443fdd88515497872cdf` |

## 发布范围与限制

两个公开 Git 仓库的 `v0.3.2` 已由 monorepo 脚本生成并推送，GitHub Release 均已公开：

- [ChatGPT Pro Research 0.3.2](https://github.com/Octo-o-o-o/chatgpt-pro-research/releases/tag/v0.3.2)：`8e72244664cd2f35b8d645da6acecba77088a842`
- [GPT-Image Design 0.3.2](https://github.com/Octo-o-o-o/gpt-image-design/releases/tag/v0.3.2)：`9706c6e4af3c428a0875a66ef36b2c9b33bc021b`
- 源码提交：`662361b0183d557a9ffda0a7d537e08ee3f8a2ec`。

本机 desktop profile 已从以上固定 Git 提交安装两个 0.3.2；host、client、README 与发布源码一致，其他三个第三方插件版本和全部 bundles 配置保持不变。npm 根据用户最新指示暂缓，仍为 0.2.6；市场本轮不重新提交，不宣称已收录。

本轮真实验收覆盖 Research 最小网页闭环；Design 底图发送和恢复使用本地假服务验证，没有新增真实生图 API 计费测试，也没有重新验证真实网页图片 + HTML 生成。图片视觉质量仍需人工确认。测试与面板验证不构成对全部页面改版、账号风控、网络中断或所有服务商兼容性的承诺。
