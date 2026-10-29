import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, copyFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

it.each(['branch', 'origin'])('rejects an unsafe release %s before fetch or generation', async scenario => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-release-'))
  try {
    const source = join(root, 'dsh-pro')
    await mkdir(join(source, 'scripts'), { recursive: true })
    await mkdir(join(source, 'packages', 'research'), { recursive: true })
    await copyFile(fileURLToPath(new URL('../../../scripts/release-dist.mjs', import.meta.url)), join(source, 'scripts', 'release-dist.mjs'))
    await writeFile(join(source, 'packages', 'research', 'package.json'), JSON.stringify({ version: '0.3.3' }))
    const dist = join(root, 'chatgpt-pro-research')
    for (const dir of [source, dist]) {
      await mkdir(dir, { recursive: true })
      expect(spawnSync('git', ['init', '-b', 'main', dir]).status).toBe(0)
    }
    const origin = scenario === 'origin'
      ? 'https://github.com/Octo-o-o-o/chatgpt-pro-research-unrelated.git'
      : 'git@github.com:Octo-o-o-o/chatgpt-pro-research.git'
    expect(spawnSync('git', ['-C', dist, 'remote', 'add', 'origin', origin]).status).toBe(0)
    if (scenario === 'branch') expect(spawnSync('git', ['-C', dist, 'symbolic-ref', 'HEAD', 'refs/heads/codex/unmerged']).status).toBe(0)
    const result = spawnSync(process.execPath, [join(source, 'scripts', 'release-dist.mjs'), '--check', '--skip-tests'], { encoding: 'utf8' })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(scenario === 'branch' ? 'must be on main' : 'origin is not')
    expect(result.stdout).not.toContain('[release] fetch')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
