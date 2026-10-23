import { createElement, useCallback, useEffect, useState } from 'react'
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
  stall_reason: string | null
  rounds: number
  rounds_cap: number
  designs?: number | null
  stop_reason: string | null
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
  reason?: string
  final?: string
}

interface TopicDetail extends TopicRow {
  created?: string
  generations?: GenerationRow[]
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

let showViewer: (view: Viewer | undefined) => void = () => {}

const STATUS_LABEL: Record<string, string> = {
  draft: '草稿',
  queued: '排队',
  uploading: '上传中',
  submitted: '已提交',
  waiting: '等待答复',
  answered: '已答复',
  adjudicating: '裁决中',
  completed: '完成',
  capped: '到轮次上限',
  stalled: '卡住',
  failed: '失败',
  cancelled: '已取消',
}

const STATUS_COLOR: Record<string, string> = {
  completed: '#2e7d32',
  capped: '#6a1b9a',
  stalled: '#ed6c02',
  failed: '#c62828',
  cancelled: '#757575',
}

const ACTIVE = new Set(['queued', 'uploading', 'submitted', 'waiting', 'answered', 'adjudicating'])

const STALL_LABEL: Record<string, string> = {
  login: '登录失效',
  upload: '材料上传不完整',
  timeout: '超时或无进展',
  ui: '页面结构变化',
  config: '配置或请求参数被拒',
  worker: '浏览器进程崩溃',
  unknown_submission: '提交状态未知',
}

function channelLabel(channel: string | undefined): string | undefined {
  if (channel === undefined || channel === '') return undefined
  return channel === 'api' ? 'API 生图' : '网页会话'
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { accept: 'application/json' } })
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
    throw new Error(text === '' ? `${response.status}` : text)
  }
  return await response.json() as T
}

function Dot({ status }: { status: string }): ReturnType<typeof createElement> {
  return createElement('span', {
    style: {
      display: 'inline-block',
      width: 8,
      height: 8,
      borderRadius: 999,
      background: STATUS_COLOR[status] ?? 'var(--dsh-text-2, #757575)',
      marginRight: 6,
      flex: '0 0 auto',
    },
  })
}

function Panel(): ReturnType<typeof createElement> {
  const [topics, setTopics] = useState<TopicRow[]>([])
  const [selected, setSelected] = useState<string | undefined>(undefined)
  const [detail, setDetail] = useState<TopicDetail | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | undefined>(undefined)
  const [regenOpen, setRegenOpen] = useState(false)
  const [regenNote, setRegenNote] = useState('')
  const [viewer, setViewer] = useState<Viewer | undefined>(undefined)
  showViewer = setViewer

  useEffect(() => {
    if (notice === undefined) return
    const timer = setTimeout(() => setNotice(undefined), 4_000)
    return () => clearTimeout(timer)
  }, [notice])

  const loadList = useCallback(async () => {
    try {
      const data = await getJson<{ topics: TopicRow[] }>(`${config.routes}/topics`)
      setTopics(data.topics)
      setError(undefined)
      if (selected === undefined && data.topics[0] !== undefined) setSelected(data.topics[0].topic_id)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [selected])

  const loadDetail = useCallback(async (id: string) => {
    try {
      const data = await getJson<{ topic: TopicDetail }>(`${config.routes}/topic?id=${encodeURIComponent(id)}`)
      setDetail(data.topic)
      setError(undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])

  useEffect(() => {
    void loadList()
    const timer = setInterval(() => { void loadList() }, POLL_MS)
    return () => clearInterval(timer)
  }, [loadList])

  useEffect(() => {
    if (selected === undefined) return
    void loadDetail(selected)
    const timer = setInterval(() => { void loadDetail(selected) }, POLL_MS)
    return () => clearInterval(timer)
  }, [selected, loadDetail, topics])

  useEffect(() => {
    if (viewer === undefined) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setViewer(undefined)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [viewer])

  const act = useCallback(async (action: string, conclusion?: string) => {
    if (selected === undefined) return
    let note: string | undefined
    if (action === 'human_check') {
      const input = window.prompt('核对结论的依据（必填）')
      if (input === null || input.trim() === '') return
      note = input.trim()
    }
    try {
      const result = await postAction<{ topic: TopicRow }>({ action, topic_id: selected, ...(conclusion !== undefined ? { conclusion } : {}), ...(note !== undefined ? { note } : {}) })
      if (action === 'accept') {
        setDetail(current => current === undefined ? current : { ...current, status: 'completed' })
        if (result.topic?.updated !== undefined) markTopicSeen(config.panelId, selected, result.topic.updated)
        setNotice({ kind: 'ok', text: '已接受结果' })
      } else {
        setNotice({ kind: 'ok', text: action === 'regenerate' ? '已提交重新生成' : `已执行：${action}` })
      }
      await loadDetail(selected)
      await loadList()
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      setError(message)
      setNotice({ kind: 'error', text: message })
    }
  }, [selected, loadDetail, loadList])

  const submitRegenerate = useCallback(async () => {
    if (selected === undefined) return
    try {
      await postAction<{ topic: TopicRow }>({ action: 'regenerate', topic_id: selected, note: regenNote.trim() })
      setNotice({ kind: 'ok', text: '已提交重新生成' })
      setDetail(current => current === undefined ? current : { ...current, status: 'queued' })
      setRegenOpen(false)
      setRegenNote('')
      await loadDetail(selected)
      await loadList()
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      setError(message)
      setNotice({ kind: 'error', text: message })
    }
  }, [selected, regenNote, loadDetail, loadList])

  const list = createElement('div', { style: { width: 240, borderRight: '1px solid rgba(127,127,127,.2)', overflowY: 'auto', flex: '0 0 auto' } },
    createElement('div', { style: { padding: '10px 12px', fontWeight: 600, fontSize: 13, opacity: 0.8 } }, config.title),
    topics.length === 0
      ? createElement('div', { style: { padding: '8px 12px', opacity: 0.6, fontSize: 12, lineHeight: 1.6 } },
        config.designMode
          ? '还没有设计任务。在会话里用 /gpt-image-design 开始。'
          : '还没有研究任务。在会话里用 /pro-research 开始。')
      : topics.map(topic => createElement('div', {
        key: topic.topic_id,
        onClick: () => {
          markTopicSeen(config.panelId, topic.topic_id, topic.updated)
          setSelected(topic.topic_id)
        },
        style: {
          padding: '8px 12px',
          cursor: 'pointer',
          background: topic.topic_id === selected ? 'rgba(127,127,127,.12)' : 'transparent',
          borderBottom: '1px solid rgba(127,127,127,.12)',
        },
      },
      createElement('div', { style: { display: 'flex', alignItems: 'center', fontSize: 13, fontWeight: 500 } },
        createElement(Dot, { status: topic.status }),
        createElement('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, topic.title)),
      createElement('div', { style: { fontSize: 11, opacity: 0.65, marginLeft: 14, marginTop: 2 } },
        `${STATUS_LABEL[topic.status] ?? topic.status} · ${topic.rounds}/${topic.rounds_cap} 轮`))))

  const hasArtifacts = (detail?.artifacts.length ?? 0) > 0
  const canAccept = detail !== undefined && (detail.status === 'capped' || ((detail.status === 'failed' || detail.status === 'stalled') && hasArtifacts))
  const canRegenerate = detail !== undefined && (detail.status === 'completed' || detail.status === 'capped' || detail.status === 'failed' || detail.status === 'stalled')

  const body = createElement('div', { style: { flex: 1, overflowY: 'auto', padding: 14, fontSize: 13, lineHeight: 1.6 } },
    error !== undefined ? createElement('div', { style: { color: '#c62828', marginBottom: 8 } }, `接口错误：${error}`) : undefined,
    notice !== undefined
      ? createElement('div', {
        style: {
          marginBottom: 8,
          padding: '6px 10px',
          borderRadius: 6,
          fontSize: 12,
          color: notice.kind === 'ok' ? '#2e7d32' : '#c62828',
          background: notice.kind === 'ok' ? 'rgba(46,125,50,.1)' : 'rgba(198,40,40,.1)',
        },
      }, notice.text)
      : undefined,
    detail === undefined
      ? createElement('div', { style: { opacity: 0.6 } }, '选择左侧的主题查看轮次与产物。')
      : createElement('div', {},
        createElement('div', { style: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', paddingBottom: 8, borderBottom: '1px solid rgba(127,127,127,.18)' } },
          createElement('h3', { style: { margin: 0, fontSize: 17, fontWeight: 650, lineHeight: 1.3 } }, detail.title),
          statusPill(detail.status)),
        createElement('div', { style: { display: 'flex', gap: 14, flexWrap: 'wrap', margin: '8px 0', fontSize: 11, opacity: 0.62 } },
          createElement('span', {}, `${detail.rounds}/${detail.rounds_cap} 轮`),
          createElement('span', {}, detail.type),
          channelLabel(detail.channel) !== undefined ? createElement('span', {}, channelLabel(detail.channel)) : undefined,
          detail.model !== undefined && detail.model !== '' ? createElement('span', {}, detail.model) : undefined,
          detail.designs != null ? createElement('span', {}, `每轮方向 ${detail.designs}`) : undefined,
          detail.updated !== undefined ? createElement('span', {}, `更新 ${formatTime(detail.updated)}`) : undefined),
        detail.stall_reason !== null ? createElement('div', { style: { color: '#ed6c02', marginBottom: 8, fontSize: 12 } }, `卡住原因：${STALL_LABEL[detail.stall_reason] ?? detail.stall_reason}（${detail.stall_reason}）`) : undefined,
        detail.stop_reason !== null ? createElement('div', { style: { marginBottom: 8, fontSize: 12, opacity: 0.72 } }, `停止依据：${detail.stop_reason}`) : undefined,
        detail.status === 'capped' && (detail.stop_reason ?? '').includes('未配置裁决模型')
          ? createElement('div', { style: { marginBottom: 8, fontSize: 11, color: '#ed6c02' } }, '未配置自动裁决：跑满轮次不会自动判定成功；请接受结果或重新生成。')
          : undefined,
        detail.path !== undefined ? createElement('div', { style: { opacity: 0.5, marginBottom: 10, wordBreak: 'break-all', fontSize: 11 } }, detail.path) : undefined,
        createElement('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 } },
          ACTIVE.has(detail.status) ? createElement('button', { onClick: () => void act('cancel'), style: buttonStyle() }, '取消') : undefined,
          detail.status === 'stalled' || detail.status === 'failed'
            ? createElement('button', { onClick: () => void act('resume'), style: buttonStyle() }, '恢复')
            : undefined,
          canRegenerate
            ? createElement('button', { onClick: () => { setRegenNote(''); setRegenOpen(true) }, style: buttonStyle() }, '重新生成')
            : undefined,
          canAccept
            ? createElement('button', { onClick: () => void act('accept'), style: buttonStyle() }, detail?.status === 'capped' ? '接受结果' : '接受已有产物')
            : undefined,
          detail.status === 'stalled'
            ? createElement('span', { style: { display: 'flex', gap: 8 } },
              createElement('button', { onClick: () => void act('human_check', 'submitted'), style: buttonStyle() }, '已提交'),
              createElement('button', { onClick: () => void act('human_check', 'not_submitted'), style: buttonStyle() }, '未提交'),
              createElement('button', { onClick: () => void act('human_check', 'reopen'), style: buttonStyle() }, '需重开'))
            : undefined),
        regenOpen
          ? createElement('div', {
            style: {
              maxWidth: 640,
              marginBottom: 18,
              padding: '12px 14px',
              border: '1px solid rgba(127,127,127,.22)',
              borderRadius: 10,
              background: 'rgba(127,127,127,.05)',
              boxSizing: 'border-box',
            },
          },
          createElement('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 } },
            createElement('div', { style: { fontSize: 12, fontWeight: 600 } }, '重新生成'),
            createElement('div', { style: { fontSize: 11, opacity: 0.55 } }, '可补充不满意的地方；提交后保留已有轮次')),
          createElement('textarea', {
            value: regenNote,
            onChange: (event: { target: { value: string } }) => setRegenNote(event.target.value),
            rows: 3,
            placeholder: '例如：保留版式，只改配色；标题必须出现……；不要再用……',
            style: {
              width: '100%',
              boxSizing: 'border-box',
              resize: 'vertical',
              padding: '8px 10px',
              borderRadius: 8,
              border: '1px solid rgba(127,127,127,.3)',
              background: 'transparent',
              color: 'inherit',
              fontSize: 12,
              lineHeight: 1.55,
            },
          }),
          createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', marginTop: 8 } },
            createElement('span', { style: { fontSize: 11, opacity: 0.45 } }, '留空则让它直接换一版'),
            createElement('div', { style: { display: 'flex', gap: 8 } },
              createElement('button', { onClick: () => { setRegenOpen(false); setRegenNote('') }, style: buttonStyle() }, '取消'),
              createElement('button', {
                onClick: () => void submitRegenerate(),
                style: { ...buttonStyle(), borderColor: 'rgba(111,159,208,.55)', background: 'rgba(111,159,208,.16)' },
              }, '提交重新生成'))))
          : undefined,
        createElement('div', { style: { fontWeight: 600, marginBottom: 6, fontSize: 13 } }, '轮次'),
        (detail.rounds_detail ?? []).length === 0
          ? createElement('div', { style: { opacity: 0.6 } }, '还没有提交记录。')
          : createElement('div', {}, renderGenerations(detail, detail.rounds_detail ?? [])),
        renderArtifacts(detail)))

  return createElement('div', { style: { display: 'flex', height: '100%', minHeight: 0, color: 'inherit' } },
    list,
    body,
    viewer !== undefined ? renderViewer(viewer) : undefined)
}

function statusPill(status: string): ReturnType<typeof createElement> {
  const color = STATUS_COLOR[status] ?? 'rgba(127,127,127,.9)'
  return createElement('span', {
    style: {
      fontSize: 10,
      fontWeight: 600,
      padding: '3px 8px',
      borderRadius: 999,
      color,
      background: 'rgba(127,127,127,.12)',
      border: '1px solid rgba(127,127,127,.18)',
      lineHeight: 1.2,
    },
  }, STATUS_LABEL[status] ?? status)
}

function renderViewer(view: Viewer): ReturnType<typeof createElement> {
  const body = view.kind === 'image' && view.src !== undefined
    ? createElement('img', {
      src: view.src,
      alt: view.title,
      style: { maxWidth: '100%', maxHeight: '74vh', objectFit: 'contain', display: 'block', margin: '0 auto' },
    })
    : view.kind === 'frame' && view.src !== undefined
      ? createElement('iframe', {
        src: view.src,
        sandbox: 'allow-scripts',
        title: view.title,
        style: { width: '100%', height: '74vh', border: 0, background: '#fff' },
      })
      : createElement('pre', {
        style: {
          margin: 0,
          padding: 16,
          maxHeight: '74vh',
          overflow: 'auto',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
          fontSize: 12,
          lineHeight: 1.55,
        },
      }, view.text ?? '')

  return createElement('div', {
    style: {
      position: 'fixed',
      inset: 0,
      zIndex: 2_147_483_000,
      background: 'rgba(0,0,0,.55)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 24,
    },
    onClick: () => showViewer(undefined),
  }, createElement('div', {
    role: 'dialog',
    'aria-modal': true,
    'aria-label': view.title,
    onClick: (event: { stopPropagation(): void }) => event.stopPropagation(),
    style: {
      background: 'Canvas',
      color: 'CanvasText',
      borderRadius: 12,
      width: 'min(92vw, 980px)',
      maxHeight: '88vh',
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
      border: '1px solid rgba(127,127,127,.25)',
      boxShadow: '0 24px 80px rgba(0,0,0,.45)',
    },
  },
  createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderBottom: '1px solid rgba(127,127,127,.2)' } },
    createElement('div', { style: { fontWeight: 600, fontSize: 13, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, view.title),
    view.path !== undefined && view.topicId !== undefined
      ? createElement('button', {
        onClick: () => void revealArtifact(view.topicId as string, view.path as string),
        style: buttonStyle(),
      }, '在文件夹中')
      : undefined,
    createElement('button', { onClick: () => showViewer(undefined), style: buttonStyle() }, '关闭')),
  createElement('div', { style: { overflow: 'auto', background: view.kind === 'frame' ? '#fff' : 'transparent' } }, body)))
}

function assetUrl(topicId: string, path: string): string {
  return `${config.routes}/asset?id=${encodeURIComponent(topicId)}&path=${encodeURIComponent(path)}`
}

function renderArtifacts(detail: TopicDetail): ReturnType<typeof createElement> | undefined {
  const artifacts = detail.artifacts ?? []
  if (artifacts.length === 0) return undefined
  if (!config.designMode) {
    return createElement('div', { style: { marginTop: 10 } },
      createElement('div', { style: { fontWeight: 600, marginBottom: 4 } }, '全部产物'),
      createElement('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
        artifacts.map(path => artifactChip(detail.topic_id, path))))
  }
  const images = artifacts.filter(path => /\.(png|jpe?g|webp|gif|svg)$/i.test(path))
  const demos = artifacts.filter(path => /\.html?$/i.test(path))
  return createElement('div', { style: { marginTop: 14 } },
    images.length > 0
      ? createElement('div', {},
        createElement('div', { style: { fontWeight: 600, marginBottom: 6 } }, '图片'),
        createElement('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 8 } },
          images.map(path => createElement('button', {
            key: path,
            onClick: () => openViewerImage(detail.topic_id, path),
            style: { padding: 0, border: 'none', background: 'transparent', cursor: 'zoom-in', borderRadius: 8, overflow: 'hidden' },
          }, createElement('img', {
            src: assetUrl(detail.topic_id, path),
            alt: path,
            style: { width: '100%', display: 'block', borderRadius: 8, border: '1px solid rgba(127,127,127,.25)' },
          })))))
      : undefined,
    demos.length > 0
      ? createElement('div', { style: { marginTop: 12 } },
        createElement('div', { style: { fontWeight: 600, marginBottom: 6 } }, '前端 demo'),
        demos.map(path => createElement('iframe', {
          key: path,
          src: assetUrl(detail.topic_id, path),
          sandbox: 'allow-scripts',
          title: path,
          style: { width: '100%', height: 420, border: '1px solid rgba(127,127,127,.25)', borderRadius: 8, background: '#fff' },
        })))
      : undefined,
    createElement('div', { style: { marginTop: 8, opacity: 0.6, fontSize: 11, wordBreak: 'break-all' } }, artifacts.join('、')))
}

function renderGenerations(detail: TopicDetail, rounds: RoundRow[]): ReturnType<typeof createElement>[] {
  const generations = detail.generations !== undefined && detail.generations.length > 0
    ? detail.generations
    : [{ n: 1, createdAt: detail.created ?? '', reason: '初始任务' }]
  if (generations.length <= 1) return rounds.map(round => renderRound(detail, round))

  const groups = new Map<number, RoundRow[]>()
  for (const round of rounds) {
    const n = round.generation ?? 1
    const list = groups.get(n) ?? []
    list.push(round)
    groups.set(n, list)
  }
  for (const generation of generations) {
    if (!groups.has(generation.n)) groups.set(generation.n, [])
  }

  return [...generations]
    .sort((left, right) => left.n - right.n)
    .map(generation => createElement('div', { key: generation.n, style: { marginBottom: 18 } },
      createElement('div', { style: { display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap', paddingBottom: 6, marginBottom: 8, borderBottom: '1px solid rgba(127,127,127,.18)' } },
        createElement('strong', { style: { fontSize: 13 } }, `第 ${generation.n} 版`),
        generation.reason !== undefined && generation.reason !== ''
          ? createElement('span', { style: { fontSize: 11, opacity: 0.62, flex: 1, minWidth: 160 } }, generation.reason)
          : undefined,
        generation.createdAt !== '' ? createElement('span', { style: { fontSize: 11, opacity: 0.45 } }, formatTime(generation.createdAt)) : undefined,
        generation.final !== undefined
          ? createElement('button', {
            onClick: () => void openTopicFile(detail.topic_id, generation.final as string),
            style: chipStyle(),
          }, '本版总结')
          : undefined),
      (groups.get(generation.n) ?? []).length === 0
        ? createElement('div', { style: { opacity: 0.55, fontSize: 12 } }, '等待提交…')
        : (groups.get(generation.n) ?? []).map(round => renderRound(detail, round))))
}

function renderRound(detail: TopicDetail, round: RoundRow): ReturnType<typeof createElement> {
  const prefix = `/round-${String(round.n).padStart(2, '0')}/`
  const artifacts = round.artifacts ?? (detail.artifacts ?? []).filter(path => path.includes(prefix))
  const attempts = round.attempts ?? 1
  return createElement('div', {
    key: round.n,
    style: { padding: '10px 12px', marginBottom: 8, borderRadius: 8, background: 'rgba(127,127,127,.055)', border: '1px solid rgba(127,127,127,.14)' },
  },
  createElement('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'baseline', fontSize: 12 } },
    createElement('strong', {}, `第 ${round.n} 轮`),
    createElement('span', { style: { opacity: 0.72 } }, round.verdict ?? (round.answeredAt !== undefined ? '已答复' : '进行中')),
    createElement('span', { style: { opacity: 0.6 } }, `${round.files} 文件`),
    createElement('span', { style: { opacity: 0.6 } }, `提交 ${formatTime(round.submittedAt)}`),
    createElement('span', { style: { opacity: 0.6 } }, `完成 ${formatTime(round.answeredAt)}`),
    attempts > 1 ? createElement('span', { style: { color: '#ed6c02' } }, `重试 ${attempts - 1}`) : undefined),
  createElement('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 } },
    createElement('button', {
      onClick: () => void openAnswer(detail.topic_id, round.n),
      style: chipStyle(),
    }, '查看回答'),
    artifacts.map(path => artifactChip(detail.topic_id, path))))
}

function artifactChip(topicId: string, path: string): ReturnType<typeof createElement> {
  const name = path.split('/').pop() ?? path
  if (/\.(png|jpe?g|webp|gif|svg)$/i.test(path)) {
    return createElement('button', {
      key: path,
      onClick: () => openViewerImage(topicId, path),
      style: chipStyle(),
      title: '查看大图',
    }, name)
  }
  if (/\.html?$/i.test(path)) {
    return createElement('button', {
      key: path,
      onClick: () => showViewer({ kind: 'frame', title: name, topicId, src: assetUrl(topicId, path), path }),
      style: chipStyle(),
      title: '预览 demo',
    }, `${name} ↗`)
  }
  return createElement('button', {
    key: path,
    onClick: () => void openTopicFile(topicId, path),
    style: chipStyle(),
    title: '查看文件',
  }, name)
}

function openViewerImage(topicId: string, path: string): void {
  const name = path.split('/').pop() ?? path
  showViewer({ kind: 'image', title: name, topicId, src: assetUrl(topicId, path), path })
}

async function openAnswer(topicId: string, round: number): Promise<void> {
  try {
    const text = await fetchText(`${config.routes}/answer?id=${encodeURIComponent(topicId)}&round=${round}`)
    showViewer({ kind: 'text', title: `第 ${round} 轮回答`, topicId, text })
  } catch (cause) {
    showViewer({ kind: 'text', title: '读取回答失败', topicId, text: cause instanceof Error ? cause.message : String(cause) })
  }
}

async function openTopicFile(topicId: string, path: string): Promise<void> {
  const name = path.split('/').pop() ?? path
  try {
    const text = await fetchText(`${config.routes}/file?id=${encodeURIComponent(topicId)}&path=${encodeURIComponent(path)}`)
    showViewer({ kind: 'text', title: name, topicId, text, path })
  } catch (cause) {
    showViewer({ kind: 'text', title: name, topicId, text: cause instanceof Error ? cause.message : String(cause), path })
  }
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, { headers: { accept: 'text/plain, text/markdown' } })
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
  return await response.text()
}

async function revealArtifact(topicId: string, path: string): Promise<void> {
  await fetch(`${config.routes}/open`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ topic_id: topicId, path }),
  }).catch(() => undefined)
}

function formatTime(value: string | undefined): string {
  return value === undefined ? '—' : value.slice(0, 16).replace('T', ' ')
}

function chipStyle(): Record<string, string | number> {
  return {
    padding: '2px 8px',
    borderRadius: 999,
    border: '1px solid rgba(127,127,127,.35)',
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
    fontSize: 11,
    textDecoration: 'none',
    display: 'inline-flex',
    alignItems: 'center',
  }
}

function buttonStyle(): Record<string, string | number> {
  return {
    padding: '4px 10px',
    borderRadius: 6,
    border: '1px solid rgba(127,127,127,.35)',
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
    fontSize: 12,
  }
}

function cellStyle(): Record<string, string> {
  return { padding: '4px 6px', borderBottom: '1px solid rgba(127,127,127,.12)' }
}

function Icon({ kind }: { kind: 'research' | 'design' }): ReturnType<typeof createElement> {
  const svg = kind === 'design' ? DESIGN_ICON : RESEARCH_ICON
  return createElement('span', {
    'aria-hidden': true,
    style: { display: 'inline-flex', width: 16, height: 16, lineHeight: 0, color: 'inherit' },
    dangerouslySetInnerHTML: { __html: svg },
  })
}

export function apply(ctx: ClientContext): void {
  // The renderer service can activate before layout and sidebar declare their slots.
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: config.panelId }, () => createElement(Panel)))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: config.panelId, order: 21, label: () => config.label }, () => createElement(Icon, { kind: config.icon })))
  const disposeBadge = mountSidebarStatus({ label: config.label, routes: config.routes, panelId: config.panelId })
  if (typeof ctx.effect === 'function') ctx.effect(() => disposeBadge, `${config.panelId}: sidebar status badge`)
}
