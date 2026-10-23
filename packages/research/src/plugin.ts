import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, extname, isAbsolute, join, resolve, sep } from 'node:path'
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import {
  ResearchEngine,
  ResearchStore,
  TransportError,
  assertImageApiConfig,
  assertMaterialLimits,
  buildManifest,
  defaultConfig,
  findSecret,
  type Channel,
  type ImageApiConfig,
  type ImageFormat,
  type Judge,
  type JudgeResult,
  type MaterialRef,
  type ProConfig,
  type ResearchCard,
  type Topic,
  type Transport,
} from '@dsh-pro/core'
import { OpenAIImageTransport, acquireSharedTransport } from '@dsh-pro/transport'
import type { ChatGptWebTransport, SharedTransport } from '@dsh-pro/transport'

export interface PluginSpec {
  name: string
  tool: string
  routes: string
  topicType: 'research' | 'design'
  homeSubdir: string
  storeSubdir: 'research' | 'design'
  skills: ReadonlyArray<{ name: string; dir: string; description: string }>
}

const baseFields = {
  rounds: z.number().step(1).min(1).max(10).default(3).description('每主题默认轮次上限（1–10）。'),
  designs: z.number().step(1).min(1).max(6).default(3).description('设计插件每轮生成的方向/图片数（1–6）。'),
  model: z.string().default('pro').description('ChatGPT 页面上的模型：pro 或 thinking。'),
  store: z.string().default('project').description('研究记录位置：project（仓库 docs/research）或 local（DSH 本机）。'),
  autoStart: z.boolean().default(false).description('研究卡是否跳过点击直接开跑。'),
  autoReview: z.boolean().default(true).description('capped 后唤醒原会话检查产物，决定接受或继续；无原会话时只显示待接受。'),
  notify: z.string().default('stall-only').description('通知策略：stall-only 只在卡住时提醒，all 完成也提醒。'),
  stallMinutes: z.number().step(1).min(1).default(45).description('无进展判定分钟数；生成中不计时。'),
  maxRoundMinutes: z.number().step(1).min(1).default(90).description('单轮墙钟上限（分钟）。'),
  maxFiles: z.number().step(1).min(1).default(12).description('单轮附件数量上限。'),
  maxTotalMB: z.number().default(24).description('单轮附件总大小（MB）。'),
  rawAnswers: z.string().default('local').description('原始答复保存位置：local（本机目录）或 repo（随项目）。公开仓库请用 local。'),
  rawAnswersDir: z.string().default('').description('local 模式的原文目录；留空用 ~/.dsh/pro-research/raw。'),
  headless: z.boolean().default(false).description('无头模式仅建议用于自检；首次登录必须有头。'),
  judgeProvider: z.string().default('').description('自动裁决的 LLM provider；留空自动使用当前 DSH 默认模型，填 off 可关闭。'),
  judgeModel: z.string().default('').description('自动裁决的 model；留空自动使用当前 DSH 默认模型；与 provider 同时填写可覆盖。'),
}

/** Loader-validated settings. Defaults mirror `defaultConfig()`. */
export const Config = z.object(baseFields)

/** Design-only schema: image settings would be noise in the research settings page. */
export const DesignConfig = z.object({
  ...baseFields,
  channel: z.string().default('web').description('生图通道：web（ChatGPT 网页会话）或 api（OpenAI 兼容生图 API）。'),
  imageBaseUrl: z.string().default('https://api.openai.com/v1').description('API 通道的 base URL，含版本前缀，例如 https://api.openai.com/v1。'),
  imageApiKey: z.string().default('').description('API 通道的 key；留空则读环境变量 GPT_IMAGE_API_KEY。只存本机配置，不要写进仓库。'),
  imageModel: z.string().default('gpt-image-1').description('API 通道的生图模型名，例如 gpt-image-1、dall-e-3 或服务商模型名。'),
  imageSize: z.string().default('auto').description('图片尺寸：auto 或 1024x1024 / 1536x1024 / 1024x1536。'),
  imageQuality: z.string().default('auto').description('质量：auto / low / medium / high（服务商支持时生效）。'),
  imageFormat: z.string().default('png').description('输出格式：png / jpeg / webp。'),
  imageAuth: z.string().default('bearer').description('鉴权头：bearer（Authorization: Bearer）或 api-key（Azure 风格）。'),
  imageEdit: z.string().default('auto').description('材料中的图片是否作为参考图发给 /images/edits：auto / off。'),
  imageTimeoutSeconds: z.number().step(1).min(10).max(3600).default(300).description('单张图片的生成/下载超时（秒，10–3600）。'),
})

export interface ResearchConfig {
  channel?: string
  rounds?: number
  designs?: number
  model?: string
  imageBaseUrl?: string
  imageApiKey?: string
  imageModel?: string
  imageSize?: string
  imageQuality?: string
  imageFormat?: string
  imageAuth?: string
  imageEdit?: string
  imageTimeoutSeconds?: number
  store?: string
  autoStart?: boolean
  autoReview?: boolean
  notify?: string
  stallMinutes?: number
  maxRoundMinutes?: number
  maxFiles?: number
  maxTotalMB?: number
  rawAnswers?: string
  rawAnswersDir?: string
  headless?: boolean
  judgeProvider?: string
  judgeModel?: string
}

interface SkillsService {
  registerProvider(create: (control: { signal: AbortSignal }) => {
    name: string
    list: () => Promise<unknown[]>
    get: (candidate: unknown) => Promise<unknown>
  }): () => void
}

type ServiceContext = Context & {
  tools: { register(tool: unknown): () => void }
  get(name: string): unknown
  inject(services: string[], callback: (scoped: Context) => void): void
}

interface RegistryEntry {
  id: string
  root: string
  mode: 'project' | 'local'
  title: string
  updated: string
  sessionId?: string
}

interface LiveAgent {
  id?: string
  inject(message: unknown): void
  followup?(message: unknown): void
  whenIdle?(): Promise<void>
}

interface AgentFactory {
  get(id: string): LiveAgent | undefined
}

interface SessionController {
  resolveAgent(sessionId: string): Promise<LiveAgent | { agent: LiveAgent } | { error: unknown }>
}

interface AgentDefaultModel {
  currentSelection(): { provider?: string; model?: string; reasoningEffort?: string }
}

function homeDir(): string {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

function isHtmlSource(text: string): boolean {
  return /^\s*(?:<!doctype\s+html|<html[\s>])/i.test(text.slice(0, 512))
}

function mimeFor(path: string): string {
  switch (extname(path).toLowerCase()) {
    case '.png': return 'image/png'
    case '.jpg':
    case '.jpeg': return 'image/jpeg'
    case '.webp': return 'image/webp'
    case '.gif': return 'image/gif'
    case '.svg': return 'image/svg+xml'
    case '.html':
    case '.htm': return 'text/html; charset=utf-8'
    case '.css': return 'text/css; charset=utf-8'
    case '.js': return 'text/javascript; charset=utf-8'
    case '.json': return 'application/json; charset=utf-8'
    case '.zip': return 'application/zip'
    case '.woff2': return 'font/woff2'
    case '.woff': return 'font/woff'
    case '.ttf': return 'font/ttf'
    case '.otf': return 'font/otf'
    case '.ico': return 'image/x-icon'
    case '.wasm': return 'application/wasm'
    case '.mp4': return 'video/mp4'
    case '.webm': return 'video/webm'
    case '.mp3': return 'audio/mpeg'
    case '.md':
    case '.markdown': return 'text/markdown; charset=utf-8'
    case '.txt': return 'text/plain; charset=utf-8'
    case '.ts':
    case '.tsx':
    case '.jsx': return 'text/plain; charset=utf-8'
    default: return 'application/octet-stream'
  }
}

// Settings load must not take the whole plugin down over one typo: the image
// enums are validated by assertImageApiConfig right before the first request.
function imageFormatOf(value: string | undefined, fallback: ImageFormat): ImageFormat {
  return value === undefined || value.trim() === '' ? fallback : value as ImageFormat
}

function imageAuthOf(value: string | undefined): 'bearer' | 'api-key' {
  return value === undefined || value.trim() === '' ? 'bearer' : value as 'bearer' | 'api-key'
}

function imageEditOf(value: string | undefined): 'auto' | 'off' {
  return value === undefined || value.trim() === '' ? 'auto' : value as 'auto' | 'off'
}

/** Settings are flat for the generated settings form; the engine keeps one object. */
function resolveImageConfig(base: ImageApiConfig, config: ResearchConfig | undefined): ImageApiConfig {
  const settingsKey = (config?.imageApiKey ?? '').trim()
  const envKey = (process.env.GPT_IMAGE_API_KEY ?? '').trim()
  return {
    baseUrl: (config?.imageBaseUrl ?? '').trim() !== '' ? config!.imageBaseUrl!.trim() : base.baseUrl,
    apiKey: settingsKey !== '' ? settingsKey : envKey,
    model: (config?.imageModel ?? '').trim() !== '' ? config!.imageModel!.trim() : base.model,
    size: (config?.imageSize ?? '').trim() !== '' ? config!.imageSize!.trim() : base.size,
    quality: (config?.imageQuality ?? '').trim() !== '' ? config!.imageQuality!.trim() : base.quality,
    format: imageFormatOf(config?.imageFormat, base.format),
    auth: imageAuthOf(config?.imageAuth),
    editMode: imageEditOf(config?.imageEdit),
    timeoutSeconds: config?.imageTimeoutSeconds ?? base.timeoutSeconds,
  }
}

export function resolvePluginConfig(spec: PluginSpec, config: ResearchConfig | undefined): ProConfig {
  const base = defaultConfig(join(homeDir(), spec.homeSubdir))
  // One ChatGPT account, one session: both plugins share the same installed
  // Chrome profile. Deliberately not configurable, so a second plugin (or a
  // copied settings file) cannot silently open a second account.
  base.browser = { ...base.browser, profileDir: join(homeDir(), 'pro-research', 'browser') }
  const design = spec.topicType === 'design'
  // The api channel is a design feature; research stays on the web session even
  // if image settings leak into its stored config.
  const channel: Channel = design && config?.channel === 'api' ? 'api' : 'web'
  const merged: ProConfig = {
    ...base,
    channel,
    image: design ? resolveImageConfig(base.image, config) : base.image,
    ...(config?.rounds !== undefined ? { rounds: config.rounds } : {}),
    ...(config?.designs !== undefined ? { designs: config.designs } : {}),
    ...(config?.model !== undefined ? { model: config.model } : {}),
    ...(config?.store === 'local' || config?.store === 'project' ? { store: config.store } : {}),
    ...(config?.autoStart !== undefined ? { autoStart: config.autoStart } : {}),
    ...(config?.autoReview !== undefined ? { autoReview: config.autoReview } : {}),
    ...(config?.notify === 'all' || config?.notify === 'stall-only' ? { notify: config.notify } : {}),
    ...(config?.stallMinutes !== undefined ? { stallMinutes: config.stallMinutes } : {}),
    ...(config?.maxRoundMinutes !== undefined ? { maxRoundMinutes: config.maxRoundMinutes } : {}),
    ...(config?.maxFiles !== undefined ? { maxFiles: config.maxFiles } : {}),
    ...(config?.maxTotalMB !== undefined ? { maxTotalMB: config.maxTotalMB } : {}),
    ...(config?.rawAnswers === 'repo' || config?.rawAnswers === 'local' ? { rawAnswers: config.rawAnswers } : {}),
    ...(config?.rawAnswersDir !== undefined && config.rawAnswersDir !== '' ? { rawAnswersDir: config.rawAnswersDir } : {}),
    ...(config?.headless !== undefined ? { browser: { ...base.browser, headless: config.headless } } : {}),
    ...(config?.judgeProvider !== undefined && config.judgeProvider !== '' ? { judgeProvider: config.judgeProvider } : {}),
    ...(config?.judgeModel !== undefined && config.judgeModel !== '' ? { judgeModel: config.judgeModel } : {}),
  }
  return merged
}

const JUDGE_SYSTEM = [
  '你是研究任务的验收裁判。只输出一个 JSON 对象，不要 Markdown 围栏。',
  '字段：verdict（accepted|partial|rejected）、reason（一句话）、done（是否已满足全部成功判据）、',
  'summary（不超过 200 字的中文结论摘要）、nextBrief（未完成时下一轮要问什么，已完成可省略）。',
  '判断依据只能是答复本身与给定判据；不要因为答复自信或一致就判 accepted。',
].join('\n')

function parseJudge(text: string): Omit<JudgeResult, 'nextBrief'> & { nextBrief?: string } {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) throw new Error('judge returned no JSON object')
  const parsed = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>
  const verdict = parsed.verdict === 'accepted' || parsed.verdict === 'rejected' || parsed.verdict === 'partial'
    ? parsed.verdict
    : 'partial'
  return {
    verdict,
    reason: typeof parsed.reason === 'string' ? parsed.reason : '',
    done: parsed.done === true,
    summary: typeof parsed.summary === 'string' ? parsed.summary : '',
    ...(typeof parsed.nextBrief === 'string' ? { nextBrief: parsed.nextBrief } : {}),
  }
}

class ProResearchService {
  private readonly engines = new Map<string, ResearchEngine>()
  private readonly stores = new Map<string, ResearchStore>()
  private readonly topicSessions = new Map<string, string>()
  private sessionController?: SessionController
  private defaultModel?: AgentDefaultModel
  private agentFactory?: AgentFactory
  private registryChain: Promise<void> = Promise.resolve()
  private transport?: ChatGptWebTransport
  private imageTransport?: OpenAIImageTransport
  private shared?: SharedTransport

  constructor(
    private readonly ctx: ServiceContext,
    private readonly config: ProConfig,
    private readonly home: string,
    private readonly spec: PluginSpec,
  ) {}

  private rootFor(cwd: string): string {
    return cwd.trim() === '' ? process.cwd() : cwd
  }

  private storeFor(cwd: string): ResearchStore {
    return this.storeAt(this.rootFor(cwd), this.config.store)
  }

  private storeAt(root: string, mode: 'project' | 'local'): ResearchStore {
    const key = `${mode}:${root}`
    const existing = this.stores.get(key)
    if (existing !== undefined) return existing
    const store = new ResearchStore({
      mode,
      projectRoot: root,
      localRoot: join(this.home, this.spec.homeSubdir),
      rawDir: this.config.rawAnswersDir,
      rawAnswers: this.config.rawAnswers,
      docsSubdir: this.spec.storeSubdir,
    })
    this.stores.set(key, store)
    return store
  }

  private transportFor(): Transport {
    if (this.config.channel === 'api') {
      if (this.imageTransport === undefined) {
        this.imageTransport = new OpenAIImageTransport({
          baseUrl: this.config.image.baseUrl,
          apiKey: this.config.image.apiKey,
          model: this.config.image.model,
          size: this.config.image.size,
          quality: this.config.image.quality,
          format: this.config.image.format,
          auth: this.config.image.auth,
          editMode: this.config.image.editMode,
          timeoutMs: this.config.image.timeoutSeconds * 1_000,
          count: this.config.designs,
        })
      }
      return this.imageTransport
    }
    if (this.transport !== undefined) return this.transport
    this.shared = acquireSharedTransport({
      profileDir: this.config.browser.profileDir,
      headless: this.config.browser.headless,
    })
    this.transport = this.shared.transport
    return this.transport
  }

  private judge(): Judge {
    return async (input) => {
      const route = this.judgeRoute()
      if (route === undefined) {
        return {
          verdict: 'partial',
          reason: '未配置裁决模型，且当前没有可用的 DSH 默认模型',
          done: false,
          summary: '未启用自动裁决；结论见各轮裁决与原始答复。',
        }
      }
      const llm = this.ctx.get('llm') as
        | { stream(options: Record<string, unknown>): AsyncIterable<unknown> }
        | undefined
      if (llm === undefined) throw new Error('the harness LLM service is unavailable')
      const assembler = new BlockAssembler()
      const user = [
        `主题：${input.topic.title}`,
        `成功判据：\n${input.criteria.map(item => `- ${item}`).join('\n')}`,
        `本轮问题：\n${input.question ?? '（未记录）'}`,
        `本轮答复：\n${input.answer.slice(0, 30_000)}`,
      ].join('\n\n')
      for await (const chunk of llm.stream({
        provider: route.provider,
        model: route.model,
        system: JUDGE_SYSTEM,
        messages: [createUserMessage({
          content: [{ type: 'text', text: user }],
          source: { kind: this.spec.name } as never,
        })],
        maxTokens: 1_200,
        signal: AbortSignal.timeout(120_000),
      })) {
        assembler.push(chunk as never)
      }
      const text = assembler.blocks().map(block => (block.type === 'text' ? block.text : '')).join('')
      return parseJudge(text)
    }
  }

  private judgeRoute(): { provider: string; model: string; source: 'configured' | 'default' } | undefined {
    const provider = this.config.judgeProvider.trim()
    const model = this.config.judgeModel.trim()
    if (provider.toLowerCase() === 'off') return undefined
    if (provider !== '' && model !== '') return { provider, model, source: 'configured' }
    try {
      const model = this.defaultModel ?? this.ctx.get('agentDefaultModel') as AgentDefaultModel | undefined
      const selection = model?.currentSelection()
      if (selection?.provider !== undefined && selection.provider !== '' && selection.model !== undefined && selection.model !== '') {
        return { provider: selection.provider, model: selection.model, source: 'default' }
      }
    } catch {
      // No default selection is available in this composition.
    }
    return undefined
  }

  private engineFor(cwd: string, mode: 'project' | 'local' = this.config.store): ResearchEngine {
    const root = this.rootFor(cwd)
    const store = this.storeAt(root, mode)
    const key = `${mode}:${root}`
    const existing = this.engines.get(key)
    if (existing !== undefined) return existing
    const engine = new ResearchEngine({
      store,
      transport: this.transportFor(),
      judge: this.judge(),
      config: this.config,
      onEvent: event => {
        if (event.type === 'status' && (event.status === 'stalled' || event.status === 'failed')) {
          this.log(`topic ${event.topicId} ${event.status}${event.reason !== undefined ? ` (${event.reason})` : ''}`)
          void this.notifyStalled(event.topicId, event.reason)
        }
        if (event.type === 'finished' && this.config.notify === 'all') {
          void this.notifyFinished(event.topicId, event.status)
        }
        if (event.type === 'finished' && event.status === 'capped' && this.config.autoReview) {
          void this.autoReviewRequest(event.topicId)
        }
      },
    })
    this.engines.set(key, engine)
    return engine
  }

  private log(message: string): void {
    const logger = (this.ctx as unknown as { logger?: (name: string) => { info?: (msg: string) => void } }).logger
    const scoped = typeof logger === 'function' ? logger(this.spec.name) : undefined
    scoped?.info?.(message)
  }

  private async find(cwd: string, topicId: string): Promise<{ store: ResearchStore; engine: ResearchEngine; topic: Topic }> {
    const entry = await this.entryFor(topicId)
    if (entry !== undefined) {
      const store = this.storeAt(entry.root, entry.mode)
      return { store, engine: this.engineFor(entry.root, entry.mode), topic: await store.load(topicId) }
    }
    const store = this.storeFor(cwd)
    try {
      const topic = await store.load(topicId)
      return { store, engine: this.engineFor(cwd), topic }
    } catch {
      for (const candidate of this.stores.values()) {
        try {
          const topic = await candidate.load(topicId)
          return { store: candidate, engine: this.engineFor(cwd), topic }
        } catch {
          // keep looking
        }
      }
    }
    throw new Error(`unknown topic: ${topicId}`)
  }

  private get registryFile(): string {
    return join(this.home, this.spec.homeSubdir, 'registry.json')
  }

  private async readRegistry(): Promise<RegistryEntry[]> {
    try {
      const parsed = JSON.parse(await readFile(this.registryFile, 'utf8')) as { topics?: RegistryEntry[] }
      return Array.isArray(parsed.topics)
        ? parsed.topics
          .filter(entry => entry !== null && typeof entry === 'object' && typeof entry.id === 'string')
          .map(entry => ({ ...entry, mode: entry.mode === 'local' ? 'local' : 'project' }))
        : []
    } catch {
      return []
    }
  }

  /**
   * Registry is a cache, not the source of truth. At startup also scan the
   * current project root and every root already named in the registry, so a
   * lost/stale registry does not hide an interrupted topic.
   */
  private async knownEntries(): Promise<RegistryEntry[]> {
    const entries = await this.readRegistry()
    const seen = new Set(entries.map(entry => entry.id))
    const roots = new Set<string>([this.rootFor(''), ...entries.map(entry => entry.root)])
    for (const root of roots) {
      for (const mode of ['project', 'local'] as const) {
        try {
          for (const topic of await this.storeAt(root, mode).list()) {
            if (seen.has(topic.id)) continue
            seen.add(topic.id)
            entries.push({ id: topic.id, root, mode, title: topic.title, updated: topic.updated })
          }
        } catch {
          // A missing/unreadable root is not a reason to stop recovering others.
        }
      }
    }
    return entries
  }

  private async writeRegistry(entries: RegistryEntry[]): Promise<void> {
    await mkdir(dirname(this.registryFile), { recursive: true })
    const temp = `${this.registryFile}.${randomUUID()}.tmp`
    await writeFile(temp, `${JSON.stringify({ version: 1, topics: entries }, null, 2)}\n`, 'utf8')
    await rename(temp, this.registryFile)
  }

  private async record(topic: Topic, root: string, sessionId?: string): Promise<void> {
    if (sessionId !== undefined && sessionId !== '') this.topicSessions.set(topic.id, sessionId)
    const job = async (): Promise<void> => {
      const entries = (await this.readRegistry()).filter(entry => entry.id !== topic.id)
      entries.push({
        id: topic.id,
        root,
        mode: this.config.store,
        title: topic.title,
        updated: topic.updated,
        ...(sessionId !== undefined && sessionId !== '' ? { sessionId } : {}),
      })
      await this.writeRegistry(entries)
    }
    const next = this.registryChain.then(job, job)
    this.registryChain = next.catch(() => undefined)
    await next
  }

  /**
   * One quiet reminder in the originating session when a run stalls or fails.
   * `agent.inject` is model-facing context that does not wake the driver; when
   * the session is no longer live the sidebar still shows the state, so a
   * missing agent is not an error.
   */
  useAgentFactory(factory: AgentFactory): void {
    this.agentFactory = factory
  }

  useSessionController(controller: SessionController): void {
    this.sessionController = controller
  }

  useDefaultModel(model: AgentDefaultModel): void {
    this.defaultModel = model
  }

  private liveAgent(sessionId: string): LiveAgent | undefined {
    const agents = this.agentFactory ?? this.ctx.get('agents') as AgentFactory | undefined
    return agents?.get(sessionId)
  }

  private async notifyStalled(id: string, reason: string | undefined): Promise<void> {
    try {
      const entry = await this.entryFor(id)
      const sessionId = entry?.sessionId ?? this.topicSessions.get(id)
      if (sessionId === undefined) return
      const agent = this.liveAgent(sessionId)
      if (agent === undefined) return
      const topic = entry === undefined ? undefined : await this.storeAt(entry.root, entry.mode).load(id).catch(() => undefined)
      const title = topic?.title ?? id
      agent.inject(createUserMessage({
        content: [{
          type: 'text',
          text: `<system-reminder>Pro ${this.spec.topicType === 'design' ? '设计' : '研究'}「${title}」卡住了${reason === undefined ? '' : `（${reason}）`}。在侧边栏「Pro」里查看现场，然后恢复、取消或人工核对。</system-reminder>`,
        }],
        source: { kind: this.spec.name } as never,
      }))
    } catch {
      // Notification is best-effort; the sidebar and records remain the truth.
    }
  }

  /** Automatic capped handoff: only a live session, and only mark it reviewing after delivery succeeds. */
  private async autoReviewRequest(id: string): Promise<void> {
    const wake = await this.notifyCappedReview(id)
    if (!wake.ok) return
    const entry = await this.entryFor(id)
    if (entry === undefined) return
    await this.engineFor(entry.root, entry.mode).markReviewing(id).catch(() => undefined)
  }

  /** Ask the originating agent to inspect a capped/failed result and decide. */
  private async notifyCappedReview(id: string, resumeCold = false): Promise<{ ok: boolean; resumed?: boolean; reason?: string }> {
    try {
      const entry = await this.entryFor(id)
      const sessionId = entry?.sessionId ?? this.topicSessions.get(id)
      if (sessionId === undefined) return { ok: false, reason: '原会话 id 未记录' }
      const topic = entry === undefined ? undefined : await this.storeAt(entry.root, entry.mode).load(id).catch(() => undefined)
      if (topic === undefined) return { ok: false, reason: '主题不存在' }
      const dir = await this.storeAt(entry?.root ?? this.rootFor(''), entry?.mode ?? this.config.store).dirOf(id)
      const state = topic.status === 'capped' ? '已到轮次上限' : topic.status === 'failed' ? '失败' : '停下等待核对'
      const message = `<system-reminder>Pro 主题「${topic.title}」${state}，结果等待确认。请先检查产物和判据：
- 满足：调用 ${this.spec.tool} action=accept topic_id=${id} confirmed=true
- 还需改进：调用 ${this.spec.tool} action=regenerate topic_id=${id} confirmed=true note="具体问题"
- 需要继续研究但不用换版：调用 ${this.spec.tool} action=continue topic_id=${id} confirmed=true brief="下一轮问题"
产物目录：${dir}
最终汇总：${join(dir, 'final.md')}</system-reminder>`
      if (resumeCold) return await this.wakeSession(sessionId, message)
      // Automatic review only nudges a still-live session; accepting a cold
      // session remains an explicit user action.
      const agents = this.agentFactory ?? this.ctx.get('agents') as AgentFactory | undefined
      const agent = agents?.get(sessionId)
      if (agent?.followup === undefined) return { ok: false, reason: '原会话当前未运行' }
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: message }],
        source: { kind: this.spec.name } as never,
      }))
      return { ok: true }
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }

  /** Quiet reminder for the opt-in `notify=all` mode. */
  private async notifyFinished(id: string, status: 'completed' | 'capped' | 'cancelled'): Promise<void> {
    try {
      const entry = await this.entryFor(id)
      const sessionId = entry?.sessionId ?? this.topicSessions.get(id)
      if (sessionId === undefined) return
      const agent = this.liveAgent(sessionId)
      if (agent === undefined) return
      const topic = entry === undefined ? undefined : await this.storeAt(entry.root, entry.mode).load(id).catch(() => undefined)
      const title = topic?.title ?? id
      agent.inject(createUserMessage({
        content: [{
          type: 'text',
          text: `<system-reminder>Pro 主题「${title}」已${status === 'completed' ? '完成' : status === 'capped' ? '到轮次上限' : '取消'}。产物与最终汇总在侧边栏对应面板里。</system-reminder>`,
        }],
        source: { kind: this.spec.name } as never,
      }))
    } catch {
      // Best-effort reminder.
    }
  }

  private async wakeSession(sessionId: string, text: string): Promise<{ ok: boolean; resumed?: boolean; reason?: string }> {
    const agents = this.agentFactory ?? this.ctx.get('agents') as AgentFactory | undefined
    let agent = agents?.get(sessionId)
    let resumed = false
    if (agent === undefined) {
      const controller = this.sessionController ?? this.ctx.get('sessionController') as SessionController | undefined
      if (controller === undefined) return { ok: false, reason: 'sessionController 服务不可用，无法恢复冷会话' }
      try {
        const resolved = await controller.resolveAgent(sessionId)
        if ('error' in resolved) {
          return { ok: false, reason: `恢复会话失败：${String(resolved.error)}` }
        }
        agent = 'agent' in resolved ? resolved.agent : resolved
        resumed = true
      } catch (error) {
        return { ok: false, reason: `恢复会话失败：${error instanceof Error ? error.message : String(error)}` }
      }
    }
    if (agent === undefined) return { ok: false, reason: '原会话已不存在或未加载' }
    if (agent.followup === undefined) return { ok: false, reason: '当前运行时不支持唤醒会话' }
    agent.followup(createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: this.spec.name } as never,
    }))
    return { ok: true, ...(resumed ? { resumed: true } : {}) }
  }

  /**
   * A human accepted a result. Wake the originating conversation so the agent
   * continues whatever it was doing before it handed this topic off.
   */
  private async notifyAccepted(id: string, topic: Topic): Promise<{ ok: boolean; resumed?: boolean; reason?: string }> {
    try {
      const entry = await this.entryFor(id)
      const sessionId = entry?.sessionId ?? this.topicSessions.get(id)
      if (sessionId === undefined) return { ok: false, reason: '原会话 id 未记录' }
      const dir = await this.storeAt(entry?.root ?? this.rootFor(''), entry?.mode ?? this.config.store).dirOf(id)
      return await this.wakeSession(sessionId, `<system-reminder>用户已接受「${topic.title}」的当前结果，视为验收通过。请继续这个主题之前被搁置的后续工作，不要重复已经完成的研究/设计轮次。产物目录：${dir}，最终汇总：${join(dir, 'final.md')}。</system-reminder>`)
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }

  private async entryFor(id: string): Promise<RegistryEntry | undefined> {
    return (await this.readRegistry()).find(entry => entry.id === id)
  }

  async listAll(): Promise<Array<Record<string, unknown>>> {
    const entries = await this.readRegistry()
    const rows: Array<Record<string, unknown>> = []
    for (const entry of entries) {
      try {
        const topic = await this.storeAt(entry.root, entry.mode).load(entry.id)
        rows.push({ ...this.view(topic), root: entry.root, store: entry.mode })
      } catch {
        // A recorded topic that no longer loads is left out instead of faked.
      }
    }
    return rows.sort((a, b) => String(b.updated ?? '').localeCompare(String(a.updated ?? '')))
  }

  async detail(id: string): Promise<Record<string, unknown> | undefined> {
    const entry = await this.entryFor(id)
    if (entry === undefined) return undefined
    const store = this.storeAt(entry.root, entry.mode)
    const topic = await store.load(id)
    const dir = await store.dirOf(id)
    return {
      ...this.view(topic),
      root: entry.root,
      store: entry.mode,
      path: dir,
      artifact_details: await this.artifactDetails(dir, topic),
      rounds_detail: topic.rounds,
    }
  }

  private async artifactDetails(dir: string, topic: Topic): Promise<Array<{ path: string; kind: 'image' | 'demo' | 'code' | 'archive' | 'file' }>> {
    const root = resolve(dir, 'artifacts')
    const details: Array<{ path: string; kind: 'image' | 'demo' | 'code' | 'archive' | 'file' }> = []
    for (const path of topic.artifacts) {
      if (path === 'final.md') continue
      const target = resolve(dir, path)
      if (target !== root && !target.startsWith(`${root}${sep}`)) continue
      const extension = extname(target).toLowerCase()
      if (/^\.(png|jpe?g|webp|gif|svg)$/.test(extension)) {
        details.push({ path, kind: 'image' })
        continue
      }
      if (extension === '.html' || extension === '.htm') {
        details.push({ path, kind: 'demo' })
        continue
      }
      if (extension === '.zip') {
        details.push({ path, kind: 'archive' })
        continue
      }
      if (/^\.(txt|md|markdown)$/.test(extension)) {
        try {
          const head = (await readFile(target, 'utf8')).slice(0, 512)
          details.push({ path, kind: isHtmlSource(head) ? 'demo' : 'code' })
        } catch {
          details.push({ path, kind: 'file' })
        }
        continue
      }
      if (/^\.(css|js|jsx|ts|tsx|json|html)$/.test(extension)) {
        details.push({ path, kind: 'code' })
        continue
      }
      details.push({ path, kind: 'file' })
    }
    return details
  }

  /** Serve one recorded artifact; the path must stay inside `<topic>/artifacts/`. */  async readArtifact(id: string, relativePath: string): Promise<{ bytes: Buffer; mime: string }> {
    const entry = await this.entryFor(id)
    if (entry === undefined) throw new Error(`unknown topic: ${id}`)
    const store = this.storeAt(entry.root, entry.mode)
    const dir = await store.dirOf(id)
    const artifactsRoot = resolve(dir, 'artifacts')
    const target = resolve(dir, relativePath)
    if (target !== artifactsRoot && !target.startsWith(`${artifactsRoot}${sep}`)) {
      throw new Error('artifact path escapes the topic')
    }
    const bytes = await readFile(target)
    const textMime = mimeFor(target)
    if (textMime.startsWith('text/plain') || textMime.startsWith('text/markdown')) {
      const head = bytes.subarray(0, 512).toString('utf8')
      if (isHtmlSource(head)) return { bytes, mime: 'text/html; charset=utf-8' }
    }
    return { bytes, mime: textMime }
  }

  /** Raw answer text for one round; shown in a new tab from the panel. */
  async answerText(id: string, round: number): Promise<string | undefined> {
    const entry = await this.entryFor(id)
    if (entry === undefined) return undefined
    const store = this.storeAt(entry.root, entry.mode)
    const topic = await store.load(id)
    return await store.readAnswer(topic, round)
  }

  /** Bundle one round's artifacts into a zip for download. */
  async bundleArtifacts(id: string, round: number): Promise<{ name: string; bytes: Buffer }> {
    const entry = await this.entryFor(id)
    if (entry === undefined) throw new Error(`unknown topic: ${id}`)
    const store = this.storeAt(entry.root, entry.mode)
    const topic = await store.load(id)
    if (!Number.isInteger(round) || round < 1) throw new Error('round is required')
    return await store.bundleRound(topic, round)
  }

  /** Read a text file (final.md, verdict, question) from inside a topic. */
  async topicText(id: string, relativePath: string): Promise<{ text: string; mime: string }> {
    const entry = await this.entryFor(id)
    if (entry === undefined) throw new Error(`unknown topic: ${id}`)
    const store = this.storeAt(entry.root, entry.mode)
    const dir = await store.dirOf(id)
    const target = resolve(dir, relativePath)
    if (target !== dir && !target.startsWith(`${dir}${sep}`)) {
      throw new Error('path escapes the topic')
    }
    const bytes = await readFile(target)
    if (bytes.byteLength > 2_000_000) throw new Error('file is too large to preview')
    return { text: bytes.toString('utf8'), mime: mimeFor(target) }
  }

  /** Reveal a topic-relative file in the OS file manager. */
  async revealFile(id: string, relativePath: string): Promise<void> {
    const entry = await this.entryFor(id)
    if (entry === undefined) throw new Error(`unknown topic: ${id}`)
    const store = this.storeAt(entry.root, entry.mode)
    const dir = await store.dirOf(id)
    const target = resolve(dir, relativePath)
    if (target !== dir && !target.startsWith(`${dir}${sep}`)) {
      throw new Error('path escapes the topic')
    }
    await access(target)
    const child = process.platform === 'win32'
      ? spawn('explorer.exe', ['/select,', target], { detached: true, stdio: 'ignore' })
      : process.platform === 'darwin'
        ? spawn('open', ['-R', target], { detached: true, stdio: 'ignore' })
        : spawn('xdg-open', [dirname(target)], { detached: true, stdio: 'ignore' })
    child.unref()
  }

  /** Open one topic file with the OS default application. */
  async openFile(id: string, relativePath: string): Promise<void> {
    const entry = await this.entryFor(id)
    if (entry === undefined) throw new Error(`unknown topic: ${id}`)
    const store = this.storeAt(entry.root, entry.mode)
    const dir = await store.dirOf(id)
    const target = resolve(dir, relativePath)
    if (target !== dir && !target.startsWith(`${dir}${sep}`)) {
      throw new Error('path escapes the topic')
    }
    await access(target)
    const child = process.platform === 'win32'
      ? spawn('cmd.exe', ['/c', 'start', '', target], { detached: true, stdio: 'ignore', windowsHide: true })
      : process.platform === 'darwin'
        ? spawn('open', [target], { detached: true, stdio: 'ignore' })
        : spawn('xdg-open', [target], { detached: true, stdio: 'ignore' })
    child.unref()
  }

  async act(
    id: string,
    action: string,
    conclusion?: 'submitted' | 'not_submitted' | 'reopen',
    note?: string,
  ): Promise<Record<string, unknown>> {
    const entry = await this.entryFor(id)
    if (entry === undefined) throw new Error(`unknown topic: ${id}`)
    const engine = this.engineFor(entry.root, entry.mode)
    if (action === 'resume') {
      const topic = await this.storeAt(entry.root, entry.mode).load(id)
      if (topic.channel === 'api' && topic.rounds.some(round => round.submissionId !== undefined)) {
        throw new Error('API 通道重启后无法接管已发出的生图请求；请接受已有产物、重新生成或取消')
      }
      return this.view(await engine.resume(id))
    }
    if (action === 'cancel') return this.view(await engine.cancel(id))
    if (action === 'accept') {
      const accepted = await engine.accept(id)
      const wake = await this.notifyAccepted(id, accepted)
      return { ...this.view(accepted), wake }
    }
    if (action === 'wake') {
      const topic = await this.storeAt(entry.root, entry.mode).load(id)
      if (topic.status !== 'completed') {
        throw new Error(`topic ${id} is ${topic.status}; only completed topics can be woken without a decision`)
      }
      const wake = await this.notifyAccepted(id, topic)
      return { ...this.view(topic), wake }
    }
    if (action === 'review') {
      const topic = await this.storeAt(entry.root, entry.mode).load(id)
      if (topic.status !== 'capped' && topic.status !== 'reviewing' && topic.status !== 'failed' && topic.status !== 'stalled') {
        throw new Error(`topic ${id} is ${topic.status}; only capped/reviewing/failed/stalled topics need review`)
      }
      const wake = await this.notifyCappedReview(id, true)
      if (wake.ok && (topic.status === 'capped' || topic.status === 'reviewing' || topic.status === 'failed' || topic.status === 'stalled')) {
        const reviewing = await engine.markReviewing(id)
        return { ...this.view(reviewing), wake }
      }
      return { ...this.view(topic), wake }
    }
    if (action === 'review_cancel') {
      return this.view(await engine.cancelReview(id))
    }
    if (action === 'human_check') {
      if (conclusion === undefined) throw new Error('conclusion is required')
      const reason = note ?? ''
      if (reason.trim() === '') throw new Error('note is required')
      return this.view(await engine.humanCheck(id, conclusion, reason))
    }
    if (action === 'regenerate') {
      const topic = await this.storeAt(entry.root, entry.mode).load(id)
      const finished = topic.status === 'completed' || topic.status === 'capped' || topic.status === 'reviewing'
      const recoverable = topic.status === 'failed' || topic.status === 'stalled'
      if (!finished && !recoverable) {
        throw new Error(`topic ${id} is ${topic.status}; regenerate needs completed/capped/reviewing or failed/stalled`)
      }
      const feedback = (note ?? '').trim()
      this.assertTextSafe('regenerate note', feedback)
      const brief = [
        `继续主题「${topic.title}」：用户对上一轮结果不满意，请基于已有上下文重新生成并改进。`,
        '## 用户反馈',
        feedback === '' ? '没有具体反馈；请保持成功判据不变，给出与上一轮明显不同的新方案。' : feedback,
        '## 要求',
        '不要重复上一轮已确认的内容；给出新的产物或方向，并说明与上一版的差异。',
      ].join('\n\n')
      return this.view(await engine.regenerate(
        id,
        this.withDesignCount(brief, topic.designs ?? this.config.designs),
        feedback,
      ))
    }
    throw new Error('action must be resume, cancel, accept, review, review_cancel, wake, human_check or regenerate')
  }

  async handle(args: Record<string, unknown>, exec: ToolRunContext): Promise<Record<string, unknown>> {
    const action = typeof args.action === 'string' ? args.action : ''
    const cwd = exec.agent?.session.header.cwd ?? process.cwd()
    switch (action) {
      case 'start':
        return await this.start(args, cwd, exec.agent?.session.id)
      case 'status': {
        const id = this.requireId(args)
        const { topic } = await this.find(cwd, id)
        return this.view(topic)
      }
      case 'list': {
        const store = this.storeFor(cwd)
        const topics = await store.list()
        return { topics: topics.map(topic => this.view(topic)) }
      }
      case 'resume': {
        const id = this.requireId(args)
        const { engine } = await this.find(cwd, id)
        return this.view(await engine.resume(id))
      }
      case 'continue': {
        const id = this.requireId(args)
        const brief = this.requireString(args, 'brief')
        this.assertTextSafe('brief', brief)
        const paths = Array.isArray(args.materials) && args.materials.length > 0
          ? this.stringArray(args.materials, 'materials')
          : []
        const refs = paths.length > 0 ? this.withSources(cwd, await buildManifest(cwd, paths, undefined, this.config.secretGlobs)) : []
        assertMaterialLimits(refs, this.config.maxFiles, this.config.maxTotalMB)
        const { engine, topic } = await this.find(cwd, id)
        const requestedDesigns = typeof args.designs === 'number' ? args.designs : undefined
        if (requestedDesigns !== undefined && (!Number.isInteger(requestedDesigns) || requestedDesigns < 1 || requestedDesigns > 6)) {
          throw new Error('designs must be an integer between 1 and 6')
        }
        const designs = topic.type === 'design' ? (requestedDesigns ?? topic.designs ?? this.config.designs) : undefined
        const followUp = designs === undefined ? brief : this.withDesignCount(brief, designs)
        return this.view(await engine.continue(id, followUp, refs, designs))
      }
      case 'cancel': {
        const id = this.requireId(args)
        const { engine } = await this.find(cwd, id)
        return this.view(await engine.cancel(id))
      }
      case 'human_check': {
        const id = this.requireId(args)
        const conclusion = args.conclusion
        if (conclusion !== 'submitted' && conclusion !== 'not_submitted' && conclusion !== 'reopen') {
          throw new Error('conclusion must be submitted, not_submitted or reopen')
        }
        const note = typeof args.note === 'string' ? args.note : ''
        if (note.trim() === '') throw new Error('human_check requires a note')
        const { engine } = await this.find(cwd, id)
        return this.view(await engine.humanCheck(id, conclusion, note))
      }
      case 'accept':
        return await this.act(this.requireId(args), 'accept')
      case 'wake':
        return await this.act(this.requireId(args), 'wake')
      case 'review':
        return await this.act(this.requireId(args), 'review')
      case 'review_cancel':
        return await this.act(this.requireId(args), 'review_cancel')
      case 'regenerate':
        return await this.act(this.requireId(args), 'regenerate', undefined, typeof args.note === 'string' ? args.note : '')
      case 'probe': {
        const probe = await this.transportFor().probe()
        return {
          channel: this.config.channel,
          probe: {
            ...probe,
            ...(this.config.channel === 'api'
              ? { baseUrl: this.config.image.baseUrl, format: this.config.image.format, editMode: this.config.image.editMode }
              : {}),
          },
        }
      }
      case 'login':
        if (this.config.channel === 'api') {
          return {
            login: {
              ok: true,
              channel: 'api',
              note: 'API 通道不需要登录；用 probe 检查 imageBaseUrl / imageApiKey / imageModel。',
            },
          }
        }
        return { login: await (this.transportFor() as ChatGptWebTransport).login() }
      default:
        throw new Error('action must be start, continue, status, list, resume, cancel, human_check, accept, review, review_cancel, wake, regenerate, probe or login')
    }
  }

  private withSources(cwd: string, refs: MaterialRef[]): MaterialRef[] {
    return refs.map(ref => ({
      ...ref,
      source: isAbsolute(ref.path) ? ref.path : resolve(cwd, ref.path),
    }))
  }

  autoStartEnabled(): boolean {
    return this.config.autoStart
  }

  private assertTextSafe(label: string, value: string): void {
    const secret = findSecret(value)
    if (secret !== undefined) {
      throw new Error(`${label} contains a ${secret}; remove it before sending`)
    }
  }

  private judgeEnabled(): boolean {
    return this.judgeRoute() !== undefined
  }

  private withDesignCount(brief: string, designs: number): string {
    if (this.spec.topicType !== 'design') return brief
    const count = Number.isInteger(designs) && designs >= 1 && designs <= 6 ? designs : this.config.designs
    const delivery = this.config.channel === 'api'
      ? `本轮由 API 生成 ${count} 张图，每个方向独立成图；HTML demo 不在此通道产出。`
      : `请生成 ${count} 个可区分的设计方向，每个方向单独一张图；需要前端时给一个可运行的单文件 HTML demo。`
    return `${brief}\n\n## 出图数量\n\n${delivery}`
  }

  private async start(args: Record<string, unknown>, cwd: string, sessionId?: string): Promise<Record<string, unknown>> {
    if (this.config.channel === 'api') assertImageApiConfig(this.config.image, { requireKey: true })
    const title = this.requireString(args, 'title')
    const question = this.requireString(args, 'question')
    const brief = this.requireString(args, 'brief')
    const designs = typeof args.designs === 'number' ? args.designs : this.config.designs
    if (!Number.isInteger(designs) || designs < 1 || designs > 6) {
      throw new Error('designs must be an integer between 1 and 6')
    }
    const criteria = this.stringArray(args.criteria, 'criteria')
    const materialPaths = args.materials === undefined || args.materials === null
      || (Array.isArray(args.materials) && args.materials.length === 0)
      ? []
      : this.stringArray(args.materials, 'materials')
    const reasons = (args.materialReasons ?? {}) as Record<string, string>
    this.assertTextSafe('title', title)
    this.assertTextSafe('question', question)
    this.assertTextSafe('brief', brief)
    for (const criterion of criteria) this.assertTextSafe('criteria', criterion)
    for (const [path, reason] of Object.entries(reasons)) {
      if (typeof reason === 'string') this.assertTextSafe(`material reason for ${path}`, reason)
    }
    const refs = this.withSources(cwd, await buildManifest(cwd, materialPaths, reasons, this.config.secretGlobs))
    assertMaterialLimits(refs, this.config.maxFiles, this.config.maxTotalMB)
    // A billable API round is not repeated by default: without an automatic
    // judge, round 2 would just buy another three images.
    const defaultRounds = this.config.channel === 'api' ? 1 : this.config.rounds
    const card: ResearchCard = {
      title,
      type: this.spec.topicType,
      question,
      successCriteria: criteria,
      brief: this.withDesignCount(brief, designs),
      materials: refs,
      rounds: typeof args.rounds === 'number' ? args.rounds : defaultRounds,
      ...(this.spec.topicType === 'design' ? { designs } : {}),
      store: this.config.store,
      model: this.config.channel === 'api' ? this.config.image.model : this.config.model,
      ...(typeof args.parent === 'string' && args.parent !== '' ? { parent: args.parent } : {}),
    }
    const engine = this.engineFor(cwd)
    const topic = await engine.start(card)
    await this.record(topic, this.rootFor(cwd), sessionId)
    return this.view(topic)
  }

  private requireString(args: Record<string, unknown>, key: string): string {
    const value = args[key]
    if (typeof value !== 'string' || value.trim() === '') throw new Error(`${key} is required`)
    return value
  }

  private requireId(args: Record<string, unknown>): string {
    const value = args.topic_id ?? args.topicId
    if (typeof value !== 'string' || value.trim() === '') throw new Error('topic_id is required')
    return value
  }

  private stringArray(value: unknown, key: string): string[] {
    if (!Array.isArray(value) || value.length === 0) throw new Error(`${key} must be a non-empty array`)
    const items = value.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
    if (items.length !== value.length) throw new Error(`${key} must contain non-empty strings`)
    return items
  }

  private view(topic: Topic): Record<string, unknown> {
    return {
      topic_id: topic.id,
      title: topic.title,
      type: topic.type,
      status: topic.status,
      channel: topic.channel,
      model: topic.model,
      judge_enabled: this.judgeEnabled(),
      created: topic.created,
      generations: topic.generations ?? [],
      stall_reason: topic.stallReason ?? null,
      rounds: topic.rounds.length,
      rounds_cap: topic.roundsCap,
      designs: topic.designs ?? null,
      stop_reason: topic.stopReason ?? null,
      review_from: topic.reviewFrom ?? null,
      artifacts: topic.artifacts,
      updated: topic.updated,
    }
  }

  /**
   * On plugin startup, adopt rounds that were already sent before a restart.
   * The prompt marker in the stored conversation is the proof; anything that
   * cannot be proven is parked as unknown_submission instead of being resent.
   * The api channel has no page to reattach: its in-flight requests die with
   * the host, so those rounds are parked for a human instead of retried.
   */
  async recoverActive(): Promise<void> {
    const active = new Set(['queued', 'uploading', 'submitted', 'waiting', 'answered', 'adjudicating'])
    const entries = await this.knownEntries()
    for (const entry of entries) {
      try {
        const store = this.storeAt(entry.root, entry.mode)
        const topic = await store.load(entry.id).catch(() => undefined)
        if (topic === undefined) continue
        const engine = this.engineFor(entry.root, entry.mode)
        const recordedChannel: Channel = topic.channel === 'api' ? 'api' : 'web'
        if (recordedChannel !== this.config.channel) {
          if (topic.status === 'reviewing') await engine.cancelReview(entry.id)
          if (active.has(topic.status)) {
            await engine.interrupt(entry.id, `这条记录来自 ${recordedChannel} 通道，当前配置为 ${this.config.channel}；已停止自动恢复，请核对后重新发起`)
            await this.notifyStalled(entry.id, 'unknown_submission')
          }
          continue
        }
        if (this.config.channel === 'api') {
          if (topic.status === 'reviewing') await engine.cancelReview(entry.id)
          if (active.has(topic.status)) {
            await engine.interrupt(entry.id, 'API 生图请求在 DSH 重启后已丢失，本轮不会自动重发；已生成的图片见 artifacts，确认后可重新发起或取消')
            await this.notifyStalled(entry.id, 'unknown_submission')
          }
          continue
        }
        if (topic.status === 'waiting' || topic.status === 'submitted') {
          try {
            await engine.reattach(entry.id)
            const recovered = await store.load(entry.id)
            if (recovered.status === 'stalled') await this.notifyStalled(entry.id, recovered.stallReason)
          } catch (error) {
            await engine.interrupt(entry.id, `恢复失败：${error instanceof Error ? error.message : String(error)}`)
            await this.notifyStalled(entry.id, 'unknown_submission')
          }
        } else if (topic.status === 'draft') {
          await engine.interrupt(entry.id, 'DSH 在启动阶段中断；已转入人工核对')
          await this.notifyStalled(entry.id, 'unknown_submission')
        } else if (topic.status === 'reviewing') {
          await engine.cancelReview(entry.id)
        } else if (active.has(topic.status)) {
          await engine.interrupt(entry.id, 'DSH 重启时任务尚未完成；已停止自动重发，请核对后恢复')
          await this.notifyStalled(entry.id, 'unknown_submission')
        } else if (topic.status === 'failed' || topic.status === 'stalled') {
          const reason = topic.stopReason ?? ''
          const pageClosed = /target page|browser has been closed|page.*closed/i.test(reason)
          const recoverable = pageClosed || topic.stallReason === 'ui' || topic.stallReason === 'unknown_submission'
          const fresh = Date.now() - Date.parse(topic.updated) < 24 * 60 * 60 * 1000
          const hasSubmission = topic.rounds.some(round => round.submissionId !== undefined)
          if (recoverable && fresh && hasSubmission) {
            try {
              await engine.resume(entry.id)
            } catch (error) {
              await engine.interrupt(entry.id, `自动恢复失败：${error instanceof Error ? error.message : String(error)}`)
            }
          }
        }
      } catch {
        // A stale registry entry or a recovered page must not take the host down.
      }
    }
  }

  dispose(): void {
    this.imageTransport?.dispose()
    this.imageTransport = undefined
    this.shared?.release()
    this.shared = undefined
    this.transport = undefined
  }
}

function registerSkill(ctx: ServiceContext, spec: PluginSpec): void {
  const skills = ctx.get('skills') as SkillsService | undefined
  if (skills === undefined) return
  const root = fileURLToPath(new URL('../resources/skills', import.meta.url))
  const byName = new Map(spec.skills.map(skill => [skill.name, skill]))
  skills.registerProvider(() => ({
    name: spec.name,
    list: async () => spec.skills.map(skill => {
      const path = join(root, skill.dir, 'SKILL.md')
      return {
        name: skill.name,
        description: skill.description,
        rank: 350,
        source: spec.name,
        provider: spec.name,
        invocation: { modelInvocable: true, userInvocable: true },
        locator: { name: skill.name, path },
        path,
        resourceBase: { kind: 'directory', path: join(root, skill.dir) },
      }
    }),
    get: async (candidate: unknown) => {
      const name = (candidate as { name?: unknown }).name
      const skill = typeof name === 'string' ? byName.get(name as never) : undefined
      if (skill === undefined) return undefined
      const path = join(root, skill.dir, 'SKILL.md')
      return {
        name: skill.name,
        description: skill.description,
        content: await readFile(path, 'utf8'),
        path,
        resourceBase: { kind: 'directory', path: join(root, skill.dir) },
        invocation: { modelInvocable: true, userInvocable: true },
        source: spec.name,
        provider: spec.name,
      }
    },
  }))
}

interface HttpRequest {
  url?: string
  method?: string
  headers: Record<string, string | string[] | undefined>
  [Symbol.asyncIterator](): AsyncIterator<string | Uint8Array>
}

interface HttpResponse {
  statusCode: number
  headersSent?: boolean
  writeHead(status: number, headers?: Record<string, string>): void
  write(chunk: string | Uint8Array): boolean
  end(body?: string | Uint8Array): void
}

function sendJson(res: HttpResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}

async function readJsonBody(req: HttpRequest): Promise<Record<string, unknown>> {
  let body = ''
  for await (const chunk of req) {
    body += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
  }
  if (body.trim() === '') return {}
  return JSON.parse(body) as Record<string, unknown>
}

function registerRoutes(scoped: Context, service: ProResearchService, spec: PluginSpec): void {
  const webServer = (scoped as unknown as {
    webServer?: { register(route: { kind: 'exact' | 'prefix'; path: string; handler: (req: HttpRequest, res: HttpResponse) => void | Promise<void> }): () => void }
  }).webServer
  if (webServer === undefined) return
  const connection = (scoped.get('connection') ?? undefined) as
    | { requestRejection?(req: HttpRequest): 401 | 403 | undefined }
    | undefined
  const reject = (req: HttpRequest): 401 | 403 | undefined => connection?.requestRejection?.(req)

  scoped.effect(() => webServer.register({
    kind: 'exact',
    path: `${spec.routes}/topics`,
    handler: async (req, res) => {
      const denied = reject(req)
      if (denied !== undefined) return sendJson(res, denied, { error: 'unauthorized' })
      try {
        sendJson(res, 200, { topics: await service.listAll() })
      } catch (error) {
        sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  }), `${spec.name}: topics route`)

  scoped.effect(() => webServer.register({
    kind: 'exact',
    path: `${spec.routes}/topic`,
    handler: async (req, res) => {
      const denied = reject(req)
      if (denied !== undefined) return sendJson(res, denied, { error: 'unauthorized' })
      const url = new URL(req.url ?? '/', 'http://localhost')
      const id = url.searchParams.get('id') ?? ''
      try {
        const topic = await service.detail(id)
        if (topic === undefined) return sendJson(res, 404, { error: 'unknown topic' })
        sendJson(res, 200, { topic })
      } catch (error) {
        sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  }), `${spec.name}: topic route`)

  scoped.effect(() => webServer.register({
    kind: 'exact',
    path: `${spec.routes}/action`,
    handler: async (req, res) => {
      const denied = reject(req)
      if (denied !== undefined) return sendJson(res, denied, { error: 'unauthorized' })
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
      try {
        const body = await readJsonBody(req)
        const id = typeof body.topic_id === 'string' ? body.topic_id : ''
        const action = typeof body.action === 'string' ? body.action : ''
        const conclusion = body.conclusion === 'submitted' || body.conclusion === 'not_submitted' || body.conclusion === 'reopen'
          ? body.conclusion
          : undefined
        const note = typeof body.note === 'string' ? body.note : undefined
        if (action === 'probe' || action === 'login') {
          sendJson(res, 200, await service.handle({ action }, { agent: undefined } as never))
          return
        }
        sendJson(res, 200, { topic: await service.act(id, action, conclusion, note) })
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  }), `${spec.name}: action route`)

  scoped.effect(() => webServer.register({
    kind: 'exact',
    path: `${spec.routes}/asset`,
    handler: async (req, res) => {
      const denied = reject(req)
      if (denied !== undefined) return sendJson(res, denied, { error: 'unauthorized' })
      const url = new URL(req.url ?? '/', 'http://localhost')
      const id = url.searchParams.get('id') ?? ''
      const path = url.searchParams.get('path') ?? ''
      try {
        const asset = await service.readArtifact(id, path)
        const headers: Record<string, string> = {
          'content-type': asset.mime,
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        }
        if (asset.mime.startsWith('text/html')) headers['content-security-policy'] = 'sandbox allow-scripts'
        res.writeHead(200, headers)
        res.end(asset.bytes)
      } catch {
        sendJson(res, 404, { error: 'unknown artifact' })
      }
    },
  }), `${spec.name}: asset route`)

  scoped.effect(() => webServer.register({
    kind: 'prefix',
    path: `${spec.routes}/raw`,
    handler: async (req, res) => {
      const denied = reject(req)
      if (denied !== undefined) return sendJson(res, denied, { error: 'unauthorized' })
      const url = new URL(req.url ?? '/', 'http://localhost')
      const rest = url.pathname.slice(`${spec.routes}/raw`.length).replace(/^\/+/, '')
      const slash = rest.indexOf('/')
      if (slash <= 0) return sendJson(res, 404, { error: 'unknown artifact' })
      try {
        const id = decodeURIComponent(rest.slice(0, slash))
        const relativePath = decodeURIComponent(rest.slice(slash + 1))
        const asset = await service.readArtifact(id, relativePath)
        const headers: Record<string, string> = {
          'content-type': asset.mime,
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        }
        if (asset.mime.startsWith('text/html')) headers['content-security-policy'] = 'sandbox allow-scripts'
        res.writeHead(200, headers)
        res.end(asset.bytes)
      } catch {
        sendJson(res, 404, { error: 'unknown artifact' })
      }
    },
  }), `${spec.name}: raw artifact route`)

  scoped.effect(() => webServer.register({
    kind: 'exact',
    path: `${spec.routes}/bundle`,
    handler: async (req, res) => {
      const denied = reject(req)
      if (denied !== undefined) return sendJson(res, denied, { error: 'unauthorized' })
      const url = new URL(req.url ?? '/', 'http://localhost')
      const id = url.searchParams.get('id') ?? ''
      const round = Number(url.searchParams.get('round') ?? '0')
      try {
        const bundle = await service.bundleArtifacts(id, round)
        res.writeHead(200, {
          'content-type': 'application/zip',
          'content-disposition': `attachment; filename="${bundle.name}"`,
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        })
        res.end(bundle.bytes)
      } catch (error) {
        sendJson(res, 404, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  }), `${spec.name}: bundle route`)

  scoped.effect(() => webServer.register({
    kind: 'exact',
    path: `${spec.routes}/answer`,
    handler: async (req, res) => {
      const denied = reject(req)
      if (denied !== undefined) return sendJson(res, denied, { error: 'unauthorized' })
      const url = new URL(req.url ?? '/', 'http://localhost')
      const id = url.searchParams.get('id') ?? ''
      const round = Number(url.searchParams.get('round') ?? '0')
      try {
        const text = await service.answerText(id, round)
        if (text === undefined) return sendJson(res, 404, { error: 'answer not found' })
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
        res.end(text)
      } catch (error) {
        sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  }), `${spec.name}: answer route`)

  scoped.effect(() => webServer.register({
    kind: 'exact',
    path: `${spec.routes}/file`,
    handler: async (req, res) => {
      const denied = reject(req)
      if (denied !== undefined) return sendJson(res, denied, { error: 'unauthorized' })
      const url = new URL(req.url ?? '/', 'http://localhost')
      const id = url.searchParams.get('id') ?? ''
      const path = url.searchParams.get('path') ?? ''
      try {
        const file = await service.topicText(id, path)
        res.writeHead(200, {
          'content-type': file.mime.includes('charset=') ? file.mime : `${file.mime}; charset=utf-8`,
          'cache-control': 'no-store',
        })
        res.end(file.text)
      } catch {
        sendJson(res, 404, { error: 'unknown file' })
      }
    },
  }), `${spec.name}: file route`)

  scoped.effect(() => webServer.register({
    kind: 'exact',
    path: `${spec.routes}/open`,
    handler: async (req, res) => {
      const denied = reject(req)
      if (denied !== undefined) return sendJson(res, denied, { error: 'unauthorized' })
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
      try {
        const body = await readJsonBody(req)
        const id = typeof body.topic_id === 'string' ? body.topic_id : ''
        const relativePath = typeof body.path === 'string' ? body.path : ''
        if (body.reveal === false) await service.openFile(id, relativePath)
        else await service.revealFile(id, relativePath)
        sendJson(res, 200, { ok: true })
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  }), `${spec.name}: open route`)
}

function toolDescription(spec: PluginSpec, config: ProConfig): string {
  if (spec.topicType === 'design') {
    if (config.channel === 'api') {
      return [
        `用 OpenAI 兼容生图 API（${config.image.model}）按方向生成设计图，保存到本地并出现在设计面板；此通道只出图，不产出 HTML demo。`,
        'start 前必须先展示设计卡（目标、成功判据、材料、轮次、产物路径、模型）；用户确认后传 confirmed=true。',
        'key 只读插件设置或环境变量 GPT_IMAGE_API_KEY，不要在会话里回显；probe 检查 base URL / key / 模型名。',
        'action: start | continue | status | list | resume | cancel | human_check | accept | review | review_cancel | wake | regenerate | probe | login。',
      ].join(' ')
    }
    return [
      '用 ChatGPT Pro 网页会话生成设计图与前端代码/HTML demo，产物保存到本地并出现在设计面板。',
      'start 前必须先展示设计卡（目标、成功判据、材料、轮次、产物路径）；用户确认后传 confirmed=true。',
      'action: start | continue | status | list | resume | cancel | human_check | accept | review | review_cancel | wake | regenerate | probe | login。',
    ].join(' ')
  }
  return [
    '用 ChatGPT Pro 网页会话做无人值守的多轮调研。',
    'start 前必须先向用户展示研究卡（问题、成功判据、材料、轮次上限、产物路径）；用户确认后传 confirmed=true。',
    'action: start | continue | status | list | resume | cancel | human_check | accept | review | review_cancel | wake | regenerate | probe | login。',
  ].join(' ')
}

export function createPlugin(spec: PluginSpec): (ctx: Context, config?: ResearchConfig) => void {
  return (ctx: Context, config?: ResearchConfig): void => {
    const resolved = resolvePluginConfig(spec, config)
    const service = new ProResearchService(ctx as ServiceContext, resolved, homeDir(), spec)
    ctx.effect(() => () => service.dispose(), `${spec.name}: close browser`)
    ctx.effect(() => {
      const timer = setTimeout(() => { void service.recoverActive() }, 2_500)
      timer.unref?.()
      return () => clearTimeout(timer)
    }, `${spec.name}: recover interrupted rounds`)
    registerSkill(ctx as ServiceContext, spec)
    ;(ctx as ServiceContext).inject(['agents'], scoped => {
      const factory = scoped.get('agents') as AgentFactory | undefined
      if (factory !== undefined) service.useAgentFactory(factory)
    })
    ;(ctx as ServiceContext).inject(['sessionController'], scoped => {
      const controller = scoped.get('sessionController') as SessionController | undefined
      if (controller !== undefined) service.useSessionController(controller)
    })
    ;(ctx as ServiceContext).inject(['agentDefaultModel'], scoped => {
      const model = scoped.get('agentDefaultModel') as AgentDefaultModel | undefined
      if (model !== undefined) service.useDefaultModel(model)
    })
    ;(ctx as ServiceContext).inject(['webServer'], scoped => registerRoutes(scoped, service, spec))
  ;(ctx as ServiceContext).tools.register(defineTool({
    name: spec.tool,
    description: toolDescription(spec, resolved),
    parameters: {
      action: { type: 'string', required: true, description: 'start|continue|status|list|resume|cancel|human_check|accept|review|review_cancel|wake|regenerate|probe|login' },
      title: { type: 'string', description: '主题标题（start 必填）' },
      question: { type: 'string', description: '研究问题（start 必填）' },
      brief: { type: 'string', description: '发给 Pro 的完整 brief（start 必填）' },
      criteria: { type: 'array', items: { type: 'string' }, description: '成功判据（start 必填）' },
      materials: { type: 'array', items: { type: 'string' }, description: '相对工作目录的材料路径（start 可选）' },
      materialReasons: { type: 'object', additionalProperties: true, description: '可选：材料路径 → 选择理由' },
      rounds: { type: 'number', description: '本次轮次上限（1–10）' },
      designs: { type: 'number', description: '设计插件本轮生成的方向/图片数（1–6，默认取设置）' },
      topic_id: { type: 'string', description: 'status/continue/resume/cancel/human_check/accept/review/wake/regenerate 的主题 id' },
      parent: { type: 'string', description: '可选：父主题 id，用于把 follow-up 串成同一棵树' },
      conclusion: { type: 'string', description: 'human_check 结论：submitted|not_submitted|reopen' },
      note: { type: 'string', description: 'human_check 依据；regenerate 时作为不满意点/新要求' },
      confirmed: { type: 'boolean', description: '用户已确认研究卡' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
      },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    execute: async (args: Record<string, unknown>, exec: ToolRunContext) => {
      const writeAction = args.action === 'start'
        || args.action === 'continue'
        || args.action === 'regenerate'
        || args.action === 'accept'
      const autoStart = args.action === 'start' && service.autoStartEnabled()
      if (writeAction && args.confirmed !== true && !autoStart) {
        throw new Error('start, continue, regenerate and accept require confirmed=true after the user has seen the card')
      }
      return (await service.handle(args, exec)) as never
    },
  }))
  }
}
