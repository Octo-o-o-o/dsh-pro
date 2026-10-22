import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { HumanCheck, MaterialRef, Receipt, ResearchCard, SessionLocator, StoreMode, Topic } from './types.ts'
import { newTopicId, shortHash, slugifyTitle } from './slug.ts'

export interface StoreOptions {
  mode: StoreMode
  projectRoot?: string
  localRoot: string
  rawDir: string
  rawAnswers: 'local' | 'repo'
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

function sanitizeSegment(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'project'
}

export class ResearchStore {
  private dirs = new Map<string, string>()

  constructor(private readonly options: StoreOptions) {}

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
    return join(this.options.projectRoot, 'docs', 'research')
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
    await rename(temp, path)
  }

  private async uniqueDir(slug: string, id: string): Promise<string> {
    const root = this.rootDir()
    let candidate = slug
    let attempt = 0
    while (true) {
      const dir = join(root, candidate)
      if (!(await this.exists(join(dir, 'topic.json')))) return dir
      attempt += 1
      candidate = `${slug}-${shortHash(`${id}:${attempt}`)}`
    }
  }

  private async exists(path: string): Promise<boolean> {
    try {
      await readFile(path)
      return true
    } catch {
      return false
    }
  }

  async create(card: ResearchCard, roundsCap: number, model: string, channel: string): Promise<{ topic: Topic; dir: string }> {
    const now = new Date().toISOString()
    const id = newTopicId(card.title)
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
      rounds: [],
      channel,
      model,
      successCriteria: [...card.successCriteria],
      artifacts: [],
    }
    const dir = await this.uniqueDir(slugifyTitle(card.title), id)
    this.dirs.set(id, dir)
    await this.atomic(join(dir, 'topic.json'), `${JSON.stringify(topic, null, 2)}\n`)
    await this.atomic(join(dir, 'rounds', '00-question.md'), `# ${card.title}\n\n## 研究问题\n\n${card.question}\n\n## 成功判据\n\n${card.successCriteria.map(item => `- ${item}`).join('\n')}\n\n## 任务\n\n${card.brief}\n`)
    await this.atomic(join(dir, 'materials', 'manifest.json'), `${JSON.stringify({ materials: card.materials }, null, 2)}\n`)
    return { topic, dir }
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
        const topic = JSON.parse(await readFile(join(dir, 'topic.json'), 'utf8')) as Topic
        if (topic.schema !== 1) continue
        this.dirs.set(topic.id, dir)
        topics.push(topic)
      } catch {
        // A directory without a readable topic.json is not ours.
      }
    }
    return topics.sort((a, b) => b.updated.localeCompare(a.updated))
  }

  async load(id: string): Promise<Topic> {
    const dir = await this.dirOf(id)
    return JSON.parse(await readFile(join(dir, 'topic.json'), 'utf8')) as Topic
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
    } catch {
      return undefined
    }
  }

  async readMaterialPaths(topic: Topic): Promise<string[]> {
    try {
      const dir = await this.dirOf(topic.id)
      const parsed = JSON.parse(await readFile(join(dir, 'materials', 'manifest.json'), 'utf8')) as {
        materials?: Array<{ path?: unknown }>
      }
      return (parsed.materials ?? [])
        .map(item => item.path)
        .filter((path): path is string => typeof path === 'string' && path !== '')
    } catch {
      return []
    }
  }

  /** Merge new material references into the topic manifest (follow-up rounds). */
  async addMaterials(topic: Topic, refs: readonly MaterialRef[]): Promise<void> {
    if (refs.length === 0) return
    const dir = await this.dirOf(topic.id)
    const file = join(dir, 'materials', 'manifest.json')
    let existing: MaterialRef[] = []
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8')) as { materials?: MaterialRef[] }
      if (Array.isArray(parsed.materials)) existing = parsed.materials
    } catch {
      // No manifest yet: the merge starts from the new refs alone.
    }
    const byPath = new Map(existing.map(item => [item.path, item]))
    for (const ref of refs) byPath.set(ref.path, ref)
    await this.atomic(file, `${JSON.stringify({ materials: [...byPath.values()] }, null, 2)}\n`)
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
      return Array.isArray(parsed.materials) ? parsed.materials : undefined
    } catch {
      return undefined
    }
  }

  /** Conversation locator stays local even when the topic is project-stored. */
  async writeLocator(topicId: string, locator: SessionLocator): Promise<void> {
    await this.atomic(join(this.options.localRoot, 'sessions', `${topicId}.json`), `${JSON.stringify(locator, null, 2)}\n`)
  }

  async readLocator(topicId: string): Promise<SessionLocator | undefined> {
    try {
      return JSON.parse(await readFile(join(this.options.localRoot, 'sessions', `${topicId}.json`), 'utf8')) as SessionLocator
    } catch {
      return undefined
    }
  }

  async writeAnswer(topic: Topic, round: number, answer: string): Promise<void> {
    await this.atomic(join(this.rawTopicDir(topic.id), `${pad(round)}-answer.md`), answer)
    if (this.options.rawAnswers === 'repo' && this.options.mode === 'project') {
      const dir = await this.dirOf(topic.id)
      await this.atomic(join(dir, 'rounds', `${pad(round)}-answer.md`), answer)
    }
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
  }

  async writeFinal(topic: Topic, text: string): Promise<void> {
    const dir = await this.dirOf(topic.id)
    await this.atomic(join(dir, 'final.md'), text)
    if (!topic.artifacts.includes('final.md')) topic.artifacts.push('final.md')
  }

  async writeHumanCheck(topic: Topic, check: HumanCheck): Promise<void> {
    const dir = await this.dirOf(topic.id)
    await this.atomic(join(dir, 'human-check.json'), `${JSON.stringify(check, null, 2)}\n`)
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
