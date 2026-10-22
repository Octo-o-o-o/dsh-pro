import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import {
  ResearchEngine,
  ResearchStore,
  TransportError,
  assertMaterialLimits,
  buildManifest,
  defaultConfig,
  type Judge,
  type JudgeResult,
  type ProConfig,
  type ResearchCard,
  type Topic,
} from '@dsh-pro/core'
import { ChatGptWebTransport } from '@dsh-pro/transport'

export const name = 'dsh-pro-research'
export const inject = ['tools']

/** Loader-validated settings. Defaults mirror `defaultConfig()`. */
export const Config = z.object({
  rounds: z.number().step(1).min(1).max(10).default(3).description('每主题默认轮次上限（1–10）。'),
  model: z.string().default('pro').description('ChatGPT 页面上的模型：pro 或 thinking。'),
  store: z.string().default('project').description('研究记录位置：project（仓库 docs/research）或 local（DSH 本机）。'),
  autoStart: z.boolean().default(false).description('研究卡是否跳过点击直接开跑。'),
  notify: z.string().default('stall-only').description('通知策略：stall-only 只在卡住时提醒，all 完成也提醒。'),
  stallMinutes: z.number().step(1).min(1).default(45).description('无进展判定分钟数；生成中不计时。'),
  maxRoundMinutes: z.number().step(1).min(1).default(90).description('单轮墙钟上限（分钟）。'),
  maxFiles: z.number().step(1).min(1).default(12).description('单轮附件数量上限。'),
  maxTotalMB: z.number().default(24).description('单轮附件总大小（MB）。'),
  rawAnswers: z.string().default('local').description('原始答复保存位置：local（本机目录）或 repo（随项目）。公开仓库请用 local。'),
  rawAnswersDir: z.string().default('').description('local 模式的原文目录；留空用 ~/.dsh/pro-research/raw。'),
  browserProfile: z.string().default('').description('独立浏览器 profile 目录；留空用 ~/.dsh/pro-research/browser。'),
  headless: z.boolean().default(false).description('无头模式仅建议用于自检；首次登录必须有头。'),
  judgeProvider: z.string().default('').description('自动裁决使用的 LLM provider；留空则跑满轮次。'),
  judgeModel: z.string().default('').description('自动裁决使用的 model；与 provider 同时填写才启用。'),
})

export interface ResearchConfig {
  rounds?: number
  model?: string
  store?: string
  autoStart?: boolean
  notify?: string
  stallMinutes?: number
  maxRoundMinutes?: number
  maxFiles?: number
  maxTotalMB?: number
  rawAnswers?: string
  rawAnswersDir?: string
  browserProfile?: string
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
}

function homeDir(): string {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

export function resolveResearchConfig(config: ResearchConfig | undefined): ProConfig {
  const base = defaultConfig(join(homeDir(), 'pro-research'))
  const merged: ProConfig = {
    ...base,
    ...(config?.rounds !== undefined ? { rounds: config.rounds } : {}),
    ...(config?.model !== undefined ? { model: config.model } : {}),
    ...(config?.store === 'local' || config?.store === 'project' ? { store: config.store } : {}),
    ...(config?.autoStart !== undefined ? { autoStart: config.autoStart } : {}),
    ...(config?.notify === 'all' || config?.notify === 'stall-only' ? { notify: config.notify } : {}),
    ...(config?.stallMinutes !== undefined ? { stallMinutes: config.stallMinutes } : {}),
    ...(config?.maxRoundMinutes !== undefined ? { maxRoundMinutes: config.maxRoundMinutes } : {}),
    ...(config?.maxFiles !== undefined ? { maxFiles: config.maxFiles } : {}),
    ...(config?.maxTotalMB !== undefined ? { maxTotalMB: config.maxTotalMB } : {}),
    ...(config?.rawAnswers === 'repo' || config?.rawAnswers === 'local' ? { rawAnswers: config.rawAnswers } : {}),
    ...(config?.rawAnswersDir !== undefined && config.rawAnswersDir !== '' ? { rawAnswersDir: config.rawAnswersDir } : {}),
    ...(config?.browserProfile !== undefined && config.browserProfile !== ''
      ? { browser: { ...base.browser, profileDir: config.browserProfile } }
      : {}),
    ...(config?.headless !== undefined ? { browser: { ...base.browser, ...(config.browserProfile ? { profileDir: config.browserProfile } : {}), headless: config.headless } } : {}),
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
  private transport?: ChatGptWebTransport

  constructor(
    private readonly ctx: ServiceContext,
    private readonly config: ProConfig,
    private readonly home: string,
  ) {}

  private rootFor(cwd: string): string {
    return cwd.trim() === '' ? process.cwd() : cwd
  }

  private storeFor(cwd: string): ResearchStore {
    const root = this.rootFor(cwd)
    const key = `${this.config.store}:${root}`
    const existing = this.stores.get(key)
    if (existing !== undefined) return existing
    const store = new ResearchStore({
      mode: this.config.store,
      projectRoot: root,
      localRoot: join(this.home, 'pro-research'),
      rawDir: this.config.rawAnswersDir,
      rawAnswers: this.config.rawAnswers,
    })
    this.stores.set(key, store)
    return store
  }

  private transportFor(): ChatGptWebTransport {
    if (this.transport !== undefined) return this.transport
    this.transport = new ChatGptWebTransport({
      profileDir: this.config.browser.profileDir,
      headless: this.config.browser.headless,
    })
    return this.transport
  }

  private judge(): Judge {
    const provider = this.config.judgeProvider
    const model = this.config.judgeModel
    if (provider === '' || model === '') {
      return async () => ({
        verdict: 'partial',
        reason: '未配置裁决模型，跑满轮次后交付',
        done: false,
        summary: '未启用自动裁决；结论见各轮裁决与原始答复。',
      })
    }
    return async (input) => {
      const llm = this.ctx.get('llm') as
        | { stream(options: Record<string, unknown>): AsyncIterable<unknown> }
        | undefined
      if (llm === undefined) throw new Error('the harness LLM service is unavailable')
      const assembler = new BlockAssembler()
      const user = [
        `主题：${input.topic.title}`,
        `成功判据：\n${input.criteria.map(item => `- ${item}`).join('\n')}`,
        `本轮问题：\n${input.topic.rounds[input.topic.rounds.length - 1]?.n ?? input.round}`,
        `本轮答复：\n${input.answer.slice(0, 30_000)}`,
      ].join('\n\n')
      for await (const chunk of llm.stream({
        provider,
        model,
        system: JUDGE_SYSTEM,
        messages: [createUserMessage({
          content: [{ type: 'text', text: user }],
          source: { kind: 'plugin', plugin: 'dsh-pro-research' },
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

  private engineFor(cwd: string): ResearchEngine {
    const store = this.storeFor(cwd)
    const key = `${this.config.store}:${this.rootFor(cwd)}`
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
        }
      },
    })
    this.engines.set(key, engine)
    return engine
  }

  private log(message: string): void {
    const logger = (this.ctx as unknown as { logger?: (name: string) => { info?: (msg: string) => void } }).logger
    const scoped = typeof logger === 'function' ? logger('dsh-pro-research') : undefined
    scoped?.info?.(message)
  }

  private async find(cwd: string, topicId: string): Promise<{ store: ResearchStore; engine: ResearchEngine; topic: Topic }> {
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

  async handle(args: Record<string, unknown>, exec: ToolRunContext): Promise<Record<string, unknown>> {
    const action = typeof args.action === 'string' ? args.action : ''
    const cwd = exec.agent?.session.header.cwd ?? process.cwd()
    switch (action) {
      case 'start':
        return await this.start(args, cwd)
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
      case 'probe':
        return { probe: await this.transportFor().probe() }
      case 'login':
        return { login: await this.transportFor().login() }
      default:
        throw new Error('action must be start, status, list, resume, cancel, human_check, probe or login')
    }
  }

  private async start(args: Record<string, unknown>, cwd: string): Promise<Record<string, unknown>> {
    const title = this.requireString(args, 'title')
    const question = this.requireString(args, 'question')
    const brief = this.requireString(args, 'brief')
    const criteria = this.stringArray(args.criteria, 'criteria')
    const materialPaths = this.stringArray(args.materials, 'materials')
    const reasons = (args.materialReasons ?? {}) as Record<string, string>
    const refs = await buildManifest(cwd, materialPaths, reasons)
    assertMaterialLimits(refs, this.config.maxFiles, this.config.maxTotalMB)
    const card: ResearchCard = {
      title,
      type: args.type === 'design' ? 'design' : 'research',
      question,
      successCriteria: criteria,
      brief,
      materials: refs,
      rounds: typeof args.rounds === 'number' ? args.rounds : this.config.rounds,
      store: this.config.store,
      model: this.config.model,
    }
    const engine = this.engineFor(cwd)
    const topic = await engine.start(card)
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
      stall_reason: topic.stallReason ?? null,
      rounds: topic.rounds.length,
      rounds_cap: topic.roundsCap,
      stop_reason: topic.stopReason ?? null,
      artifacts: topic.artifacts,
      updated: topic.updated,
    }
  }

  dispose(): void {
    void this.transport?.close()
  }
}

const SKILLS = [
  {
    name: 'pro-research',
    dir: 'pro-research',
    description: '用 ChatGPT Pro 网页会话做无人值守的多轮调研；只在用户明确要求 Pro 调研时使用。',
  },
  {
    name: 'pro-design',
    dir: 'pro-design',
    description: '用 ChatGPT Pro 网页会话做有界的设计征询（方向、取舍、反例）；只在用户明确要求 Pro 设计时使用。',
  },
] as const

function registerSkill(ctx: ServiceContext): void {
  const skills = ctx.get('skills') as SkillsService | undefined
  if (skills === undefined) return
  const root = fileURLToPath(new URL('../resources/skills', import.meta.url))
  const byName = new Map(SKILLS.map(skill => [skill.name, skill]))
  skills.registerProvider(() => ({
    name: 'dsh-pro-research',
    list: async () => SKILLS.map(skill => {
      const path = join(root, skill.dir, 'SKILL.md')
      return {
        name: skill.name,
        description: skill.description,
        rank: 350,
        source: 'dsh-pro-research',
        provider: 'dsh-pro-research',
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
        source: 'dsh-pro-research',
        provider: 'dsh-pro-research',
      }
    },
  }))
}

export function apply(ctx: Context, config?: ResearchConfig): void {
  const service = new ProResearchService(ctx as ServiceContext, resolveResearchConfig(config), homeDir())
  ctx.effect(() => () => service.dispose(), 'dsh-pro-research: close browser')
  registerSkill(ctx as ServiceContext)
  ;(ctx as ServiceContext).tools.register(defineTool({
    name: 'pro_research',
    description: [
      '用 ChatGPT Pro 网页会话做无人值守的多轮调研或设计。',
      'start 前必须先向用户展示研究卡（问题、成功判据、材料、轮次上限、产物路径）；用户确认后传 confirmed=true。',
      'action: start | status | list | resume | cancel | human_check | probe | login。',
    ].join(' '),
    parameters: {
      action: { type: 'string', required: true, description: 'start|status|list|resume|cancel|human_check|probe|login' },
      title: { type: 'string', description: '主题标题（start 必填）' },
      question: { type: 'string', description: '研究问题（start 必填）' },
      brief: { type: 'string', description: '发给 Pro 的完整 brief（start 必填）' },
      criteria: { type: 'array', items: { type: 'string' }, description: '成功判据（start 必填）' },
      materials: { type: 'array', items: { type: 'string' }, description: '相对工作目录的材料路径（start 可选）' },
      type: { type: 'string', description: 'research 或 design' },
      rounds: { type: 'number', description: '本次轮次上限（1–10）' },
      topic_id: { type: 'string', description: 'status/resume/cancel/human_check 的主题 id' },
      conclusion: { type: 'string', description: 'human_check 结论：submitted|not_submitted|reopen' },
      note: { type: 'string', description: 'human_check 依据' },
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
      if (args.action === 'start' && args.confirmed !== true) {
        throw new Error('start requires confirmed=true after the user has seen the research card')
      }
      return (await service.handle(args, exec)) as never
    },
  }))
}
