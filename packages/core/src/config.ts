import type { AnswerHome, StoreMode, TopicType } from './types.ts'

export interface BrowserConfig {
  profileDir: string
  headless: boolean
}

/** `web` drives a real ChatGPT page; `api` calls an OpenAI-compatible image API. */
export type Channel = 'web' | 'api'

export type ImageFormat = 'png' | 'jpeg' | 'webp'

export interface ImageApiConfig {
  /** Base URL including the version prefix, e.g. https://api.openai.com/v1. */
  baseUrl: string
  /** Bearer token (or api-key header for Azure-style gateways). Never logged. */
  apiKey: string
  model: string
  /** Provider size string; `auto` leaves the field out of the request. */
  size: string
  /** `auto` / `low` / `medium` / `high`; `auto` leaves the field out. */
  quality: string
  format: ImageFormat
  /** `bearer` → Authorization header; `api-key` → api-key header. */
  auth: 'bearer' | 'api-key'
  /** `auto` sends image materials as reference images to /images/edits. */
  editMode: 'auto' | 'off'
  timeoutSeconds: number
}

export interface ProConfig {
  channel: Channel
  image: ImageApiConfig
  model: string
  rounds: number
  designs: number
  stallMinutes: number
  maxRoundMinutes: number
  store: StoreMode
  autoStart: boolean
  autoReview: boolean
  notify: 'stall-only' | 'all'
  maxFiles: number
  maxTotalMB: number
  secretGlobs: string[]
  rawAnswers: AnswerHome
  rawAnswersDir: string
  judgeProvider: string
  judgeModel: string
  browser: BrowserConfig
}

export type ProjectOverride = Partial<Pick<ProConfig, 'rounds' | 'designs' | 'store' | 'notify'>>

export interface RunOverride {
  rounds?: number
  designs?: number
  store?: StoreMode
}

export const DEFAULT_SECRET_GLOBS = [
  '.env',
  '.env.*',
  '*.pem',
  '*.key',
  'id_rsa*',
  '.npmrc',
  '.credentials*',
  '**/secrets/**',
]

export function defaultConfig(home: string): ProConfig {
  return {
    channel: 'web',
    image: {
      baseUrl: 'https://api.openai.com/v1',
      apiKey: '',
      model: 'gpt-image-1',
      size: 'auto',
      quality: 'auto',
      format: 'png',
      auth: 'bearer',
      editMode: 'auto',
      timeoutSeconds: 300,
    },
    model: 'pro',
    rounds: 3,
    designs: 3,
    stallMinutes: 45,
    maxRoundMinutes: 90,
    store: 'project',
    autoStart: false,
    autoReview: true,
    notify: 'stall-only',
    maxFiles: 12,
    maxTotalMB: 24,
    secretGlobs: [...DEFAULT_SECRET_GLOBS],
    rawAnswers: 'local',
    rawAnswersDir: `${home}/raw`,
    judgeProvider: '',
    judgeModel: '',
    browser: { profileDir: `${home}/browser`, headless: false },
  }
}

const ROUND_MIN = 1
const ROUND_MAX = 10
const IMAGE_FORMATS: readonly ImageFormat[] = ['png', 'jpeg', 'webp']

/**
 * Fail before the first billable request. The key check is optional because the
 * plugin resolves `GPT_IMAGE_API_KEY` after the settings layer has run.
 */
export function assertImageApiConfig(image: ImageApiConfig, options?: { requireKey?: boolean }): void {
  let url: URL
  try {
    url = new URL(image.baseUrl.trim())
  } catch {
    throw new Error('imageBaseUrl must be an absolute URL, for example https://api.openai.com/v1')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('imageBaseUrl must use http or https')
  }
  if (image.model.trim() === '') throw new Error('imageModel is required for the api channel')
  if (!IMAGE_FORMATS.includes(image.format)) throw new Error('imageFormat must be png, jpeg or webp')
  if (image.auth !== 'bearer' && image.auth !== 'api-key') throw new Error('imageAuth must be bearer or api-key')
  if (image.editMode !== 'auto' && image.editMode !== 'off') throw new Error('imageEdit must be auto or off')
  if (!Number.isInteger(image.timeoutSeconds) || image.timeoutSeconds < 10 || image.timeoutSeconds > 3600) {
    throw new Error('imageTimeoutSeconds must be an integer between 10 and 3600')
  }
  if (options?.requireKey === true && image.apiKey.trim() === '') {
    throw new Error('imageApiKey is empty: set it in the plugin settings or export GPT_IMAGE_API_KEY')
  }
}

export function assertConfig(config: ProConfig): ProConfig {
  if (config.channel !== 'web' && config.channel !== 'api') throw new Error('channel must be web or api')
  if (config.channel === 'api') assertImageApiConfig(config.image)
  if (!Number.isInteger(config.rounds) || config.rounds < ROUND_MIN || config.rounds > ROUND_MAX) {
    throw new Error(`rounds must be an integer between ${ROUND_MIN} and ${ROUND_MAX}`)
  }
  if (!Number.isInteger(config.designs) || config.designs < 1 || config.designs > 6) {
    throw new Error('designs must be an integer between 1 and 6')
  }
  if (!Number.isInteger(config.stallMinutes) || config.stallMinutes < 1) {
    throw new Error('stallMinutes must be a positive integer')
  }
  if (!Number.isInteger(config.maxRoundMinutes) || config.maxRoundMinutes < config.stallMinutes) {
    throw new Error('maxRoundMinutes must be an integer no smaller than stallMinutes')
  }
  if (!Number.isInteger(config.maxFiles) || config.maxFiles < 1) {
    throw new Error('maxFiles must be a positive integer')
  }
  if (!(config.maxTotalMB > 0)) throw new Error('maxTotalMB must be positive')
  if (config.store !== 'project' && config.store !== 'local') throw new Error('store must be project or local')
  if (config.rawAnswers !== 'local' && config.rawAnswers !== 'repo') throw new Error('rawAnswers must be local or repo')
  return config
}

/** Precedence: run > project > profile. Only whitelisted project keys apply. */
export function resolveConfig(
  profile: ProConfig,
  project?: ProjectOverride,
  run?: RunOverride,
): ProConfig {
  const merged: ProConfig = {
    ...profile,
    image: { ...profile.image },
    browser: { ...profile.browser },
    secretGlobs: [...profile.secretGlobs],
  }
  if (project?.rounds !== undefined) merged.rounds = project.rounds
  if (project?.designs !== undefined) merged.designs = project.designs
  if (project?.store !== undefined) merged.store = project.store
  if (project?.notify !== undefined) merged.notify = project.notify
  if (run?.rounds !== undefined) merged.rounds = run.rounds
  if (run?.designs !== undefined) merged.designs = run.designs
  if (run?.store !== undefined) merged.store = run.store
  return assertConfig(merged)
}

export function cardRounds(config: ProConfig, card: { rounds?: number }): number {
  const rounds = card.rounds ?? config.rounds
  if (!Number.isInteger(rounds) || rounds < ROUND_MIN || rounds > ROUND_MAX) {
    throw new Error(`rounds must be an integer between ${ROUND_MIN} and ${ROUND_MAX}`)
  }
  return rounds
}

export function topicTypeOf(value: string): TopicType {
  if (value === 'research' || value === 'design') return value
  throw new Error('type must be research or design')
}
