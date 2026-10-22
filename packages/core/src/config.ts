import type { AnswerHome, StoreMode, TopicType } from './types.ts'

export interface BrowserConfig {
  profileDir: string
  headless: boolean
}

export interface ProConfig {
  channel: string
  model: string
  rounds: number
  designs: number
  stallMinutes: number
  maxRoundMinutes: number
  store: StoreMode
  autoStart: boolean
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
    channel: 'web-pro',
    model: 'pro',
    rounds: 3,
    designs: 3,
    stallMinutes: 45,
    maxRoundMinutes: 90,
    store: 'project',
    autoStart: false,
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

export function assertConfig(config: ProConfig): ProConfig {
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
