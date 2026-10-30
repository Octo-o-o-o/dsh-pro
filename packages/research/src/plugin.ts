import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
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
  baseImageMaterial,
  FileSizeLimitError,
  readContainedFile,
  readContainedPrefix,
  resolveContainedPath,
  readReportInfo,
  defaultConfig,
  findSecret,
  isHtmlSource,
  type Channel,
  type ImageApiConfig,
  type ImageFormat,
  type Judge,
  type JudgeCriterion,
  type JudgeResult,
  type MaterialRef,
  type ProConfig,
  type ResearchCard,
  type Topic,
  type Transport,
} from '@dsh-pro/core'
import { OpenAIImageTransport, acquireSharedTransport } from '@dsh-pro/transport'
import type { ChatGptWebTransport, SharedTransport } from '@dsh-pro/transport'
import { previewHtml } from './preview.ts'

export interface PluginSpec {
  name: string
  tool: string
  routes: string
  topicType: 'research' | 'design'
  homeSubdir: string
  storeSubdir: 'research' | 'design'
  skills: ReadonlyArray<{ name: string; dir: string; description: string }>
}

const MAX_ARTIFACT_BYTES = 100 * 1024 * 1024
const MAX_PREVIEW_BYTES = 2_000_000

const baseFields = {
  rounds: z.number().step(1).min(1).max(10).default(3).description('每主题默认轮次上限（1–10）。'),
  designs: z.number().step(1).min(1).max(6).default(3).description('设计插件每轮生成的方向/图片数（1–6）。'),
  model: z.string().default('prefer-pro').description('ChatGPT 网页模型：prefer-pro（默认，优先 Pro，不可用则沿用页面当前模型）；auto 保留当前模型；pro、thinking 等指定模型须可用。'),
  store: z.string().default('project').description('研究记录位置：project（仓库 docs/research）或 local（DSH 本机）。'),
  autoStart: z.boolean().default(false).description('研究卡是否跳过点击直接开跑。'),
  autoReview: z.boolean().default(true).description('capped 后唤醒原会话检查产物，决定接受或继续；无原会话时只显示待接受。'),
  notify: z.string().default('stall-only').description('通知策略：stall-only 只在卡住时提醒，all 完成也提醒。'),
  stallMinutes: z.number().step(1).min(1).default(45).description('无进展判定分钟数；生成中不计时。'),
  maxRoundMinutes: z.number().step(1).min(1).default(90).description('单轮墙钟上限（分钟）。'),
  maxFiles: z.number().step(1).min(1).default(12).description('单轮附件数量上限。'),
  maxTotalMB: z.number().default(24).description('单轮附件总大小（MB）。'),
  rawAnswers: z.string().default('local').description('原始答复保存位置：local（本机目录）或 repo（随项目）。公开仓库请用 local。'),
  rawAnswersDir: z.string().default('').description('local 模式的原文目录；留空用 ~/.dsh/<插件目录>/raw（研究为 chatgpt-pro-research，设计为 gpt-image-design）。'),
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

/**
 * OS opener for one validated file, without a shell. `cmd.exe /c start` was
 * unsafe here: a file name containing `&` could split the command even though
 * the path was lexically inside the topic directory.
 */
export function externalOpenCommand(
  platform: NodeJS.Platform,
  target: string,
): { command: string; args: string[] } {
  if (platform === 'win32') return { command: 'explorer.exe', args: [target] }
  if (platform === 'darwin') return { command: 'open', args: [target] }
  return { command: 'xdg-open', args: [target] }
}

/** Reveal (highlight) one file in the OS file manager. */
export function externalRevealCommand(
  platform: NodeJS.Platform,
  target: string,
): { command: string; args: string[] } {
  // Explorer expects `/select,<path>` as a single argument; splitting it into
  // two arguments is silently ignored on current Windows builds.
  if (platform === 'win32') return { command: 'explorer.exe', args: [`/select,${target}`] }
  if (platform === 'darwin') return { command: 'open', args: ['-R', target] }
  return { command: 'xdg-open', args: [dirname(target)] }
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

/**
 * Settings arrive from a loader-validated form, but a hand-edited config file
 * can still carry garbage. Clamp instead of throwing: one typo must not take
 * the whole plugin down, and the engine needs sane stall/round numbers.
 */
function clampInt(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value) || value < min) return fallback
  return Math.min(max, Math.round(value))
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
  merged.rounds = clampInt(merged.rounds, 1, 10, base.rounds)
  merged.designs = clampInt(merged.designs, 1, 6, base.designs)
  merged.stallMinutes = clampInt(merged.stallMinutes, 1, 7 * 24 * 60, base.stallMinutes)
  merged.maxRoundMinutes = Math.max(
    clampInt(merged.maxRoundMinutes, 1, 30 * 24 * 60, base.maxRoundMinutes),
    merged.stallMinutes,
  )
  merged.maxFiles = clampInt(merged.maxFiles, 1, 100, base.maxFiles)
  if (!Number.isFinite(merged.maxTotalMB) || merged.maxTotalMB <= 0) merged.maxTotalMB = base.maxTotalMB
  return merged
}

const JUDGE_SYSTEM = [
  '你是研究任务的验收裁判。只输出一个 JSON 对象，不要 Markdown 围栏。',
  '字段：verdict（accepted|partial|rejected）、reason（一句话）、done（是否已满足全部成功判据）、',
  'summary（不超过 200 字的中文结论摘要）、nextBrief（未完成时下一轮要问什么，已完成可省略）、',
  'criteria（数组：每个成功判据一项，字段 criterion、status=met|partial|unmet|unknown、evidence 一句话引用答复中的依据）。',
  '成功判据以 JSON 字符串数组提供。输出 criteria 必须与该数组长度、顺序相同，criterion 必须逐字复制对应原文；禁止拆分、合并、改写或新增判据。',
  '一条复合判据即使包含多个要求也只输出一项；所有要求均有依据才能 met，否则 partial/unmet/unknown，并在 evidence 中说明已满足和缺失的部分。',
  '必须逐条判断所有成功判据；done 只有在 verdict=accepted 且全部判据 status=met 时才为 true。',
  '文件存在或文本声称已验证不能替代实际图片视觉与 HTML 交互证据；没有此类证据时不能把相关要求判为 met。',
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
  const criteria = Array.isArray(parsed.criteria)
    ? parsed.criteria.flatMap(item => {
      if (item === null || typeof item !== 'object') return []
      const row = item as Record<string, unknown>
      if (typeof row.criterion !== 'string' || row.criterion.trim() === '') return []
      const status = row.status === 'met' || row.status === 'partial' || row.status === 'unmet' || row.status === 'unknown'
        ? row.status
        : 'unknown'
      return [{
        criterion: row.criterion,
        status,
        ...(typeof row.evidence === 'string' && row.evidence.trim() !== '' ? { evidence: row.evidence } : {}),
      }] as JudgeCriterion[]
    })
    : undefined
  return {
    verdict,
    reason: typeof parsed.reason === 'string' ? parsed.reason : '',
    // The engine checks completion claims against the original criteria.
    done: parsed.done === true,
    summary: typeof parsed.summary === 'string' ? parsed.summary : '',
    ...(criteria !== undefined && criteria.length > 0 ? { criteria } : {}),
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
      let finished = false
      const user = [
        `主题：${input.topic.title}`,
        `成功判据（原文 JSON 数组，不可拆分）：\n${JSON.stringify(input.criteria)}`,
        `本轮问题：\n${input.question ?? '（未记录）'}`,
        `本轮答复：\n${input.answer.slice(0, 30_000)}`,
        `已保存产物（文件存在不代表视觉或交互验收通过；不要因答复无文字而否认已保存图片）：\n${input.topic.rounds.flatMap(round => (round.artifacts ?? []).map(path => `- 第 ${round.n} 轮：${path}`)).join('\n') || '（无）'}`,
      ].join('\n\n')
      const sessionId = this.topicSessions.get(input.topic.id) ?? (await this.entryFor(input.topic.id))?.sessionId ?? input.topic.id
      for await (const chunk of llm.stream({
        provider: route.provider,
        model: route.model,
        sessionId,
        system: JUDGE_SYSTEM,
        messages: [createUserMessage({
          content: [{ type: 'text', text: user }],
          source: { kind: this.spec.name } as never,
        })],
        // Reasoning and JSON share the output budget on supported providers.
        // 1,800 tokens truncated real DeepSeek judgments before a complete JSON.
        maxTokens: 8_192,
        ...(route.reasoningEffort ? { reasoningEffort: route.reasoningEffort } : {}),
        signal: input.signal === undefined ? AbortSignal.timeout(180_000) : AbortSignal.any([input.signal, AbortSignal.timeout(180_000)]),
      })) {
        assembler.push(chunk as never)
        if ((chunk as { type?: string }).type === 'finish') finished = true
      }
      if (assembler.finish.kind === 'error' || assembler.finish.kind === 'aborted') throw new Error(`裁决服务失败：${assembler.finish.failure.message}`)
      const blocks = assembler.blocks()
      const text = blocks.map(block => (block.type === 'text' ? block.text : '')).join('')
      const reasoningChars = blocks.reduce((total, block) => total + (block.type === 'reasoning' ? block.text.length : 0), 0)
      // Persist only counts and termination state, never raw reasoning/output.
      const diagnostic = `finish=${finished ? assembler.finish.kind : 'missing'}; textChars=${text.length}; reasoningChars=${reasoningChars}`
      if (!finished || assembler.finish.kind !== 'stop') {
        throw new Error(`裁决未正常完成（${diagnostic}）；答复已保留，可检查裁决模型后重试`)
      }
      try {
        return parseJudge(text)
      } catch {
        throw new Error(`裁决返回无效 JSON 或结构（${diagnostic}）；答复已保留，可检查裁决模型后重试`)
      }
    }
  }

  private judgeRoute(): { provider: string; model: string; reasoningEffort?: string; source: 'configured' | 'default' } | undefined {
    const provider = this.config.judgeProvider.trim()
    const model = this.config.judgeModel.trim()
    if (provider.toLowerCase() === 'off') return undefined
    if (provider !== '' && model !== '') return { provider, model, source: 'configured' }
    try {
      const model = this.defaultModel ?? this.ctx.get('agentDefaultModel') as AgentDefaultModel | undefined
      const selection = model?.currentSelection()
      if (selection?.provider !== undefined && selection.provider !== '' && selection.model !== undefined && selection.model !== '') {
        return { provider: selection.provider, model: selection.model, reasoningEffort: selection.reasoningEffort, source: 'default' }
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
      onError: error => {
        this.log(`topic run failed inside failure handling: ${error instanceof Error ? error.message : String(error)}`)
      },
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
        if (event.type === 'judge_failed') {
          void this.notifyJudgeFailed(event.topicId, event.round, event.message)
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

  /**
   * Loud, one-line signal when the host provides no connection guard. Routes
   * are not registered in that case: an unauthenticated artifact/action
   * surface is worse than a missing panel.
   */
  noteMissingConnectionGuard(): void {
    this.log(`${this.spec.name}: connection service unavailable; HTTP routes were not registered (no host auth guard)`)
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
      // The store map key is `${mode}:${root}`; carrying the pair forward keeps
      // the engine bound to the SAME root/mode as the store that owns the
      // topic (a bare engineFor(cwd) would run actions against the wrong root).
      for (const [key, candidate] of this.stores.entries()) {
        try {
          const topic = await candidate.load(topicId)
          const separator = key.indexOf(':')
          const mode = key.slice(0, separator) === 'local' ? 'local' : 'project'
          const root = key.slice(separator + 1)
          return { store: candidate, engine: this.engineFor(root, mode), topic }
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
    // Same Windows retry as store.atomic(): a reader holding the old file makes
    // rename report EPERM/EACCES/EBUSY instead of waiting.
    for (let attempt = 1; ; attempt += 1) {
      try {
        await rename(temp, this.registryFile)
        return
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        const retriable = code === 'EPERM' || code === 'EACCES' || code === 'EBUSY'
        if (!retriable || attempt >= 8) throw error
        await new Promise(resolve => setTimeout(resolve, 10 * attempt))
      }
    }
  }

  private async record(topic: Topic, root: string, sessionId?: string, mode = this.config.store): Promise<void> {
    if (sessionId !== undefined && sessionId !== '') this.topicSessions.set(topic.id, sessionId)
    const job = async (): Promise<void> => {
      const entries = (await this.readRegistry()).filter(entry => entry.id !== topic.id)
      entries.push({
        id: topic.id,
        root,
        mode,
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
   * Write scan-discovered topics back into the registry; otherwise a lost
   * registry hides interrupted topics from the sidebar forever. Existing
   * entries keep their recorded sessionId. The chain job re-reads the file so
   * concurrent record() calls cannot be overwritten.
   */
  private async mergeRegistry(discovered: RegistryEntry[]): Promise<void> {
    const job = async (): Promise<void> => {
      const entries = await this.readRegistry()
      const known = new Set(entries.map(entry => entry.id))
      const additions = discovered.filter(entry => !known.has(entry.id))
      if (additions.length === 0) return
      await this.writeRegistry([...entries, ...additions])
    }
    const next = this.registryChain.then(job, job)
    this.registryChain = next.catch(() => undefined)
    await next
  }

  /** Remove one registry entry; callers delete the topic directory FIRST so a rescan cannot resurrect it. */
  private async removeFromRegistry(id: string): Promise<void> {
    const job = async (): Promise<void> => {
      await this.writeRegistry((await this.readRegistry()).filter(entry => entry.id !== id))
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

  /** Ask the originating agent to inspect a response whose automatic verdict failed. */
  private async notifyJudgeFailed(id: string, round: number, message: string): Promise<void> {
    try {
      const entry = await this.entryFor(id)
      const sessionId = entry?.sessionId ?? this.topicSessions.get(id)
      if (entry === undefined || sessionId === undefined) return
      const topic = entry === undefined ? undefined : await this.storeAt(entry.root, entry.mode).load(id).catch(() => undefined)
      if (topic === undefined) return
      const dir = await this.storeAt(entry.root, entry.mode).dirOf(id)
      const agent = this.liveAgent(sessionId)
      if (agent?.followup === undefined) return
      agent.followup(createUserMessage({
        content: [{
          type: 'text',
          text: `<system-reminder>Pro 主题「${topic.title}」已取回第 ${round} 轮答复，但自动裁决失败（${message}）。答复与产物已保留，主题停在“待判断”。
请宿主按成功判据人工裁决：
- 满足：${this.spec.tool} action=accept topic_id=${id} confirmed=true
- 需要改进：${this.spec.tool} action=regenerate topic_id=${id} confirmed=true note="具体问题"
- 只补充一轮：${this.spec.tool} action=continue topic_id=${id} confirmed=true brief="下一轮问题"
- 修复 judgeProvider / judgeModel 后：${this.spec.tool} action=resume topic_id=${id}
目录：${dir}
裁决占位：${join(dir, 'rounds', `${String(round).padStart(2, '0')}-verdict.md`)}</system-reminder>`,
        }],
        source: { kind: this.spec.name } as never,
      }))
    } catch {
      // Best-effort reminder; the sidebar and records remain the truth.
    }
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
      const state = topic.status === 'capped' ? '已结束本次运行' : topic.status === 'failed' ? '失败' : '停下等待核对'
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
          text: `<system-reminder>Pro 主题「${title}」已${status === 'completed' ? '完成' : status === 'capped' ? '停止并等待确认' : '取消'}。产物与最终汇总在侧边栏对应面板里。</system-reminder>`,
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
  private async notifyAccepted(id: string, topic: Topic, humanAccepted = true): Promise<{ ok: boolean; resumed?: boolean; reason?: string }> {
    try {
      const entry = await this.entryFor(id)
      const sessionId = entry?.sessionId ?? this.topicSessions.get(id)
      if (sessionId === undefined) return { ok: false, reason: '原会话 id 未记录' }
      const dir = await this.storeAt(entry?.root ?? this.rootFor(''), entry?.mode ?? this.config.store).dirOf(id)
      const outcome = humanAccepted
        ? `用户已接受「${topic.title}」的当前结果。`
        : `「${topic.title}」已通过自动文本裁决，尚不代表人工验收。请先核对结论与证据。`
      return await this.wakeSession(sessionId, `<system-reminder>${outcome}请在原有授权范围内继续后续工作，不要重复已经完成的研究/设计轮次。产物目录：${dir}，最终汇总：${join(dir, 'final.md')}。</system-reminder>`)
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
    const reportInfo = await readReportInfo(dir, topic)
    return {
      ...this.view(topic),
      root: entry.root,
      store: entry.mode,
      path: dir,
      report: reportInfo?.path ?? null,
      report_info: reportInfo,
      artifact_details: await this.artifactDetails(dir, topic),
      rounds_detail: topic.rounds,
    }
  }

  private async artifactDetails(dir: string, topic: Topic): Promise<Array<{ path: string; kind: 'image' | 'demo' | 'code' | 'archive' | 'file' }>> {
    const details: Array<{ path: string; kind: 'image' | 'demo' | 'code' | 'archive' | 'file' }> = []
    for (const path of topic.artifacts) {
      if (!path.replace(/\\/g, '/').startsWith('artifacts/')) continue
      try {
        await resolveContainedPath(dir, path)
      } catch {
        continue
      }
      const extension = extname(path).toLowerCase()
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
          const head = (await readContainedPrefix(dir, path, 512)).toString('utf8')
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

  /** Serve one artifact, enforcing both physical topic and artifact boundaries. */
  async readArtifact(id: string, relativePath: string): Promise<{ bytes: Buffer; mime: string }> {
    const entry = await this.entryFor(id)
    if (entry === undefined) throw new Error(`unknown topic: ${id}`)
    const store = this.storeAt(entry.root, entry.mode)
    const dir = await store.dirOf(id)
    const normalized = relativePath.replace(/\\/g, '/')
    if (!normalized.startsWith('artifacts/')) throw new Error('artifact path escapes the topic')
    const artifactsRoot = await resolveContainedPath(dir, 'artifacts')
    const bytes = await readContainedFile(artifactsRoot, normalized.slice('artifacts/'.length), MAX_ARTIFACT_BYTES)
    const textMime = mimeFor(relativePath)
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
    const bytes = await readContainedFile(dir, relativePath, MAX_PREVIEW_BYTES)
    return { text: bytes.toString('utf8'), mime: mimeFor(relativePath) }
  }

  /** Reveal a topic-relative file in the OS file manager. */
  async revealFile(id: string, relativePath: string): Promise<void> {
    const entry = await this.entryFor(id)
    if (entry === undefined) throw new Error(`unknown topic: ${id}`)
    const store = this.storeAt(entry.root, entry.mode)
    const dir = await store.dirOf(id)
    const target = await resolveContainedPath(dir, relativePath)
    const reveal = externalRevealCommand(process.platform, target)
    const child = spawn(reveal.command, reveal.args, { detached: true, stdio: 'ignore' })
    child.on('error', () => undefined)
    child.unref()
  }

  /** Open one topic file with the OS default application. */
  async openFile(id: string, relativePath: string): Promise<void> {
    const entry = await this.entryFor(id)
    if (entry === undefined) throw new Error(`unknown topic: ${id}`)
    const store = this.storeAt(entry.root, entry.mode)
    const dir = await store.dirOf(id)
    const target = await resolveContainedPath(dir, relativePath)
    const opener = externalOpenCommand(process.platform, target)
    const child = spawn(opener.command, opener.args, {
      detached: true,
      stdio: 'ignore',
      ...(process.platform === 'win32' ? { windowsHide: true } : {}),
    })
    child.on('error', () => undefined)
    child.unref()
  }

  async act(
    id: string,
    action: string,
    conclusion?: 'submitted' | 'not_submitted' | 'reopen',
    note?: string,
    materialPaths?: string[],
    extra?: { brief?: string; designs?: number; baseArtifact?: string },
  ): Promise<Record<string, unknown>> {
    const entry = await this.entryFor(id)
    if (entry === undefined) throw new Error(`unknown topic: ${id}`)
    const engine = this.engineFor(entry.root, entry.mode)
    if (action === 'continue') {
      // The panel's "continue one round" dialog posts here; the tool path has
      // its own handler. Keep both on one engine call so the resulting record
      // is identical no matter who started the follow-up.
      const brief = (extra?.brief ?? '').trim()
      if (brief === '') throw new Error('brief is required')
      this.assertTextSafe('brief', brief)
      const store = this.storeAt(entry.root, entry.mode)
      const topic = await store.load(id)
      let refs: MaterialRef[] | undefined
      const base = extra?.baseArtifact
      if (base !== undefined) {
        if (topic.channel === 'api' && this.config.image.editMode === 'off') {
          throw new Error('imageEdit=off：请启用参考图编辑后再以此图继续修改')
        }
        if ((materialPaths?.length ?? 0) > 0 || (extra?.designs !== undefined && extra.designs !== 1)) {
          throw new Error('以这张继续改仅使用所选底图，且本轮只生成一个结果')
        }
        refs = [await baseImageMaterial(await store.dirOf(id), topic, base)]
        assertMaterialLimits(refs, this.config.maxFiles, this.config.maxTotalMB)
      }
      if (materialPaths !== undefined && materialPaths.length > 0) {
        // Panel/route materials resolve against the topic's project root, not
        // the requesting session cwd, so a follow-up cannot silently attach a
        // different project's file with the same relative path.
        refs = this.withSources(entry.root, await buildManifest(entry.root, materialPaths, undefined, this.config.secretGlobs))
        assertMaterialLimits(refs, this.config.maxFiles, this.config.maxTotalMB)
      }
      const requestedDesigns = extra?.designs
      if (requestedDesigns !== undefined
        && (!Number.isInteger(requestedDesigns) || requestedDesigns < 1 || requestedDesigns > 6)) {
        throw new Error('designs must be an integer between 1 and 6')
      }
      const designs = topic.type === 'design'
        ? (base !== undefined ? 1 : requestedDesigns ?? topic.designs ?? this.config.designs)
        : undefined
      const editBrief = base === undefined ? brief : `以本轮附带的图片为唯一底图，保留用户未要求改变的部分。\n\n${brief}`
      const followUp = designs === undefined ? editBrief : this.withDesignCount(editBrief, designs)
      return this.view(await engine.continue(id, followUp, refs, designs, base))
    }
    if (action === 'resume') {
      // The engine probes the transport before refusing an api-channel resume,
      // so a still-live job recovers instead of hitting a blanket error.
      return this.view(await engine.resume(id))
    }
    if (action === 'cancel') return this.view(await engine.cancel(id))
    if (action === 'delete') {
      const store = this.storeAt(entry.root, entry.mode)
      const topic = await store.load(id)
      const deletable = topic.status === 'draft' || topic.status === 'completed' || topic.status === 'cancelled'
        || topic.status === 'capped' || topic.status === 'failed' || topic.status === 'stalled'
      if (!deletable) {
        throw new Error(`topic ${id} is ${topic.status}; only draft/capped/completed/failed/stalled/cancelled topics can be deleted${topic.status === 'reviewing' ? '；请先撤回判断请求' : ''}`)
      }
      // Directory first, registry second: a startup rescan would otherwise
      // resurrect a registry-less topic back into the sidebar.
      await store.remove(topic)
      await this.removeFromRegistry(id)
      this.topicSessions.delete(id)
      return { deleted: true, topic_id: id, title: topic.title }
    }
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
      const wake = await this.notifyAccepted(id, topic, topic.acceptedAt !== undefined)
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
      // Materials resolve against the topic's own project root, so the tool
      // path and the panel route agree on what a relative path means.
      let refs: MaterialRef[] | undefined
      if (materialPaths !== undefined && materialPaths.length > 0) {
        refs = this.withSources(entry.root, await buildManifest(entry.root, materialPaths, undefined, this.config.secretGlobs))
        assertMaterialLimits(refs, this.config.maxFiles, this.config.maxTotalMB)
      }
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
        refs,
      ))
    }
    throw new Error('action must be resume, cancel, delete, accept, review, review_cancel, wake, human_check or regenerate')
  }

  async handle(args: Record<string, unknown>, exec: ToolRunContext): Promise<Record<string, unknown>> {
    const action = typeof args.action === 'string' ? args.action : ''
    const cwd = exec.agent?.session.header.cwd ?? process.cwd()
    switch (action) {
      case 'start':
        return await this.start(args, cwd, exec.agent?.session.id)
      case 'status': {
        const id = this.requireId(args)
        const { topic, store } = await this.find(cwd, id)
        return { ...this.view(topic), path: await store.dirOf(id) }
      }
      case 'read_round':
      case 'read_report':
      case 'write_report': {
        if (!exec.agent?.session.header.cwd) throw new Error('report actions require a workspace session')
        const id = this.requireId(args)
        const { store } = await this.find(cwd, id)
        if (action === 'read_round') return await store.readRound(id, cwd, args.round as number)
        if (action === 'read_report') return await store.readReport(id, cwd)
        const report = await store.writeReport(id, cwd, {
          markdown: this.requireString(args, 'markdown'),
          generation: args.generation as number,
          throughRound: args.through_round as number,
          expectedRevision: args.expected_revision as string,
        })
        return { topic_id: id, report, path: join(await store.dirOf(id), report.path) }
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
        if (args.base_artifact !== undefined) {
          const baseArtifact = this.requireString(args, 'base_artifact')
          const materials = Array.isArray(args.materials) && args.materials.length > 0 ? this.stringArray(args.materials, 'materials') : undefined
          return await this.act(id, 'continue', undefined, undefined, materials, {
            brief: this.requireString(args, 'brief'), baseArtifact,
            ...(typeof args.designs === 'number' ? { designs: args.designs } : {}),
          })
        }
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
        return await this.act(
          this.requireId(args),
          'regenerate',
          undefined,
          typeof args.note === 'string' ? args.note : '',
          Array.isArray(args.materials) && args.materials.length > 0
            ? this.stringArray(args.materials, 'materials')
            : undefined,
        )
      case 'delete':
        return await this.act(this.requireId(args), 'delete')
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
        throw new Error('action must be start, continue, status, list, resume, cancel, delete, human_check, accept, review, review_cancel, wake, regenerate, probe, login, read_round, read_report or write_report')
    }
  }

  private withSources(cwd: string, refs: MaterialRef[]): MaterialRef[] {
    return refs.map(ref => ({
      ...ref,
      source: ref.source ?? (isAbsolute(ref.path) ? ref.path : resolve(cwd, ref.path)),
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
    const mode = args.store ?? this.config.store
    if (mode !== 'project' && mode !== 'local') throw new Error('store must be project or local')
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
      store: mode,
      model: this.config.channel === 'api' ? this.config.image.model : this.config.model,
      ...(typeof args.parent === 'string' && args.parent !== '' ? { parent: args.parent } : {}),
    }
    const store = this.storeAt(this.rootFor(cwd), mode)
    const engine = this.engineFor(cwd, mode)
    const topic = await engine.start(card)
    await this.record(topic, this.rootFor(cwd), sessionId, mode)
    return { ...this.view(topic), store: mode, path: await store.dirOf(topic.id) }
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
      image_edit_enabled: topic.type === 'design' && (topic.channel !== 'api' || this.config.image.editMode !== 'off'),
      created: topic.created,
      generations: topic.generations ?? [],
      stall_reason: topic.stallReason ?? null,
      rounds: topic.rounds.length,
      last_round: topic.rounds.at(-1) ?? null,
      rounds_cap: topic.roundsCap,
      designs: topic.designs ?? null,
      stop_reason: topic.stopReason ?? null,
      review_from: topic.reviewFrom ?? null,
      accepted_at: topic.acceptedAt ?? null,
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
    const registered = await this.readRegistry()
    const entries = await this.knownEntries()
    const discovered = entries.filter(entry => !registered.some(item => item.id === entry.id))
    if (discovered.length > 0) await this.mergeRegistry(discovered).catch(() => undefined)
    for (const entry of entries) {
      try {
        const store = this.storeAt(entry.root, entry.mode)
        const topic = await store.load(entry.id).catch(() => undefined)
        if (topic === undefined) continue
        // Failed automatic judging is a deliberate stop, not a stale handoff.
        if (topic.status === 'reviewing' && topic.reviewFrom === 'answered') continue
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
            // An answered-but-unjudged api round needs only the local judge.
            if (topic.status === 'answered' || topic.status === 'adjudicating') {
              await engine.resume(entry.id).catch(async () => {
                await engine.interrupt(entry.id, 'API 主题恢复裁决失败；请人工核对')
                await this.notifyStalled(entry.id, 'unknown_submission')
              })
              continue
            }
            await engine.interrupt(entry.id, 'API 生图请求在 DSH 重启后已丢失，本轮不会自动重发；已生成的图片见 artifacts，确认后可重新发起或取消')
            await this.notifyStalled(entry.id, 'unknown_submission')
          }
          continue
        }
        if (topic.status === 'answered' || topic.status === 'adjudicating') {
          // The answer is already on disk; finish the adjudication locally
          // instead of parking the topic for a human.
          try {
            await engine.resume(entry.id)
          } catch (error) {
            await engine.interrupt(entry.id, `恢复裁决失败：${error instanceof Error ? error.message : String(error)}`)
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
          // Startup may observe an existing dispatch, but must not restart a
          // known pre-send failure just because an earlier round was sent.
          const last = topic.rounds.at(-1)
          const hasSubmission = last?.answeredAt === undefined && last?.submissionState !== 'not_sent'
            && (last?.submissionId !== undefined || last?.dispatch !== undefined)
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

  async dispose(): Promise<void> {
    const engines = [...this.engines.values()]
    for (const engine of engines) engine.dispose()
    this.engines.clear()
    this.stores.clear()
    this.topicSessions.clear()
    this.imageTransport?.dispose()
    this.imageTransport = undefined
    const shared = this.shared
    this.shared = undefined
    this.transport = undefined
    const release = (): void => shared?.release()
    if (engines.length === 0) {
      release()
      return
    }
    // Let the aborted runs persist `cancelled` before Chrome closes under
    // them; settle() is bounded, so a stuck transport cannot block HMR forever.
    await Promise.allSettled(engines.map(engine => engine.settle()))
    release()
  }
}

function registerSkill(ctx: ServiceContext, spec: PluginSpec): void {
  const skills = ctx.get('skills') as SkillsService | undefined
  if (skills === undefined) return
  const root = fileURLToPath(new URL('../resources/skills', import.meta.url))
  const byName = new Map(spec.skills.map(skill => [skill.name, skill]))
  ctx.effect(() => skills.registerProvider(() => ({
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
  })), `${spec.name}: skills`)
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

/**
 * Uniform artifact response policy: nosniff everywhere; HTML demos run
 * sandboxed scripts (opaque origin, no forms/popups); SVG gets no script
 * execution at all (inline <img> display is unaffected).
 */
function artifactHeaders(mime: string): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': mime,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  }
  if (mime.startsWith('text/html')) headers['content-security-policy'] = 'sandbox allow-scripts'
  else if (mime.startsWith('image/svg+xml')) headers['content-security-policy'] = 'sandbox'
  return headers
}

const MAX_BODY_BYTES = 1_000_000

class BodyTooLargeError extends Error {}

async function readJsonBody(req: HttpRequest): Promise<Record<string, unknown>> {
  // Buffer first, decode once: decoding per chunk corrupts multibyte UTF-8
  // (e.g. a Chinese note) split across chunk boundaries.
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk)
    total += buffer.byteLength
    if (total > MAX_BODY_BYTES) throw new BodyTooLargeError('body exceeds 1 MB')
    chunks.push(buffer)
  }
  const body = Buffer.concat(chunks).toString('utf8')
  if (body.trim() === '') return {}
  return JSON.parse(body) as Record<string, unknown>
}

function registerRoutes(scoped: Context, service: ProResearchService, spec: PluginSpec): void {
  const webServer = (scoped as unknown as {
    webServer?: { register(route: { kind: 'exact' | 'prefix'; path: string; handler: (req: HttpRequest, res: HttpResponse) => void | Promise<void> }): () => void }
  }).webServer
  if (webServer === undefined) return
  const connection = scoped.get('connection') as
    | { requestRejection?(req: HttpRequest): 401 | 403 | undefined }
    | undefined
  if (connection === undefined) {
    // The caller injects ['webServer', 'connection']; a missing guard here
    // means the composition is not safe to expose. Do not register fail-open
    // routes: the panel will report the missing host service instead.
    service.noteMissingConnectionGuard()
    return
  }
  const reject = (req: HttpRequest): 401 | 403 | undefined => {
    // Depth defense: a cross-site POST never reaches the action surface even
    // if the host guard itself has a bug.
    const site = req.headers['sec-fetch-site']
    const value = Array.isArray(site) ? site[0] : site
    if (req.method === 'POST' && value === 'cross-site') return 403
    return connection.requestRejection?.(req)
  }

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
        const brief = typeof body.brief === 'string' ? body.brief : undefined
        const designs = typeof body.designs === 'number' ? body.designs : undefined
        const baseArtifact = typeof body.base_artifact === 'string' ? body.base_artifact : undefined
        const materials = Array.isArray(body.materials)
          ? body.materials.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
          : undefined
        if (action === 'probe' || action === 'login') {
          sendJson(res, 200, await service.handle({ action }, { agent: undefined } as never))
          return
        }
        sendJson(res, 200, {
          topic: await service.act(id, action, conclusion, note, materials, {
            ...(brief !== undefined ? { brief } : {}),
            ...(designs !== undefined ? { designs } : {}),
            ...(baseArtifact !== undefined ? { baseArtifact } : {}),
          }),
        })
      } catch (error) {
        const status = error instanceof BodyTooLargeError ? 413 : 400
        sendJson(res, status, { error: error instanceof Error ? error.message : String(error) })
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
        res.writeHead(200, artifactHeaders(asset.mime))
        res.end(asset.bytes)
      } catch (error) {
        sendJson(res, error instanceof FileSizeLimitError ? 413 : 404, { error: error instanceof FileSizeLimitError ? error.message : 'unknown artifact' })
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
        res.writeHead(200, artifactHeaders(asset.mime))
        res.end(url.searchParams.get('preview') === '1' && asset.mime.startsWith('text/html')
          ? previewHtml(Buffer.from(asset.bytes).toString('utf8'))
          : asset.bytes)
      } catch (error) {
        sendJson(res, error instanceof FileSizeLimitError ? 413 : 404, { error: error instanceof FileSizeLimitError ? error.message : 'unknown artifact' })
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
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
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
        const mime = file.mime.includes('charset=') ? file.mime : `${file.mime}; charset=utf-8`
        // topicText can reach HTML/SVG inside the topic directory: serve them
        // with the same sandbox policy as the artifact routes.
        res.writeHead(200, artifactHeaders(mime))
        res.end(file.text)
      } catch (error) {
        sendJson(res, error instanceof FileSizeLimitError ? 413 : 404, { error: error instanceof FileSizeLimitError ? error.message : 'unknown file' })
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
        const status = error instanceof BodyTooLargeError ? 413 : 400
        sendJson(res, status, { error: error instanceof Error ? error.message : String(error) })
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
        'action: start | continue | status | list | resume | cancel | delete | human_check | accept | review | review_cancel | wake | regenerate | probe | login | read_round | read_report | write_report。交付：read_round 核对证据，read_report 取 revision，再 write_report 写当前主题固定交付稿（local/project 均支持），不传文件路径。',
      ].join(' ')
    }
    return [
      '用 ChatGPT 网页会话生成设计图与前端代码/HTML demo，产物保存到本地并出现在设计面板；默认优先使用可用的 Pro，否则沿用账号当前模型。',
      'start 前必须先展示设计卡（目标、成功判据、材料、轮次、产物路径）；用户确认后传 confirmed=true。',
      'action: start | continue | status | list | resume | cancel | delete | human_check | accept | review | review_cancel | wake | regenerate | probe | login | read_round | read_report | write_report。交付：read_round 核对证据，read_report 取 revision，再 write_report 写当前主题固定交付稿（local/project 均支持），不传文件路径。',
    ].join(' ')
  }
  return [
    '用 ChatGPT 网页会话做无人值守的多轮调研；默认优先使用可用的 Pro，否则沿用账号当前模型。',
    'start 前必须先向用户展示研究卡（问题、成功判据、材料、轮次上限、产物路径）；用户确认后传 confirmed=true。',
    'action: start | continue | status | list | resume | cancel | delete | human_check | accept | review | review_cancel | wake | regenerate | probe | login | read_round | read_report | write_report。交付：read_round 核对证据，read_report 取 revision，再 write_report 写当前主题固定交付稿（local/project 均支持），不传文件路径。',
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
    // Register through inject, not a one-shot ctx.get(): the service can
    // activate after this plugin and can be replaced by HMR. The effect inside
    // registerSkill is scoped to the injected context, so a replacement
    // registers a fresh provider instead of being blocked by a stale guard.
    ;(ctx as ServiceContext).inject(['skills'], scoped => registerSkill(scoped as ServiceContext, spec))
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
    ;(ctx as ServiceContext).inject(['webServer', 'connection'], scoped => registerRoutes(scoped, service, spec))
  // The registry disposer must belong to this plugin's fiber: a plain
  // tools.register() call ignores cleanup on disable/HMR and a reload then
  // trips the registry's duplicate-name guard.
  ctx.effect(() => (ctx as ServiceContext).tools.register(defineTool({
    name: spec.tool,
    description: toolDescription(spec, resolved),
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['start', 'continue', 'status', 'list', 'resume', 'cancel', 'delete', 'human_check', 'accept', 'review', 'review_cancel', 'wake', 'regenerate', 'probe', 'login', 'read_round', 'read_report', 'write_report'],
        description: 'start|continue|status|list|resume|cancel|delete|human_check|accept|review|review_cancel|wake|regenerate|probe|login|read_round|read_report|write_report',
      },
      title: { type: 'string', description: '主题标题（start 必填）' },
      question: { type: 'string', description: '主题目标/研究问题（start 必填）' },
      brief: { type: 'string', description: '发给 Pro 的完整 brief（start 与 continue 必填）' },
      criteria: { type: 'array', items: { type: 'string' }, description: '成功判据（start 必填）' },
      materials: { type: 'array', items: { type: 'string' }, description: '材料路径（start/continue/regenerate 可选）' },
      base_artifact: { type: 'string', description: '仅 design 的 continue：当前主题已记录的 PNG/JPEG/WebP 产物路径；只以此图修改，一轮一个结果，不与 materials 合用' },
      materialReasons: { type: 'object', additionalProperties: true, description: '可选：材料路径 → 选择理由' },
      rounds: { type: 'number', description: '本次轮次上限（1–10，仅 start；continue 固定加一轮）' },
      store: { type: 'string', enum: ['project', 'local'], description: '仅 start：研究卡确认的记录位置；project 写仓库，local 写 DSH 本机；省略时使用插件设置' },
      designs: { type: 'number', description: '设计插件本轮方向/图片数（1–6，仅 design 主题的 start/continue）' },
      topic_id: { type: 'string', description: 'status/continue/resume/cancel/delete/human_check/accept/review/review_cancel/wake/regenerate 的主题 id' },
      parent: { type: 'string', description: '可选：父主题 id，仅 start 使用' },
      conclusion: {
        type: 'string',
        enum: ['submitted', 'not_submitted', 'reopen'],
        description: 'human_check 结论：submitted|not_submitted|reopen',
      },
      note: { type: 'string', description: 'human_check 依据；regenerate 时作为不满意点/新要求' },
      round: { type: 'number', description: 'read_round：主题内已回答的全局轮次序号，读取原答复与裁决' },
      markdown: { type: 'string', description: 'write_report：已核对证据的交付稿正文（最多 256 KiB），不要包含覆盖范围文件头' },
      generation: { type: 'number', description: 'write_report：实际覆盖的当前方案版本序号' },
      through_round: { type: 'number', description: 'write_report：实际整合至最新已回答轮次的全局序号' },
      expected_revision: { type: 'string', description: 'write_report：read_report 返回的 revision；没有旧稿时传空字符串，防止覆盖他人更新' },
      confirmed: { type: 'boolean', description: '用户已授权任务/交付；start、continue、regenerate、accept、delete、write_report 需要 true' },
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
        || args.action === 'delete'
        || args.action === 'write_report'
      const autoStart = args.action === 'start' && service.autoStartEnabled()
      if (writeAction && args.confirmed !== true && !autoStart) {
        throw new Error('start, continue, regenerate, accept, delete and write_report require confirmed=true after user authorization')
      }
      return (await service.handle(args, exec)) as never
    },
  })), `${spec.name}: tool`)
  }
}
