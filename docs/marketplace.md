# Marketplace submissions

Status snapshot: 2026-10-23 (Asia/Shanghai).

## Coordinates

| Plugin | Public repo | Commit | Version |
|---|---|---|---|
| `chatgpt-pro-research` | https://github.com/Octo-o-o-o/chatgpt-pro-research | `9e3853f1a64135b8c82eb098007a619057e5102e` | `0.3.0` |
| `gpt-image-design` | https://github.com/Octo-o-o-o/gpt-image-design | `e29502c3350eb3ab0b69a7c3c66928ddbcf1faea` | `0.3.0` |

Both public repos are generated from this monorepo by `node scripts/sync-dist.mjs`; `lib/` is committed there for dsh.pub and `github:` installs. The monorepo remains the source of truth.

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
