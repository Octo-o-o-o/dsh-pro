import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { buildManifest } from '../src/materials.ts'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-material-regression-'))
  roots.push(root)
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  return { root, workspace }
}

it('rejects a workspace material alias whose real source is outside the workspace', async () => {
  const { root, workspace } = await fixture()
  const outside = join(root, 'outside')
  await mkdir(outside)
  await writeFile(join(outside, 'note.md'), 'private project notes')
  await symlink(outside, join(workspace, 'inputs'), process.platform === 'win32' ? 'junction' : 'dir')

  await expect(buildManifest(workspace, ['inputs/note.md'])).rejects.toThrow(/escapes the workspace/)
})

it('checks secret globs against the real source as well as its harmless alias', async () => {
  const { workspace } = await fixture()
  const secrets = join(workspace, 'secrets')
  await mkdir(secrets)
  await writeFile(join(secrets, 'note.md'), 'private project notes')
  await symlink(secrets, join(workspace, 'inputs'), process.platform === 'win32' ? 'junction' : 'dir')

  await expect(buildManifest(workspace, ['inputs/note.md'], undefined, ['**/secrets/**']))
    .rejects.toThrow(/secret pattern/)
})

it('retains the display path but fixes an allowed material source to its verified real path', async () => {
  const { workspace } = await fixture()
  const notes = join(workspace, 'notes')
  await mkdir(notes)
  await writeFile(join(notes, 'note.md'), 'shareable notes')
  await symlink(notes, join(workspace, 'inputs'), process.platform === 'win32' ? 'junction' : 'dir')

  const refs = await buildManifest(workspace, ['inputs/note.md'])
  expect(refs).toHaveLength(1)
  expect(refs[0]).toMatchObject({ path: 'inputs/note.md', source: await realpath(join(notes, 'note.md')) })
})
