# 0.3.3 项目复核与 Git 发布

日期：2026-10-29（Asia/Shanghai）。本轮按用户要求检查项目缺口、收拢全部分支/worktree，并推送开发仓库及两个独立发布仓库。此记录是本轮自检，不称独立第三方验收。

## 分支与工作区盘点

对三个仓库完成 fetch、远端 heads、本地分支、worktree、stash 及开放 PR/issue 检查：均只有 main 和各自主工作区，无额外分支、worktree、stash、开放 PR 或 issue。无需生成空 merge commit；已有未提交修改与研究/验收证据收拢到开发仓库 main。

起点：开发仓库 `e654f35`，Research `8e72244`，Design `9706c6e`（两发布仓库均为 0.3.2）。保留所有旧版本 tag；本轮版本为 0.3.3。

## 本轮确认与修补

- 复查并纳入已有网页完成识别、原提交恢复、明确未发送状态、跨 bundle 异常、store 参数和预览修复。
- **Design 交付稿识别缺口**：技能要求写 `design.md`，原共享读取器只识别 `report.md`。现按 design 主题优先读取 `design.md`，兼容旧 `report.md`；面板按实际交付稿路径标注宿主来源。回归覆盖优先级、旧文件回退、研究隔离及真实 bundle 的 HTTP/面板展示。
- **裁决结束状态缺口**：原代码仅拒绝 error/aborted，max-tokens 或无 finish 的流即使携带完成 JSON 也可能被接受。现要求 stop 结束；异常记录 finish、正文字符数和推理字符数，不保存原始推理/无效正文。覆盖截断、无结束标记、非 JSON、纯推理四种流，答复均保留在 reviewing，无额外网页发送。这提供诊断能力，不把 10-28 真实故障的根因标为已确定。
- **发布分支与 origin 校验缺口**：原脚本可在非 main 分支提交产物，却推送 main；origin 子串也会接受相似仓库名。现必须在 main 且 HTTPS/SSH origin 精确匹配；隔离临时仓库测试验证错误在 fetch/生成前被拒绝。
- 更新版本、技能、安装文档、CHANGELOG 和发布说明；CI 增加显式 Chrome 回归与实际 bundle 隔离验收，避免这些检查长期被 skip。

## 验证

环境：Windows，Node v24.22.1、npm 11.19.1，本机 Google Chrome。DSH 宿主依赖保持 `0.2.1-rc.3` 范围，未升级依赖。

| 检查 | 结果 |
|---|---|
| `npm test` | 187 passed，14 optional Chrome cases skipped |
| 显式 Chrome 两套测试 | 14/14 passed；本地网页与 DOM 夹具 |
| `npm run typecheck` | passed |
| build + bundle smoke | 两插件均可加载；各 1 工具、9 路由、2 前端槽位 |
| release-dist `--check` / `--apply` | 在发布脚本中重新校验远端；由唯一源码生成并提交两个分发仓库 |
| `scripts/acceptance-smoke.mjs` | 两插件首次使用、确认保护、续轮、图片/HTML、预览 Esc、Design 交付稿、进程恢复、取消、模拟 API 编辑与失败恢复、窄屏和主题检查 |
| 凭据模式检查 | 待提交文件仅命中两处既有测试假密钥；无浏览器配置、cookies、凭据、tarball 或 `.tmp` 运行目录入库 |

验收脚本使用真实构建 bundle、Cordis、HTTP 和 Chrome，ChatGPT/裁决/生图 API 由隔离假服务替代；不得把模拟通过当作真实服务商验收。新增 design.md 是测试宿主写的夹具交付稿，也不代表旧 local 主题权限问题已解决。

## 仍需验证的边界

1. **全新账号首次真实登录**：10-28 的空 profile 未获得成功回执；本轮不复制账号状态、不重做真实登录。现有会话恢复的历史证据仍有效，首次登录端到端仍未验收。
2. **真实 Design 自动裁决**：10-28 的非 JSON 返回缺少原始结束诊断；本轮已补诊断及安全停止，但需要后续真实运行确认根因和成功路径。
3. **local 交付稿写入权限**：既有宿主 workspace-write 无权写 local 目录；不更改宿主安全设置。技能现要求启动前核对 store/path 与交付稿权限，项目存储在已获授权时可选；已有 local 主题不迁移。真实 local 交付稿闭环仍未完成。
4. **真实付费生图 API、精确尺寸与跨平台端到端**：本轮无付费服务调用。历史网页图像未严格满足 1024×1024；视觉质量与尺寸必须单独核对。macOS/Linux 的真实 DSH 与账号流程未覆盖；托管 CI 即使通过也只证明其自动化检查。
5. **市场与 npm**：仅推送 Git main 与新版本 tag，不重新投稿或宣称市场收录，不更新 npm。市场历史状态见 marketplace.md。

## 发布回执

开发仓库候选为本文件所属提交；发布仓库最终候选如下。GitHub Actions 结果单独核对，不将本地通过代替远端 CI。

- Research：`3e841afeca1919dc31e009211fd86ffc84002dc8`。
- Design：`d3d2fb65bcdb311009d7ebdf27169bd142a7ecbb`。
- 最终隔离验收：`.tmp/acceptance-20261028/run-HXifmY/`，10 组通过，`errors=[]`、`findings=[]`；[结果副本](release-0.3.3-2026-10-29/acceptance.json)。初次新增交付稿检查暴露 Design 前端缺少展示区，修复后重跑通过；失败证据保留于 `.tmp/acceptance-20261028/run-qKs2Ak/`。
- 发布过程遇到 Git HTTPS 抓取停滞/Schannel 握手失败，停止本次抓取进程后，以仅本次命令生效的 SSH URL 映射继续；未更改持久 remote、凭据或证书验证设置。

| Bundle | SHA-256（与分发仓库逐一核对） |
|---|---|
| Research host | `cfd17e4662f207e377c5c071bb90ee2d2e6dabbc1bae95e40ee02ff7a57df087` |
| Research client | `69723f13ace97e99fb5d3616715d4acb329a0a4c1b85ab05337910cba2c95bbb` |
| Design host | `71020d83d57e161957d84cc7be8635c95b0667854fb1c8269489cab59406b1f5` |
| Design client | `e4d2f6bd4b25d4811b542ccb492c4ed7c1e521ccafa64736043fa4c06ecafea4` |
