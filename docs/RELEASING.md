# 开发与发布指南

更新：2026-10-29。适用于 `dsh-pro` monorepo，以及 `chatgpt-pro-research`、`gpt-image-design` 两个发布仓库。

## 一句话原则

**源码只在当前 monorepo 改；两个发布仓库是生成产物，不要直接改。**

```text
C:\WorkSpace\dsh-plugins\dsh-pro\                 # 源码、测试、共享 core/transport
C:\WorkSpace\dsh-plugins\chatgpt-pro-research\    # 发布仓库（生成）
C:\WorkSpace\dsh-plugins\gpt-image-design\        # 发布仓库（生成）
```

发布仓库由 [scripts/sync-dist.mjs](../scripts/sync-dist.mjs) 从 monorepo 生成，包含：

- 根 `package.json`（`dsh.bundle.patch`、`engines.dsh`、转换后的 `repository`/`homepage`）
- `cordis.patch.yml`
- 已提交的 `lib/index.js`、`lib/client.js`
- `resources/`、`locale/`、`icon.svg`、`README.md`、`LICENSE`、`SYNC.md`

`sync-dist` 会覆盖这些文件；直接改会丢失。

## 改哪里

| 要改的内容 | 位置 |
|---|---|
| Research 插件逻辑/UI | `packages/research/src`、`packages/research/client` |
| Design 插件逻辑/UI | `packages/design/src`、`packages/design/client` |
| 共享引擎、状态机、传输 | `packages/core`、`packages/transport` |
| 插件 README | `packages/<pkg>/README.md` |
| 市场图标 / 显示名 | `packages/<pkg>/icon.svg`、`packages/<pkg>/locale/*.json` |
| 版本号 | `packages/<pkg>/package.json` 的 `version` |
| GitHub 描述、topics、Release | 两个发布仓库的 GitHub 设置 |
| 市场提交记录 | [docs/marketplace.md](marketplace.md) |

## 日常开发

```powershell
cd C:\WorkSpace\dsh-plugins\dsh-pro

npm install
npm test
npm run typecheck
npm run build
node scripts/smoke-bundle.mjs
```

只改一个插件时，仍建议在 monorepo 根目录跑完整测试；两个插件的 host/client bundle 共用 `core`/`transport`，一个改动可能同时影响两边。

## 发版

### 0. 先决定版本

两个包可以独立发版，版本号在各自 `packages/<pkg>/package.json`。  
发布仓库的 tag 是 `v<version>`；**不要移动已经存在的 tag**，已发布就递增 patch/minor。

### 1. 改版本并验证

```powershell
# 例如两个都发 0.3.1
# 编辑 packages/research/package.json / packages/design/package.json 的 version
node scripts/release-dist.mjs --check
```

`--check` 会：

- 校验两个发布仓库存在、是 git worktree、当前分支为 main、origin 精确匹配（HTTPS/SSH）、工作区干净、没有落后 origin/main；
- 校验 `--push` 时 `v<version>` tag 还不存在；
- 跑 `npm test` + `npm run typecheck`（可用 `--skip-tests` 跳过）。

它不会写文件、不会提交、不会推送。

### 2. 生成并本地提交

```powershell
node scripts/release-dist.mjs --apply
```

`--apply` 会：

- 再跑测试（除非 `--skip-tests`）；
- `npm run build` + `node scripts/smoke-bundle.mjs`；
- `node scripts/sync-dist.mjs`；
- 在两个发布仓库里 `git add -A`，有变化才提交，commit message 为 `release: <repo> <version>`。

**不会推送。** 先人工检查两个发布仓库的 `git show --stat` 和 `git diff`。

### 3. 推送并打 tag

```powershell
node scripts/release-dist.mjs --push
```

`--push` 会重新执行 `--apply` 的步骤（通常无新变化），然后：

- `git push origin main`
- 创建并推送 `v<version>` tag

需要同时创建 GitHub Release：

```powershell
node scripts/release-dist.mjs --push --release
```

`--release` 需要 `gh auth status` 已登录；tag 或 release 已存在时会报错/跳过，避免覆盖。

### 4. 提交市场

发布仓库推送并发布 npm 后，先检查已有条目与投稿，再按各站规则更新：

- **dsh.pub**：https://dsh.pub/zh/submit/  
  新条目粘贴仓库 URL，固定默认分支 commit 并开 PR。已有条目走刷新；`already_listed` 不应重复投稿。根目录保持 bundle 形态。
- **dsh.so**：https://www.dsh.so/zh/submit/  
  粘贴仓库 URL 或 npm 包名；检查通过后提交，等待审核/L4–L5。

DSH Plugin Hub 可通过 topic/npm 自动索引；开放插件市场通过 plugin-add issue 申请；DSHX 提供网页投稿。具体入口与现有回执见 [marketplace.md](marketplace.md)，避免重复提交。dsh.so 指向的官方 Discussions 可用于发布兼容性实测报告，但报告不等于市场收录或独立验证。

提交后记录 commit、PR/issue、成功回执、待审核状态及外部阻塞，不把失败尝试写成发布成功。

## release-dist 模式

| 命令 | 作用 | 推送 |
|---|---|---|
| `--check` | 校验 + 测试 | 否 |
| `--apply` | 测试 + build + smoke + sync + 本地提交 | 否 |
| `--push` | apply + push main + tag | 是 |
| `--push --release` | 再创建 GitHub Release | 是 |
| `--skip-tests` | 跳过 test/typecheck（build/smoke 仍跑） | 按模式 |

## 手工兜底

如果脚本因网络/环境失败，可以手工执行同样顺序：

```powershell
npm test
npm run typecheck
npm run build
node scripts/smoke-bundle.mjs
node scripts/sync-dist.mjs

git -C C:\WorkSpace\dsh-plugins\chatgpt-pro-research add -A
git -C C:\WorkSpace\dsh-plugins\chatgpt-pro-research commit -m "release: chatgpt-pro-research X.Y.Z"
git -C C:\WorkSpace\dsh-plugins\chatgpt-pro-research push
git -C C:\WorkSpace\dsh-plugins\chatgpt-pro-research tag vX.Y.Z
git -C C:\WorkSpace\dsh-plugins\chatgpt-pro-research push origin vX.Y.Z

# design 同理
```

## 常见问题

**发布仓库有未提交改动**  
脚本会拒绝。先检查 `git -C <dist> status`；不要直接丢弃用户改动。

**发布仓库落后 origin/main**  
先 `git -C <dist> pull --ff-only`。

**tag 已存在**  
说明该版本已发布；递增 `packages/<pkg>/package.json` 的 version，不要 force-move tag。

**只改 README/截图，不想升版本**  
脚本的 `--apply` 可以在同版本下生成本地 docs commit，但 `--push` 会因 tag 已存在而拒绝。此时要么手工 push 该 docs commit（不移动 tag），要么按 patch 版本正式发一版；推荐后者。

**npm 发布**  
`npm whoami` 401 时先 `npm login`，然后在 `packages/research` / `packages/design` 分别 `npm publish --access public`。发布仓库的 Git 安装不依赖 npm。

## 当前状态（2026-10-29）

两个插件 `0.3.4` 已发布到 GitHub Releases 与 npm；开发仓库和两个发布仓库 main 已同步推送。真实自动裁决、local 交付与桌面恢复已经验证。社区市场的刷新、收录申请和官方兼容性报告已提交；dsh.so 的本轮正式投稿受限流/超时和投稿仓库 404 阻塞。具体 commit、tag 与逐渠道回执见 [marketplace.md](marketplace.md)。

本轮检查、真实证据与限制见 [0.3.4 验证记录](validation/release-0.3.4-2026-10-29.md)。[0.3.3 复核记录](validation/release-0.3.3-2026-10-29.md) 和 [0.3.2 验收记录](validation/release-0.3.2-2026-10-25.md) 保留为历史，不替代当前版本验证。

### Windows link 安装切换

切换已有 `link:` 插件前，先检查 `node_modules/<包>` 是否为 junction，并备份未提交源码和 profile 清单。此次 pnpm remove 曾误清理 junction 指向的源码目录；不要直接对仍链接源码的包执行 remove。先把完整源码与改动做可恢复快照，再移开并核对链接本身，最后让包管理器安装真实副本。安装后验证 LinkType、包版本和 bundle 哈希，再重启 DSH。

## 相关文件

- [scripts/release-dist.mjs](../scripts/release-dist.mjs)
- [scripts/sync-dist.mjs](../scripts/sync-dist.mjs)
- [scripts/build.mjs](../scripts/build.mjs)
- [docs/marketplace.md](marketplace.md)
