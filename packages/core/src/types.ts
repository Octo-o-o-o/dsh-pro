/** Shared vocabulary for the research engine, transport and plugin halves. */

export type TopicType = 'research' | 'design'

export type Status =
  | 'draft'
  | 'queued'
  | 'uploading'
  | 'submitted'
  | 'waiting'
  | 'answered'
  | 'adjudicating'
  | 'completed'
  | 'capped'
  | 'stalled'
  | 'failed'
  | 'cancelled'

export type Verdict = 'accepted' | 'partial' | 'rejected'

export type StallReason = 'login' | 'upload' | 'timeout' | 'ui' | 'worker' | 'unknown_submission'

export type StoreMode = 'project' | 'local'

export type AnswerHome = 'local' | 'repo'

export interface RoundRecord {
  n: number
  submittedAt?: string
  answeredAt?: string
  verdict?: Verdict
  done?: boolean
  files: number
  fingerprint?: string
  submissionId?: string
}

export interface Topic {
  schema: 1
  id: string
  title: string
  type: TopicType
  parent: string | null
  created: string
  updated: string
  status: Status
  stallReason?: StallReason
  roundsCap: number
  rounds: RoundRecord[]
  channel: string
  model: string
  successCriteria: string[]
  artifacts: string[]
  stopReason?: string
  humanCheck?: HumanCheck
}

export interface HumanCheck {
  at: string
  conclusion: 'submitted' | 'not_submitted' | 'reopen'
  note: string
}

export interface MaterialRef {
  path: string
  bytes: number
  sha256: string
  reason?: string
}

export interface ResearchCard {
  title: string
  type: TopicType
  question: string
  successCriteria: string[]
  brief: string
  materials: MaterialRef[]
  rounds: number
  store: StoreMode
  model?: string
  parent?: string
}

export interface SessionLocator {
  conversationUrl: string
  profileDir: string
  lastFingerprint?: string
}

export interface Receipt {
  n: number
  submissionId: string
  fingerprint: string
  conversationUrl: string
  attachments: string[]
  submittedAt: string
  answerSha256?: string
  answeredAt?: string
}

export interface SubmitRequest {
  topicId: string
  round: number
  brief: string
  files: string[]
  /** Attachments to use when the stored conversation cannot be reused. */
  fallbackFiles?: string[]
  model: string
  session?: SessionLocator | null
}

export interface SubmitResult {
  submissionId: string
  fingerprint: string
  attachments: string[]
  conversationUrl: string
}

export interface PollResult {
  state: 'waiting' | 'answered' | 'unknown'
  answer?: string
  snapshotPath?: string
}

export type TransportFailure = 'login' | 'upload' | 'ui' | 'network' | 'worker' | 'timeout'

export class TransportError extends Error {
  constructor(
    message: string,
    readonly failure: TransportFailure,
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = 'TransportError'
  }
}

export interface Transport {
  probe(): Promise<{ ok: boolean; loggedIn: boolean; model: string; available: string[] }>
  submit(request: SubmitRequest): Promise<SubmitResult>
  poll(request: { submissionId: string; timeoutMs: number; signal?: AbortSignal }): Promise<PollResult>
  fetch(request: { submissionId: string }): Promise<{ answer: string; snapshotPath?: string }>
  cancel(): Promise<void>
}

export interface JudgeInput {
  topic: Topic
  round: number
  answer: string
  criteria: string[]
}

export interface JudgeResult {
  verdict: Verdict
  reason: string
  done: boolean
  summary: string
  nextBrief?: string
}

export type Judge = (input: JudgeInput) => Promise<JudgeResult>

export type EngineEvent =
  | { type: 'status'; topicId: string; status: Status; reason?: StallReason }
  | { type: 'round'; topicId: string; round: number; verdict?: Verdict }
  | { type: 'answered'; topicId: string; round: number }
  | { type: 'finished'; topicId: string; status: 'completed' | 'capped' | 'cancelled' }
