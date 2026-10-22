import { createElement, useCallback, useEffect, useState } from 'react'

const PANEL_ID = 'pro-research'
const POLL_MS = 3_000

interface ClientContext {
  slots: {
    register(options: Record<string, unknown>, render: (owner?: unknown) => unknown): (() => void) | undefined
  }
  effect(fn: () => () => void, label?: string): void
}

export const inject = ['slots']

interface TopicRow {
  topic_id: string
  title: string
  type: string
  status: string
  stall_reason: string | null
  rounds: number
  rounds_cap: number
  stop_reason: string | null
  artifacts: string[]
  updated: string
  root?: string
  store?: string
}

interface RoundRow {
  n: number
  verdict?: string
  files: number
  submittedAt?: string
  answeredAt?: string
}

interface TopicDetail extends TopicRow {
  path?: string
  rounds_detail?: RoundRow[]
}

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

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { accept: 'application/json' } })
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
  return await response.json() as T
}

async function postAction(body: Record<string, unknown>): Promise<void> {
  const response = await fetch('/pro-research/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(text === '' ? `${response.status}` : text)
  }
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

  const loadList = useCallback(async () => {
    try {
      const data = await getJson<{ topics: TopicRow[] }>('/pro-research/topics')
      setTopics(data.topics)
      setError(undefined)
      if (selected === undefined && data.topics[0] !== undefined) setSelected(data.topics[0].topic_id)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [selected])

  const loadDetail = useCallback(async (id: string) => {
    try {
      const data = await getJson<{ topic: TopicDetail }>(`/pro-research/topic?id=${encodeURIComponent(id)}`)
      setDetail(data.topic)
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

  const act = useCallback(async (action: string, conclusion?: string) => {
    if (selected === undefined) return
    let note: string | undefined
    if (action === 'human_check') {
      const input = window.prompt('核对结论的依据（必填）')
      if (input === null || input.trim() === '') return
      note = input.trim()
    }
    try {
      await postAction({ action, topic_id: selected, ...(conclusion !== undefined ? { conclusion } : {}), ...(note !== undefined ? { note } : {}) })
      await loadDetail(selected)
      await loadList()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [selected, loadDetail, loadList])

  const list = createElement('div', { style: { width: 240, borderRight: '1px solid rgba(127,127,127,.2)', overflowY: 'auto', flex: '0 0 auto' } },
    createElement('div', { style: { padding: '10px 12px', fontWeight: 600, fontSize: 13, opacity: 0.8 } }, 'Pro 研究'),
    topics.length === 0
      ? createElement('div', { style: { padding: '8px 12px', opacity: 0.6, fontSize: 12, lineHeight: 1.6 } },
        '还没有研究任务。在会话里用 /pro-research 开始。')
      : topics.map(topic => createElement('div', {
        key: topic.topic_id,
        onClick: () => setSelected(topic.topic_id),
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

  const body = createElement('div', { style: { flex: 1, overflowY: 'auto', padding: 14, fontSize: 13, lineHeight: 1.6 } },
    error !== undefined ? createElement('div', { style: { color: '#c62828', marginBottom: 8 } }, `接口错误：${error}`) : undefined,
    detail === undefined
      ? createElement('div', { style: { opacity: 0.6 } }, '选择左侧的主题查看轮次与产物。')
      : createElement('div', {},
        createElement('h3', { style: { margin: '0 0 6px', fontSize: 15 } }, detail.title),
        createElement('div', { style: { opacity: 0.75, marginBottom: 8 } },
          `${STATUS_LABEL[detail.status] ?? detail.status} · ${detail.rounds}/${detail.rounds_cap} 轮 · ${detail.type}`),
        detail.stall_reason !== null ? createElement('div', { style: { color: '#ed6c02', marginBottom: 8 } }, `卡住原因：${detail.stall_reason}`) : undefined,
        detail.stop_reason !== null ? createElement('div', { style: { marginBottom: 8 } }, `停止依据：${detail.stop_reason}`) : undefined,
        detail.path !== undefined ? createElement('div', { style: { opacity: 0.65, marginBottom: 8, wordBreak: 'break-all' } }, `记录：${detail.path}`) : undefined,
        createElement('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 } },
          ACTIVE.has(detail.status) ? createElement('button', { onClick: () => void act('cancel'), style: buttonStyle() }, '取消') : undefined,
          detail.status === 'stalled' || detail.status === 'failed'
            ? createElement('button', { onClick: () => void act('resume'), style: buttonStyle() }, '恢复')
            : undefined,
          detail.status === 'stalled'
            ? createElement('span', { style: { display: 'flex', gap: 8 } },
              createElement('button', { onClick: () => void act('human_check', 'submitted'), style: buttonStyle() }, '已提交'),
              createElement('button', { onClick: () => void act('human_check', 'not_submitted'), style: buttonStyle() }, '未提交'),
              createElement('button', { onClick: () => void act('human_check', 'reopen'), style: buttonStyle() }, '需重开'))
            : undefined),
        createElement('div', { style: { fontWeight: 600, marginBottom: 4 } }, '轮次'),
        (detail.rounds_detail ?? []).length === 0
          ? createElement('div', { style: { opacity: 0.6 } }, '还没有提交记录。')
          : createElement('table', { style: { width: '100%', borderCollapse: 'collapse', fontSize: 12 } },
            createElement('thead', {}, createElement('tr', {},
              ['轮', '裁决', '文件', '提交时间'].map(label => createElement('th', {
                key: label,
                style: { textAlign: 'left', padding: '4px 6px', borderBottom: '1px solid rgba(127,127,127,.25)', opacity: 0.7, fontWeight: 500 },
              }, label)))),
            createElement('tbody', {}, (detail.rounds_detail ?? []).map(round => createElement('tr', { key: round.n },
              createElement('td', { style: cellStyle() }, String(round.n)),
              createElement('td', { style: cellStyle() }, round.verdict ?? '—'),
              createElement('td', { style: cellStyle() }, String(round.files)),
              createElement('td', { style: cellStyle() }, round.submittedAt?.slice(0, 16).replace('T', ' ') ?? '—'))))),
        (detail.artifacts ?? []).length > 0
          ? createElement('div', { style: { marginTop: 10, opacity: 0.75 } }, `产物：${detail.artifacts.join('、')}`)
          : undefined))

  return createElement('div', { style: { display: 'flex', height: '100%', minHeight: 0, color: 'inherit' } }, list, body)
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

function Icon(): ReturnType<typeof createElement> {
  return createElement('span', {
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: 16,
      height: 16,
      borderRadius: 4,
      background: 'rgba(127,127,127,.22)',
      fontSize: 10,
      fontWeight: 700,
    },
  }, 'P')
}

export function apply(ctx: ClientContext): void {
  const disposers: Array<() => void> = []
  const panel = ctx.slots.register({ name: 'main', key: PANEL_ID }, () => createElement(Panel))
  if (typeof panel === 'function') disposers.push(panel as () => void)
  const row = ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 21, label: () => 'Pro' }, () => createElement(Icon))
  if (typeof row === 'function') disposers.push(row as () => void)
  ctx.effect(() => () => { for (const dispose of disposers) dispose() }, 'dsh-pro-research: client panel')
}
