#!/usr/bin/env node
/**
 * Release the two public distribution repos from the monorepo.
 *
 *   node scripts/release-dist.mjs --check
 *   node scripts/release-dist.mjs --apply
 *   node scripts/release-dist.mjs --push
 *   node scripts/release-dist.mjs --push --release
 *
 * The monorepo is the source of truth. The dist repos only receive generated
 * files (lib/, resources/, locale/, icon.svg, README.md, LICENSE, package.json).
 *
 * --check  validate versions, remotes, clean dist trees and tag availability;
 *          run unit tests and typecheck (unless --skip-tests). No writes.
 * --apply  run tests/build/smoke, sync the dist repos and commit locally.
 *          No push, no tag, no GitHub release.
 * --push   apply, push both main branches, create/push v<version> tags.
 * --release  with --push, also create GitHub Releases (requires gh auth).
 * --skip-tests  skip npm test / typecheck (build and smoke still run).
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const parent = dirname(root)
const owner = 'Octo-o-o-o'
const args = new Set(process.argv.slice(2))
const checkOnly = args.has('--check')
const apply = args.has('--apply') || args.has('--push')
const push = args.has('--push')
const release = args.has('--release')
const skipTests = args.has('--skip-tests')

const specs = [
  { pkg: 'research', repo: 'chatgpt-pro-research' },
  { pkg: 'design', repo: 'gpt-image-design' },
]

const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const useShell = process.platform === 'win32'

function help () {
  console.log(`Usage:
  node scripts/release-dist.mjs --check
  node scripts/release-dist.mjs --apply
  node scripts/release-dist.mjs --push
  node scripts/release-dist.mjs --push --release

Modes:
  --check        validate versions/remotes/tags and run tests; no writes
  --apply        tests + build + smoke + sync + local dist commits
  --push         apply + push dist main + v<version> tags
  --release      with --push, create GitHub Releases
  --skip-tests   skip npm test / typecheck

The monorepo is the source of truth. Never edit the dist repos by hand.
`)
}

if (args.has('--help') || args.has('-h') || args.size === 0) {
  help()
  process.exit(0)
}
if (checkOnly && (apply || push || release)) {
  throw new Error('--check cannot be combined with --apply/--push/--release')
}
if (release && !push) throw new Error('--release requires --push')
if (!checkOnly && !apply) throw new Error('choose --check, --apply or --push')

function log (message) {
  console.log(`\n[release] ${message}`)
}

function run (command, commandArgs, { cwd = root, capture = false, shell = false } = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd,
    shell,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  })
  if (result.error) throw new Error(`${command} failed to start: ${result.error.message}`)
  if (result.status !== 0) {
    const detail = capture ? `\n${(result.stderr || '').trim()}` : ''
    throw new Error(`${command} ${commandArgs.join(' ')} exited ${String(result.status)}${detail}`)
  }
  return capture ? String(result.stdout || '').trim() : ''
}

function runNpm (commandArgs) {
  run(npmCmd, commandArgs, { shell: useShell })
}

function git (dir, commandArgs, capture = true) {
  return run('git', ['-C', dir, ...commandArgs], { capture })
}

function gitStatus (dir) {
  return git(dir, ['status', '--porcelain'])
}

async function readManifest (pkg) {
  const path = join(root, 'packages', pkg, 'package.json')
  if (!existsSync(path)) throw new Error(`missing ${path}`)
  return JSON.parse(await readFile(path, 'utf8'))
}

async function gather () {
  const rows = []
  for (const spec of specs) {
    const manifest = await readManifest(spec.pkg)
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version)) {
      throw new Error(`${spec.pkg} has an invalid version: ${manifest.version}`)
    }
    const dir = join(parent, spec.repo)
    if (!existsSync(dir)) throw new Error(`missing dist repo: ${dir}`)
    if (git(dir, ['rev-parse', '--is-inside-work-tree']) !== 'true') {
      throw new Error(`${dir} is not a git worktree`)
    }
    const remote = git(dir, ['remote', 'get-url', 'origin'])
    const expected = `github.com/${owner}/${spec.repo}`
    if (![ `https://${expected}`, `https://${expected}.git`, `git@github.com:${owner}/${spec.repo}`, `git@github.com:${owner}/${spec.repo}.git` ].includes(remote)) {
      throw new Error(`${dir} origin is not ${owner}/${spec.repo}: ${remote}`)
    }
    if (git(dir, ['branch', '--show-current']) !== 'main') {
      throw new Error(`${dir} must be on main before releasing`)
    }
    if (gitStatus(dir) !== '') throw new Error(`${dir} has uncommitted changes`)
    rows.push({ ...spec, dir, version: manifest.version, remote })
  }
  return rows
}

function checkRemoteState (row) {
  log(`fetch ${row.repo}`)
  git(row.dir, ['fetch', 'origin', 'main', '--tags', '--quiet'])
  const counts = git(row.dir, ['rev-list', '--left-right', '--count', 'origin/main...HEAD'])
  const [behind, ahead] = counts.split(/\s+/).map(Number)
  if (behind !== 0) throw new Error(`${row.repo} is ${behind} commit(s) behind origin/main; pull first`)
  if (ahead !== 0) console.warn(`[release] ${row.repo} has ${ahead} local commit(s); they will be pushed with --push`)
  if (push) {
    const tag = `v${row.version}`
    const existing = spawnSync('git', ['-C', row.dir, 'rev-parse', '-q', '--verify', `refs/tags/${tag}`], { encoding: 'utf8' })
    if (existing.status === 0) {
      throw new Error(`${row.repo} already has tag ${tag}; bump packages/${row.pkg}/package.json before releasing`)
    }
  }
}

function maybeWarnMonorepo () {
  const branch = git(root, ['branch', '--show-current'])
  if (branch !== 'main') console.warn(`[release] warning: monorepo branch is ${branch || '(detached)'}, not main`)
  const status = git(root, ['status', '--porcelain'])
  if (status !== '') console.warn('[release] warning: monorepo has uncommitted changes; they are not part of the dist repos')
}

function runTests () {
  if (skipTests) {
    log('skip tests (--skip-tests)')
    return
  }
  log('npm test')
  runNpm(['test'])
  log('npm run typecheck')
  runNpm(['run', 'typecheck'])
}

function buildAndSync () {
  log('npm run build')
  runNpm(['run', 'build'])
  log('node scripts/smoke-bundle.mjs')
  run(process.execPath, ['scripts/smoke-bundle.mjs'])
  log('node scripts/sync-dist.mjs')
  run(process.execPath, ['scripts/sync-dist.mjs'])
}

function commitDist (row) {
  const status = gitStatus(row.dir)
  if (status === '') {
    log(`${row.repo}: no changes`)
    return false
  }
  log(`${row.repo}: commit`)
  git(row.dir, ['add', '-A'], false)
  git(row.dir, ['commit', '-m', `release: ${row.repo} ${row.version}`], false)
  return true
}

function pushDist (row) {
  log(`${row.repo}: push main`)
  git(row.dir, ['push', 'origin', 'main'], false)
  const tag = `v${row.version}`
  log(`${row.repo}: tag ${tag}`)
  git(row.dir, ['tag', tag], false)
  git(row.dir, ['push', 'origin', tag], false)
  if (!release) return
  const notes = [
    `## ${row.repo} ${row.version}`,
    '',
    `- Install this exact build: \`dsh plugin --profile <profile> add github:${owner}/${row.repo}#${git(row.dir, ['rev-parse', 'HEAD'])}\``,
    '- GitHub publication does not update npm or community marketplace pins.',
    `- Commit: \`${git(row.dir, ['rev-parse', 'HEAD'])}\``,
    '',
    'Generated from the dsh-pro monorepo; see SYNC.md in the repository.',
  ].join('\n')
  const existing = spawnSync('gh', ['release', 'view', tag, '--repo', `${owner}/${row.repo}`], { encoding: 'utf8' })
  if (existing.status === 0) {
    log(`${row.repo}: GitHub release ${tag} already exists, skipping`)
    return
  }
  log(`${row.repo}: GitHub release ${tag}`)
  run('gh', [
    'release', 'create', tag,
    '--repo', `${owner}/${row.repo}`,
    '--title', `${row.repo} ${row.version}`,
    '--notes', notes,
  ])
}

async function main () {
  maybeWarnMonorepo()
  const rows = await gather()
  for (const row of rows) {
    log(`${row.repo} ${row.version}`)
    checkRemoteState(row)
  }
  runTests()
  if (checkOnly) {
    log('check passed; no files changed, no commits, no pushes')
    return
  }
  if (release) run('gh', ['auth', 'status'], { capture: false })
  buildAndSync()
  for (const row of rows) commitDist(row)
  if (!push) {
    log('local dist commits are ready; run --push when you have reviewed them')
    return
  }
  for (const row of rows) pushDist(row)
  log('done. GitHub publication does not update npm or marketplace pins; follow docs/RELEASING.md and record independently authorized channel changes.')
}

main().catch((error) => {
  console.error(`\n[release] ERROR: ${error.message}`)
  process.exit(1)
})
