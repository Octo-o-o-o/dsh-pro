import { useEffect, useMemo, useRef, useState } from 'react'
import { DocumentContent } from './document.tsx'
import { PANEL_CSS } from './panel-styles.ts'
import type { ReactNode } from 'react'
import { DESIGN_ICON, RESEARCH_ICON } from './icons.ts'
import { mountSidebarStatus } from './sidebar-status.ts'
import { markTopicSeen } from './seen.ts'
import { PREVIEW_ESCAPE_MESSAGE } from '../src/preview.ts'

const POLL_MS = 3_000

export interface ClientSpec {
  routes: string
  panelId: string
  title: string
  label: string
  icon: 'research' | 'design'
  designMode: boolean
}

let config: ClientSpec = {
  routes: '/chatgpt-pro-research',
  panelId: 'chatgpt-pro-research',
  title: 'ChatGPT Pro Research',
  label: 'Pro Research',
  icon: 'research',
  designMode: false,
}

export function configure(spec: ClientSpec): void {
  config = spec
}

interface ClientContext {
  slots: {
    register(options: Record<string, unknown>, render: (owner?: unknown) => unknown): () => void
    inject(name: string, register: () => () => void): () => void
  }
  effect?(setup: () => () => void, label?: string): () => void
}

export const inject = ['slots']

interface TopicRow {
  topic_id: string
  title: string
  type: string
  status: string
  channel?: string
  model?: string
  judge_enabled?: boolean
  image_edit_enabled?: boolean
  stall_reason: string | null
  rounds: number
  rounds_cap: number
  designs?: number | null
  stop_reason: string | null
  review_from?: string | null
  accepted_at?: string | null
  artifacts: string[]
  updated: string
  root?: string
  store?: string
}

interface RoundRow {
  n: number
  generation?: number
  verdict?: string
  files: number
  designs?: number
  submittedAt?: string
  answeredAt?: string
  attempts?: number
  artifacts?: string[]
  judgeError?: string
  baseArtifact?: string
  dispatch?: { observedAt?: string }
  submissionState?: 'not_sent' | 'unknown'
}

interface GenerationRow {
  n: number
  createdAt: string
  rounds?: number
  reason?: string
  final?: string
}

interface ArtifactInfo {
  path: string
  kind: 'image' | 'demo' | 'code' | 'archive' | 'file'
}

interface TopicDetail extends TopicRow {
  created?: string
  generations?: GenerationRow[]
  artifact_details?: ArtifactInfo[]
  path?: string
  report?: string | null
  report_info?: { revision: string; updated: string; status: 'current' | 'stale' | 'unknown'; generation?: number; throughRound?: number } | null
  rounds_detail?: RoundRow[]
}

interface Viewer {
  kind: 'image' | 'frame' | 'text'
  title: string
  topicId?: string
  src?: string
  text?: string
  path?: string
}

type Tone = 'success' | 'capped' | 'review' | 'warn' | 'error' | 'active' | 'muted'
type Filter = 'all' | 'active' | 'attention' | 'done'
type Tab = 'overview' | 'rounds' | 'artifacts'
type DialogState =
  | { kind: 'regenerate' }
  | { kind: 'continue'; base?: { topicId: string; path: string } }
  | { kind: 'check'; conclusion: 'submitted' | 'not_submitted' | 'reopen' }

const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'active', label: '进行中' },
  { id: 'attention', label: '需处理' },
  { id: 'done', label: '已结束' },
]

const STATUS_LABEL: Record<string, string> = {
  draft: '草稿',
  queued: '排队',
  uploading: '上传中',
  submitted: '已提交',
  waiting: '等待答复',
  answered: '已答复',
  adjudicating: '裁决中',
  completed: '完成',
  capped: '待接受',
  reviewing: '待原会话判断',
  stalled: '卡住',
  failed: '失败',
  cancelled: '已取消',
}

const STATUS_TONE: Record<string, Tone> = {
  draft: 'muted',
  queued: 'active',
  uploading: 'active',
  submitted: 'active',
  waiting: 'active',
  answered: 'active',
  adjudicating: 'active',
  completed: 'success',
  capped: 'capped',
  reviewing: 'review',
  stalled: 'warn',
  failed: 'error',
  cancelled: 'muted',
}

const ACTIVE = new Set(['queued', 'uploading', 'submitted', 'waiting', 'answered', 'adjudicating'])
const ATTENTION = new Set(['capped', 'reviewing', 'stalled', 'failed'])
const DONE = new Set(['completed', 'cancelled'])

const STALL_LABEL: Record<string, string> = {
  login: '登录失效',
  upload: '材料上传不完整',
  timeout: '超时或无进展',
  ui: '页面结构变化',
  config: '配置或请求参数被拒',
  worker: '浏览器进程崩溃',
  unknown_submission: '提交状态未知',
}

let viewerRequest = 0
let showViewer: (view: Viewer | undefined) => void = () => {}

function toneOf(status: string): Tone {
  return STATUS_TONE[status] ?? 'muted'
}

function statusLabel(status: string): string {
  return STATUS_LABEL[status] ?? status
}

function attentionLabel(topic: Pick<TopicRow, 'status' | 'stall_reason'>): string | undefined {
  if (topic.status === 'capped' || topic.status === 'reviewing') return '待处理'
  if (topic.status === 'stalled') return '卡住'
  if (topic.status === 'failed') return '失败'
  return undefined
}

function channelLabel(channel: string | undefined): string | undefined {
  if (channel === undefined || channel === '') return undefined
  return channel === 'api' ? 'API 生图' : '网页会话'
}

function formatTime(value: string | undefined): string {
  if (value === undefined || value === '') return '—'
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return '时间未知'
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(date)
}

function formatRelative(value: string | undefined): string {
  if (value === undefined || value === '') return '—'
  const time = Date.now() - new Date(value).getTime()
  if (!Number.isFinite(time)) return formatTime(value)
  if (time < -60_000) return formatTime(value)
  const abs = Math.abs(time)
  if (abs < 60_000) return '刚刚'
  if (abs < 3_600_000) return `${Math.floor(abs / 60_000)} 分钟前`
  if (abs < 86_400_000) return `${Math.floor(abs / 3_600_000)} 小时前`
  if (abs < 7 * 86_400_000) return `${Math.floor(abs / 86_400_000)} 天前`
  return value.slice(0, 10)
}

function artifactName(path: string): string {
  return path.split('/').pop() ?? path
}

function roundOf(path: string): number | undefined {
  const match = path.match(/round-(\d+)/i)
  return match !== null ? Number(match[1]) : undefined
}

function artifactDisplayName(path: string): string {
  const round = roundOf(path)
  return round !== undefined ? `R${round} · ${artifactName(path)}` : artifactName(path)
}

function artifactKind(detail: TopicDetail, path: string): ArtifactInfo['kind'] {
  const known = detail.artifact_details?.find(item => item.path === path)
  if (known !== undefined) return known.kind
  if (/\.(png|jpe?g|webp|gif|svg)$/i.test(path)) return 'image'
  if (/\.html?$/i.test(path)) return 'demo'
  if (/\.zip$/i.test(path)) return 'archive'
  return 'code'
}

function imageArtifacts(detail: TopicDetail): string[] {
  return detail.artifacts
    .filter(path => artifactKind(detail, path) === 'image')
    .sort((left, right) => left.localeCompare(right))
}

function demoArtifacts(detail: TopicDetail): string[] {
  return detail.artifacts
    .filter(path => artifactKind(detail, path) === 'demo')
    .sort((left, right) => left.localeCompare(right))
}

function fileArtifacts(detail: TopicDetail): string[] {
  return detail.artifacts
    .filter(path => {
      const kind = artifactKind(detail, path)
      return kind !== 'image' && kind !== 'demo'
    })
    .sort((left, right) => left.localeCompare(right))
}

function generationList(detail: TopicDetail): GenerationRow[] {
  const generations = detail.generations !== undefined && detail.generations.length > 0
    ? [...detail.generations]
    : [{ n: 1, createdAt: detail.created ?? '', reason: '初始任务' }]
  return generations.sort((left, right) => left.n - right.n)
}

function latestFinal(detail: TopicDetail): string | undefined {
  const generations = [...generationList(detail)].reverse()
  for (const generation of generations) {
    if (generation.final !== undefined && generation.final !== '') return generation.final
  }
  return detail.artifacts.find(path => /(^|\/)final\.md$/i.test(path))
}

function generationRounds(detail: TopicDetail, generation: number): RoundRow[] {
  return (detail.rounds_detail ?? [])
    .filter(round => (round.generation ?? 1) === generation)
    .sort((left, right) => left.n - right.n)
}

function roundArtifacts(detail: TopicDetail, round: RoundRow): string[] {
  if (round.artifacts !== undefined) return round.artifacts
  const prefix = `/round-${String(round.n).padStart(2, '0')}/`
  return (detail.artifacts ?? []).filter(path => path.includes(prefix))
}

function generationLabel(generation: GenerationRow, rounds: RoundRow[]): string {
  const total = generation.rounds ?? rounds.length
  return `${rounds.length}/${total} 轮`
}

export function outcomeOf(round: RoundRow, status: string): { label: string; tone: string } {
  if (round.judgeError !== undefined) return { label: '裁决失败', tone: 'rejected' }
  if (round.verdict === 'accepted') return { label: '通过', tone: 'accepted' }
  if (round.verdict === 'partial') return { label: '部分通过', tone: 'partial' }
  if (round.verdict === 'rejected') return { label: '未通过', tone: 'rejected' }
  if (round.answeredAt !== undefined) return { label: '已答复', tone: 'answered' }
  if (round.submissionState === 'not_sent') return { label: '未发送', tone: 'pending' }
  if (!ACTIVE.has(status)) {
    if (round.submittedAt !== undefined) return { label: '待恢复', tone: 'pending' }
    if (round.dispatch !== undefined || round.submissionState === 'unknown') return { label: '提交待核对', tone: 'pending' }
    return { label: '未提交', tone: 'pending' }
  }
  return { label: '进行中', tone: 'pending' }
}

async function getJson<T>(url: string, timeoutMs = 15_000): Promise<T> {
  // A hung fetch used to leave listInFlight/detailInFlight set forever, which
  // froze polling and disabled every action button with no error state.
  const response = await fetch(url, {
    headers: { accept: 'application/json' },
    cache: 'no-store',
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
  return await response.json() as T
}

async function postAction<T>(body: Record<string, unknown>, timeoutMs = 30_000): Promise<T> {
  const response = await fetch(`${config.routes}/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    let message = text === '' ? `${response.status}` : text
    try {
      const parsed = JSON.parse(text) as { error?: unknown }
      if (typeof parsed.error === 'string') message = parsed.error
    } catch {
      // Non-JSON error body: keep the raw text.
    }
    throw new Error(message)
  }
  return await response.json() as T
}

async function copyText(text: string): Promise<void> {
  if (navigator.clipboard === undefined) throw new Error('当前环境不支持剪贴板')
  await navigator.clipboard.writeText(text)
}

async function copyImage(src: string): Promise<void> {
  if (navigator.clipboard === undefined || typeof ClipboardItem === 'undefined') {
    throw new Error('当前环境不支持复制图片')
  }
  const response = await fetch(src)
  if (!response.ok) throw new Error(`读取图片失败：${response.status}`)
  const blob = await response.blob()
  let png = blob
  if (blob.type !== 'image/png') {
    const bitmap = await createImageBitmap(blob)
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const context = canvas.getContext('2d')
    if (context === null) throw new Error('无法转换图片')
    context.drawImage(bitmap, 0, 0)
    png = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(candidate => candidate === null ? reject(new Error('无法转换图片')) : resolve(candidate), 'image/png')
    })
  }
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })])
}

function fullPath(base: string | undefined, path: string): string {
  if (base === undefined || base === '') return path
  const separator = base.includes('\\') ? '\\' : '/'
  return `${base.replace(/[\\/]+$/, '')}${separator}${path.replace(/[\\/]/g, separator)}`
}

async function openArtifact(topicId: string, path: string, reveal: boolean): Promise<void> {
  const response = await fetch(`${config.routes}/open`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ topic_id: topicId, path, reveal }),
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    let message = text === '' ? `${response.status}` : text
    try {
      const parsed = JSON.parse(text) as { error?: unknown }
      if (typeof parsed.error === 'string') message = parsed.error
    } catch {
      // Keep the raw body.
    }
    throw new Error(message)
  }
}

function assetUrl(topicId: string, path: string): string {
  return `${config.routes}/asset?id=${encodeURIComponent(topicId)}&path=${encodeURIComponent(path)}`
}

function rawUrl(topicId: string, path: string): string {
  const encoded = path.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/')
  return `${config.routes}/raw/${encodeURIComponent(topicId)}/${encoded}`
}

function bundleUrl(topicId: string, round: number): string {
  return `${config.routes}/bundle?id=${encodeURIComponent(topicId)}&round=${round}`
}

function openViewerImage(topicId: string, path: string): void {
  viewerRequest++
  showViewer({ kind: 'image', title: artifactDisplayName(path), topicId, src: assetUrl(topicId, path), path })
}

function openFrame(view: Viewer): void {
  viewerRequest++
  showViewer(view)
}

async function openTextViewer(topicId: string, title: string, url: string, path?: string): Promise<void> {
  const request = ++viewerRequest
  showViewer({ kind: 'text', title, topicId, text: '正在读取…', path })
  try {
    const text = await fetchText(url)
    if (request === viewerRequest) showViewer({ kind: 'text', title, topicId, text, path })
  } catch (cause) {
    if (request === viewerRequest) showViewer({ kind: 'text', title: `读取失败 · ${title}`, topicId, text: cause instanceof Error ? cause.message : String(cause), path })
  }
}

async function openTopicFile(topicId: string, path: string): Promise<void> {
  await openTextViewer(topicId, artifactName(path), `${config.routes}/file?id=${encodeURIComponent(topicId)}&path=${encodeURIComponent(path)}`, path)
}

async function openAnswer(topicId: string, round: number): Promise<void> {
  await openTextViewer(topicId, `第 ${round} 轮回答`, `${config.routes}/answer?id=${encodeURIComponent(topicId)}&round=${round}`)
}

async function fetchText(url: string, signal?: AbortSignal): Promise<string> {
  const response = await fetch(url, { signal, headers: { accept: 'text/plain, text/markdown' } })
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
  return await response.text()
}

function closeMenu(event: { currentTarget: HTMLButtonElement }): void {
  event.currentTarget.closest('details')?.removeAttribute('open')
}

type GlyphName =
  | 'search'
  | 'chevron'
  | 'file'
  | 'image'
  | 'demo'
  | 'copy'
  | 'external'
  | 'more'
  | 'check'
  | 'clock'
  | 'alert'
  | 'folder'
  | 'download'
  | 'close'
  | 'arrow'

function Glyph({ name, size = 14 }: { name: GlyphName; size?: number }): ReactNode {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.6,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  }
  switch (name) {
    case 'search':
      return <svg {...common}><circle cx="7" cy="7" r="4.2" /><path d="m10.3 10.3 3.2 3.2" /></svg>
    case 'chevron':
      return <svg {...common}><path d="m6 4 4 4-4 4" /></svg>
    case 'file':
      return <svg {...common}><path d="M4 1.8h5l3 3v9.4H4z" /><path d="M9 1.8v3h3" /></svg>
    case 'image':
      return <svg {...common}><rect x="2" y="3" width="12" height="10" rx="1.5" /><circle cx="5.5" cy="6.5" r="1" /><path d="m3 12 3.5-3.5 2.5 2.5 2-2 2 2" /></svg>
    case 'demo':
      return <svg {...common}><rect x="2" y="3" width="12" height="10" rx="1.5" /><path d="M2 6h12" /><circle cx="4.2" cy="4.5" r=".45" fill="currentColor" stroke="none" /><circle cx="5.8" cy="4.5" r=".45" fill="currentColor" stroke="none" /></svg>
    case 'copy':
      return <svg {...common}><rect x="5" y="5" width="8" height="8" rx="1" /><path d="M3 11V3h8" /></svg>
    case 'external':
      return <svg {...common}><path d="M9 3h4v4" /><path d="m13 3-6 6" /><path d="M11 9v3H3V4h3" /></svg>
    case 'more':
      return <svg {...common}><circle cx="3.5" cy="8" r=".8" fill="currentColor" stroke="none" /><circle cx="8" cy="8" r=".8" fill="currentColor" stroke="none" /><circle cx="12.5" cy="8" r=".8" fill="currentColor" stroke="none" /></svg>
    case 'check':
      return <svg {...common}><path d="m3 8 3 3 7-7" /></svg>
    case 'clock':
      return <svg {...common}><circle cx="8" cy="8" r="5.5" /><path d="M8 4.5V8l2.3 1.4" /></svg>
    case 'alert':
      return <svg {...common}><path d="M8 2 14 13H2z" /><path d="M8 6v3" /><circle cx="8" cy="11" r=".55" fill="currentColor" stroke="none" /></svg>
    case 'folder':
      return <svg {...common}><path d="M2 4h5l1.5 2H14v7H2z" /></svg>
    case 'download':
      return <svg {...common}><path d="M8 2v8" /><path d="m4.5 7 3.5 3.5L11.5 7" /><path d="M3 13h10" /></svg>
    case 'close':
      return <svg {...common}><path d="m4 4 8 8M12 4l-8 8" /></svg>
    case 'arrow':
      return <svg {...common}><path d="M3 8h10" /><path d="m9 4 4 4-4 4" /></svg>
  }
}

function artifactGlyph(kind: ArtifactInfo['kind']): GlyphName {
  if (kind === 'image') return 'image'
  if (kind === 'demo') return 'demo'
  if (kind === 'archive') return 'download'
  return 'file'
}

function StatusPill({ status }: { status: string }): ReactNode {
  return <span className="dshpro-status" data-tone={toneOf(status)}>{statusLabel(status)}</span>
}



function ListSkeleton(): ReactNode {
  return (
    <div role="status" aria-label="正在加载任务">
      {[0, 1, 2, 3].map(index => (
        <div className="dshpro-list-skeleton" key={index}>
          <div className="dshpro-skeleton" style={{ height: 12, width: `${72 - index * 6}%` }} />
          <div className="dshpro-skeleton" style={{ height: 9, width: '58%', marginTop: 7 }} />
        </div>
      ))}
    </div>
  )
}

function DetailSkeleton(): ReactNode {
  return (
    <div>
      <div className="dshpro-card">
        <div className="dshpro-skeleton" style={{ height: 22, width: '48%' }} />
        <div className="dshpro-skeleton" style={{ height: 11, width: '70%', marginTop: 10 }} />
        <div className="dshpro-skeleton" style={{ height: 11, width: '42%', marginTop: 7 }} />
        <div className="dshpro-skeleton" style={{ height: 28, width: '260px', marginTop: 14 }} />
      </div>
      <div className="dshpro-card">
        <div className="dshpro-skeleton" style={{ height: 13, width: '30%' }} />
        <div className="dshpro-skeleton" style={{ height: 120, width: '100%', marginTop: 12 }} />
      </div>
    </div>
  )
}

function EmptyDetail({ design }: { design: boolean }): ReactNode {
  return (
    <div className="dshpro-empty-detail">
      <div className="dshpro-empty-mark">{design ? 'D' : 'R'}</div>
      <strong>{design ? '选择左侧的设计主题' : '选择左侧的研究主题'}</strong>
      <span>{design ? '列表里会显示状态、轮次和产物；点开后有图片、demo 和文件。' : '列表里会显示状态、轮次和产物；点开后有轮次、裁决、运行汇总和交付稿。'}</span>
    </div>
  )
}

function FinalCard({ detail, path }: { detail: TopicDetail; path: string }): ReactNode {
  return (
    <div className="dshpro-final">
      <div className="dshpro-final-icon"><Glyph name="file" size={17} /></div>
      <div className="dshpro-final-info">
        <div className="dshpro-final-title">{summaryLabel(detail, path)}</div>
        <div className="dshpro-final-path" title={path}>{artifactName(path)}</div>
        <div className="dshpro-final-desc">{path === detail.report ? '宿主整理 · 点击阅读全文' : '自动生成 · 点击阅读全文'}</div>
      </div>
      <button type="button" className="dshpro-btn small" onClick={() => { void openTopicFile(detail.topic_id, path) }}>查看</button>
    </div>
  )
}

function ArtifactRow({ detail, path }: { detail: TopicDetail; path: string }): ReactNode {
  const kind = artifactKind(detail, path)
  const name = artifactName(path)
  return (
    <div className="dshpro-file">
      <div className="dshpro-file-icon"><Glyph name={artifactGlyph(kind)} size={15} /></div>
      <div className="dshpro-file-info">
        <div className="dshpro-file-name" title={path}>{name}</div>
        <div className="dshpro-file-path" title={path}>{path}</div>
      </div>
      <div className="dshpro-file-actions">
        {kind === 'image' && <button type="button" className="dshpro-btn small" onClick={() => openViewerImage(detail.topic_id, path)}>查看</button>}
        {kind === 'demo' && <button type="button" className="dshpro-btn small" onClick={() => openFrame({ kind: 'frame', title: name, topicId: detail.topic_id, src: rawUrl(detail.topic_id, path), path })}>预览</button>}
        {kind === 'archive' && <a className="dshpro-btn small" href={assetUrl(detail.topic_id, path)} download={name}>下载</a>}
        {(kind === 'code' || kind === 'file') && <button type="button" className="dshpro-btn small" onClick={() => { void openTopicFile(detail.topic_id, path) }}>查看</button>}
      </div>
    </div>
  )
}

function ArtifactLink({ detail, path }: { detail: TopicDetail; path: string }): ReactNode {
  const kind = artifactKind(detail, path)
  const name = artifactName(path)
  if (kind === 'image') {
    return <button type="button" className="dshpro-chip" onClick={() => openViewerImage(detail.topic_id, path)}>{name}</button>
  }
  if (kind === 'demo') {
    return <button type="button" className="dshpro-chip" onClick={() => openFrame({ kind: 'frame', title: name, topicId: detail.topic_id, src: rawUrl(detail.topic_id, path), path })}>{name} ↗</button>
  }
  if (kind === 'archive') {
    return <a className="dshpro-chip" href={assetUrl(detail.topic_id, path)} download={name}>{name}</a>
  }
  return <button type="button" className="dshpro-chip" onClick={() => { void openTopicFile(detail.topic_id, path) }}>{name}</button>
}

function RoundTable({ detail, rounds, generation }: { detail: TopicDetail; rounds: RoundRow[]; generation: number }): ReactNode {
  return (
    <div className="dshpro-table-region">
      <div className="dshpro-table-hint">可横向滚动查看完整记录</div>
      <div className="dshpro-table-wrap" tabIndex={0} role="region" aria-label="轮次记录，可横向滚动">
      <table className="dshpro-table">
        <thead>
          <tr>
            <th>轮次</th>
            <th>裁决</th>
            <th className="dshpro-optional">附件</th>
            <th>提交</th>
            <th>完成</th>
            <th className="dshpro-optional">重试</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {rounds.map((round, index) => {
            const label = `${generation}-${index + 1}`
            const artifacts = roundArtifacts(detail, round)
            const images = artifacts.filter(path => artifactKind(detail, path) === 'image')
            const files = artifacts.filter(path => artifactKind(detail, path) !== 'image')
            const outcome = outcomeOf(round, detail.status)
            const attempts = round.attempts ?? 1
            return [
              <tr key={`round-${round.n}`}>
                <td className="dshpro-num">{label}</td>
                <td><span className="dshpro-verdict" data-verdict={outcome.tone}>{outcome.label}</span></td>
                <td className="dshpro-optional">{round.files}</td>
                <td className="dshpro-nowrap dshpro-dim">{formatTime(round.submittedAt)}</td>
                <td className="dshpro-nowrap dshpro-dim">{round.answeredAt !== undefined ? formatTime(round.answeredAt) : ACTIVE.has(detail.status) ? '进行中' : '—'}</td>
                <td className="dshpro-optional dshpro-dim">{attempts > 1 ? attempts - 1 : '—'}</td>
                <td>
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                    <button type="button" className="dshpro-btn small" disabled={round.answeredAt === undefined} onClick={() => { void openAnswer(detail.topic_id, round.n) }}>查看回答</button>
                    {round.verdict !== undefined || round.judgeError !== undefined ? (
                      <button type="button" className="dshpro-btn small" onClick={() => { void openTopicFile(detail.topic_id, `rounds/${String(round.n).padStart(2, '0')}-verdict.md`) }}>裁决</button>
                    ) : null}
                    {artifacts.length > 0 && <a className="dshpro-btn small" href={bundleUrl(detail.topic_id, round.n)} download={`round-${String(round.n).padStart(2, '0')}.zip`}>下载 ZIP</a>}
                    {round.baseArtifact !== undefined && <button type="button" className="dshpro-btn small" onClick={() => openViewerImage(detail.topic_id, round.baseArtifact as string)}>查看底图</button>}
                  </div>
                </td>
              </tr>,
              artifacts.length > 0 ? (
                <tr key={`artifacts-${round.n}`}>
                  <td className="dshpro-artifacts-cell" colSpan={7}>
                    {images.length > 0 && (
                      <div className="dshpro-thumbs">
                        {images.map(path => (
                          <button key={path} type="button" className="dshpro-thumb" title={artifactDisplayName(path)} onClick={() => openViewerImage(detail.topic_id, path)}>
                            <img src={assetUrl(detail.topic_id, path)} alt={artifactDisplayName(path)} loading="lazy" />
                          </button>
                        ))}
                      </div>
                    )}
                    {files.length > 0 && (
                      <div className="dshpro-chips">
                        {files.map(path => <ArtifactLink key={path} detail={detail} path={path} />)}
                      </div>
                    )}
                  </td>
                </tr>
              ) : null,
            ]
          })}
        </tbody>
      </table>
      </div>
    </div>
  )
}

function RoundsView({ detail }: { detail: TopicDetail }): ReactNode {
  const generations = generationList(detail)
  return (
    <div>
      {generations.map(generation => {
        const rounds = generationRounds(detail, generation.n)
        return (
          <section className="dshpro-round-card" key={generation.n}>
            <div className="dshpro-round-head">
              <div>
                <div className="dshpro-round-title">第 {generation.n} 版</div>
                <div className="dshpro-round-sub">
                  {generation.reason !== undefined && generation.reason !== '' ? `${generation.reason} · ` : ''}
                  {formatTime(generation.createdAt)} · {generationLabel(generation, rounds)}
                </div>
              </div>
              {generation.final !== undefined && generation.final !== '' && (
                <button type="button" className="dshpro-btn small" onClick={() => { void openTopicFile(detail.topic_id, generation.final as string) }}>本版运行汇总</button>
              )}
            </div>
            {rounds.length > 0 ? <RoundTable detail={detail} rounds={rounds} generation={generation.n} /> : <div className="dshpro-empty-inline">等待提交…</div>}
          </section>
        )
      })}
      {generations.length === 0 && <div className="dshpro-empty-inline">还没有提交记录。</div>}
    </div>
  )
}

function summaryLabel(detail: TopicDetail, path: string): string {
  if (path === detail.report) return '宿主交付稿'
  const source = generationList(detail).find(item => item.final === path)
  return source !== undefined ? `第 ${source.n} 版总结` : '已有总结 · 版本未确认'
}

function ResearchOverview({ detail, onTab }: { detail: TopicDetail; onTab: (tab: Tab) => void }): ReactNode {
  const report = detail.report ?? undefined
  const generated = latestFinal(detail)
  const path = report ?? generated
  const isReport = report !== undefined
  const source = `${detail.topic_id}:${path ?? ''}:${isReport ? detail.report_info?.revision ?? '' : ''}`
  const [document, setDocument] = useState<{ source: string; text?: string; error?: string }>()
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    if (path === undefined) return
    const abort = new AbortController()
    setDocument({ source })
    void fetchText(`${config.routes}/file?id=${encodeURIComponent(detail.topic_id)}&path=${encodeURIComponent(path)}`, abort.signal)
      .then(text => { if (!abort.signal.aborted) setDocument({ source, text: text.replace(/^\s*<!--\s*dsh-pro-report:[\s\S]*?-->\s*/, '') }) })
      .catch((error: unknown) => {
        if (!abort.signal.aborted) setDocument({ source, error: error instanceof Error ? error.message : String(error) })
      })
    return () => abort.abort()
  }, [source, detail.updated, retry])
  const current = document?.source === source ? document : undefined
  const generations = generationList(detail)
  const latest = generations.at(-1)
  const previous = !isReport && path !== undefined && latest !== undefined && latest.final !== path
  const title = path === undefined ? '运行汇总尚未生成' : isReport ? '宿主交付稿' : '运行汇总（自动生成）'
  return (
    <section className="dshpro-document-card">
      <div className="dshpro-section-heading">
        <div><span className="dshpro-eyebrow">{isReport ? '交付稿' : '运行汇总'}</span><h3>{title}</h3></div>
        {path !== undefined && <button type="button" className="dshpro-btn" onClick={() => { void openTopicFile(detail.topic_id, path) }}>阅读全文 <Glyph name="arrow" /></button>}
      </div>
      {isReport && <div className="dshpro-report-source" data-state={detail.report_info?.status ?? 'unknown'}>
        <strong>{detail.report_info?.status === 'current' ? '已覆盖当前轮次' : detail.report_info?.status === 'stale' ? '交付稿待更新' : '覆盖范围未确认'}</strong>
        <span>{detail.report_info?.throughRound !== undefined ? `第 ${detail.report_info.generation} 版 · 覆盖至第 ${detail.report_info.throughRound} 轮` : '旧稿未记录来源，请对照运行记录核实。'}{detail.report_info?.updated !== undefined ? ` · 文稿更新 ${formatTime(detail.report_info.updated)}` : ''}</span>
        {detail.report_info?.throughRound !== undefined && <div className="dshpro-source-actions">
          <button type="button" className="dshpro-btn small" onClick={() => { void openAnswer(detail.topic_id, detail.report_info?.throughRound as number) }}>来源回答</button>
          <button type="button" className="dshpro-btn small" onClick={() => { void openTopicFile(detail.topic_id, `rounds/${String(detail.report_info?.throughRound).padStart(2, '0')}-verdict.md`) }}>来源裁决</button>
        </div>}
      </div>}
      {path === undefined ? <div className="dshpro-content-empty"><Glyph name="file" size={28} /><strong>这里将呈现运行汇总</strong><span>已有轮次的回答可在运行记录中查看；宿主整理后会生成交付稿 report.md，并优先显示在这里。</span><button className="dshpro-btn" type="button" onClick={() => onTab('rounds')}>查看运行记录</button></div> : <>
        <div className="dshpro-document-context">
          {isReport
            ? '宿主按判据整理的交付稿；结论和证据仍应回到轮次与原始答复核对。'
            : '自动生成的运行汇总，不是交付稿；宿主交付稿 report.md 尚未生成。'}
          {previous ? '当前版本尚无已关联总结，以下为已有文档。' : ''}
          {detail.accepted_at ? '当前结果已人工接受。' : detail.status === 'cancelled' || detail.status === 'failed' || detail.status === 'stalled' || detail.status === 'reviewing' ? '任务未正常结束，请核对内容与完整性。' : '任务状态不代表人工验收。'}
        </div>
        {current?.error !== undefined ? <div className="dshpro-content-empty" role="alert"><strong>暂时无法读取文档</strong><span>{current.error}</span><button type="button" className="dshpro-btn" onClick={() => setRetry(value => value + 1)}>重新加载</button></div>
          : current?.text === undefined ? <div className="dshpro-document-loading" role="status" aria-label="正在读取文档"><div className="dshpro-skeleton" /><div className="dshpro-skeleton" /><div className="dshpro-skeleton" /></div>
            : current.text.trim() === '' ? <div className="dshpro-content-empty">此文件暂无内容。</div>
              : <DocumentContent text={current.text.slice(0, 18000)} />}
        {current?.text !== undefined && current.text.length > 18000 && <button type="button" className="dshpro-btn" onClick={() => { void openTopicFile(detail.topic_id, path) }}>继续阅读全文</button>}
      </>}
    </section>
  )
}

function ArtifactImage({ detail, path, onRefine }: { detail: TopicDetail; path: string; onRefine?: (path: string) => void }): ReactNode {
  const [failed, setFailed] = useState(false)
  const [retry, setRetry] = useState(0)
  const source = assetUrl(detail.topic_id, path)
  useEffect(() => { setFailed(false); setRetry(0) }, [source])
  return <div className="dshpro-art-frame">
    {failed ? <div className="dshpro-image-error"><Glyph name="image" size={24} /><span>图片加载失败</span><button type="button" className="dshpro-btn small" onClick={() => { setFailed(false); setRetry(value => value + 1) }}>重新加载</button></div>
      : <button type="button" className="dshpro-art" title={`查看 ${artifactDisplayName(path)}`} onClick={() => openViewerImage(detail.topic_id, path)}><img src={`${source}&v=${retry}`} alt={artifactDisplayName(path)} loading="lazy" onError={() => setFailed(true)} /></button>}
    <div className="dshpro-art-caption"><Glyph name="image" /><span title={path}>{artifactDisplayName(path)}</span></div>
    {onRefine !== undefined && /\.(png|jpe?g|webp)$/i.test(path) && detail.rounds_detail?.some(round => round.artifacts?.includes(path)) && <div className="dshpro-art-actions"><button type="button" className="dshpro-btn small" disabled={failed || detail.image_edit_enabled === false} title={detail.image_edit_enabled === false ? 'imageEdit=off：参考图编辑已关闭' : '以所选图片为底图，只修改本轮要求的内容'} onClick={() => onRefine(path)}>以这张继续改</button></div>}
  </div>
}

function DemoCard({ detail, path }: { detail: TopicDetail; path: string }): ReactNode {
  const name = artifactName(path)
  return (
    <div className="dshpro-demo">
      <div className="dshpro-demo-meta">
        <div className="dshpro-file-info">
          <div className="dshpro-file-name" title={path}>{name}</div>
          <div className="dshpro-file-path">{roundOf(path) !== undefined ? `第 ${roundOf(path)} 轮 · ` : '来源轮次未确认 · '}HTML 交互演示</div>
        </div>
        <div className="dshpro-demo-actions">
          <button type="button" className="dshpro-btn small" onClick={() => openFrame({ kind: 'frame', title: name, topicId: detail.topic_id, src: rawUrl(detail.topic_id, path), path })}>预览</button>
          <button type="button" className="dshpro-btn small" onClick={() => { window.open(rawUrl(detail.topic_id, path), '_blank', 'noopener,noreferrer') }}>新窗口</button>
        </div>
      </div>
    </div>
  )
}

function DesignOverview({ detail, onTab, onRefine }: { detail: TopicDetail; onTab: (tab: Tab) => void; onRefine?: (path: string) => void }): ReactNode {
  const generation = generationList(detail).at(-1)
  const round = generation === undefined ? undefined : generationRounds(detail, generation.n).at(-1)
  const artifacts = round === undefined ? [] : roundArtifacts(detail, round)
  const images = artifacts.filter(path => artifactKind(detail, path) === 'image')
  const demos = artifacts.filter(path => artifactKind(detail, path) === 'demo')
  const expected = round?.designs ?? detail.designs ?? 3
  const visualStatus = detail.accepted_at ? '当前结果已人工接受' : '视觉待人工确认'
  const pipeline = round === undefined
    ? '等待本轮结果。'
    : detail.channel === 'api'
      ? `图片通道：本轮取回 ${images.length}/${expected} 张；只产出图片，不产出 HTML demo；${visualStatus}。`
      : `本轮取回 ${images.length}/${expected} 张图；${demos.length > 0 ? `HTML demo ${demos.length} 个` : 'HTML 未取回'}；${visualStatus}。`
  return <div>
    <section className="dshpro-design-sheet">
      <div className="dshpro-section-heading">
        <div><span className="dshpro-eyebrow">设计成果{generation !== undefined ? ` / 第 ${generation.n} 版` : ''}</span><h3>{round !== undefined ? `第 ${round.n} 轮图片` : '等待本版设计'} <span className="dshpro-muted">{images.length > 0 ? `· ${images.length} 张` : ''}</span></h3></div>
        <button type="button" className="dshpro-btn ghost" onClick={() => onTab('artifacts')}>全部产物 <Glyph name="arrow" /></button>
      </div>
      <div className="dshpro-document-context">{pipeline}</div>
      {images.length > 0 ? <div className="dshpro-gallery">{images.map(path => <ArtifactImage key={path} detail={detail} path={path} onRefine={onRefine} />)}</div>
        : <div className="dshpro-content-empty"><Glyph name="image" size={32} /><strong>本轮还没有图片</strong><span>生成的设计图将在这里完整呈现。</span>{imageArtifacts(detail).length > 0 && <button type="button" className="dshpro-btn" onClick={() => onTab('artifacts')}>查看历史图片（{imageArtifacts(detail).length}）</button>}</div>}
    </section>
    {demos.length > 0 && <section className="dshpro-card"><div className="dshpro-card-head"><h3 className="dshpro-card-title">本轮交互演示</h3></div>{demos.map(path => <DemoCard key={path} detail={detail} path={path} />)}</section>}
    {detail.report != null ? <ResearchOverview detail={detail} onTab={onTab} />
      : <section className="dshpro-card"><p className="dshpro-muted">宿主尚未整理交付稿 design.md；图片取回与任务完成不代表视觉验收通过。</p></section>}
  </div>
}

function ArtifactsView({ detail, onRefine }: { detail: TopicDetail; onRefine?: (path: string) => void }): ReactNode {
  const final = latestFinal(detail)
  const report = detail.report ?? undefined
  if (!config.designMode) {
    const groups = new Map<string, string[]>()
    for (const path of detail.artifacts) {
      if (path === final || path === report || (final !== undefined && path === 'final.md')) continue
      const match = path.match(/round-(\d+)/i)
      const key = match !== null ? `第 ${Number(match[1])} 轮` : '主题文件'
      const list = groups.get(key) ?? []
      list.push(path)
      groups.set(key, list)
    }
    const entries = [...groups.entries()].sort((left, right) => {
      const leftNumber = Number(left[0].match(/\d+/)?.[0] ?? 999)
      const rightNumber = Number(right[0].match(/\d+/)?.[0] ?? 999)
      return leftNumber - rightNumber
    })
    return (
      <div>
        {report !== undefined && (
          <section className="dshpro-card">
            <div className="dshpro-card-head"><div className="dshpro-card-title">宿主交付稿</div></div>
            <FinalCard detail={detail} path={report} />
          </section>
        )}
        {final !== undefined && (
          <section className="dshpro-card">
            <div className="dshpro-card-head"><div className="dshpro-card-title">运行汇总（自动生成）</div></div>
            <FinalCard detail={detail} path={final} />
          </section>
        )}
        {entries.map(([label, paths]) => (
          <section className="dshpro-card" key={label}>
            <div className="dshpro-card-head">
              <div className="dshpro-card-title">{label}</div>
              <span className="dshpro-faint" style={{ fontSize: 10 }}>{paths.length} 个文件</span>
            </div>
            <div className="dshpro-file-list">
              {paths.map(path => <ArtifactRow key={path} detail={detail} path={path} />)}
            </div>
          </section>
        ))}
        {detail.artifacts.length === 0 && <div className="dshpro-card"><div className="dshpro-empty-inline">还没有产物。</div></div>}
      </div>
    )
  }
  const images = imageArtifacts(detail)
  const demos = demoArtifacts(detail)
  const files = fileArtifacts(detail)
  return (
    <div>
      {report !== undefined && <section className="dshpro-card">
        <div className="dshpro-card-head"><div className="dshpro-card-title">宿主交付稿</div></div>
        <FinalCard detail={detail} path={report} />
      </section>}
      {images.length > 0 && (
        <section className="dshpro-card">
          <div className="dshpro-card-head">
            <div className="dshpro-card-title">全部图片 <span className="dshpro-faint">({images.length})</span></div>
          </div>
          <div className="dshpro-gallery">
            {images.map(path => (
              <ArtifactImage key={path} detail={detail} path={path} onRefine={onRefine} />
            ))}
          </div>
        </section>
      )}
      {demos.length > 0 && (
        <section className="dshpro-card">
          <div className="dshpro-card-head"><div className="dshpro-card-title">前端 demo <span className="dshpro-faint">({demos.length})</span></div></div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {demos.map(path => <DemoCard key={path} detail={detail} path={path} />)}
          </div>
        </section>
      )}
      {files.length > 0 && (
        <section className="dshpro-card">
          <div className="dshpro-card-head"><div className="dshpro-card-title">代码与文件 <span className="dshpro-faint">({files.length})</span></div></div>
          <div className="dshpro-file-list">
            {files.map(path => <ArtifactRow key={path} detail={detail} path={path} />)}
          </div>
        </section>
      )}
      {detail.artifacts.length === 0 && <div className="dshpro-card"><div className="dshpro-empty-inline">还没有产物。</div></div>}
    </div>
  )
}

function MetaCard({ detail }: { detail: TopicDetail }): ReactNode {
  const [copied, setCopied] = useState('')
  return <details className="dshpro-context" key={detail.topic_id}>
    <summary><Glyph name="folder" />主题信息<Glyph name="chevron" /></summary>
    <div className="dshpro-context-body"><dl className="dshpro-meta-grid">
      <div><dt>类型</dt><dd>{detail.type === 'design' ? '设计' : '研究'}</dd></div>
      <div><dt>通道</dt><dd>{channelLabel(detail.channel) ?? '—'}</dd></div>
      <div><dt>模型</dt><dd>{detail.model || '—'}</dd></div>
      <div><dt>存储</dt><dd>{detail.store === 'local' ? '本机' : '项目'}</dd></div>
      <div><dt>创建</dt><dd>{formatTime(detail.created)}</dd></div>
      <div><dt>更新</dt><dd>{formatTime(detail.updated)}</dd></div>
    </dl>
    {detail.stop_reason && <p className="dshpro-context-note">停止依据：{detail.stop_reason}</p>}
    {detail.path && <div className="dshpro-context-path"><span>{detail.path}</span><button type="button" className="dshpro-btn small" onClick={() => { void copyText(detail.path as string).then(() => setCopied('已复制')).catch(() => setCopied('复制失败')) }}><Glyph name="copy" />复制路径</button><span role="status">{copied}</span></div>}
    </div>
  </details>
}

function Rail({ detail, onTab }: { detail: TopicDetail; onTab: (tab: Tab) => void }): ReactNode {
  const rounds = [...(detail.rounds_detail ?? [])].sort((a, b) => b.n - a.n).slice(0, 3)
  return <aside className="dshpro-rail" aria-label="运行摘要">
    <section className="dshpro-activity">
      <div className="dshpro-card-head"><h3 className="dshpro-card-title">最近活动</h3><button type="button" className="dshpro-card-link" onClick={() => onTab('rounds')}>全部记录</button></div>
      {rounds.length === 0 ? <p className="dshpro-muted">尚无提交记录</p> : <ol>{rounds.map(round => {
        const outcome = outcomeOf(round, detail.status)
        return <li key={round.n}><span className="dshpro-activity-dot" /><div className="dshpro-activity-heading"><strong>第 {round.generation ?? 1} 版 · 第 {round.n} 轮</strong><span className="dshpro-verdict" data-verdict={outcome.tone}>{outcome.label}</span></div><time>{formatTime(round.answeredAt ?? round.submittedAt)}</time><div className="dshpro-activity-actions"><span>{round.files} 个附件</span><button type="button" className="dshpro-card-link" disabled={round.answeredAt === undefined} onClick={() => { void openAnswer(detail.topic_id, round.n) }}>查看回答 <Glyph name="arrow" size={12} /></button></div></li>
      })}</ol>}
    </section>
    <button type="button" className="dshpro-artifact-index" onClick={() => onTab('artifacts')}><Glyph name="folder" size={17} /><span>产物索引<small>{detail.artifacts.length} 个已保存文件</small></span><Glyph name="chevron" /></button>
    <MetaCard key={detail.topic_id} detail={detail} />
  </aside>
}

function useModal(): React.RefObject<HTMLDialogElement> {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
    const dialog = ref.current
    dialog?.showModal()
    const first = dialog?.querySelector<HTMLElement>('textarea') ?? dialog?.querySelector<HTMLElement>('button')
    first?.focus()
    return () => { dialog?.close(); if (previous?.isConnected && !previous.matches(':disabled')) previous.focus() }
  }, [])
  return ref
}

function ViewerModal({ view, basePath, onClose }: { view: Viewer; basePath?: string; onClose: () => void }): ReactNode {
  const modal = useModal()
  const frame = useRef<HTMLIFrameElement>(null)
  const [notice, setNotice] = useState<string | undefined>(undefined)
  useEffect(() => { setNotice(undefined) }, [view])
  useEffect(() => {
    if (view.kind !== 'frame') return
    const closeFromFrame = (event: MessageEvent): void => {
      // Sandboxed HTML has an opaque origin. Bind the signal to this exact
      // frame instead of trusting an origin string or arbitrary messages.
      if (frame.current?.contentWindow != null && event.source === frame.current.contentWindow
        && event.data?.type === PREVIEW_ESCAPE_MESSAGE) onClose()
    }
    window.addEventListener('message', closeFromFrame)
    return () => window.removeEventListener('message', closeFromFrame)
  }, [view.kind, onClose])
  const run = (task: () => Promise<void>, success: string): void => {
    setNotice('处理中…')
    void task()
      .then(() => setNotice(success))
      .catch((error: unknown) => setNotice(error instanceof Error ? error.message : String(error)))
  }
  const path = view.path
  const native = path !== undefined ? fullPath(basePath, path) : undefined
  return (
    <dialog ref={modal} className="dshpro-overlay is-viewer" aria-label={view.title} onCancel={event => { event.preventDefault(); onClose() }} onClick={onClose}>
      <div className="dshpro-modal-card" onClick={event => event.stopPropagation()}>
        <div className="dshpro-modal-head">
          <div className="dshpro-modal-title" title={view.title}>{view.title}</div>
          <button type="button" className="dshpro-icon-btn" onClick={onClose} aria-label="关闭"><Glyph name="close" size={15} /></button>
        </div>
        <div className="dshpro-modal-body">
          {view.kind === 'image' && view.src !== undefined && <img src={view.src} alt={view.title} />}
          {view.kind === 'frame' && view.src !== undefined && <iframe ref={frame} src={`${view.src}${view.src.includes('?') ? '&' : '?'}preview=1`} sandbox="allow-scripts" title={view.title} />}
          {view.kind === 'text' && <pre>{view.text ?? ''}</pre>}
        </div>
        <div className="dshpro-modal-foot">
          {view.kind === 'image' && view.src !== undefined && (
            <button type="button" className="dshpro-btn small" onClick={() => run(() => copyImage(view.src as string), '图片已复制到剪贴板')}>复制图片</button>
          )}
          {native !== undefined && (
            <button type="button" className="dshpro-btn small" onClick={() => run(() => copyText(native), '文件路径已复制')}>复制路径</button>
          )}
          {view.kind === 'frame' && view.src !== undefined && (
            <button type="button" className="dshpro-btn small" onClick={() => { window.open(view.src as string, '_blank', 'noopener,noreferrer') }}>新窗口打开</button>
          )}
          {native !== undefined && view.topicId !== undefined && (
            <>
              <button type="button" className="dshpro-btn small" onClick={() => run(() => openArtifact(view.topicId as string, path as string, false), '已请求打开原文件')}>打开原文件</button>
              <button type="button" className="dshpro-btn small" onClick={() => run(() => openArtifact(view.topicId as string, path as string, true), '已在文件夹中定位')}>在文件夹中显示</button>
            </>
          )}
          <button type="button" className="dshpro-btn small" onClick={onClose}>关闭</button>
          <span className="dshpro-modal-note">{notice ?? ''}</span>
        </div>
      </div>
    </dialog>
  )
}

function ActionDialog({
  dialog,
  designMode,
  busy,
  regenNote,
  continueNote,
  continueDesigns,
  materialsNote,
  checkNote,
  onRegenNote,
  onContinueNote,
  onContinueDesigns,
  onMaterialsNote,
  onCheckNote,
  onClose,
  onSubmit,
  feedback,
}: {
  feedback?: { kind: 'ok' | 'error'; text: string }
  dialog: DialogState
  designMode: boolean
  busy: boolean
  regenNote: string
  continueNote: string
  continueDesigns: string
  materialsNote: string
  checkNote: string
  onRegenNote: (value: string) => void
  onContinueNote: (value: string) => void
  onContinueDesigns: (value: string) => void
  onMaterialsNote: (value: string) => void
  onCheckNote: (value: string) => void
  onClose: () => void
  onSubmit: () => void
}): ReactNode {
  const modal = useModal()
  const base = dialog.kind === 'continue' ? dialog.base : undefined
  const title = dialog.kind === 'regenerate' ? '重新生成' : dialog.kind === 'continue' ? base !== undefined ? '以这张继续改' : '继续一轮' : '人工核对'
  return (
    <dialog ref={modal} className="dshpro-overlay" aria-label={title} onCancel={event => { event.preventDefault(); if (!busy) onClose() }} onClick={() => { if (!busy) onClose() }}>
      <div className="dshpro-modal-card is-dialog" onClick={event => event.stopPropagation()}>
        <div className="dshpro-modal-head">
          <div className="dshpro-modal-title">{title}</div>
          <button type="button" className="dshpro-icon-btn" onClick={onClose} disabled={busy} aria-label="关闭"><Glyph name="close" size={15} /></button>
        </div>
        <fieldset className="dshpro-dialog-body" disabled={busy}>
          {dialog.kind === 'regenerate' && (
            <>
              <label htmlFor="dshpro-regen">不满意的地方 / 新要求</label>
              <p>可留空直接换一版；提交后保留已有轮次。</p>
              <textarea id="dshpro-regen" value={regenNote} onChange={event => onRegenNote(event.target.value)} placeholder="例如：保留版式，只改配色；标题必须出现……；不要再用……" />
            </>
          )}
          {dialog.kind === 'continue' && (
            <>
              {base !== undefined && <div className="dshpro-edit-base"><img src={assetUrl(base.topicId, base.path)} alt="本轮修改底图" /><span>{artifactDisplayName(base.path)}<small>仅使用这张底图 · 一轮一个结果</small></span></div>}
              <label htmlFor="dshpro-continue">{base !== undefined ? '保留什么，只改什么' : '这一轮只补充什么'}</label>
              <p>{base !== undefined ? '原图保留，改稿另存；生成效果仍需你确认。' : '一次继续只追加一轮，不会顺带跑完剩余上限。'}</p>
              <textarea id="dshpro-continue" value={continueNote} onChange={event => onContinueNote(event.target.value)} placeholder={base !== undefined ? '例如：保留文字和布局，只把背景改为米白色' : '例如：只查部署风险；只改配色，保留版式'} />
              {designMode && base === undefined && (
                <div className="dshpro-dialog-row">
                  <label htmlFor="dshpro-directions">本轮方向数</label>
                  <input id="dshpro-directions" type="number" min={1} max={6} value={continueDesigns} onChange={event => onContinueDesigns(event.target.value)} placeholder="3" />
                  <span>1–6</span>
                </div>
              )}
            </>
          )}
          {(dialog.kind === 'regenerate' || dialog.kind === 'continue') && base === undefined && (
            <>
              <label htmlFor="dshpro-materials">新增材料（可选）</label>
              <p>每行一个相对项目根的路径，只发送本轮新增文件；超限、密钥命中或路径不存在会在提交前报错。</p>
              <textarea id="dshpro-materials" value={materialsNote} onChange={event => onMaterialsNote(event.target.value)} placeholder={'docs/evidence.md\nassets/brand.png'} />
            </>
          )}
          {dialog.kind === 'check' && (
            <>
              <label htmlFor="dshpro-check">核对依据（必填）</label>
              <p>结论：{dialog.conclusion === 'submitted' ? '已提交' : dialog.conclusion === 'not_submitted' ? '未提交' : '需重开'}。写一下你在浏览器里看到的依据，方便追溯。</p>
              <textarea id="dshpro-check" value={checkNote} onChange={event => onCheckNote(event.target.value)} placeholder="例如：输入框里能看到消息、附件卡片齐全；或页面停在 about:blank" />
            </>
          )}
        </fieldset>
        {feedback !== undefined && <div className="dshpro-dialog-feedback" data-kind={feedback.kind} role={feedback.kind === 'error' ? 'alert' : 'status'}>{feedback.text}</div>}
        <div className="dshpro-dialog-foot">
          <button type="button" className="dshpro-btn" onClick={onClose} disabled={busy}>取消</button>
          <button type="button" className="dshpro-btn primary" onClick={onSubmit} disabled={busy}>{busy ? '处理中…' : dialog.kind === 'regenerate' ? '提交重新生成' : dialog.kind === 'continue' ? base !== undefined ? '提交修改' : '提交继续' : '提交核对'}</button>
        </div>
      </div>
    </dialog>
  )
}

function TopicItem({
  topic,
  selected,
  design,
  onSelect,
  disabled,
}: {
  disabled?: boolean
  topic: TopicRow
  selected: boolean
  design: boolean
  onSelect: () => void
}): ReactNode {
  const tone = toneOf(topic.status)
  const badge = attentionLabel(topic)
  const stall = topic.stall_reason !== null ? STALL_LABEL[topic.stall_reason] ?? topic.stall_reason : undefined
  return (
    <button
      type="button"
      className={`dshpro-topic${selected ? ' is-selected' : ''}`}
      data-tone={tone}
      data-topic-id={topic.topic_id}
      disabled={disabled}
      onClick={onSelect}
      title={topic.title}
      aria-current={selected ? 'true' : undefined}
    >
      <span className="dshpro-topic-bar" />
      <span className="dshpro-topic-title">{topic.title}</span>
      <span className="dshpro-topic-meta">
        <span className="dshpro-dot" data-tone={tone} />
        <span className="dshpro-status-text" data-tone={tone}>{statusLabel(topic.status)}</span>
        <span className="dshpro-sep">·</span>
        <span>{topic.type === 'design' ? '设计' : '研究'}</span>
        <span className="dshpro-sep">·</span>
        <span>{topic.rounds}/{topic.rounds_cap} 轮</span>
      </span>
      <span className="dshpro-topic-foot">
        <span>{formatRelative(topic.updated)}</span>
        <span className="dshpro-topic-tail">
          {topic.artifacts.length > 0 && (
            <span className="dshpro-topic-artifacts">
              <Glyph name={design ? 'image' : 'file'} size={12} />{topic.artifacts.length}
            </span>
          )}
          {badge !== undefined && <span className="dshpro-badge" data-tone={tone}>{badge}</span>}
          {stall !== undefined && badge === undefined && <span className="dshpro-badge" data-tone="warn" title={stall}>{stall}</span>}
        </span>
      </span>
    </button>
  )
}

function Panel(): ReactNode {
  const [topics, setTopics] = useState<TopicRow[]>([])
  const [selected, setSelected] = useState<string | undefined>(undefined)
  const [detail, setDetail] = useState<TopicDetail | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | undefined>(undefined)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [tab, setTab] = useState<Tab>('overview')
  const [listLoading, setListLoading] = useState(true)
  const [listError, setListError] = useState<string>()
  const [mobileDetail, setMobileDetail] = useState(false)
  const selectedRef = useRef(selected)
  selectedRef.current = selected
  const detailRequest = useRef(0)
  const listRequest = useRef(0)
  const listInFlight = useRef(false)
  const detailInFlight = useRef<string>()
  const dialogTrigger = useRef<HTMLElement>()
  const actionLock = useRef(false)
  const panelRef = useRef<HTMLDivElement>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [dialog, setDialog] = useState<DialogState | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [regenNote, setRegenNote] = useState('')
  const [continueNote, setContinueNote] = useState('')
  const [continueDesigns, setContinueDesigns] = useState('')
  const [materialsNote, setMaterialsNote] = useState('')
  const [checkNote, setCheckNote] = useState('')
  const [viewer, setViewer] = useState<Viewer | undefined>(undefined)
  showViewer = view => {
    if (view?.topicId !== undefined && view.topicId !== selectedRef.current) return
    setViewer(view)
  }

  useEffect(() => {
    if (notice === undefined || dialog !== undefined) return
    const timer = setTimeout(() => setNotice(undefined), 4_000)
    return () => clearTimeout(timer)
  }, [notice, dialog])

  useEffect(() => {
    const closeMenus = (event: Event): void => {
      panelRef.current?.querySelectorAll<HTMLDetailsElement>('.dshpro-more[open]').forEach(menu => {
        if (event instanceof KeyboardEvent) {
          if (event.key !== 'Escape') return
          menu.open = false
          menu.querySelector<HTMLElement>('summary')?.focus()
        } else if (event.target instanceof Node && !menu.contains(event.target)) menu.open = false
      })
    }
    document.addEventListener('pointerdown', closeMenus)
    document.addEventListener('keydown', closeMenus)
    return () => { document.removeEventListener('pointerdown', closeMenus); document.removeEventListener('keydown', closeMenus) }
  }, [])

  const loadList = async (): Promise<void> => {
    if (listInFlight.current) return
    listInFlight.current = true
    const request = ++listRequest.current
    setListLoading(true)
    try {
      const data = await getJson<{ topics: TopicRow[] }>(`${config.routes}/topics`)
      if (request !== listRequest.current) return
      setTopics(data.topics)
      setListError(undefined)
      setSelected(current => current ?? data.topics[0]?.topic_id)
    } catch (cause) {
      if (request === listRequest.current) setListError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      listInFlight.current = false
      if (request === listRequest.current) setListLoading(false)
    }
  }

  const loadDetail = async (id: string): Promise<void> => {
    if (selectedRef.current !== id || detailInFlight.current === id) return
    detailInFlight.current = id
    const request = ++detailRequest.current
    setDetailLoading(true)
    try {
      const data = await getJson<{ topic: TopicDetail }>(`${config.routes}/topic?id=${encodeURIComponent(id)}`)
      if (selectedRef.current !== id || request !== detailRequest.current) return
      setDetail(data.topic)
      setError(undefined)
    } catch (cause) {
      if (selectedRef.current === id && request === detailRequest.current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (request === detailRequest.current) {
        detailInFlight.current = undefined
        if (selectedRef.current === id) setDetailLoading(false)
      }
    }
  }

  useEffect(() => {
    void loadList()
    const timer = setInterval(() => { void loadList() }, POLL_MS)
    return () => { clearInterval(timer); listRequest.current++; detailRequest.current++ }
  }, [])

  useEffect(() => {
    setError(undefined)
    if (selected === undefined) return
    void loadDetail(selected)
    const timer = setInterval(() => { void loadDetail(selected) }, POLL_MS)
    return () => clearInterval(timer)
  }, [selected])

  useEffect(() => {
    if (selected === undefined || detail === undefined) return
    const listed = topics.find(topic => topic.topic_id === selected)
    if (listed !== undefined && detail.topic_id === selected && listed.status !== detail.status) void loadDetail(selected)
  }, [topics, selected, detail])

  useEffect(() => {
    const refresh = (): void => {
      if (selected !== undefined) void loadDetail(selected)
      void loadList()
    }
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') refresh()
    }
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [selected])

  useEffect(() => {
    viewerRequest++
    setTab('overview')
    setDialog(undefined)
    setViewer(undefined)
    if (selected === undefined) return
    const reveal = (): void => {
      const row = panelRef.current?.querySelector<HTMLElement>(`[data-topic-id="${selected}"]`)
      if (row !== undefined && row !== null && row.getClientRects().length > 0) row.scrollIntoView({ block: 'nearest' })
    }
    reveal()
    panelRef.current?.querySelector('.dshpro-detail')?.scrollTo(0, 0)
  }, [selected])

  const act = async (action: string, conclusion?: string, note?: string): Promise<boolean> => {
    const target = detail?.topic_id
    if (selected === undefined || target === undefined || target !== selected) {
      setNotice({ kind: 'error', text: '主题正在切换，请等详情加载完成后再操作' })
      return false
    }
    try {
      if (action === 'cancel') setNotice({ kind: 'ok', text: '正在取消；若正在提交，会等当前提交结束后停止…' })
      const result = await postAction<{ topic: TopicRow & { wake?: { ok: boolean; resumed?: boolean; reason?: string } } }>(
        { action, topic_id: target, ...(conclusion !== undefined ? { conclusion } : {}), ...(note !== undefined ? { note } : {}) },
        // Engine.cancel waits for an already-clicked submit (bounded to 90s).
        action === 'cancel' ? 120_000 : 30_000,
      )
      const wake = result.topic?.wake
      if (action === 'accept') {
        setDetail(current => current === undefined ? current : { ...current, status: 'completed' })
        if (result.topic?.updated !== undefined) markTopicSeen(config.panelId, target, result.topic.updated)
        if (wake?.ok === true) {
          setNotice({ kind: 'ok', text: wake.resumed === true ? '已接受结果，并恢复了原会话' : '已接受结果，原会话已唤醒' })
        } else {
          const reason = wake?.reason ?? (wake === undefined ? '宿主未返回唤醒结果，请重启 DSH 后重试' : '原因未知')
          setNotice({ kind: 'error', text: `已接受结果，但没能唤醒原会话：${reason}` })
        }
      } else if (action === 'review') {
        if (wake?.ok === true) {
          setNotice({ kind: 'ok', text: wake.resumed === true ? '已恢复原会话，请它判断是否接受' : '已把结果交给原会话判断' })
        } else {
          const reason = wake?.reason ?? (wake === undefined ? '宿主未返回唤醒结果，请重启 DSH 后重试' : '原因未知')
          setNotice({ kind: 'error', text: `没能通知原会话：${reason}` })
        }
      } else if (action === 'wake') {
        if (wake?.ok === true) {
          setNotice({ kind: 'ok', text: wake.resumed === true ? '已恢复原会话' : '原会话已唤醒' })
        } else {
          const reason = wake?.reason ?? (wake === undefined ? '宿主未返回唤醒结果，请重启 DSH 后重试' : '原因未知')
          setNotice({ kind: 'error', text: `没能唤醒原会话：${reason}` })
        }
      } else if (action === 'review_cancel') {
        setNotice({ kind: 'ok', text: '已撤回判断请求，返回原状态' })
      } else if (action === 'human_check') {
        setNotice({ kind: 'ok', text: '人工核对已记录' })
      } else if (action === 'cancel') {
        setNotice({
          kind: 'ok',
          text: result.topic?.status === 'cancelled'
            ? '已取消'
            : '取消已发出；正在等当前提交结束后停止，状态会自动更新',
        })
      } else {
        setNotice({ kind: 'ok', text: action === 'regenerate' ? '已提交重新生成' : `已执行：${action}` })
      }
      setDialog(undefined)
      await loadDetail(target)
      await loadList()
      return true
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      setError(undefined)
      setNotice({ kind: 'error', text: message })
      return false
    }
  }

  const runPanelAction = async (action: 'probe' | 'login'): Promise<void> => {
    setNotice({ kind: 'ok', text: action === 'probe' ? '正在自检…' : '正在打开登录窗口…' })
    try {
      // Login can legitimately wait for a human (the host allows 5 minutes).
      const result = await postAction<Record<string, unknown>>({ action }, action === 'login' ? 360_000 : 60_000)
      if (action === 'probe') {
        const probe = (result.probe ?? {}) as Record<string, unknown>
        const ok = probe.ok === true
        const parts = [
          `通道 ${String(result.channel ?? '?')}`,
          ok ? '自检通过' : '自检未通过',
          probe.loggedIn === true ? '已登录' : '未登录',
          probe.model !== undefined && probe.model !== '' ? `模型 ${String(probe.model)}` : undefined,
          typeof probe.reason === 'string' && probe.reason !== '' ? `原因 ${probe.reason}` : undefined,
        ].filter((part): part is string => part !== undefined)
        setNotice({ kind: ok ? 'ok' : 'error', text: parts.join(' · ') })
      } else {
        const login = (result.login ?? {}) as Record<string, unknown>
        setNotice({ kind: login.ok === false ? 'error' : 'ok', text: String(login.note ?? '登录流程完成') })
      }
    } catch (cause) {
      setError(undefined)
      setNotice({ kind: 'error', text: cause instanceof Error ? cause.message : String(cause) })
    }
  }

  const dialogMaterials = (): string[] => materialsNote
    .split(/\r?\n/)
    .map(item => item.trim())
    .filter(item => item !== '')

  const submitRegenerate = async (): Promise<void> => {
    const target = detail?.topic_id
    if (selected === undefined || target === undefined || target !== selected) {
      setNotice({ kind: 'error', text: '主题正在切换，请等详情加载完成后再操作' })
      return
    }
    const materials = dialogMaterials()
    try {
      await postAction<{ topic: TopicRow }>({
        action: 'regenerate',
        topic_id: target,
        note: regenNote.trim(),
        ...(materials.length > 0 ? { materials } : {}),
      })
      setNotice({ kind: 'ok', text: '已提交重新生成' })
      setDetail(current => current === undefined ? current : { ...current, status: 'queued' })
      setDialog(undefined)
      setRegenNote('')
      setMaterialsNote('')
      await loadDetail(target)
      await loadList()
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      setError(undefined)
      setNotice({ kind: 'error', text: message })
    }
  }

  const submitContinue = async (): Promise<void> => {
    const target = detail?.topic_id
    if (selected === undefined || target === undefined || target !== selected) {
      setNotice({ kind: 'error', text: '主题正在切换，请等详情加载完成后再操作' })
      return
    }
    const brief = continueNote.trim()
    if (brief === '') {
      setNotice({ kind: 'error', text: '请填写这一轮要补充的问题' })
      return
    }
    let designs: number | undefined
    if (detail?.type === 'design') {
      designs = continueDesigns.trim() === '' ? detail.designs ?? 3 : Number(continueDesigns)
      if (!Number.isInteger(designs) || designs < 1 || designs > 6) {
        setNotice({ kind: 'error', text: '方向数必须是 1–6 的整数' })
        return
      }
    }
    const materials = dialogMaterials()
    try {
      await postAction<{ topic: TopicRow }>({
        action: 'continue',
        topic_id: target,
        brief,
        ...(dialog?.kind === 'continue' && dialog.base !== undefined ? { base_artifact: dialog.base.path } : {}),
        ...(designs !== undefined ? { designs } : {}),
        ...(materials.length > 0 ? { materials } : {}),
      })
      setNotice({ kind: 'ok', text: '已追加一轮' })
      setDetail(current => current === undefined ? current : { ...current, status: 'queued' })
      setDialog(undefined)
      setContinueNote('')
      setContinueDesigns('')
      setMaterialsNote('')
      await loadDetail(target)
      await loadList()
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      setError(undefined)
      setNotice({ kind: 'error', text: message })
    }
  }

  const submitHumanCheck = async (): Promise<void> => {
    if (dialog === undefined || dialog.kind !== 'check') return
    const note = checkNote.trim()
    if (note === '') {
      setNotice({ kind: 'error', text: '请填写核对依据' })
      return
    }
    const ok = await act('human_check', dialog.conclusion, note)
    if (ok) setCheckNote('')
  }

  const runExclusive = async (task: () => Promise<unknown>): Promise<void> => {
    if (actionLock.current) return
    actionLock.current = true
    setBusy(true)
    try { await task() } finally { actionLock.current = false; setBusy(false) }
  }

  const submitDialog = (): void => {
    if (dialog === undefined) return
    void runExclusive(() => dialog.kind === 'regenerate' ? submitRegenerate() : dialog.kind === 'continue' ? submitContinue() : submitHumanCheck())
  }

  const openRegenerate = (): void => {
    dialogTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
    setNotice(undefined)
    setRegenNote('')
    setMaterialsNote('')
    setDialog({ kind: 'regenerate' })
  }

  const openContinue = (path?: string): void => {
    dialogTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
    setNotice(undefined)
    setContinueNote('')
    setMaterialsNote('')
    setContinueDesigns(path === undefined ? '' : '1')
    setDialog({ kind: 'continue', ...(path !== undefined && detail !== undefined ? { base: { topicId: detail.topic_id, path } } : {}) })
  }

  const openCheck = (conclusion: 'submitted' | 'not_submitted' | 'reopen'): void => {
    dialogTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
    setNotice(undefined)
    setCheckNote('')
    setDialog({ kind: 'check', conclusion })
  }

  useEffect(() => {
    if (dialog !== undefined || busy || dialogTrigger.current === undefined) return
    if (dialogTrigger.current.isConnected && !dialogTrigger.current.matches(':disabled')) dialogTrigger.current.focus()
    else panelRef.current?.querySelector<HTMLElement>('.dshpro-title')?.focus()
    dialogTrigger.current = undefined
  }, [dialog, busy])

  const current = detail !== undefined && detail.topic_id === selected ? detail : undefined
  const hasArtifacts = (current?.artifacts.length ?? 0) > 0
  const canAccept = current !== undefined && (
    current.status === 'capped'
    || (current.status === 'completed' && !current.accepted_at)
    || (current.status === 'reviewing' && (current.review_from === 'capped' || current.review_from === 'answered' || hasArtifacts))
    || ((current.status === 'failed' || current.status === 'stalled') && hasArtifacts)
  )
  const canRegenerate = current !== undefined && (current.status === 'completed' || current.status === 'capped' || current.status === 'reviewing' || current.status === 'failed' || current.status === 'stalled')
  const canContinue = current !== undefined && (current.status === 'completed' || current.status === 'capped' || current.status === 'reviewing' || current.status === 'failed' || current.status === 'stalled')
  const canReview = current !== undefined && (current.status === 'capped' || (current.status === 'reviewing' && current.review_from !== 'answered') || ((current.status === 'failed' || current.status === 'stalled') && hasArtifacts))
  const canReviewCancel = current !== undefined && current.status === 'reviewing' && current.review_from !== 'answered'
  const canWake = current !== undefined && current.status === 'completed'
  const canCancel = current !== undefined && ACTIVE.has(current.status)
  const retryJudge = current !== undefined && current.status === 'reviewing' && current.review_from === 'answered'
  const canResume = current !== undefined && (current.status === 'stalled' || current.status === 'failed' || retryJudge)
  const canDelete = current !== undefined && (current.status === 'draft' || current.status === 'completed' || current.status === 'cancelled'
    || current.status === 'capped' || current.status === 'failed' || current.status === 'stalled')
  const acceptLabel = current !== undefined && (current.status === 'capped' || current.status === 'reviewing' || current.status === 'completed') ? '接受结果' : '接受已有产物'

  let primary: { label: string; run: () => void } | undefined
  if (current !== undefined) {
    if (canResume) primary = { label: retryJudge ? '重试自动裁决' : '恢复运行', run: () => { void runExclusive(() => act('resume')) } }
    else if (canAccept) primary = { label: acceptLabel, run: () => { void runExclusive(() => act('accept')) } }
    else if (current.status === 'completed' && canContinue) primary = { label: '继续一轮', run: () => openContinue() }
  }

  const secondary: Array<{ label: string; run: () => void }> = []
  if (current !== undefined) {
    if (canContinue && primary?.label !== '继续一轮') secondary.push({ label: '继续一轮', run: () => openContinue() })
    if (canRegenerate && primary?.label !== '重新生成') secondary.push({ label: '重新生成', run: openRegenerate })
    if (canReview) secondary.push({ label: current.status === 'reviewing' ? '再次提醒原会话' : '请原会话判断', run: () => { void runExclusive(() => act('review')) } })
    if (canReviewCancel) secondary.push({ label: '撤回判断请求', run: () => { void runExclusive(() => act('review_cancel')) } })
    if (canWake) secondary.push({ label: '唤醒原会话', run: () => { void runExclusive(() => act('wake')) } })
    if (canAccept && primary?.label !== acceptLabel) secondary.push({ label: acceptLabel, run: () => { void runExclusive(() => act('accept')) } })
  }

  const counts = useMemo(() => {
    const count = (statuses: Set<string>): number => topics.filter(topic => statuses.has(topic.status)).length
    return {
      all: topics.length,
      active: topics.filter(topic => topic.status === 'draft' || ACTIVE.has(topic.status)).length,
      attention: count(ATTENTION),
      done: count(DONE),
    }
  }, [topics])

  const filtered = useMemo(() => {
    const text = query.trim().toLowerCase()
    const base = topics.filter(topic => {
      if (text !== '' && !topic.title.toLowerCase().includes(text)) return false
      if (filter === 'active') return topic.status === 'draft' || ACTIVE.has(topic.status)
      if (filter === 'attention') return ATTENTION.has(topic.status)
      if (filter === 'done') return DONE.has(topic.status)
      return true
    })
    return [...base].sort((left, right) => (right.updated ?? '').localeCompare(left.updated ?? ''))
  }, [topics, query, filter])

  const copyPath = async (): Promise<void> => {
    if (current?.path === undefined || current.path === '') return
    try {
      await copyText(current.path)
      setNotice({ kind: 'ok', text: '主题路径已复制' })
    } catch (cause) {
      setNotice({ kind: 'error', text: cause instanceof Error ? cause.message : String(cause) })
    }
  }

  const runDelete = async (): Promise<void> => {
    const target = detail?.topic_id
    if (selected === undefined || target === undefined || target !== selected) {
      setNotice({ kind: 'error', text: '主题正在切换，请等详情加载完成后再操作' })
      return
    }
    const confirmed = typeof window.confirm === 'function'
      ? window.confirm(`删除主题「${current?.title ?? target}」？\n\n主题目录、原始答复与面板记录都会被删除，且不可恢复。`)
      : false
    if (!confirmed) return
    try {
      await postAction({ action: 'delete', topic_id: target })
      setNotice({ kind: 'ok', text: '主题已删除' })
      setSelected(undefined)
      setDetail(undefined)
      await loadList()
    } catch (cause) {
      setNotice({ kind: 'error', text: cause instanceof Error ? cause.message : String(cause) })
    }
  }

  const refresh = (): void => {
    if (selected !== undefined) void loadDetail(selected)
    void loadList()
  }

  const hasBanner = current !== undefined && (current.status === 'capped' || current.status === 'reviewing' || current.status === 'stalled' || current.status === 'failed' || current.status === 'draft' || ACTIVE.has(current.status))

  return (
    <div className="dshpro-host"><div ref={panelRef} className="dshpro-root" data-mobile-detail={mobileDetail} data-plugin={config.designMode ? 'design' : 'research'}>
      <style data-dsh-pro-panel dangerouslySetInnerHTML={{ __html: PANEL_CSS }} />
      <aside className="dshpro-list" aria-label="任务列表">
        <div className="dshpro-list-head">
          <div className="dshpro-brand">
            <span className="dshpro-brand-mark">{config.designMode ? 'D' : 'R'}</span>
            <div className="dshpro-brand-info">
              <div className="dshpro-brand-title">{config.title}</div>
              <div className="dshpro-brand-sub">{config.designMode ? '设计任务 · 图片与 demo' : '研究任务 · 轮次与文档'}</div>
            </div>
            <span className="dshpro-count">{topics.length}</span>
          </div>
          <label className="dshpro-search">
            <Glyph name="search" size={13} />
            <input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索主题…" aria-label="搜索主题" />
          </label>
          <div className="dshpro-filters">
            {FILTERS.map(item => (
              <button
                key={item.id}
                type="button"
                aria-pressed={filter === item.id}
                className={`dshpro-filter${filter === item.id ? ' is-on' : ''}`}
                onClick={() => setFilter(item.id)}
              >
                {item.label}<span>{counts[item.id]}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="dshpro-list-scroll" aria-busy={listLoading}>
          {listError !== undefined && (
            <div className="dshpro-list-error" role="alert">列表加载失败：{listError} <button type="button" className="dshpro-card-link" onClick={() => { void loadList() }}>重试</button></div>
          )}
          {listLoading && topics.length === 0
            ? <ListSkeleton />
            : topics.length === 0
              ? (
                <div className="dshpro-list-empty">
                  <div className="dshpro-empty-icon"><Glyph name={config.designMode ? 'image' : 'file'} size={24} /></div>
                  <p>{listError !== undefined ? '任务列表暂不可用' : config.designMode ? '还没有设计任务' : '还没有研究任务'}</p>
                  <span>{config.designMode ? '在会话里用 /pro-design 开始；web 通道会同时产出图和 HTML demo。' : '在会话里用 /pro-research 开始；第一次可以不给材料，单轮就能看到结果。'}</span>
                </div>
              )
              : filtered.length === 0
                ? (
                  <div className="dshpro-list-empty">
                    <p>没有匹配的主题</p>
                    <span>换个关键词，或清除筛选。</span>
                    <button type="button" className="dshpro-btn small" onClick={() => { setQuery(''); setFilter('all') }}>清除</button>
                  </div>
                )
                : filtered.map(topic => (
                  <TopicItem
                    key={topic.topic_id}
                    topic={topic}
                    selected={topic.topic_id === selected}
                    disabled={busy}
                    design={config.designMode}
                    onSelect={() => {
                      markTopicSeen(config.panelId, topic.topic_id, topic.updated)
                      setSelected(topic.topic_id)
                      setMobileDetail(true)
                    }}
                  />
                ))}
        </div>
      </aside>

      <main className="dshpro-detail" aria-label="任务详情">
        <button type="button" className="dshpro-btn dshpro-back" disabled={busy} onClick={() => setMobileDetail(false)}>‹ 返回任务列表</button>
        {error !== undefined && topics.length > 0 && (
          <div className="dshpro-error-banner" role="alert">
            <Glyph name="alert" size={13} />
            <span>接口错误：{error}</span>
            <button type="button" className="dshpro-card-link" style={{ marginLeft: 'auto' }} onClick={refresh}>重试</button>
          </div>
        )}
        {selected === undefined
          ? <EmptyDetail design={config.designMode} />
          : current === undefined
            ? detailLoading ? <DetailSkeleton /> : <EmptyDetail design={config.designMode} />
            : (
              <>
                <header className="dshpro-head">
                  <div className="dshpro-head-info">
                  <div className="dshpro-eyebrow">{current.type === 'design' ? '设计工作台' : '研究工作台'}<span> / 第 {generationList(current).at(-1)?.n ?? 1} 版</span></div>
                  <div className="dshpro-title-row">
                    <h2 className="dshpro-title" tabIndex={-1} title={current.title}>{current.title}</h2>
                    <StatusPill status={current.status} />
                  </div>
                  <div className="dshpro-meta">
                    <span>{current.rounds}/{current.rounds_cap} 轮</span>
                    {channelLabel(current.channel) !== undefined && <span>{channelLabel(current.channel)}</span>}
                    {current.designs != null && <span>每轮 {current.designs} 个方向</span>}
                    <span>更新 {formatRelative(current.updated)}</span>
                  </div>
                  </div>
                  <div className="dshpro-actions">
                    {primary !== undefined && <button type="button" className="dshpro-btn primary" disabled={busy} onClick={primary.run}>{busy ? '处理中…' : primary.label}</button>}
                    {secondary.slice(0, 2).map(item => <button key={item.label} type="button" className="dshpro-btn" disabled={busy} onClick={item.run}>{item.label}</button>)}
                    {canCancel && <button type="button" className="dshpro-btn danger" disabled={busy} onClick={() => { void runExclusive(() => act('cancel')) }}>取消运行</button>}
                    <details className="dshpro-more">
                      <summary className="dshpro-btn"><Glyph name="more" size={13} /> 更多</summary>
                      <div className="dshpro-menu">
                        {secondary.slice(2).map(item => <button key={item.label} type="button" disabled={busy} onClick={event => { closeMenu(event); item.run() }}>{item.label}</button>)}
                        <button type="button" disabled={busy} onClick={event => { closeMenu(event); void runExclusive(() => runPanelAction('probe')) }}>自检</button>
                        <button type="button" disabled={busy} onClick={event => { closeMenu(event); void runExclusive(() => runPanelAction('login')) }}>登录</button>
                        <button type="button" onClick={event => { closeMenu(event); void copyPath() }}>复制主题路径</button>
                        <button type="button" onClick={event => { closeMenu(event); refresh() }}>刷新</button>
                        {canDelete && (
                          <button type="button" disabled={busy} style={{ color: 'var(--dshpro-error)' }} onClick={event => { closeMenu(event); void runExclusive(runDelete) }}>删除主题…</button>
                        )}
                      </div>
                    </details>
                  </div>
                </header>

                {hasBanner && current !== undefined && (
                  <div className="dshpro-banner" data-tone={
                    current.status === 'stalled' || current.status === 'failed' ? 'error'
                      : current.status === 'capped' ? 'warn'
                        : current.status === 'reviewing' ? 'review' : 'active'
                  }>
                    {current.status === 'stalled' && <><strong>卡住了</strong><span>{STALL_LABEL[current.stall_reason ?? ''] ?? '需要人工检查'}；检查共享 Chrome 现场后恢复，或做人工核对。</span></>}
                    {current.status === 'failed' && <><strong>运行失败</strong><span>{hasArtifacts ? '可恢复运行，或检查已有产物后接受。' : '检查原因后可恢复运行。'}</span></>}
                    {current.status === 'capped' && <><strong>结果待接受</strong><span>{current.type === 'design' ? '图片视觉效果待人工确认；可选一张继续修改。' : '本次运行已停止；检查产物后接受，或继续一轮。'}</span></>}
                    {current.status === 'reviewing' && (current.review_from === 'answered'
                      ? <><strong>自动裁决失败</strong><span>答复与产物已保留。可以接受结果、继续一轮，或修好 judgeProvider / judgeModel 后重试自动裁决。</span></>
                      : <><strong>待原会话判断</strong><span>结果已交给发起会话；可以接受结果，或撤回判断请求。</span></>)}
                    {ACTIVE.has(current.status) && <><strong>正在运行</strong><span>{statusLabel(current.status)} · 自动更新</span></>}
                    {current.status === 'draft' && <><strong>草稿</strong><span>等待确认后开始。</span></>}
                    {(current.status === 'stalled' || current.status === 'failed') && current.stop_reason && (
                      <div style={{ flexBasis: '100%', overflowWrap: 'anywhere' }}>原因：{current.stop_reason}</div>
                    )}
                    {(current.status === 'stalled' || current.status === 'failed') && current.rounds_detail?.at(-1)?.submissionState === 'not_sent' && (
                      <div style={{ flexBasis: '100%' }}>本轮在点击发送前停止，可恢复运行重试本轮，不增加轮次。</div>
                    )}
                    {(current.status === 'stalled' || current.status === 'failed') && current.rounds_detail?.at(-1)?.submissionState !== 'not_sent' && (
                      <div className="dshpro-check-actions">
                        <span>人工核对</span>
                        <button type="button" className="dshpro-btn small" disabled={busy} onClick={() => openCheck('submitted')}>已提交</button>
                        <button type="button" className="dshpro-btn small" disabled={busy} onClick={() => openCheck('not_submitted')}>未提交</button>
                        <button type="button" className="dshpro-btn small" disabled={busy} onClick={() => openCheck('reopen')}>需重开</button>
                      </div>
                    )}
                  </div>
                )}

                <nav className="dshpro-tabs" role="tablist" aria-label="主题内容" onKeyDown={event => {
                  const tabs: Tab[] = ['overview', 'rounds', 'artifacts']
                  const index = tabs.indexOf(tab)
                  const next = event.key === 'ArrowRight' ? tabs[(index + 1) % 3] : event.key === 'ArrowLeft' ? tabs[(index + 2) % 3] : event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs[2] : undefined
                  if (next !== undefined) { event.preventDefault(); setTab(next); event.currentTarget.querySelector<HTMLButtonElement>(`[data-tab="${next}"]`)?.focus() }
                }}>
                  <button type="button" role="tab" data-tab="overview" id={`${config.panelId}-tab-overview`} aria-controls={`${config.panelId}-content`} tabIndex={tab === 'overview' ? 0 : -1} aria-selected={tab === 'overview'} className={`dshpro-tab${tab === 'overview' ? ' is-on' : ''}`} onClick={() => setTab('overview')}>概览</button>
                  <button type="button" role="tab" data-tab="rounds" id={`${config.panelId}-tab-rounds`} aria-controls={`${config.panelId}-content`} tabIndex={tab === 'rounds' ? 0 : -1} aria-selected={tab === 'rounds'} className={`dshpro-tab${tab === 'rounds' ? ' is-on' : ''}`} onClick={() => setTab('rounds')}>轮次<em>{current.rounds}</em></button>
                  <button type="button" role="tab" data-tab="artifacts" id={`${config.panelId}-tab-artifacts`} aria-controls={`${config.panelId}-content`} tabIndex={tab === 'artifacts' ? 0 : -1} aria-selected={tab === 'artifacts'} className={`dshpro-tab${tab === 'artifacts' ? ' is-on' : ''}`} onClick={() => setTab('artifacts')}>产物<em>{current.artifacts.length}</em></button>
                </nav>

                <div className="dshpro-body" data-view={tab} role="tabpanel" id={`${config.panelId}-content`} aria-labelledby={`${config.panelId}-tab-${tab}`} tabIndex={0}>
                  <div className="dshpro-main">
                    {tab === 'overview' && (config.designMode
                      ? <DesignOverview detail={current} onTab={setTab} onRefine={canContinue && !busy ? openContinue : undefined} />
                      : <ResearchOverview detail={current} onTab={setTab} />)}
                    {tab === 'rounds' && <RoundsView detail={current} />}
                    {tab === 'artifacts' && <ArtifactsView detail={current} onRefine={canContinue && !busy ? openContinue : undefined} />}
                  </div>
                  {tab === 'overview' && <Rail detail={current} onTab={setTab} />}
                </div>
              </>
            )}
      </main>

      {dialog !== undefined && (
        <ActionDialog
          dialog={dialog}
          designMode={config.designMode}
          busy={busy}
          regenNote={regenNote}
          continueNote={continueNote}
          continueDesigns={continueDesigns}
          materialsNote={materialsNote}
          checkNote={checkNote}
          onRegenNote={setRegenNote}
          onContinueNote={setContinueNote}
          onContinueDesigns={setContinueDesigns}
          onMaterialsNote={setMaterialsNote}
          onCheckNote={setCheckNote}
          onClose={() => { if (!actionLock.current) setDialog(undefined) }}
          onSubmit={submitDialog}
          feedback={notice}
        />
      )}
      {viewer !== undefined && (
        <ViewerModal view={viewer} basePath={current?.path} onClose={() => { viewerRequest++; setViewer(undefined) }} />
      )}
      {notice !== undefined && dialog === undefined && <div className="dshpro-toast" data-kind={notice.kind} role={notice.kind === 'error' ? 'alert' : 'status'}>{notice.text}</div>}
    </div></div>
  )
}

function Icon({ kind }: { kind: 'research' | 'design' }): ReactNode {
  const svg = kind === 'design' ? DESIGN_ICON : RESEARCH_ICON
  return <span className="dshpro-sidebar-icon" aria-hidden="true" style={{ display: 'inline-flex', width: 16, height: 16, lineHeight: 0, color: 'inherit' }} dangerouslySetInnerHTML={{ __html: svg }} />
}

export function apply(ctx: ClientContext): void {
  // The renderer service can activate before layout and sidebar declare their slots.
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: config.panelId }, () => <Panel />))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: config.panelId, order: 21, label: () => config.label }, () => <Icon kind={config.icon} />))
  const disposeBadge = mountSidebarStatus({ label: config.label, routes: config.routes, panelId: config.panelId })
  if (typeof ctx.effect === 'function') ctx.effect(() => disposeBadge, `${config.panelId}: sidebar status badge`)
}
