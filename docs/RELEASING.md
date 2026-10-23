# 开发与发布指南

更新：2026-10-23。适用于 `dsh-pro` monorepo，以及 `chatgpt-pro-research`、`gpt-image-design` 两个发布仓库。

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

- 校验两个发布仓库存在、是 git worktree、origin 正确、工作区干净、没有落后 origin/main；
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

发布仓库推送后，再到市场提交新 commit：

- **dsh.pub**：https://dsh.pub/zh/submit/  
  粘贴仓库 URL；它会固定默认分支 commit，自动开 PR。根目录必须保持 bundle 形态。
- **dsh.so**：https://www.dsh.so/zh/submit/  
  粘贴仓库 URL 或 npm 包名；检查通过后提交，等待审核/L4–L5。

提交后更新 [docs/marketplace.md](marketplace.md) 里的 commit、PR/issue 和状态。

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

## 当前状态（2026-10-23）

| 插件 | 版本 | 发布仓库 HEAD | 市场 |
|---|---|---|---|
| `chatgpt-pro-research` | `0.3.0` | `6eb3608` | dsh.so 已提交待审；dsh.pub PR #152 等 #155 修复 |
| `gpt-image-design` | `0.3.0` | `a280273` | dsh.so 已提交待审；dsh.pub #153 已合入，目录集成被 #155 卡住 |

市场阻塞详情、PR/issue 链接见 [docs/marketplace.md](marketplace.md)。

## 相关文件

- [scripts/release-dist.mjs](../scripts/release-dist.mjs)
- [scripts/sync-dist.mjs](../scripts/sync-dist.mjs)
- [scripts/build.mjs](../scripts/build.mjs)
- [docs/marketplace.md](marketplace.md)
