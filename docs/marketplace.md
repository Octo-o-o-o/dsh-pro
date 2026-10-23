# Marketplace submissions

Status snapshot: 2026-10-23 (Asia/Shanghai). Release workflow: [RELEASING.md](RELEASING.md).

## Coordinates

| Plugin | Public repo | Commit | Version |
|---|---|---|---|
| `chatgpt-pro-research` | https://github.com/Octo-o-o-o/chatgpt-pro-research | `9e3853f1a64135b8c82eb098007a619057e5102e`（dsh.so 提交）/ `8a9d57e`（当前 HEAD） | `0.3.1` |
| `gpt-image-design` | https://github.com/Octo-o-o-o/gpt-image-design | `e29502c3350eb3ab0b69a7c3c66928ddbcf1faea`（dsh.so 提交）/ `25dcce3`（当前 HEAD） | `0.3.1` |

0.3.1 was released on 2026-10-23; the dsh.pub / dsh.so submissions below still point at 0.3.0 and need re-submission before they reflect this version.

Both public repos are generated from this monorepo by `node scripts/sync-dist.mjs`; `lib/` is committed there for dsh.pub and `github:` installs. The monorepo remains the source of truth.

## Local web verification (2026-10-23)

- Clean `DSH_HOME` (`%TEMP%\dsh-l5-verify`), profile `l5` created from the shipped `web` template.
- Installed both plugins from the public commits with `dsh plugin --profile l5 add github:...#<sha>`.
- `--dump-config` shows both layers: `# == chatgpt-pro-research` and `# == gpt-image-design`.
- `dsh --profile l5 --port 6123 --no-open` starts; `GET /chatgpt-pro-research/topics` and `GET /gpt-image-design/topics` both return `200 {"topics":[]}`.
- The sidebar entries **Pro Research** and **Image Design** render and open their empty panels.
- Screenshots: [research panel](../packages/research/resources/screenshots/panel.png), [design panel](../packages/design/resources/screenshots/panel.png).
- Not covered: real ChatGPT login, a full research round, and a real image API call.

## dsh.pub

- `gpt-image-design`: submission PR [#153](https://github.com/dsh-pub/dsh-pub/pull/153) **merged**. The post-merge integration failed because the merged submission file was compressed JSON and `npm run format:check` rejected it. Catalog entry is not generated yet.
- `chatgpt-pro-research`: submission PR [#152](https://github.com/dsh-pub/dsh-pub/pull/152) open. Its submission file is formatted; validation is blocked by the same global format failure on `main`.
- Registry-side fix request: issue [#155](https://github.com/dsh-pub/dsh-pub/issues/155). A normal formatting PR is rejected because `loadPullRequestSubmission` requires the PR's single file to have `status: added`; only a maintainer commit on `main` can reformat the already-merged file.
- When `main` is formatted, re-run #152; it should validate and auto-merge. Then confirm both pages:
  - https://dsh.pub/zh/plugins/chatgpt-pro-research/
  - https://dsh.pub/zh/plugins/gpt-image-design/

## dsh.so

Both repositories were submitted through https://www.dsh.so/zh/submit/ and returned “提交成功”:

- `chatgpt-pro-research` @ `9e3853f`
- `gpt-image-design` @ `e29502c`

Check results:

- Format: passed (public repo, README, MIT license, `dsh` manifest, valid id).
- Security scan: 0 critical, 2 warnings (`child_process` spawn for opening files/folders), 10 info. Warning-level findings require human review.
- Status: Declared, pending dsh.so maintainer review and L4/L5 verification.

## Re-release checklist

1. Update source in this monorepo; run `npm test`, `npm run typecheck`, `npm run build`, `node scripts/smoke-bundle.mjs`.
2. Run `node scripts/sync-dist.mjs`; commit and push both public repos; bump the version and tag `vX.Y.Z`.
3. Re-submit the changed public repo commit to dsh.pub (new submission PR) and to dsh.so (repo URL).
4. Keep `README.md`, `LICENSE`, `cordis.patch.yml`, `lib/index.js`, `lib/client.js`, `locale/*.json` and `icon.svg` in the public repo; dsh.pub validates them at the pinned commit.
