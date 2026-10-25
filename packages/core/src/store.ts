import { appendFile, copyFile, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { Unzip, UnzipInflate, UnzipPassThrough, zipSync } from 'fflate'
import type { FetchedAnswer, HumanCheck, MaterialRef, Receipt, ResearchCard, SessionLocator, StoreMode, Topic } from './types.ts'
import { newTopicId, shortHash, slugifyTitle } from './slug.ts'
import { STATUSES } from './state.ts'

export interface StoreOptions {
  mode: StoreMode
  projectRoot?: string
  localRoot: string
  rawDir: string
  rawAnswers: 'local' | 'repo'
  /** Project-relative docs folder: research or design. */
  docsSubdir?: 'research' | 'design'
}

export interface IndexEntry {
  id: string
  title: string
  type: Topic['type']
  status: Topic['status']
  rounds: number
  parent: string | null
  updated: string
  artifact?: string
}

interface IndexFile {
  schema: 1
  updated: string
  topics: IndexEntry[]
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function artifactFileName(value: string): string {
  const base = value.split(/[\\/]/).pop() ?? 'artifact'
  return base.replace(/[^\w.-]/g, '_').slice(0, 100) || 'artifact'
}

function artifactRelativePath(value: string): string {
  const parts = value
    .replace(/\\/g, '/')
    .split('/')
    .filter(part => part !== '' && part !== '.' && part !== '..')
    .map(part => part.replace(/[^\w.-]/g, '_').slice(0, 60))
    .filter(part => part !== '')
    .slice(-4)
  return parts.length > 0 ? parts.join('/') : 'artifact'
}

export function isHtmlSource(text: string): boolean {
  return /^\s*(?:<!doctype\s+html|<html[\s>])/i.test(text.slice(0, 512))
}

/**
 * Fail closed on a structurally invalid topic.json. Optional/newer fields are
 * deliberately not checked so older records keep loading.
 */
function assertTopicShape(value: unknown, id: string): asserts value is Topic {
  const topic = value as Topic
  const fail = (field: string): never => {
    throw new Error(`corrupt topic ${id}: invalid ${field}`)
  }
  if (topic === null || typeof topic !== 'object') fail('topic')
  if (topic.schema !== 1) fail('schema')
  if (typeof topic.id !== 'string' || topic.id === '') fail('id')
  if (typeof topic.title !== 'string') fail('title')
  if (topic.type !== 'research' && topic.type !== 'design') fail('type')
  if (!STATUSES.includes(topic.status)) fail('status')
  // list() sorts on this field; a missing/non-string value used to throw from
  // localeCompare and take down the whole /topics response. Older records can
  // fall back to created instead of disappearing from the sidebar.
  if (typeof topic.updated !== 'string' || topic.updated === '') {
    const created = (topic as { created?: unknown }).created
    if (typeof created === 'string' && created !== '') topic.updated = created
    else fail('updated')
  }
  if (!Number.isInteger(topic.roundsCap) || topic.roundsCap < 1) fail('roundsCap')
  if (!Array.isArray(topic.rounds)) fail('rounds')
  if (typeof topic.channel !== 'string') fail('channel')
  if (!Array.isArray(topic.successCriteria)) fail('successCriteria')
  if (!Array.isArray(topic.artifacts)) fail('artifacts')
}

function extensionForLanguage(language: string): string {
  switch (language.toLowerCase()) {
    case 'html':
    case 'htm':
      return 'html'
    case 'tsx':
    case 'typescriptreact':
      return 'tsx'
    case 'jsx':
      return 'jsx'
    case 'css':
      return 'css'
    case 'js':
    case 'javascript':
      return 'js'
    case 'json':
      return 'json'
    case 'md':
    case 'markdown':
      return 'md'
    default:
      return 'txt'
  }
}

function sanitizeSegment(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'project'
}

/**
 * Windows refuses to replace a file that another handle (a reader, the indexer,
 * an antivirus scan) still has open, reporting EPERM/EACCES/EBUSY instead of
 * blocking. The readers here are the panel's poll and `status`, so a short
 * bounded retry keeps atomic writes atomic without turning them into direct
 * overwrites.
 */
async function replaceFile(temp: string, target: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rename(temp, target)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      const retriable = code === 'EPERM' || code === 'EACCES' || code === 'EBUSY'
      if (!retriable || attempt >= 8) throw error
      await new Promise(resolve => setTimeout(resolve, 10 * attempt))
    }
  }
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

const ZIP_MAX_FILES = 100
const ZIP_MAX_BYTES = 50 * 1024 * 1024

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0))
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

/**
 * Streaming, capped unzip. `unzipSync` would inflate every entry into memory
 * before any count/size check could run, so a high-ratio zip bomb could take
 * the host down. Here the declared size is a first gate (forgeable), the
 * per-chunk accumulation is the hard cap: an over-budget file is dropped and
 * no later file is started. Returns undefined for non-zip input.
 */
export function inflateArchive(bytes: Uint8Array): Array<[string, Uint8Array]> | undefined {
  const files: Array<[string, Uint8Array]> = []
  let total = 0
  let capped = false
  try {
    const unzip = new Unzip()
    // The decoders are NOT registered by default; without them every file
    // errors with "unknown compression type".
    unzip.register(UnzipInflate)
    unzip.register(UnzipPassThrough)
    unzip.onfile = file => {
      if (capped) return
      if (files.length >= ZIP_MAX_FILES) {
        capped = true
        return
      }
      if ((file.originalSize ?? 0) > ZIP_MAX_BYTES - total) {
        capped = true
        return
      }
      const chunks: Uint8Array[] = []
      let size = 0
      let drop = false
      file.ondata = (error, chunk, final) => {
        if (error !== null || drop) {
          drop = true
          chunks.length = 0
          return
        }
        if (chunk !== null && chunk.length > 0) {
          size += chunk.length
          if (size > ZIP_MAX_BYTES || total + size > ZIP_MAX_BYTES) {
            drop = true
            capped = true
            chunks.length = 0
            return
          }
          chunks.push(chunk.slice())
        }
        if (final) {
          files.push([file.name, concatBytes(chunks)])
          total += size
        }
      }
      file.start()
    }
    unzip.push(bytes, true)
  } catch {
    return undefined
  }
  return files
}

export class ResearchStore {
  private dirs = new Map<string, string>()
  private readonly options: StoreOptions

  constructor(options: StoreOptions) {
    this.options = options
  }

  rootDir(): string {
    if (this.options.mode === 'local') {
      const projectRoot = this.options.projectRoot !== undefined && this.options.projectRoot !== ''
        ? resolve(this.options.projectRoot)
        : process.cwd()
      return join(this.options.localRoot, 'projects', this.projectSlug(projectRoot))
    }
    if (this.options.projectRoot === undefined || this.options.projectRoot === '') {
      throw new Error('project store requires a project root')
    }
    return join(this.options.projectRoot, 'docs', this.options.docsSubdir ?? 'research')
  }

  rawTopicDir(topicId: string): string {
    return join(this.options.rawDir, topicId)
  }

  private projectSlug(projectRoot: string): string {
    const base = sanitizeSegment(projectRoot.split(/[\\/]/).filter(Boolean).pop() ?? 'project')
    return `${base}-${shortHash(projectRoot)}`
  }

  private async atomic(path: string, text: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true })
    const temp = `${path}.tmp-${process.pid}-${Date.now()}`
    await writeFile(temp, text, 'utf8')
    await replaceFile(temp, path)
  }

  private async appendJsonLine(path: string, value: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true })
    await appendFile(path, `${JSON.stringify(value)}\n`, 'utf8')
  }

  /** Append one auditable event; callers may treat this as best-effort. */
  async appendEvent(topic: Topic, event: Record<string, unknown> & { type: string }): Promise<void> {
    const dir = await this.dirOf(topic.id)
    await this.appendJsonLine(join(dir, 'events.ndjson'), { at: new Date().toISOString(), ...event })
  }

  /**
   * The id is written into topic.json, the registry, raw-answer paths and
   * session locators; a duplicate silently merges two topics. Ten hex chars
   * make this rare, and the scan keeps it correct even if two creates race or
   * an old record already occupies the value.
   */
  private async uniqueTopicId(title: string): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const id = newTopicId(title)
      if (!(await this.topicIdExists(id))) return id
    }
    return `topic-${randomUUID().replace(/-/g, '').slice(0, 12)}`
  }

  private async topicIdExists(id: string): Promise<boolean> {
    if (this.dirs.has(id)) return true
    await this.list().catch(() => [])
    return this.dirs.has(id)
  }

  private async uniqueDir(slug: string, id: string): Promise<string> {
    const root = this.rootDir()
    await mkdir(root, { recursive: true })
    // Reserve the directory atomically. The old read-then-write check let two
    // concurrent creates with the same title pick one directory and overwrite
    // each other's topic.json.
    for (let attempt = 0; ; attempt += 1) {
      const candidate = attempt === 0 ? slug : `${slug}-${shortHash(`${id}:${attempt}`)}`
      const dir = join(root, candidate)
      try {
        await mkdir(dir)
        return dir
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
    }
  }

  async create(card: ResearchCard, roundsCap: number, model: string, channel: string): Promise<{ topic: Topic; dir: string }> {
    const now = new Date().toISOString()
    const id = await this.uniqueTopicId(card.title)
    const topic: Topic = {
      schema: 1,
      id,
      title: card.title,
      type: card.type,
      parent: card.parent ?? null,
      created: now,
      updated: now,
      status: 'draft',
      roundsCap,
      ...(card.designs !== undefined ? { designs: card.designs } : {}),
      generations: [{ n: 1, createdAt: now, rounds: roundsCap, reason: '初始任务' }],
      rounds: [],
      channel,
      model,
      successCriteria: [...card.successCriteria],
      artifacts: [],
    }
    const dir = await this.uniqueDir(slugifyTitle(card.title), id)
    this.dirs.set(id, dir)
    const materials = await this.stageMaterials(dir, card.materials)
    await this.atomic(join(dir, 'topic.json'), `${JSON.stringify(topic, null, 2)}\n`)
    await this.atomic(join(dir, 'rounds', '00-question.md'), `# ${card.title}\n\n## 研究问题\n\n${card.question}\n\n## 成功判据\n\n${card.successCriteria.map(item => `- ${item}`).join('\n')}\n\n## 任务\n\n${card.brief}\n`)
    await this.atomic(join(dir, 'materials', 'manifest.json'), `${JSON.stringify({ materials }, null, 2)}\n`)
    return { topic, dir }
  }

  /**
   * Copy source files into `<topic>/materials/` and verify the copied bytes
   * against the manifest digest. The manifest stores relative paths only.
   */
  private async stageMaterials(dir: string, refs: readonly MaterialRef[]): Promise<MaterialRef[]> {
    const staged: MaterialRef[] = []
    const topicRoot = await realpath(dir)
    const materialsDir = join(dir, 'materials')
    await mkdir(materialsDir, { recursive: true })
    const root = await realpath(materialsDir)
    if (!root.startsWith(`${topicRoot}${sep}`)) throw new Error('material directory escapes the topic')
    for (const ref of refs) {
      if (ref.source === undefined || ref.source === '') {
        staged.push(ref)
        continue
      }
      const safePath = ref.path.replace(/\\/g, '/')
      if (isAbsolute(safePath) || safePath.split('/').includes('..')) {
        throw new Error(`material path escapes the topic: ${ref.path}`)
      }
      const target = join(dir, 'materials', safePath)
      let parent = materialsDir
      for (const part of safePath.split('/').slice(0, -1)) {
        parent = join(parent, part)
        await mkdir(parent, { recursive: true })
        if (!(await realpath(parent)).startsWith(`${root}${sep}`)) throw new Error('material directory escapes the topic')
      }
      const existingTarget = await realpath(target).catch(error => { if (isMissing(error)) return undefined; throw error })
      if (existingTarget !== undefined && !existingTarget.startsWith(`${root}${sep}`)) throw new Error('material file escapes the topic')
      await copyFile(ref.source, target)
      const copied = await readFile(target)
      const digest = createHash('sha256').update(copied).digest('hex')
      if (copied.byteLength !== ref.bytes || digest !== ref.sha256) {
        await rm(target, { force: true })
        throw new Error(`material changed while staging: ${ref.path}`)
      }
      staged.push({ ...ref, path: safePath, source: ref.path })
    }
    return staged
  }

  async save(topic: Topic): Promise<void> {
    const dir = await this.dirOf(topic.id)
    topic.updated = new Date().toISOString()
    await this.atomic(join(dir, 'topic.json'), `${JSON.stringify(topic, null, 2)}\n`)
  }

  async list(): Promise<Topic[]> {
    const root = this.rootDir()
    let entries
    try {
      entries = await readdir(root, { withFileTypes: true })
    } catch {
      return []
    }
    const topics: Topic[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const dir = join(root, entry.name)
      try {
        const parsed = JSON.parse(await readFile(join(dir, 'topic.json'), 'utf8')) as unknown
        assertTopicShape(parsed, entry.name)
        this.dirs.set(parsed.id, dir)
        topics.push(parsed)
      } catch {
        // A directory without a readable, structurally valid topic.json is not ours.
      }
    }
    return topics.sort((a, b) => b.updated.localeCompare(a.updated))
  }

  async load(id: string): Promise<Topic> {
    const dir = await this.dirOf(id)
    const parsed = JSON.parse(await readFile(join(dir, 'topic.json'), 'utf8')) as unknown
    assertTopicShape(parsed, id)
    return parsed
  }

  async dirOf(id: string): Promise<string> {
    const known = this.dirs.get(id)
    if (known !== undefined) return known
    const topics = await this.list()
    const found = topics.find(topic => topic.id === id)
    if (found === undefined) throw new Error(`unknown topic: ${id}`)
    const dir = this.dirs.get(id)
    if (dir === undefined) throw new Error(`topic directory missing: ${id}`)
    return dir
  }

  async writeQuestion(topic: Topic, round: number, text: string): Promise<void> {
    const dir = await this.dirOf(topic.id)
    await this.atomic(join(dir, 'rounds', `${pad(round)}-question.md`), text)
  }

  async readQuestion(topic: Topic, round: number): Promise<string | undefined> {
    try {
      const dir = await this.dirOf(topic.id)
      return await readFile(join(dir, 'rounds', `${pad(round)}-question.md`), 'utf8')
    } catch (error) {
      if (isMissing(error)) return undefined
      throw new Error(`cannot read question for round ${round}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Resolve one manifest path and refuse anything outside the staged tree. */
  private stagedMaterialPath(materialsRoot: string, path: string): string {
    const resolved = isAbsolute(path) ? resolve(path) : resolve(materialsRoot, path)
    const rel = relative(materialsRoot, resolved)
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(`material manifest path escapes the topic: ${path}`)
    }
    return resolved
  }

  async readMaterialPaths(topic: Topic): Promise<string[]> {
    let raw: string
    try {
      const dir = await this.dirOf(topic.id)
      raw = await readFile(join(dir, 'materials', 'manifest.json'), 'utf8')
      const parsed = JSON.parse(raw) as { materials?: Array<{ path?: unknown }> }
      if (!Array.isArray(parsed.materials)) throw new Error('manifest materials is not an array')
      const materialsRoot = join(dir, 'materials')
      return parsed.materials
        .map(item => item.path)
        .filter((path): path is string => typeof path === 'string' && path !== '')
        .map(path => this.stagedMaterialPath(materialsRoot, path))
    } catch (error) {
      if (isMissing(error)) return []
      throw new Error(`cannot read material manifest: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Merge new material references into the topic manifest (follow-up rounds). */
  async addMaterials(topic: Topic, refs: readonly MaterialRef[]): Promise<MaterialRef[]> {
    if (refs.length === 0) return []
    const dir = await this.dirOf(topic.id)
    const file = join(dir, 'materials', 'manifest.json')
    let existing: MaterialRef[] = []
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8')) as { materials?: MaterialRef[] }
      if (!Array.isArray(parsed.materials)) throw new Error('manifest materials is not an array')
      existing = parsed.materials
    } catch (error) {
      if (!isMissing(error)) {
        throw new Error(`cannot merge material manifest: ${error instanceof Error ? error.message : String(error)}`)
      }
      // No manifest yet: the merge starts from the new refs alone.
    }
    const byPath = new Map(existing.map(item => [item.source ?? item.path, item]))
    const staged = await this.stageMaterials(dir, refs)
    for (const ref of staged) byPath.set(ref.source ?? ref.path, ref)
    await this.atomic(file, `${JSON.stringify({ materials: [...byPath.values()] }, null, 2)}\n`)
    return staged
  }

  /** Materials introduced by one follow-up round (empty means "no delta"). */
  async writeRoundMaterials(topic: Topic, round: number, refs: readonly MaterialRef[]): Promise<void> {
    const dir = await this.dirOf(topic.id)
    await this.atomic(join(dir, 'rounds', `${pad(round)}-materials.json`), `${JSON.stringify({ materials: refs }, null, 2)}\n`)
  }

  async readRoundMaterials(topic: Topic, round: number): Promise<MaterialRef[] | undefined> {
    try {
      const dir = await this.dirOf(topic.id)
      const parsed = JSON.parse(await readFile(join(dir, 'rounds', `${pad(round)}-materials.json`), 'utf8')) as {
        materials?: MaterialRef[]
      }
      if (!Array.isArray(parsed.materials)) throw new Error('round materials is not an array')
      const materialsRoot = join(dir, 'materials')
      return parsed.materials.map(item => ({
        ...item,
        path: this.stagedMaterialPath(materialsRoot, item.path),
      }))
    } catch (error) {
      if (isMissing(error)) return undefined
      throw new Error(`cannot read round ${round} materials: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Conversation locator stays local even when the topic is project-stored. */
  async writeLocator(topicId: string, locator: SessionLocator): Promise<void> {
    await this.atomic(join(this.options.localRoot, 'sessions', `${topicId}.json`), `${JSON.stringify(locator, null, 2)}\n`)
  }

  async readLocator(topicId: string): Promise<SessionLocator | undefined> {
    try {
      const parsed = JSON.parse(await readFile(join(this.options.localRoot, 'sessions', `${topicId}.json`), 'utf8')) as SessionLocator
      if (typeof parsed.conversationUrl !== 'string' || parsed.conversationUrl === '') {
        throw new Error('locator conversationUrl is missing')
      }
      return parsed
    } catch (error) {
      if (isMissing(error)) return undefined
      throw new Error(`cannot read session locator for ${topicId}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async writeAnswer(topic: Topic, round: number, answer: string): Promise<string> {
    const hash = createHash('sha256').update(answer, 'utf8').digest('hex')
    await this.atomic(join(this.rawTopicDir(topic.id), `${pad(round)}-answer.md`), answer)
    if (this.options.rawAnswers === 'repo' && this.options.mode === 'project') {
      const dir = await this.dirOf(topic.id)
      await this.atomic(join(dir, 'rounds', `${pad(round)}-answer.md`), answer)
    }
    return hash
  }

  /** Persist images, code blocks and downloadable archives under `<topic>/artifacts/round-NN/`. */
  async writeArtifacts(topic: Topic, round: number, fetched: FetchedAnswer): Promise<string[]> {
    const images = fetched.images ?? []
    const blocks = fetched.codeBlocks ?? []
    const archives = fetched.archives ?? []
    if (images.length === 0 && blocks.length === 0 && archives.length === 0) return []
    const dir = await this.dirOf(topic.id)
    const base = join(dir, 'artifacts', `round-${pad(round)}`)
    const added: string[] = []
    for (const [index, image] of images.entries()) {
      const name = artifactFileName(image.name ?? `image-${pad(index + 1)}.png`)
      const target = join(base, name)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, Buffer.from(image.base64, 'base64'))
      added.push(relative(dir, target).replace(/\\/g, '/'))
    }
    const used = new Set<string>()
    for (const [index, block] of blocks.entries()) {
      const guessed = extensionForLanguage(block.language)
      const extension = guessed === 'txt' && isHtmlSource(block.text) ? 'html' : guessed
      const hinted = block.name === undefined || block.name.trim() === '' ? '' : artifactRelativePath(block.name.trim())
      const withExtension = hinted === ''
        ? `code-${pad(index + 1)}.${extension}`
        : /\.[a-z0-9]+$/i.test(hinted) ? hinted : `${hinted}.${extension}`
      let name = withExtension
      let suffix = 1
      while (used.has(name.toLowerCase())) {
        suffix += 1
        name = `${withExtension.replace(/\.[a-z0-9]+$/i, '')}-${suffix}${/\.[a-z0-9]+$/i.exec(withExtension)?.[0] ?? ''}`
      }
      used.add(name.toLowerCase())
      const target = join(base, name)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, block.text, 'utf8')
      added.push(relative(dir, target).replace(/\\/g, '/'))
    }
    for (const [index, archive] of archives.entries()) {
      const bytes = Buffer.from(archive.base64, 'base64')
      if (bytes.length === 0) continue
      const archiveName = artifactFileName(archive.name === '' ? `archive-${pad(index + 1)}.zip` : archive.name)
      const zipName = archiveName.toLowerCase().endsWith('.zip') ? archiveName : `${archiveName}.zip`
      const target = join(base, zipName)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, bytes)
      added.push(relative(dir, target).replace(/\\/g, '/'))
      try {
        const entries = inflateArchive(new Uint8Array(bytes))
        if (entries === undefined) throw new Error('not a readable zip')
        const rootName = zipName.replace(/\.zip$/i, '')
        const valid = entries.filter(([entry, data]) => {
          const normalized = entry.replace(/\\/g, '/')
          return !normalized.endsWith('/')
            && !normalized.startsWith('/')
            && !isAbsolute(normalized)
            && !normalized.split('/').includes('..')
            && !normalized.startsWith('__MACOSX/')
            && data.length > 0
        })
        const topLevel = new Set(valid.map(([entry]) => entry.replace(/\\/g, '/').split('/')[0]))
        const useRoot = topLevel.size > 1 || valid.some(([entry]) => !entry.replace(/\\/g, '/').includes('/'))
        for (const [entry, data] of valid) {
          const normalized = entry.replace(/\\/g, '/')
          const nested = join(base, useRoot ? rootName : '', normalized)
          await mkdir(dirname(nested), { recursive: true })
          await writeFile(nested, data)
          added.push(relative(dir, nested).replace(/\\/g, '/'))
        }
      } catch {
        // Invalid/encrypted zip: keep the original archive for manual handling.
      }
    }
    for (const artifact of added) {
      if (!topic.artifacts.includes(artifact)) topic.artifacts.push(artifact)
    }
    return added
  }

  /** Build a downloadable zip for one round without touching the topic files. */
  async bundleRound(topic: Topic, round: number): Promise<{ name: string; bytes: Buffer }> {
    const dir = await this.dirOf(topic.id)
    const base = resolve(dir, 'artifacts', `round-${pad(round)}`)
    const prefix = `artifacts/round-${pad(round)}/`
    const files: Record<string, Uint8Array> = {}
    let total = 0
    for (const path of topic.artifacts) {
      if (!path.startsWith(prefix)) continue
      const target = resolve(dir, path)
      if (target !== base && !target.startsWith(`${base}${sep}`)) continue
      let bytes: Buffer
      try {
        bytes = await readFile(target)
      } catch {
        // Skip one unreadable file; the rest of the bundle is still useful.
        continue
      }
      total += bytes.length
      // Deliberately outside the per-file catch: an over-limit bundle must
      // fail loudly instead of silently shipping a truncated zip.
      if (total > 100 * 1024 * 1024) throw new Error('round artifacts exceed 100 MB')
      files[path.slice(prefix.length)] = bytes
    }
    if (Object.keys(files).length === 0) throw new Error(`round ${round} has no artifacts to bundle`)
    const zipped = zipSync(files, { level: 6 })
    return { name: `round-${pad(round)}.zip`, bytes: Buffer.from(zipped) }
  }

  /**
   * Delete every persisted byte of a topic: the topic directory, its raw
   * answers and its session locator. Callers must refuse active statuses
   * before invoking this.
   */
  async remove(topic: Topic): Promise<void> {
    const dir = await this.dirOf(topic.id)
    await rm(dir, { recursive: true, force: true })
    await rm(this.rawTopicDir(topic.id), { recursive: true, force: true })
    await rm(join(this.options.localRoot, 'sessions', `${topic.id}.json`), { force: true })
    this.dirs.delete(topic.id)
  }

  async readAnswer(topic: Topic, round: number): Promise<string | undefined> {
    const candidates = [
      join(this.rawTopicDir(topic.id), `${pad(round)}-answer.md`),
    ]
    if (this.options.rawAnswers === 'repo' && this.options.mode === 'project') {
      candidates.push(join(await this.dirOf(topic.id), 'rounds', `${pad(round)}-answer.md`))
    }
    for (const path of candidates) {
      try {
        return await readFile(path, 'utf8')
      } catch {
        // try the next location
      }
    }
    return undefined
  }

  async writeVerdict(topic: Topic, round: number, text: string): Promise<void> {
    const dir = await this.dirOf(topic.id)
    await this.atomic(join(dir, 'rounds', `${pad(round)}-verdict.md`), text)
  }

  async writeReceipt(topic: Topic, round: number, receipt: Receipt): Promise<void> {
    const dir = await this.dirOf(topic.id)
    await this.atomic(join(dir, 'receipts', `${pad(round)}.json`), `${JSON.stringify(receipt, null, 2)}\n`)
    await this.appendJsonLine(join(dir, 'receipts', 'history.ndjson'), {
      at: new Date().toISOString(),
      round,
      receipt,
    })
  }

  /** Merge the answer hash/timestamp into the existing receipt without losing submit fields. */
  async patchReceipt(topic: Topic, round: number, patch: Partial<Receipt>): Promise<Receipt | undefined> {
    const existing = await this.readReceipt(topic, round)
    if (existing === undefined) return undefined
    const next = { ...existing, ...patch }
    await this.writeReceipt(topic, round, next)
    return next
  }

  async writeFinal(topic: Topic, text: string): Promise<void> {
    const dir = await this.dirOf(topic.id)
    await this.atomic(join(dir, 'final.md'), text)
    if (!topic.artifacts.includes('final.md')) topic.artifacts.push('final.md')
    if (topic.generations === undefined) {
      topic.generations = [{ n: 1, createdAt: topic.created, reason: '初始任务' }]
    }
    const generation = topic.rounds[topic.rounds.length - 1]?.generation ?? topic.generations.at(-1)?.n ?? 1
    const relative = `finals/attempt-${pad(generation)}.md`
    await this.atomic(join(dir, relative), text)
    const record = topic.generations.find(item => item.n === generation)
    if (record !== undefined) record.final = relative
  }

  async readFinal(topic: Topic): Promise<string | undefined> {
    try {
      return await readFile(join(await this.dirOf(topic.id), 'final.md'), 'utf8')
    } catch {
      return undefined
    }
  }

  async writeHumanCheck(topic: Topic, check: HumanCheck): Promise<void> {
    const dir = await this.dirOf(topic.id)
    await this.atomic(join(dir, 'human-check.json'), `${JSON.stringify(check, null, 2)}\n`)
    await this.appendJsonLine(join(dir, 'human-checks.ndjson'), check)
  }

  async readReceipt(topic: Topic, round: number): Promise<Receipt | undefined> {
    try {
      const dir = await this.dirOf(topic.id)
      return JSON.parse(await readFile(join(dir, 'receipts', `${pad(round)}.json`), 'utf8')) as Receipt
    } catch {
      return undefined
    }
  }

  async index(): Promise<IndexFile> {
    const topics = await this.list()
    const entries: IndexEntry[] = topics.map(topic => ({
      id: topic.id,
      title: topic.title,
      type: topic.type,
      status: topic.status,
      rounds: topic.rounds.length,
      parent: topic.parent,
      updated: topic.updated,
      ...(topic.artifacts.includes('final.md') ? { artifact: 'final.md' } : {}),
    }))
    const file: IndexFile = { schema: 1, updated: new Date().toISOString(), topics: entries }
    await mkdir(this.rootDir(), { recursive: true })
    await this.atomic(join(this.rootDir(), 'index.json'), `${JSON.stringify(file, null, 2)}\n`)
    return file
  }

  materialManifest(entries: readonly MaterialRef[]): string {
    return `${JSON.stringify({ materials: entries }, null, 2)}\n`
  }
}
