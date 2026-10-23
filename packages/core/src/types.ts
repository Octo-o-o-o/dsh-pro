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
  | 'reviewing'
  | 'stalled'
  | 'failed'
  | 'cancelled'

export type Verdict = 'accepted' | 'partial' | 'rejected'

export type StallReason = 'login' | 'upload' | 'timeout' | 'ui' | 'config' | 'worker' | 'unknown_submission'

export type StoreMode = 'project' | 'local'

export type AnswerHome = 'local' | 'repo'

export interface RoundRecord {
  n: number
  /** Which regeneration/version this round belongs to; 1 is the first run. */
  generation?: number
  submittedAt?: string
  answeredAt?: string
  verdict?: Verdict
  done?: boolean
  files: number
  fingerprint?: string
  submissionId?: string
  /** How many submits this round has made; 1 means no retry yet. */
  attempts?: number
  /** Topic-relative artifacts produced by this round. */
  artifacts?: string[]
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
  designs?: number
  /** One entry per generation: the initial run and each explicit regeneration. */
  generations?: GenerationRecord[]
  rounds: RoundRecord[]
  channel: string
  model: string
  successCriteria: string[]
  artifacts: string[]
  stopReason?: string
  /** Judge-authored brief for the next round, persisted across restarts. */
  nextBrief?: string
  humanCheck?: HumanCheck
}

export interface HumanCheck {
  at: string
  conclusion: 'submitted' | 'not_submitted' | 'reopen'
  note: string
}

export interface GenerationRecord {
  n: number
  createdAt: string
  /** Rounds this version is allowed to run (its own budget). */
  rounds?: number
  /** Why this version was requested, e.g. the user's regeneration feedback. */
  reason?: string
  /** Topic-relative archived final for this version. */
  final?: string
}

export interface MaterialRef {
  path: string
  bytes: number
  sha256: string
  reason?: string
  /** Absolute source path; the store stages a copy into the topic directory. */
  source?: string
}

export interface ResearchCard {
  title: string
  type: TopicType
  question: string
  successCriteria: string[]
  brief: string
  materials: MaterialRef[]
  rounds: number
  designs?: number
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
  /** Images one round should produce for the design plugin (1–6). */
  designs?: number
  session?: SessionLocator | null
}

export interface SubmitResult {
  submissionId: string
  fingerprint: string
  attachments: string[]
  conversationUrl: string
}

export interface ReattachRequest {
  topicId: string
  round: number
  conversationUrl: string
  /** Text unique to the round; used to verify the prompt is already in the chat. */
  brief: string
}

export interface ReattachResult {
  attached: boolean
  submissionId?: string
}

export interface PollResult {
  state: 'waiting' | 'answered' | 'unknown'
  answer?: string
  snapshotPath?: string
  /** The page/request visibly changed since the previous poll. */
  progress?: boolean
}

/** One image produced by the answer (base64 payload, no filesystem assumptions). */
export interface ImageAsset {
  name?: string
  mime: string
  base64: string
}

/** One fenced code block from the answer (frontend demos live here). */
export interface CodeBlock {
  language: string
  /** Filename hint from the fence/header, when ChatGPT exposes one. */
  name?: string
  text: string
}

/** A downloadable archive linked from the answer (often a code-interpreter zip). */
export interface ArchiveAsset {
  name: string
  base64: string
}

export interface FetchedAnswer {
  answer: string
  images?: ImageAsset[]
  codeBlocks?: CodeBlock[]
  archives?: ArchiveAsset[]
  snapshotPath?: string
}

export type TransportFailure = 'login' | 'upload' | 'ui' | 'network' | 'worker' | 'timeout' | 'config'

export class TransportError extends Error {
  readonly failure: TransportFailure

  constructor(
    message: string,
    failure: TransportFailure,
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = 'TransportError'
    this.failure = failure
  }
}

export interface Transport {
  /** `reason` carries a human-readable hint for the api channel (never the key). */
  probe(): Promise<{ ok: boolean; loggedIn: boolean; model: string; available: string[]; reason?: string }>
  submit(request: SubmitRequest): Promise<SubmitResult>
  reattach?(request: ReattachRequest): Promise<ReattachResult>
  poll(request: { submissionId: string; timeoutMs: number; signal?: AbortSignal }): Promise<PollResult>
  fetch(request: { submissionId: string }): Promise<FetchedAnswer>
  cancelSubmission?(submissionId: string): Promise<void>
  cancel(): Promise<void>
}

export interface JudgeInput {
  topic: Topic
  round: number
  answer: string
  criteria: string[]
  question?: string
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
