import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { DESIGN_ICON, RESEARCH_ICON } from './icons.ts'
import { mountSidebarStatus } from './sidebar-status.ts'
import { markTopicSeen } from './seen.ts'

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
  stall_reason: string | null
  rounds: number
  rounds_cap: number
  designs?: number | null
  stop_reason: string | null
  review_from?: string | null
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
  submittedAt?: string
  answeredAt?: string
  attempts?: number
  artifacts?: string[]
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
  | { kind: 'continue' }
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

let showViewer: (view: Viewer | undefined) => void = () => {}

function toneOf(status: string): Tone {
  return STATUS_TONE[status] ?? 'muted'
}

function statusLabel(status: string): string {
  return STATUS_LABEL[status] ?? status
}

function needsAttention(status: string): boolean {
  return ATTENTION.has(status)
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
  return value === undefined || value === '' ? '—' : value.slice(0, 16).replace('T', ' ')
}

function formatRelative(value: string | undefined): string {
  if (value === undefined || value === '') return '—'
  const time = Date.now() - new Date(value).getTime()
  if (!Number.isFinite(time)) return formatTime(value)
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
  const finalDoc = detail.artifacts.find(path => /(^|\/)final\.md$/i.test(path))
  if (finalDoc !== undefined) return finalDoc
  const generations = [...generationList(detail)].reverse()
  for (const generation of generations) {
    if (generation.final !== undefined && generation.final !== '') return generation.final
  }
  return undefined
}

function generationRounds(detail: TopicDetail, generation: number): RoundRow[] {
  return (detail.rounds_detail ?? [])
    .filter(round => (round.generation ?? 1) === generation)
    .sort((left, right) => left.n - right.n)
}

function latestRound(detail: TopicDetail): RoundRow | undefined {
  return [...(detail.rounds_detail ?? [])].sort((left, right) => right.n - left.n)[0]
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

function outcomeOf(round: RoundRow): { label: string; tone: string } {
  if (round.verdict === 'accepted') return { label: 'accepted', tone: 'accepted' }
  if (round.verdict === 'partial') return { label: 'partial', tone: 'partial' }
  if (round.verdict === 'rejected') return { label: 'rejected', tone: 'rejected' }
  if (round.answeredAt !== undefined) return { label: '已答复', tone: 'answered' }
  return { label: '进行中', tone: 'pending' }
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { accept: 'application/json' }, cache: 'no-store' })
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
  return await response.json() as T
}

async function postAction<T>(body: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${config.routes}/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
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
  showViewer({ kind: 'image', title: artifactDisplayName(path), topicId, src: assetUrl(topicId, path), path })
}

async function openTopicFile(topicId: string, path: string): Promise<void> {
  const name = artifactName(path)
  try {
    const text = await fetchText(`${config.routes}/file?id=${encodeURIComponent(topicId)}&path=${encodeURIComponent(path)}`)
    showViewer({ kind: 'text', title: name, topicId, text, path })
  } catch (cause) {
    showViewer({ kind: 'text', title: name, topicId, text: cause instanceof Error ? cause.message : String(cause), path })
  }
}

async function openAnswer(topicId: string, round: number): Promise<void> {
  try {
    const text = await fetchText(`${config.routes}/answer?id=${encodeURIComponent(topicId)}&round=${round}`)
    showViewer({ kind: 'text', title: `第 ${round} 轮回答`, topicId, text })
  } catch (cause) {
    showViewer({ kind: 'text', title: '读取回答失败', topicId, text: cause instanceof Error ? cause.message : String(cause) })
  }
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, { headers: { accept: 'text/plain, text/markdown' } })
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

const PANEL_CSS = `
.dshpro-root {
  --dshpro-accent: #4f6fd8;
  --dshpro-accent-fg: #fff;
  --dshpro-bg: var(--dsw-alias-bg-base, Canvas);
  --dshpro-panel: var(--dsw-alias-bg-layer-1, Canvas);
  --dshpro-panel-2: var(--dsw-alias-bg-module-platform, rgba(127,127,127,.06));
  --dshpro-text: var(--dsw-alias-label-primary, CanvasText);
  --dshpro-muted: var(--dsw-alias-label-secondary, rgba(127,127,127,.82));
  --dshpro-faint: var(--dsw-alias-label-tertiary, rgba(127,127,127,.62));
  --dshpro-line: var(--dsw-alias-border-l2, rgba(127,127,127,.22));
  --dshpro-line-strong: var(--dsw-alias-border-l3, rgba(127,127,127,.32));
  --dshpro-hover: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.09));
  --dshpro-success: #2e7d32;
  --dshpro-error: #c62828;
  --dshpro-warn: #b45309;
  --dshpro-info: #356faf;
  --dshpro-capped: #6f3fa8;
  --dshpro-radius: 8px;
  display: flex;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  background: var(--dshpro-bg);
  color: var(--dshpro-text);
  font-family: var(--dsw-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif);
  font-size: 13px;
  line-height: 1.5;
}
.dshpro-root[data-plugin="design"] { --dshpro-accent: #b26a12; }
body[data-ds-dark-theme] .dshpro-root {
  --dshpro-accent-fg: #101114;
  --dshpro-success: #4ade80;
  --dshpro-error: #f87171;
  --dshpro-warn: #fbbf24;
  --dshpro-info: #93c5fd;
  --dshpro-capped: #c4a5ff;
}
body[data-ds-dark-theme] .dshpro-root[data-plugin="research"] { --dshpro-accent: #7f9cff; }
body[data-ds-dark-theme] .dshpro-root[data-plugin="design"] { --dshpro-accent: #d79a4f; }
.dshpro-root, .dshpro-root *, .dshpro-root *::before, .dshpro-root *::after { box-sizing: border-box; }
.dshpro-root button, .dshpro-root input, .dshpro-root textarea { font: inherit; color: inherit; }
.dshpro-root button { cursor: pointer; }
.dshpro-root [data-tone="success"] { --tone-color: var(--dshpro-success); }
.dshpro-root [data-tone="capped"] { --tone-color: var(--dshpro-capped); }
.dshpro-root [data-tone="review"] { --tone-color: var(--dshpro-info); }
.dshpro-root [data-tone="warn"] { --tone-color: var(--dshpro-warn); }
.dshpro-root [data-tone="error"] { --tone-color: var(--dshpro-error); }
.dshpro-root [data-tone="active"] { --tone-color: #6f8fbf; }
.dshpro-root [data-tone="muted"] { --tone-color: var(--dshpro-faint); }

.dshpro-list {
  width: 280px;
  flex: 0 0 280px;
  min-height: 0;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--dshpro-line);
  background: var(--dshpro-panel-2);
}
.dshpro-list-head { padding: 12px 12px 10px; border-bottom: 1px solid var(--dshpro-line); }
.dshpro-brand { display: flex; align-items: center; gap: 8px; min-width: 0; }
.dshpro-brand-mark {
  width: 27px; height: 27px; flex: none; display: grid; place-items: center;
  border: 1px solid color-mix(in srgb, var(--dshpro-accent) 30%, var(--dshpro-line));
  border-radius: 7px; background: color-mix(in srgb, var(--dshpro-accent) 11%, var(--dshpro-panel));
  color: var(--dshpro-accent); font-size: 12px; font-weight: 800;
}
.dshpro-brand-info { min-width: 0; flex: 1; }
.dshpro-brand-title { font-size: 13px; font-weight: 700; line-height: 1.3; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dshpro-brand-sub { margin-top: 1px; color: var(--dshpro-muted); font-size: 10.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dshpro-count {
  flex: none; min-width: 22px; text-align: center; padding: 1px 6px;
  border: 1px solid var(--dshpro-line); border-radius: 999px;
  color: var(--dshpro-muted); font-size: 10px; font-variant-numeric: tabular-nums;
}
.dshpro-search {
  display: flex; align-items: center; gap: 6px; height: 30px; margin-top: 10px;
  padding: 0 8px; border: 1px solid var(--dshpro-line); border-radius: 6px;
  background: var(--dshpro-panel); color: var(--dshpro-muted);
}
.dshpro-search:focus-within { border-color: var(--dshpro-accent); box-shadow: 0 0 0 2px color-mix(in srgb, var(--dshpro-accent) 14%, transparent); }
.dshpro-search input { flex: 1; min-width: 0; height: 28px; padding: 0; border: 0; outline: 0; background: transparent; color: var(--dshpro-text); font-size: 12px; }
.dshpro-search input::placeholder { color: var(--dshpro-faint); }
.dshpro-filters { display: flex; gap: 3px; flex-wrap: wrap; margin-top: 7px; }
.dshpro-filter {
  display: inline-flex; align-items: center; gap: 4px; padding: 3px 6px;
  border: 1px solid transparent; border-radius: 5px; background: transparent;
  color: var(--dshpro-muted); font-size: 10.5px;
}
.dshpro-filter:hover { background: var(--dshpro-hover); }
.dshpro-filter.is-on { border-color: color-mix(in srgb, var(--dshpro-accent) 28%, var(--dshpro-line)); background: var(--dshpro-panel); color: var(--dshpro-text); }
.dshpro-filter span { color: var(--dshpro-faint); font-size: 9.5px; font-variant-numeric: tabular-nums; }
.dshpro-list-scroll { flex: 1; min-height: 0; overflow: auto; padding: 5px; scrollbar-width: thin; scrollbar-color: var(--dsw-alias-scrollbar-bg-l2, rgba(127,127,127,.35)) transparent; }
.dshpro-topic {
  display: block; position: relative; width: 100%; margin: 0 0 3px; padding: 8px 8px 8px 14px;
  border: 1px solid transparent; border-radius: 7px; background: transparent;
  color: var(--dshpro-text); text-align: left;
}
.dshpro-topic:hover { background: var(--dshpro-hover); }
.dshpro-topic.is-selected { background: color-mix(in srgb, var(--dshpro-accent) 10%, var(--dshpro-panel)); border-color: color-mix(in srgb, var(--dshpro-accent) 32%, var(--dshpro-line)); }
.dshpro-topic-bar {
  position: absolute; left: 0; top: 8px; bottom: 8px; width: 3px; border-radius: 0 3px 3px 0;
  background: var(--tone-color, var(--dshpro-faint)); opacity: .6;
}
.dshpro-topic.is-selected .dshpro-topic-bar { background: var(--dshpro-accent); opacity: 1; }
.dshpro-topic-title {
  display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden;
  font-size: 12.5px; font-weight: 650; line-height: 1.35; overflow-wrap: anywhere;
}
.dshpro-topic-meta {
  display: flex; align-items: center; flex-wrap: wrap; gap: 4px;
  margin-top: 4px; color: var(--dshpro-muted); font-size: 10.5px;
}
.dshpro-topic-meta .dshpro-sep { color: var(--dshpro-faint); opacity: .7; }
.dshpro-topic-tail { margin-left: auto; display: inline-flex; align-items: center; gap: 5px; }
.dshpro-topic-artifacts { display: inline-flex; align-items: center; gap: 2px; color: var(--dshpro-faint); font-size: 9.5px; }
.dshpro-dot { width: 7px; height: 7px; flex: none; border-radius: 999px; background: var(--tone-color, var(--dshpro-faint)); }
.dshpro-status-text { color: var(--tone-color, var(--dshpro-muted)); font-weight: 650; }
.dshpro-badge {
  display: inline-flex; align-items: center; padding: 1px 5px;
  border: 1px solid color-mix(in srgb, var(--tone-color) 38%, transparent);
  border-radius: 4px; background: color-mix(in srgb, var(--tone-color) 10%, transparent);
  color: var(--tone-color); font-size: 9.5px; font-weight: 650; white-space: nowrap;
}
.dshpro-list-empty { padding: 28px 16px; text-align: center; color: var(--dshpro-muted); }
.dshpro-list-empty .dshpro-empty-icon { margin: 0 auto 8px; color: var(--dshpro-faint); }
.dshpro-list-empty p { margin: 0; font-size: 12.5px; font-weight: 650; color: var(--dshpro-text); }
.dshpro-list-empty span { display: block; margin-top: 4px; font-size: 10.5px; line-height: 1.5; }
.dshpro-list-empty button { margin-top: 8px; }
.dshpro-list-error { margin: 8px; padding: 8px; border: 1px solid color-mix(in srgb, var(--dshpro-error) 30%, var(--dshpro-line)); border-radius: 6px; background: color-mix(in srgb, var(--dshpro-error) 7%, var(--dshpro-panel)); color: var(--dshpro-error); font-size: 10.5px; }
.dshpro-skeleton { border-radius: 4px; background: linear-gradient(90deg, var(--dshpro-hover), color-mix(in srgb, var(--dshpro-hover) 45%, transparent), var(--dshpro-hover)); background-size: 200% 100%; animation: dshpro-shimmer 1.4s ease-in-out infinite; }
@keyframes dshpro-shimmer { from { background-position: 200% 0; } to { background-position: -200% 0; } }
.dshpro-list-skeleton { padding: 8px 8px 8px 17px; }

.dshpro-detail { flex: 1; min-width: 0; overflow: auto; padding: 14px 16px 36px; scrollbar-width: thin; scrollbar-color: var(--dsw-alias-scrollbar-bg-l2, rgba(127,127,127,.35)) transparent; }
.dshpro-error-banner {
  display: flex; align-items: center; gap: 8px; margin-bottom: 10px; padding: 8px 10px;
  border: 1px solid color-mix(in srgb, var(--dshpro-error) 35%, var(--dshpro-line)); border-radius: 7px;
  background: color-mix(in srgb, var(--dshpro-error) 8%, var(--dshpro-panel)); color: var(--dshpro-error); font-size: 11px;
}
.dshpro-head {
  position: sticky; top: 0; z-index: 2; margin-bottom: 10px; padding: 13px 14px;
  border: 1px solid var(--dshpro-line); border-radius: 9px;
  background: var(--dshpro-panel); box-shadow: 0 1px 0 color-mix(in srgb, var(--dshpro-text) 3%, transparent);
}
.dshpro-title-row { display: flex; align-items: flex-start; gap: 9px; flex-wrap: wrap; }
.dshpro-title { margin: 0; max-width: 900px; color: var(--dshpro-text); font-size: 18px; font-weight: 750; line-height: 1.35; overflow-wrap: anywhere; }
.dshpro-status { flex: none; padding: 2px 6px; border: 1px solid color-mix(in srgb, var(--tone-color) 50%, transparent); border-radius: 5px; color: var(--tone-color); font-size: 10px; font-weight: 700; line-height: 1.35; white-space: nowrap; }
.dshpro-meta { display: flex; flex-wrap: wrap; gap: 4px 12px; margin-top: 7px; color: var(--dshpro-muted); font-size: 11px; }
.dshpro-meta > span:not(:first-child)::before { content: "·"; margin-right: 6px; color: var(--dshpro-faint); opacity: .7; }
.dshpro-path { display: flex; align-items: center; gap: 5px; min-width: 0; margin-top: 7px; color: var(--dshpro-faint); font-size: 10px; }
.dshpro-path span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
.dshpro-icon-btn { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; padding: 0; border: 1px solid transparent; border-radius: 4px; background: transparent; color: var(--dshpro-muted); }
.dshpro-icon-btn:hover { border-color: var(--dshpro-line); background: var(--dshpro-hover); color: var(--dshpro-text); }
.dshpro-actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-top: 11px; }
.dshpro-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 5px;
  min-height: 27px; padding: 4px 9px; border: 1px solid var(--dshpro-line);
  border-radius: 6px; background: var(--dshpro-panel); color: var(--dshpro-text);
  font-size: 11.5px; line-height: 1.2; text-decoration: none; white-space: nowrap;
}
.dshpro-btn:hover { background: var(--dshpro-hover); }
.dshpro-btn:disabled { opacity: .55; cursor: default; }
.dshpro-btn.primary { border-color: var(--dshpro-accent); background: var(--dshpro-accent); color: var(--dshpro-accent-fg); font-weight: 650; }
.dshpro-btn.primary:hover { filter: brightness(.96); }
.dshpro-btn.danger { border-color: color-mix(in srgb, var(--dshpro-error) 42%, var(--dshpro-line)); color: var(--dshpro-error); }
.dshpro-btn.ghost { border-color: transparent; background: transparent; color: var(--dshpro-muted); }
.dshpro-btn.ghost:hover { color: var(--dshpro-text); background: var(--dshpro-hover); }
.dshpro-btn.small { min-height: 23px; padding: 3px 7px; font-size: 10.5px; }
.dshpro-more { position: relative; margin-left: auto; }
.dshpro-more summary { list-style: none; }
.dshpro-more summary::-webkit-details-marker { display: none; }
.dshpro-menu {
  position: absolute; right: 0; top: calc(100% + 4px); z-index: 12; min-width: 160px;
  display: flex; flex-direction: column; gap: 1px; padding: 4px;
  border: 1px solid var(--dshpro-line); border-radius: 7px; background: var(--dshpro-panel);
  box-shadow: 0 10px 30px rgba(0,0,0,.18);
}
.dshpro-menu button { padding: 6px 8px; border: 0; border-radius: 4px; background: transparent; color: var(--dshpro-text); text-align: left; font-size: 11.5px; }
.dshpro-menu button:hover { background: var(--dshpro-hover); }

.dshpro-banner {
  display: flex; align-items: flex-start; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; padding: 9px 11px;
  border: 1px solid color-mix(in srgb, var(--tone-color) 32%, var(--dshpro-line)); border-radius: 7px;
  background: color-mix(in srgb, var(--tone-color) 7%, var(--dshpro-panel)); color: var(--dshpro-muted); font-size: 11.5px;
}
.dshpro-banner strong { color: var(--tone-color); font-weight: 700; }
.dshpro-banner .dshpro-check-actions { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; margin-left: auto; }
.dshpro-banner .dshpro-check-actions span { color: var(--dshpro-faint); font-size: 10.5px; }
.dshpro-tabs { display: flex; align-items: center; gap: 2px; margin: 0 0 10px; border-bottom: 1px solid var(--dshpro-line); overflow: auto; }
.dshpro-tab { padding: 8px 10px; border: 0; border-bottom: 2px solid transparent; background: transparent; color: var(--dshpro-muted); font-size: 12px; white-space: nowrap; }
.dshpro-tab:hover { color: var(--dshpro-text); }
.dshpro-tab.is-on { border-bottom-color: var(--dshpro-accent); color: var(--dshpro-text); font-weight: 700; }
.dshpro-tab em { margin-left: 4px; color: var(--dshpro-faint); font-style: normal; font-size: 9.5px; font-variant-numeric: tabular-nums; }
.dshpro-body { display: grid; grid-template-columns: minmax(0, 1fr) 276px; gap: 12px; align-items: start; }
.dshpro-main, .dshpro-rail { min-width: 0; }
.dshpro-card { margin-bottom: 12px; padding: 12px; border: 1px solid var(--dshpro-line); border-radius: var(--dshpro-radius); background: var(--dshpro-panel); min-width: 0; }
.dshpro-card-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
.dshpro-card-title { font-size: 12.5px; font-weight: 700; line-height: 1.35; }
.dshpro-card-sub { margin-top: 1px; color: var(--dshpro-muted); font-size: 10.5px; }
.dshpro-muted { color: var(--dshpro-muted); }
.dshpro-faint { color: var(--dshpro-faint); }
.dshpro-card-link { border: 0; background: transparent; color: var(--dshpro-muted); font-size: 10.5px; }
.dshpro-card-link:hover { color: var(--dshpro-accent); }
.dshpro-empty-inline { padding: 14px 0; color: var(--dshpro-faint); font-size: 11.5px; text-align: center; }
.dshpro-empty-detail { display: flex; height: 100%; min-height: 260px; flex-direction: column; align-items: center; justify-content: center; gap: 7px; color: var(--dshpro-muted); text-align: center; }
.dshpro-empty-detail .dshpro-empty-mark { width: 40px; height: 40px; display: grid; place-items: center; border: 1px solid var(--dshpro-line); border-radius: 10px; background: var(--dshpro-panel-2); color: var(--dshpro-accent); }
.dshpro-empty-detail strong { color: var(--dshpro-text); font-size: 13px; }
.dshpro-empty-detail span { font-size: 11px; max-width: 320px; line-height: 1.5; }

.dshpro-final { display: flex; align-items: center; gap: 10px; padding: 10px; border: 1px solid color-mix(in srgb, var(--dshpro-accent) 28%, var(--dshpro-line)); border-radius: 8px; background: linear-gradient(120deg, color-mix(in srgb, var(--dshpro-accent) 9%, var(--dshpro-panel)), var(--dshpro-panel) 70%); }
.dshpro-final-icon { width: 34px; height: 38px; flex: none; display: grid; place-items: center; border: 1px solid color-mix(in srgb, var(--dshpro-accent) 25%, var(--dshpro-line)); border-radius: 6px; background: var(--dshpro-panel); color: var(--dshpro-accent); }
.dshpro-final-info { flex: 1; min-width: 0; }
.dshpro-final-title { font-size: 12px; font-weight: 700; }
.dshpro-final-path { margin-top: 1px; color: var(--dshpro-muted); font-size: 10px; font-family: ui-monospace, Consolas, monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshpro-final-desc { margin-top: 2px; color: var(--dshpro-faint); font-size: 10px; }

.dshpro-table-wrap { width: 100%; overflow-x: auto; }
.dshpro-table { width: 100%; border-collapse: collapse; font-size: 11px; }
.dshpro-table th { padding: 6px 7px; border-bottom: 1px solid var(--dshpro-line); background: var(--dshpro-panel-2); color: var(--dshpro-muted); font-size: 10px; font-weight: 600; text-align: left; white-space: nowrap; }
.dshpro-table td { padding: 7px; border-bottom: 1px solid color-mix(in srgb, var(--dshpro-line) 65%, transparent); vertical-align: top; }
.dshpro-table tr:last-child td { border-bottom: 0; }
.dshpro-table .dshpro-num { font-variant-numeric: tabular-nums; font-weight: 650; white-space: nowrap; }
.dshpro-table .dshpro-nowrap { white-space: nowrap; }
.dshpro-table .dshpro-dim { color: var(--dshpro-muted); }
.dshpro-verdict { font-weight: 650; }
.dshpro-verdict[data-verdict="accepted"] { color: var(--dshpro-success); }
.dshpro-verdict[data-verdict="partial"] { color: #b58a2b; }
.dshpro-verdict[data-verdict="rejected"] { color: var(--dshpro-error); }
.dshpro-verdict[data-verdict="answered"] { color: var(--dshpro-info); }
.dshpro-verdict[data-verdict="pending"] { color: var(--dshpro-faint); }
.dshpro-artifacts-cell { padding: 0 7px 9px; }
.dshpro-thumbs { display: flex; gap: 6px; flex-wrap: wrap; padding-top: 6px; }
.dshpro-thumb { width: 132px; height: 84px; padding: 0; overflow: hidden; border: 1px solid var(--dshpro-line); border-radius: 6px; background: var(--dshpro-panel-2); cursor: zoom-in; }
.dshpro-thumb img { width: 100%; height: 100%; display: block; object-fit: cover; }
.dshpro-thumb:hover { border-color: var(--dshpro-accent); }
.dshpro-chips { display: flex; gap: 5px; flex-wrap: wrap; padding-top: 6px; }
.dshpro-chip { display: inline-flex; align-items: center; gap: 3px; padding: 2px 6px; border: 1px solid var(--dshpro-line); border-radius: 4px; background: transparent; color: var(--dshpro-muted); font-size: 10px; text-decoration: none; }
.dshpro-chip:hover { border-color: var(--dshpro-accent); color: var(--dshpro-accent); }
.dshpro-round-card { margin-bottom: 12px; padding: 12px; border: 1px solid var(--dshpro-line); border-radius: var(--dshpro-radius); background: var(--dshpro-panel); }
.dshpro-round-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; margin-bottom: 8px; }
.dshpro-round-title { font-size: 12.5px; font-weight: 700; }
.dshpro-round-sub { margin-top: 2px; color: var(--dshpro-muted); font-size: 10.5px; }

.dshpro-gallery { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px; }
.dshpro-art { position: relative; display: block; width: 100%; padding: 0; overflow: hidden; border: 1px solid var(--dshpro-line); border-radius: 7px; background: var(--dshpro-panel-2); aspect-ratio: 4 / 3; cursor: zoom-in; }
.dshpro-art img { width: 100%; height: 100%; display: block; object-fit: cover; }
.dshpro-art:hover { border-color: var(--dshpro-accent); }
.dshpro-art-label { position: absolute; left: 0; right: 0; bottom: 0; padding: 5px 7px; background: linear-gradient(0deg, rgba(0,0,0,.5), transparent); color: #fff; font-size: 9px; text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshpro-art-round { position: absolute; top: 4px; right: 4px; padding: 1px 3px; border-radius: 3px; background: rgba(15,17,21,.62); color: #fff; font-size: 8px; font-weight: 700; line-height: 1.3; }
.dshpro-mini-gallery { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px; }
.dshpro-mini-gallery .dshpro-art { aspect-ratio: 4 / 3; }

.dshpro-file-list { display: flex; flex-direction: column; }
.dshpro-file { display: flex; align-items: center; gap: 8px; min-width: 0; padding: 7px 0; border-top: 1px solid color-mix(in srgb, var(--dshpro-line) 65%, transparent); }
.dshpro-file:first-child { border-top: 0; }
.dshpro-file-icon { width: 29px; height: 31px; flex: none; display: grid; place-items: center; border: 1px solid color-mix(in srgb, var(--dshpro-accent) 20%, var(--dshpro-line)); border-radius: 5px; background: color-mix(in srgb, var(--dshpro-accent) 8%, var(--dshpro-panel)); color: var(--dshpro-accent); }
.dshpro-file-info { flex: 1; min-width: 0; }
.dshpro-file-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11.5px; font-weight: 650; }
.dshpro-file-path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dshpro-faint); font-size: 9.5px; font-family: ui-monospace, Consolas, monospace; }
.dshpro-file-actions { display: flex; align-items: center; gap: 4px; flex: none; }
.dshpro-file-actions .dshpro-btn { min-height: 22px; padding: 2px 6px; font-size: 10px; }

.dshpro-demo { overflow: hidden; border: 1px solid var(--dshpro-line); border-radius: 8px; background: var(--dshpro-panel); }
.dshpro-demo-preview { border-bottom: 1px solid var(--dshpro-line); background: var(--dshpro-panel-2); }
.dshpro-demo-bar { display: flex; align-items: center; gap: 4px; padding: 6px 8px; border-bottom: 1px solid var(--dshpro-line); background: var(--dshpro-panel); color: var(--dshpro-faint); font-size: 9px; }
.dshpro-demo-bar i { width: 5px; height: 5px; border-radius: 999px; background: currentColor; opacity: .5; }
.dshpro-demo-bar em { margin-left: auto; max-width: 70%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-style: normal; }
.dshpro-demo-canvas { display: grid; place-items: center; min-height: 100px; background: linear-gradient(135deg, color-mix(in srgb, var(--dshpro-accent) 12%, var(--dshpro-panel)), var(--dshpro-panel-2) 62%, color-mix(in srgb, var(--dshpro-warn) 9%, var(--dshpro-panel))); color: var(--dshpro-muted); font-size: 10px; }
.dshpro-demo-meta { display: flex; align-items: center; gap: 8px; padding: 8px; }
.dshpro-demo-meta .dshpro-file-info { flex: 1; }
.dshpro-demo-actions { display: flex; gap: 4px; flex: none; }
.dshpro-meta-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 7px 10px; font-size: 10.5px; }
.dshpro-meta-grid span { display: block; color: var(--dshpro-faint); }
.dshpro-meta-grid b { display: block; margin-top: 1px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 550; color: var(--dshpro-muted); }

.dshpro-toast { position: fixed; right: 18px; bottom: 18px; z-index: 2147483100; max-width: min(420px, calc(100vw - 36px)); padding: 9px 12px; border-radius: 7px; background: var(--dshpro-text); color: var(--dshpro-panel); box-shadow: 0 10px 28px rgba(0,0,0,.25); font-size: 11.5px; line-height: 1.45; }
.dshpro-toast[data-kind="error"] { background: var(--dshpro-error); color: #fff; }
.dshpro-overlay { position: fixed; inset: 0; z-index: 2147482900; display: flex; align-items: center; justify-content: center; padding: 22px; background: rgba(0,0,0,.46); }
.dshpro-overlay.is-viewer { z-index: 2147483000; padding: 18px; }
.dshpro-modal-card { display: flex; flex-direction: column; width: min(920px, 94vw); max-height: 90vh; overflow: hidden; border: 1px solid var(--dshpro-line); border-radius: 10px; background: var(--dshpro-panel); color: var(--dshpro-text); box-shadow: 0 24px 80px rgba(0,0,0,.42); }
.dshpro-modal-card.is-dialog { width: min(520px, 94vw); }
.dshpro-modal-head { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--dshpro-line); }
.dshpro-modal-head .dshpro-modal-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12.5px; font-weight: 700; }
.dshpro-modal-body { flex: 1; min-height: 0; overflow: auto; }
.dshpro-modal-body img { display: block; max-width: 100%; max-height: 70vh; margin: 0 auto; object-fit: contain; }
.dshpro-modal-body iframe { display: block; width: 100%; height: 70vh; border: 0; background: #fff; }
.dshpro-modal-body pre { margin: 0; padding: 14px; white-space: pre-wrap; word-break: break-word; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 11.5px; line-height: 1.55; }
.dshpro-modal-foot { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; padding: 8px 12px; border-top: 1px solid var(--dshpro-line); background: var(--dshpro-panel-2); }
.dshpro-modal-note { margin-left: auto; color: var(--dshpro-muted); font-size: 10px; }
.dshpro-dialog-body { padding: 13px 14px; }
.dshpro-dialog-body label { display: block; margin-bottom: 6px; font-size: 11.5px; font-weight: 650; }
.dshpro-dialog-body p { margin: 0 0 8px; color: var(--dshpro-muted); font-size: 11px; line-height: 1.5; }
.dshpro-dialog-body textarea { width: 100%; min-height: 82px; resize: vertical; padding: 7px 9px; border: 1px solid var(--dshpro-line); border-radius: 6px; outline: 0; background: var(--dshpro-bg); color: var(--dshpro-text); font-size: 12px; line-height: 1.5; }
.dshpro-dialog-body textarea:focus { border-color: var(--dshpro-accent); box-shadow: 0 0 0 2px color-mix(in srgb, var(--dshpro-accent) 13%, transparent); }
.dshpro-dialog-row { display: flex; align-items: center; gap: 8px; margin-top: 9px; color: var(--dshpro-muted); font-size: 11px; }
.dshpro-dialog-row input { width: 62px; padding: 5px 7px; border: 1px solid var(--dshpro-line); border-radius: 5px; background: var(--dshpro-bg); color: var(--dshpro-text); }
.dshpro-dialog-foot { display: flex; justify-content: flex-end; gap: 6px; padding: 10px 14px; border-top: 1px solid var(--dshpro-line); background: var(--dshpro-panel-2); }
.dshpro-dialog-foot .dshpro-btn { min-height: 28px; padding: 4px 11px; }

@media (max-width: 1280px) {
  .dshpro-body { grid-template-columns: minmax(0, 1fr); }
  .dshpro-rail { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
  .dshpro-rail .dshpro-card { margin-bottom: 0; }
}
@media (max-width: 1040px) {
  .dshpro-list { width: 240px; flex-basis: 240px; }
  .dshpro-detail { padding: 12px 12px 30px; }
  .dshpro-title { font-size: 16.5px; }
}
@media (max-width: 1000px) {
  .dshpro-root { flex-direction: column; }
  .dshpro-list { width: 100%; flex-basis: auto; max-height: 250px; border-right: 0; border-bottom: 1px solid var(--dshpro-line); }
  .dshpro-list-scroll { max-height: 140px; }
  .dshpro-rail { grid-template-columns: 1fr; }
}
@media (max-width: 640px) {
  .dshpro-optional { display: none; }
  .dshpro-title { font-size: 15.5px; }
  .dshpro-gallery { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .dshpro-thumb { width: 108px; height: 70px; }
}
@media (prefers-reduced-motion: reduce) {
  .dshpro-skeleton { animation: none; }
}
`

function ListSkeleton(): ReactNode {
  return (
    <div>
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
      <span>{design ? '列表里会显示状态、轮次和产物；点开后有图片、demo 和文件。' : '列表里会显示状态、轮次和产物；点开后有轮次、裁决和最终文档。'}</span>
    </div>
  )
}

function FinalCard({ detail, path }: { detail: TopicDetail; path: string }): ReactNode {
  return (
    <div className="dshpro-final">
      <div className="dshpro-final-icon"><Glyph name="file" size={17} /></div>
      <div className="dshpro-final-info">
        <div className="dshpro-final-title">本版总结</div>
        <div className="dshpro-final-path" title={path}>{artifactName(path)}</div>
        <div className="dshpro-final-desc">最终交付文档 · 点击查看全文</div>
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
        {kind === 'demo' && <button type="button" className="dshpro-btn small" onClick={() => showViewer({ kind: 'frame', title: name, topicId: detail.topic_id, src: rawUrl(detail.topic_id, path), path })}>预览</button>}
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
    return <button type="button" className="dshpro-chip" onClick={() => showViewer({ kind: 'frame', title: name, topicId: detail.topic_id, src: rawUrl(detail.topic_id, path), path })}>{name} ↗</button>
  }
  if (kind === 'archive') {
    return <a className="dshpro-chip" href={assetUrl(detail.topic_id, path)} download={name}>{name}</a>
  }
  return <button type="button" className="dshpro-chip" onClick={() => { void openTopicFile(detail.topic_id, path) }}>{name}</button>
}

function RoundTable({ detail, rounds, generation }: { detail: TopicDetail; rounds: RoundRow[]; generation: number }): ReactNode {
  return (
    <div className="dshpro-table-wrap">
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
            const outcome = outcomeOf(round)
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
                    <button type="button" className="dshpro-btn small" onClick={() => { void openAnswer(detail.topic_id, round.n) }}>查看回答</button>
                    {artifacts.length > 0 && <a className="dshpro-btn small" href={bundleUrl(detail.topic_id, round.n)} download={`round-${String(round.n).padStart(2, '0')}.zip`}>下载 ZIP</a>}
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
                <button type="button" className="dshpro-btn small" onClick={() => { void openTopicFile(detail.topic_id, generation.final as string) }}>本版总结</button>
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

function ResearchOverview({ detail, onTab }: { detail: TopicDetail; onTab: (tab: Tab) => void }): ReactNode {
  const generations = generationList(detail)
  const latest = generations[generations.length - 1]
  const rounds = latest !== undefined ? generationRounds(detail, latest.n) : []
  return (
    <div>
      <section className="dshpro-card">
        <div className="dshpro-card-head">
          <div>
            <div className="dshpro-card-title">{latest !== undefined ? `第 ${latest.n} 版` : '最近轮次'}</div>
            <div className="dshpro-card-sub">{latest !== undefined ? generationLabel(latest, rounds) : '尚无轮次'}</div>
          </div>
          <button type="button" className="dshpro-card-link" onClick={() => onTab('rounds')}>全部轮次</button>
        </div>
        {rounds.length > 0 ? <RoundTable detail={detail} rounds={rounds} generation={latest?.n ?? 1} /> : <div className="dshpro-empty-inline">还没有提交记录。</div>}
      </section>
    </div>
  )
}

function DemoCard({ detail, path }: { detail: TopicDetail; path: string }): ReactNode {
  const name = artifactName(path)
  return (
    <div className="dshpro-demo">
      <div className="dshpro-demo-preview">
        <div className="dshpro-demo-bar"><i /><i /><i /><em>{name}</em></div>
        <div className="dshpro-demo-canvas"><span>单文件 HTML demo</span></div>
      </div>
      <div className="dshpro-demo-meta">
        <div className="dshpro-file-info">
          <div className="dshpro-file-name" title={path}>{name}</div>
          <div className="dshpro-file-path">可预览、可新窗口打开</div>
        </div>
        <div className="dshpro-demo-actions">
          <button type="button" className="dshpro-btn small" onClick={() => showViewer({ kind: 'frame', title: name, topicId: detail.topic_id, src: rawUrl(detail.topic_id, path), path })}>预览</button>
          <button type="button" className="dshpro-btn small" onClick={() => { window.open(rawUrl(detail.topic_id, path), '_blank', 'noopener,noreferrer') }}>新窗口</button>
        </div>
      </div>
    </div>
  )
}

function DesignOverview({ detail, onTab }: { detail: TopicDetail; onTab: (tab: Tab) => void }): ReactNode {
  const images = imageArtifacts(detail)
  const round = latestRound(detail)
  const roundPrefix = round !== undefined ? `/round-${String(round.n).padStart(2, '0')}/` : undefined
  const latestImages = roundPrefix !== undefined ? images.filter(path => path.includes(roundPrefix)) : []
  const ordered = [...latestImages, ...images.filter(path => !latestImages.includes(path))]
  const showImages = ordered.slice(0, 9)
  return (
    <div>
      <section className="dshpro-card">
        <div className="dshpro-card-head">
          <div>
            <div className="dshpro-card-title">图片 <span className="dshpro-faint">({images.length})</span></div>
            <div className="dshpro-card-sub">
              {round !== undefined ? `第 ${round.n} 轮 ${latestImages.length} 张优先` : '按轮次排列'}；点击缩略图查看大图。
            </div>
          </div>
          <button type="button" className="dshpro-card-link" onClick={() => onTab('artifacts')}>全部图片</button>
        </div>
        {showImages.length > 0 ? (
          <div className="dshpro-gallery">
            {showImages.map(path => (
              <button key={path} type="button" className="dshpro-art" title={artifactDisplayName(path)} onClick={() => openViewerImage(detail.topic_id, path)}>
                <img src={assetUrl(detail.topic_id, path)} alt={artifactDisplayName(path)} loading="lazy" />
                <span className="dshpro-art-label">{artifactDisplayName(path)}</span>
              </button>
            ))}
          </div>
        ) : <div className="dshpro-empty-inline">还没有图片产物。</div>}
      </section>
    </div>
  )
}

function ArtifactsView({ detail }: { detail: TopicDetail }): ReactNode {
  const final = latestFinal(detail)
  if (!config.designMode) {
    const groups = new Map<string, string[]>()
    for (const path of detail.artifacts) {
      if (path === final) continue
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
        {final !== undefined && (
          <section className="dshpro-card">
            <div className="dshpro-card-head"><div className="dshpro-card-title">最终文档</div></div>
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
      {images.length > 0 && (
        <section className="dshpro-card">
          <div className="dshpro-card-head">
            <div className="dshpro-card-title">全部图片 <span className="dshpro-faint">({images.length})</span></div>
          </div>
          <div className="dshpro-gallery">
            {images.map(path => (
              <button key={path} type="button" className="dshpro-art" title={artifactDisplayName(path)} onClick={() => openViewerImage(detail.topic_id, path)}>
                <img src={assetUrl(detail.topic_id, path)} alt={artifactDisplayName(path)} loading="lazy" />
                <span className="dshpro-art-label">{artifactDisplayName(path)}</span>
              </button>
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
  return (
    <section className="dshpro-card">
      <div className="dshpro-card-head"><div className="dshpro-card-title">主题信息</div></div>
      <div className="dshpro-meta-grid">
        <div><span>类型</span><b>{detail.type === 'design' ? '设计' : '研究'}</b></div>
        <div><span>通道</span><b>{channelLabel(detail.channel) ?? '—'}</b></div>
        <div><span>模型</span><b>{detail.model !== undefined && detail.model !== '' ? detail.model : '—'}</b></div>
        <div><span>存储</span><b>{detail.store === 'local' ? '本机' : '项目'}</b></div>
        <div><span>创建</span><b>{formatTime(detail.created)}</b></div>
        <div><span>更新</span><b>{formatTime(detail.updated)}</b></div>
      </div>
    </section>
  )
}

function Rail({ detail, onTab }: { detail: TopicDetail; onTab: (tab: Tab) => void }): ReactNode {
  const final = latestFinal(detail)
  const images = imageArtifacts(detail)
  const demos = demoArtifacts(detail)
  const files = fileArtifacts(detail)
  if (config.designMode) {
    return (
      <aside className="dshpro-rail">
        {demos.length > 0 && (
          <section className="dshpro-card">
            <div className="dshpro-card-head"><div className="dshpro-card-title">当前 demo</div></div>
            <DemoCard detail={detail} path={demos[0] as string} />
          </section>
        )}
        <section className="dshpro-card">
          <div className="dshpro-card-head">
            <div className="dshpro-card-title">全部图片 <span className="dshpro-faint">({images.length})</span></div>
            <button type="button" className="dshpro-card-link" onClick={() => onTab('artifacts')}>查看</button>
          </div>
          {images.length > 0 ? (
            <div className="dshpro-mini-gallery">
              {images.slice(0, 6).map(path => (
                <button key={path} type="button" className="dshpro-art" title={artifactDisplayName(path)} onClick={() => openViewerImage(detail.topic_id, path)}>
                  <img src={assetUrl(detail.topic_id, path)} alt={artifactDisplayName(path)} loading="lazy" />
                  {roundOf(path) !== undefined && <span className="dshpro-art-round">R{roundOf(path)}</span>}
                </button>
              ))}
            </div>
          ) : <div className="dshpro-empty-inline">还没有图片。</div>}
        </section>
        <section className="dshpro-card">
          <div className="dshpro-card-head">
            <div className="dshpro-card-title">代码与文件 <span className="dshpro-faint">({files.length})</span></div>
            <button type="button" className="dshpro-card-link" onClick={() => onTab('artifacts')}>查看</button>
          </div>
          <div className="dshpro-file-list">
            {files.slice(0, 4).map(path => <ArtifactRow key={path} detail={detail} path={path} />)}
            {files.length === 0 && <div className="dshpro-empty-inline">还没有文件。</div>}
          </div>
        </section>
        <MetaCard detail={detail} />
      </aside>
    )
  }
  return (
    <aside className="dshpro-rail">
      <section className="dshpro-card">
        <div className="dshpro-card-head"><div className="dshpro-card-title">最终文档</div></div>
        {final !== undefined ? <FinalCard detail={detail} path={final} /> : <div className="dshpro-empty-inline">还没有 final.md。</div>}
      </section>
      <section className="dshpro-card">
        <div className="dshpro-card-head">
          <div className="dshpro-card-title">全部产物 <span className="dshpro-faint">({detail.artifacts.length})</span></div>
          <button type="button" className="dshpro-card-link" onClick={() => onTab('artifacts')}>查看</button>
        </div>
        <div className="dshpro-file-list">
          {detail.artifacts.slice(0, 5).map(path => <ArtifactRow key={path} detail={detail} path={path} />)}
          {detail.artifacts.length === 0 && <div className="dshpro-empty-inline">还没有产物。</div>}
        </div>
      </section>
      <MetaCard detail={detail} />
    </aside>
  )
}

function ViewerModal({ view, basePath, onClose }: { view: Viewer; basePath?: string; onClose: () => void }): ReactNode {
  const [notice, setNotice] = useState<string | undefined>(undefined)
  useEffect(() => { setNotice(undefined) }, [view])
  const run = (task: () => Promise<void>, success: string): void => {
    setNotice('处理中…')
    void task()
      .then(() => setNotice(success))
      .catch((error: unknown) => setNotice(error instanceof Error ? error.message : String(error)))
  }
  const path = view.path
  const native = path !== undefined ? fullPath(basePath, path) : undefined
  return (
    <div className="dshpro-overlay is-viewer" onClick={onClose}>
      <div className="dshpro-modal-card" role="dialog" aria-modal="true" aria-label={view.title} onClick={event => event.stopPropagation()}>
        <div className="dshpro-modal-head">
          <div className="dshpro-modal-title" title={view.title}>{view.title}</div>
          <button type="button" className="dshpro-icon-btn" onClick={onClose} aria-label="关闭"><Glyph name="close" size={15} /></button>
        </div>
        <div className="dshpro-modal-body">
          {view.kind === 'image' && view.src !== undefined && <img src={view.src} alt={view.title} />}
          {view.kind === 'frame' && view.src !== undefined && <iframe src={view.src} sandbox="allow-scripts" title={view.title} />}
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
    </div>
  )
}

function ActionDialog({
  dialog,
  designMode,
  busy,
  regenNote,
  continueNote,
  continueDesigns,
  checkNote,
  onRegenNote,
  onContinueNote,
  onContinueDesigns,
  onCheckNote,
  onClose,
  onSubmit,
}: {
  dialog: DialogState
  designMode: boolean
  busy: boolean
  regenNote: string
  continueNote: string
  continueDesigns: string
  checkNote: string
  onRegenNote: (value: string) => void
  onContinueNote: (value: string) => void
  onContinueDesigns: (value: string) => void
  onCheckNote: (value: string) => void
  onClose: () => void
  onSubmit: () => void
}): ReactNode {
  const title = dialog.kind === 'regenerate' ? '重新生成' : dialog.kind === 'continue' ? '继续一轮' : '人工核对'
  return (
    <div className="dshpro-overlay" onClick={onClose}>
      <div className="dshpro-modal-card is-dialog" role="dialog" aria-modal="true" aria-label={title} onClick={event => event.stopPropagation()}>
        <div className="dshpro-modal-head">
          <div className="dshpro-modal-title">{title}</div>
          <button type="button" className="dshpro-icon-btn" onClick={onClose} aria-label="关闭"><Glyph name="close" size={15} /></button>
        </div>
        <div className="dshpro-dialog-body">
          {dialog.kind === 'regenerate' && (
            <>
              <label htmlFor="dshpro-regen">不满意的地方 / 新要求</label>
              <p>可留空直接换一版；提交后保留已有轮次。</p>
              <textarea id="dshpro-regen" value={regenNote} onChange={event => onRegenNote(event.target.value)} placeholder="例如：保留版式，只改配色；标题必须出现……；不要再用……" />
            </>
          )}
          {dialog.kind === 'continue' && (
            <>
              <label htmlFor="dshpro-continue">这一轮只补充什么</label>
              <p>一次继续只追加一轮，不会顺带跑完剩余上限。</p>
              <textarea id="dshpro-continue" value={continueNote} onChange={event => onContinueNote(event.target.value)} placeholder="例如：只查部署风险；只改配色，保留版式" />
              {designMode && (
                <div className="dshpro-dialog-row">
                  <span>本轮方向数</span>
                  <input type="number" min={1} max={6} value={continueDesigns} onChange={event => onContinueDesigns(event.target.value)} placeholder="3" />
                  <span>1–6</span>
                </div>
              )}
            </>
          )}
          {dialog.kind === 'check' && (
            <>
              <label htmlFor="dshpro-check">核对依据（必填）</label>
              <p>结论：{dialog.conclusion === 'submitted' ? '已提交' : dialog.conclusion === 'not_submitted' ? '未提交' : '需重开'}。写一下你在浏览器里看到的依据，方便追溯。</p>
              <textarea id="dshpro-check" value={checkNote} onChange={event => onCheckNote(event.target.value)} placeholder="例如：输入框里能看到消息、附件卡片齐全；或页面停在 about:blank" />
            </>
          )}
        </div>
        <div className="dshpro-dialog-foot">
          <button type="button" className="dshpro-btn" onClick={onClose}>取消</button>
          <button type="button" className="dshpro-btn primary" onClick={onSubmit} disabled={busy}>{busy ? '处理中…' : dialog.kind === 'regenerate' ? '提交重新生成' : dialog.kind === 'continue' ? '提交继续' : '提交核对'}</button>
        </div>
      </div>
    </div>
  )
}

function TopicItem({
  topic,
  selected,
  design,
  onSelect,
}: {
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
        <span>{design ? '设计' : '研究'}</span>
        <span className="dshpro-sep">·</span>
        <span>{topic.rounds}/{topic.rounds_cap} 轮</span>
        <span className="dshpro-sep">·</span>
        <span>{formatRelative(topic.updated)}</span>
        <span className="dshpro-topic-tail">
          {topic.artifacts.length > 0 && (
            <span className="dshpro-topic-artifacts">
              <Glyph name="image" size={11} />{topic.artifacts.length}
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
  const [listLoading, setListLoading] = useState(false)
  const [detailLoading, setDetailLoading] = useState(false)
  const [dialog, setDialog] = useState<DialogState | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [regenNote, setRegenNote] = useState('')
  const [continueNote, setContinueNote] = useState('')
  const [continueDesigns, setContinueDesigns] = useState('')
  const [checkNote, setCheckNote] = useState('')
  const [viewer, setViewer] = useState<Viewer | undefined>(undefined)
  showViewer = setViewer

  useEffect(() => {
    if (notice === undefined) return
    const timer = setTimeout(() => setNotice(undefined), 4_000)
    return () => clearTimeout(timer)
  }, [notice])

  useEffect(() => {
    if (viewer === undefined && dialog === undefined) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      if (viewer !== undefined) setViewer(undefined)
      else setDialog(undefined)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [viewer, dialog])

  const loadList = async (): Promise<void> => {
    setListLoading(true)
    try {
      const data = await getJson<{ topics: TopicRow[] }>(`${config.routes}/topics`)
      setTopics(data.topics)
      setError(undefined)
      setSelected(current => current ?? data.topics[0]?.topic_id)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setListLoading(false)
    }
  }

  const loadDetail = async (id: string): Promise<void> => {
    setDetailLoading(true)
    try {
      const data = await getJson<{ topic: TopicDetail }>(`${config.routes}/topic?id=${encodeURIComponent(id)}`)
      setDetail(data.topic)
      setError(undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setDetailLoading(false)
    }
  }

  useEffect(() => {
    void loadList()
    const timer = setInterval(() => { void loadList() }, POLL_MS)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    if (selected === undefined) return
    void loadDetail(selected)
    const timer = setInterval(() => { void loadDetail(selected) }, POLL_MS)
    return () => clearInterval(timer)
  }, [selected])

  useEffect(() => {
    if (selected === undefined || detail === undefined) return
    const listed = topics.find(topic => topic.topic_id === selected)
    if (listed !== undefined && listed.status !== detail.status) void loadDetail(selected)
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
    setTab('overview')
    setDialog(undefined)
    setViewer(undefined)
    if (selected === undefined) return
    const reveal = (): void => {
      const row = document.querySelector<HTMLElement>(`[data-topic-id="${selected}"]`)
      row?.scrollIntoView({ block: 'nearest' })
    }
    reveal()
    window.addEventListener('resize', reveal)
    return () => window.removeEventListener('resize', reveal)
  }, [selected])

  const act = async (action: string, conclusion?: string, note?: string): Promise<boolean> => {
    const target = detail?.topic_id
    if (selected === undefined || target === undefined || target !== selected) {
      setNotice({ kind: 'error', text: '主题正在切换，请等详情加载完成后再操作' })
      return false
    }
    try {
      const result = await postAction<{ topic: TopicRow & { wake?: { ok: boolean; resumed?: boolean; reason?: string } } }>({ action, topic_id: target, ...(conclusion !== undefined ? { conclusion } : {}), ...(note !== undefined ? { note } : {}) })
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
      const result = await postAction<Record<string, unknown>>({ action })
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

  const submitRegenerate = async (): Promise<void> => {
    const target = detail?.topic_id
    if (selected === undefined || target === undefined || target !== selected) {
      setNotice({ kind: 'error', text: '主题正在切换，请等详情加载完成后再操作' })
      return
    }
    try {
      await postAction<{ topic: TopicRow }>({ action: 'regenerate', topic_id: target, note: regenNote.trim() })
      setNotice({ kind: 'ok', text: '已提交重新生成' })
      setDetail(current => current === undefined ? current : { ...current, status: 'queued' })
      setDialog(undefined)
      setRegenNote('')
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
    try {
      await postAction<{ topic: TopicRow }>({
        action: 'continue',
        topic_id: target,
        brief,
        ...(designs !== undefined ? { designs } : {}),
      })
      setNotice({ kind: 'ok', text: '已追加一轮' })
      setDetail(current => current === undefined ? current : { ...current, status: 'queued' })
      setDialog(undefined)
      setContinueNote('')
      setContinueDesigns('')
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

  const submitDialog = (): void => {
    if (dialog === undefined || busy) return
    setBusy(true)
    const task = dialog.kind === 'regenerate'
      ? submitRegenerate()
      : dialog.kind === 'continue'
        ? submitContinue()
        : submitHumanCheck()
    void task.finally(() => setBusy(false))
  }

  const openRegenerate = (): void => {
    setRegenNote('')
    setDialog({ kind: 'regenerate' })
  }

  const openContinue = (): void => {
    setContinueNote('')
    setContinueDesigns('')
    setDialog({ kind: 'continue' })
  }

  const openCheck = (conclusion: 'submitted' | 'not_submitted' | 'reopen'): void => {
    setCheckNote('')
    setDialog({ kind: 'check', conclusion })
  }

  const current = detail !== undefined && detail.topic_id === selected ? detail : undefined
  const hasArtifacts = (current?.artifacts.length ?? 0) > 0
  const canAccept = current !== undefined && (
    current.status === 'capped'
    || (current.status === 'reviewing' && (current.review_from === 'capped' || hasArtifacts))
    || ((current.status === 'failed' || current.status === 'stalled') && hasArtifacts)
  )
  const canRegenerate = current !== undefined && (current.status === 'completed' || current.status === 'capped' || current.status === 'reviewing' || current.status === 'failed' || current.status === 'stalled')
  const canContinue = current !== undefined && (current.status === 'completed' || current.status === 'capped' || current.status === 'reviewing' || current.status === 'failed' || current.status === 'stalled')
  const canReview = current !== undefined && (current.status === 'capped' || current.status === 'reviewing' || ((current.status === 'failed' || current.status === 'stalled') && hasArtifacts))
  const canReviewCancel = current !== undefined && current.status === 'reviewing'
  const canWake = current !== undefined && current.status === 'completed'
  const canCancel = current !== undefined && ACTIVE.has(current.status)
  const canResume = current !== undefined && (current.status === 'stalled' || current.status === 'failed')
  const acceptLabel = current !== undefined && (current.status === 'capped' || current.status === 'reviewing') ? '接受结果' : '接受已有产物'

  let primary: { label: string; run: () => void } | undefined
  if (current !== undefined) {
    if (canResume) primary = { label: '恢复运行', run: () => { void act('resume') } }
    else if (canAccept) primary = { label: acceptLabel, run: () => { void act('accept') } }
    else if (current.status === 'completed' && canContinue) primary = { label: '继续一轮', run: openContinue }
  }

  const secondary: Array<{ label: string; run: () => void }> = []
  if (current !== undefined) {
    if (canContinue && primary?.label !== '继续一轮') secondary.push({ label: '继续一轮', run: openContinue })
    if (canRegenerate && primary?.label !== '重新生成') secondary.push({ label: '重新生成', run: openRegenerate })
    if (canReview) secondary.push({ label: current.status === 'reviewing' ? '再次提醒原会话' : '请原会话判断', run: () => { void act('review') } })
    if (canReviewCancel) secondary.push({ label: '撤回判断请求', run: () => { void act('review_cancel') } })
    if (canWake) secondary.push({ label: '唤醒原会话', run: () => { void act('wake') } })
    if (canAccept && primary?.label !== acceptLabel) secondary.push({ label: acceptLabel, run: () => { void act('accept') } })
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

  const refresh = (): void => {
    if (selected !== undefined) void loadDetail(selected)
    void loadList()
  }

  const hasBanner = current !== undefined && (current.status === 'capped' || current.status === 'reviewing' || current.status === 'stalled' || current.status === 'failed' || current.status === 'draft' || ACTIVE.has(current.status))

  return (
    <div className="dshpro-root" data-plugin={config.designMode ? 'design' : 'research'}>
      <style data-dsh-pro-panel dangerouslySetInnerHTML={{ __html: PANEL_CSS }} />
      <aside className="dshpro-list">
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
          {error !== undefined && topics.length === 0 && (
            <div className="dshpro-list-error">加载失败：{error} <button type="button" className="dshpro-card-link" onClick={() => { void loadList() }}>重试</button></div>
          )}
          {listLoading && topics.length === 0
            ? <ListSkeleton />
            : topics.length === 0
              ? (
                <div className="dshpro-list-empty">
                  <div className="dshpro-empty-icon"><Glyph name={config.designMode ? 'image' : 'file'} size={24} /></div>
                  <p>{config.designMode ? '还没有设计任务' : '还没有研究任务'}</p>
                  <span>{config.designMode ? '在会话里用 /gpt-image-design 开始。' : '在会话里用 /pro-research 开始。'}</span>
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
                    design={config.designMode}
                    onSelect={() => {
                      markTopicSeen(config.panelId, topic.topic_id, topic.updated)
                      setSelected(topic.topic_id)
                    }}
                  />
                ))}
        </div>
      </aside>

      <main className="dshpro-detail">
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
                  <div className="dshpro-title-row">
                    <h2 className="dshpro-title">{current.title}</h2>
                    <StatusPill status={current.status} />
                  </div>
                  <div className="dshpro-meta">
                    <span>{current.rounds}/{current.rounds_cap} 轮</span>
                    <span>{current.type === 'design' ? '设计' : '研究'}</span>
                    {channelLabel(current.channel) !== undefined && <span>{channelLabel(current.channel)}</span>}
                    {current.model !== undefined && current.model !== '' && <span>{current.model}</span>}
                    {current.designs != null && <span>每轮 {current.designs} 个方向</span>}
                    <span>更新 {formatRelative(current.updated)}</span>
                  </div>
                  {current.stop_reason !== null && (
                    <div className="dshpro-card-sub" style={{ marginTop: 6 }}>停止依据：{current.stop_reason}</div>
                  )}
                  {(current.judge_enabled === false || (current.judge_enabled === undefined && (current.stop_reason ?? '').includes('未配置裁决模型'))) && current.status === 'capped' && (
                    <div className="dshpro-card-sub" style={{ marginTop: 6, color: 'var(--dshpro-warn)' }}>当前没有可用的自动裁决模型：跑满轮次后进入待接受。</div>
                  )}
                  {current.path !== undefined && current.path !== '' && (
                    <div className="dshpro-path">
                      <Glyph name="folder" size={12} />
                      <span title={current.path}>{current.path}</span>
                      <button type="button" className="dshpro-icon-btn" title="复制路径" aria-label="复制主题路径" onClick={() => { void copyPath() }}><Glyph name="copy" size={12} /></button>
                    </div>
                  )}
                  <div className="dshpro-actions">
                    {primary !== undefined && <button type="button" className="dshpro-btn primary" onClick={primary.run}>{primary.label}</button>}
                    {secondary.map(item => <button key={item.label} type="button" className="dshpro-btn" onClick={item.run}>{item.label}</button>)}
                    {canCancel && <button type="button" className="dshpro-btn danger" onClick={() => { void act('cancel') }}>取消运行</button>}
                    <details className="dshpro-more">
                      <summary className="dshpro-btn"><Glyph name="more" size={13} /> 更多</summary>
                      <div className="dshpro-menu">
                        <button type="button" onClick={event => { closeMenu(event); void runPanelAction('probe') }}>自检</button>
                        <button type="button" onClick={event => { closeMenu(event); void runPanelAction('login') }}>登录</button>
                        <button type="button" onClick={event => { closeMenu(event); void copyPath() }}>复制主题路径</button>
                        <button type="button" onClick={event => { closeMenu(event); refresh() }}>刷新</button>
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
                    {current.status === 'failed' && <><strong>运行失败</strong><span>可恢复运行，或接受已有产物。</span></>}
                    {current.status === 'capped' && <><strong>已达到轮次上限</strong><span>检查产物后接受结果，或继续一轮。</span></>}
                    {current.status === 'reviewing' && <><strong>待原会话判断</strong><span>结果已交给发起会话；可以接受结果，或撤回判断请求。</span></>}
                    {ACTIVE.has(current.status) && <><strong>正在运行</strong><span>{statusLabel(current.status)} · 每 3 秒刷新</span></>}
                    {current.status === 'draft' && <><strong>草稿</strong><span>等待确认后开始。</span></>}
                    {current.status === 'stalled' && (
                      <div className="dshpro-check-actions">
                        <span>人工核对</span>
                        <button type="button" className="dshpro-btn small" onClick={() => openCheck('submitted')}>已提交</button>
                        <button type="button" className="dshpro-btn small" onClick={() => openCheck('not_submitted')}>未提交</button>
                        <button type="button" className="dshpro-btn small" onClick={() => openCheck('reopen')}>需重开</button>
                      </div>
                    )}
                  </div>
                )}

                <nav className="dshpro-tabs" role="tablist">
                  <button type="button" role="tab" aria-selected={tab === 'overview'} className={`dshpro-tab${tab === 'overview' ? ' is-on' : ''}`} onClick={() => setTab('overview')}>概览</button>
                  <button type="button" role="tab" aria-selected={tab === 'rounds'} className={`dshpro-tab${tab === 'rounds' ? ' is-on' : ''}`} onClick={() => setTab('rounds')}>轮次<em>{current.rounds}</em></button>
                  <button type="button" role="tab" aria-selected={tab === 'artifacts'} className={`dshpro-tab${tab === 'artifacts' ? ' is-on' : ''}`} onClick={() => setTab('artifacts')}>产物<em>{current.artifacts.length}</em></button>
                </nav>

                <div className="dshpro-body">
                  <div className="dshpro-main">
                    {tab === 'overview' && (config.designMode
                      ? <DesignOverview detail={current} onTab={setTab} />
                      : <ResearchOverview detail={current} onTab={setTab} />)}
                    {tab === 'rounds' && <RoundsView detail={current} />}
                    {tab === 'artifacts' && <ArtifactsView detail={current} />}
                  </div>
                  <Rail detail={current} onTab={setTab} />
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
          checkNote={checkNote}
          onRegenNote={setRegenNote}
          onContinueNote={setContinueNote}
          onContinueDesigns={setContinueDesigns}
          onCheckNote={setCheckNote}
          onClose={() => setDialog(undefined)}
          onSubmit={submitDialog}
        />
      )}
      {viewer !== undefined && (
        <ViewerModal view={viewer} basePath={current?.path} onClose={() => setViewer(undefined)} />
      )}
      {notice !== undefined && <div className="dshpro-toast" data-kind={notice.kind} role={notice.kind === 'error' ? 'alert' : 'status'}>{notice.text}</div>}
    </div>
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
