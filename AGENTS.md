# dsh-pro repository instructions

## Source of truth

This monorepo is the only source of truth for both plugins:

- `packages/research` → `chatgpt-pro-research`
- `packages/design` → `gpt-image-design`
- shared code: `packages/core`, `packages/transport`

The public repos `C:\WorkSpace\dsh-plugins\chatgpt-pro-research` and
`C:\WorkSpace\dsh-plugins\gpt-image-design` are **generated distribution repos**
(committed `lib/`, README, LICENSE, patch, locale, icon). Never implement
features or edit generated files there; `scripts/sync-dist.mjs` overwrites them.

## Before changing release/market behavior

Read [docs/RELEASING.md](docs/RELEASING.md) completely.

- Dev loop: `npm test`, `npm run typecheck`, `npm run build`,
  `node scripts/smoke-bundle.mjs`.
- Release: `node scripts/release-dist.mjs --check`, `--apply`, `--push`
  (optionally `--release`).
- Do not push the monorepo unless the user explicitly asks; it is often ahead
  of `origin/main` and may contain unrelated in-progress docs.
- Do not force-move a released `v<version>` tag. Bump the package version.

## Marketplace state

Current submission details, PRs, issue links and external marketplace blockers
are recorded in [docs/marketplace.md](docs/marketplace.md). Check it before
re-submitting or claiming a listing.

- dsh.pub requires the bundle at the repository root and committed runtime
  artifacts (`lib/index.js`, `lib/client.js`).
- dsh.so accepts the public repository URL; compiled bundles are scanned and
  the listing is Declared until independently verified.
- dsh.pub #155 was fixed by #157. Both plugins are already in the source
  catalog; #163 tracks the 0.3.4 refresh/public-page issue. Do not create a
  duplicate submission when validation returns `already_listed`.

## Practical rules

- Keep `engines.dsh` and peer ranges aligned with the tested DSH version.
- Keep `locale/*.json`, `icon.svg`, `README.md`, `LICENSE`, `cordis.patch.yml`
  and `lib/` in the public repos; dsh.pub validates them at the pinned commit.
- Don't commit credentials, cookies, `~/.dsh` data, or generated tarballs.
- When in doubt, update the monorepo, run the release script, and inspect the
  generated diff before pushing.
