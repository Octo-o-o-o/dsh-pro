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
  capped: '待接受',
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
  const [checkOpen, setCheckOpen] = useState<'submitted' | 'not_submitted' | 'reopen' | undefined>(undefined)
  const [checkNote, setCheckNote] = useState('')
  const [viewer, setViewer] = useState<Viewer | undefined>(undefined)
  const [viewerNotice, setViewerNotice] = useState<string | undefined>(undefined)
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
      setSelected(current => current ?? data.topics[0]?.topic_id)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])

  const loadDetail = useCallback(async (id: string) => {
    try {
      const data = await getJson<{ topic: TopicDetail }>(`${config.routes}/topic?id=${encodeURIComponent(id)}`)
      setDetail(current => current === undefined || current.topic_id === id ? data.topic : current)
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
  }, [selected, loadDetail])

  useEffect(() => {
    if (selected === undefined || detail === undefined) return
    const listed = topics.find(topic => topic.topic_id === selected)
    if (listed !== undefined && listed.status !== detail.status) {
      void loadDetail(selected)
    }
  }, [topics, selected, detail, loadDetail])

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
  }, [selected, loadDetail, loadList])

  useEffect(() => {
    setViewerNotice(undefined)
  }, [viewer])

  useEffect(() => {
    if (viewer === undefined) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setViewer(undefined)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [viewer])

  const act = useCallback(async (action: string, conclusion?: string, note?: string) => {
    if (selected === undefined) return
    try {
      const result = await postAction<{ topic: TopicRow; wake?: { ok: boolean; resumed?: boolean; reason?: string } }>({ action, topic_id: selected, ...(conclusion !== undefined ? { conclusion } : {}), ...(note !== undefined ? { note } : {}) })
      if (action === 'accept') {
        setDetail(current => current === undefined ? current : { ...current, status: 'completed' })
        if (result.topic?.updated !== undefined) markTopicSeen(config.panelId, selected, result.topic.updated)
        if (result.wake?.ok === true) {
          setNotice({ kind: 'ok', text: result.wake.resumed === true ? '已接受结果，并恢复了原会话' : '已接受结果，原会话已唤醒' })
        } else {
          setNotice({ kind: 'error', text: `已接受结果，但没能唤醒原会话：${result.wake?.reason ?? '原因未知'}` })
        }
      } else if (action === 'review') {
        if (result.wake?.ok === true) {
          setNotice({ kind: 'ok', text: result.wake.resumed === true ? '已恢复原会话，请它判断是否接受' : '已把结果交给原会话判断' })
        } else {
          setNotice({ kind: 'error', text: `没能通知原会话：${result.wake?.reason ?? '原因未知'}` })
        }
      } else if (action === 'wake') {
        if (result.wake?.ok === true) {
          setNotice({ kind: 'ok', text: result.wake.resumed === true ? '已恢复原会话' : '原会话已唤醒' })
        } else {
          setNotice({ kind: 'error', text: `没能唤醒原会话：${result.wake?.reason ?? '原因未知'}` })
        }
      } else {
        setNotice({ kind: 'ok', text: action === 'regenerate' ? '已提交重新生成' : `已执行：${action}` })
      }
      await loadDetail(selected)
      await loadList()
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      setError(undefined)
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
      setError(undefined)
      setNotice({ kind: 'error', text: message })
    }
  }, [selected, regenNote, loadDetail, loadList])

  const submitHumanCheck = useCallback(async () => {
    if (selected === undefined || checkOpen === undefined) return
    const note = checkNote.trim()
    if (note === '') {
      setNotice({ kind: 'error', text: '请填写核对依据' })
      return
    }
    await act('human_check', checkOpen, note)
    setCheckOpen(undefined)
    setCheckNote('')
  }, [selected, checkOpen, checkNote, act])

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
          ? createElement('div', { style: { marginBottom: 8, fontSize: 11, color: '#ed6c02' } }, '未配置自动裁决：跑满轮次后进入待接受。可以接受、重新生成，或点「请原会话判断」。')
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
          detail.status === 'capped' || ((detail.status === 'failed' || detail.status === 'stalled') && hasArtifacts)
            ? createElement('button', { onClick: () => void act('review'), style: buttonStyle() }, '请原会话判断')
            : undefined,
          detail.status === 'completed'
            ? createElement('button', { onClick: () => void act('wake'), style: buttonStyle() }, '唤醒原会话')
            : undefined,
          detail.status === 'stalled'
            ? createElement('span', { style: { display: 'flex', gap: 8 } },
              createElement('button', { onClick: () => { setCheckNote(''); setCheckOpen('submitted') }, style: buttonStyle() }, '已提交'),
              createElement('button', { onClick: () => { setCheckNote(''); setCheckOpen('not_submitted') }, style: buttonStyle() }, '未提交'),
              createElement('button', { onClick: () => { setCheckNote(''); setCheckOpen('reopen') }, style: buttonStyle() }, '需重开'))
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
        checkOpen !== undefined
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
          createElement('div', { style: { fontSize: 12, fontWeight: 600, marginBottom: 8 } },
            `人工核对：${checkOpen === 'submitted' ? '确认已提交' : checkOpen === 'not_submitted' ? '确认未提交' : '需要重开'}`),
          createElement('textarea', {
            value: checkNote,
            onChange: (event: { target: { value: string } }) => setCheckNote(event.target.value),
            rows: 2,
            placeholder: '写一下核对依据，方便后续追溯（必填）',
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
          createElement('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 } },
            createElement('button', { onClick: () => { setCheckOpen(undefined); setCheckNote('') }, style: buttonStyle() }, '取消'),
            createElement('button', { onClick: () => void submitHumanCheck(), style: buttonStyle() }, '提交核对')))
          : undefined,
        createElement('div', { style: { fontWeight: 600, marginBottom: 6, fontSize: 13 } }, '轮次'),
        (detail.rounds_detail ?? []).length === 0
          ? createElement('div', { style: { opacity: 0.6 } }, '还没有提交记录。')
          : createElement('div', {}, renderGenerations(detail, detail.rounds_detail ?? [])),
        renderArtifacts(detail)))

  return createElement('div', { style: { display: 'flex', height: '100%', minHeight: 0, color: 'inherit' } },
    list,
    body,
    viewer !== undefined ? renderViewer(viewer, {
      basePath: detail?.path,
      notice: viewerNotice,
      onNotice: setViewerNotice,
    }) : undefined)
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

interface ViewerOptions {
  basePath?: string
  notice?: string
  onNotice: (text: string) => void
}

function renderViewer(view: Viewer, options: ViewerOptions): ReturnType<typeof createElement> {
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
    createElement('button', { onClick: () => showViewer(undefined), style: buttonStyle() }, '关闭')),
  createElement('div', { style: { overflow: 'auto', flex: 1, minHeight: 0, background: view.kind === 'frame' ? '#fff' : 'transparent' } }, body),
  viewerActions(view, options)))

function viewerActions(view: Viewer, options: ViewerOptions): ReturnType<typeof createElement> | undefined {
  const buttons: ReturnType<typeof createElement>[] = []
  const run = (label: string, success: string, task: () => Promise<void>): ReturnType<typeof createElement> => createElement('button', {
    key: label,
    onClick: () => {
      options.onNotice('处理中…')
      void task()
        .then(() => options.onNotice(success))
        .catch((error: unknown) => options.onNotice(error instanceof Error ? error.message : String(error)))
    },
    style: buttonStyle(),
  }, label)

  if (view.kind === 'image' && view.src !== undefined) {
    buttons.push(run('复制图片', '图片已复制到剪贴板', () => copyImage(view.src as string)))
  }
  if (view.path !== undefined) {
    const native = fullPath(options.basePath, view.path)
    buttons.push(run('复制路径', '文件路径已复制', () => navigator.clipboard.writeText(native)))
    if (view.topicId !== undefined) {
      buttons.push(run('打开原文件', '已请求打开原文件', () => openArtifact(view.topicId as string, view.path as string, false)))
      buttons.push(run('在文件夹中显示', '已在文件夹中定位', () => openArtifact(view.topicId as string, view.path as string, true)))
    }
  }
  if (buttons.length === 0 && options.notice === undefined) return undefined
  return createElement('div', {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      flexWrap: 'wrap',
      padding: '9px 14px',
      borderTop: '1px solid rgba(127,127,127,.2)',
      background: 'rgba(127,127,127,.04)',
    },
  },
  buttons,
  createElement('span', { style: { marginLeft: 'auto', fontSize: 11, opacity: 0.65 } }, options.notice ?? ''))
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
}

function artifactKind(detail: TopicDetail, path: string): ArtifactInfo['kind'] {
  const known = detail.artifact_details?.find(item => item.path === path)
  if (known !== undefined) return known.kind
  if (/\.(png|jpe?g|webp|gif|svg)$/i.test(path)) return 'image'
  if (/\.html?$/i.test(path)) return 'demo'
  if (/\.zip$/i.test(path)) return 'archive'
  return 'code'
}

function bundleUrl(topicId: string, round: number): string {
  return `${config.routes}/bundle?id=${encodeURIComponent(topicId)}&round=${round}`
}

function assetUrl(topicId: string, path: string): string {
  return `${config.routes}/asset?id=${encodeURIComponent(topicId)}&path=${encodeURIComponent(path)}`
}

function rawUrl(topicId: string, path: string): string {
  const encoded = path.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/')
  return `${config.routes}/raw/${encodeURIComponent(topicId)}/${encoded}`
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
  const images = artifacts.filter(path => artifactKind(detail, path) === 'image')
  const demos = artifacts.filter(path => artifactKind(detail, path) === 'demo')
  const files = artifacts.filter(path => artifactKind(detail, path) !== 'image')
  return createElement('div', { style: { marginTop: 14 } },
    images.length > 0
      ? createElement('div', {},
        createElement('div', { style: { fontWeight: 600, marginBottom: 6 } }, '全部图片'),
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
          src: rawUrl(detail.topic_id, path),
          sandbox: 'allow-scripts',
          title: path,
          style: { width: '100%', height: 420, border: '1px solid rgba(127,127,127,.25)', borderRadius: 8, background: '#fff' },
        })))
      : undefined,
    files.length > 0
      ? createElement('div', { style: { marginTop: 12 } },
        createElement('div', { style: { fontWeight: 600, marginBottom: 6 } }, '代码与文件'),
        createElement('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
          files.flatMap(path => {
            const chips = [artifactChip(detail.topic_id, path)]
            if (artifactKind(detail, path) === 'demo') {
              chips.push(createElement('button', {
                key: `preview-${path}`,
                onClick: () => showViewer({
                  kind: 'frame',
                  title: path.split('/').pop() ?? path,
                  topicId: detail.topic_id,
                  src: rawUrl(detail.topic_id, path),
                  path,
                }),
                style: chipStyle(),
              }, `预览 ${path.split('/').pop() ?? path}`))
            }
            return chips
          })))
      : undefined,
    createElement('div', { style: { marginTop: 8, opacity: 0.6, fontSize: 11, wordBreak: 'break-all' } }, artifacts.join('、')))
}

function renderGenerations(detail: TopicDetail, rounds: RoundRow[]): ReturnType<typeof createElement>[] {
  const generations = detail.generations !== undefined && detail.generations.length > 0
    ? detail.generations
    : [{ n: 1, createdAt: detail.created ?? '', reason: '初始任务' }]
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
    .map(generation => createElement('div', { key: generation.n, style: { marginBottom: 20, maxWidth: 980 } },
      createElement('div', { style: { display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap', paddingBottom: 6, marginBottom: 8, borderBottom: '1px solid rgba(127,127,127,.18)' } },
        createElement('strong', { style: { fontSize: 13 } }, `第 ${generation.n} 版`),
        generation.reason !== undefined && generation.reason !== ''
          ? createElement('span', { style: { fontSize: 11, opacity: 0.62, flex: 1, minWidth: 160 } }, generation.reason)
          : undefined,
        generation.createdAt !== '' ? createElement('span', { style: { fontSize: 11, opacity: 0.45 } }, formatTime(generation.createdAt)) : undefined,
        generation.rounds !== undefined
          ? createElement('span', { style: { fontSize: 11, opacity: 0.5, fontVariantNumeric: 'tabular-nums' } },
            `${(groups.get(generation.n) ?? []).length}/${generation.rounds} 轮`)
          : undefined,
        generation.final !== undefined
          ? createElement('button', {
            onClick: () => void openTopicFile(detail.topic_id, generation.final as string),
            style: chipStyle(),
          }, '本版总结')
          : undefined),
      (groups.get(generation.n) ?? []).length === 0
        ? createElement('div', { style: { opacity: 0.55, fontSize: 12 } }, '等待提交…')
        : renderRoundTable(detail, groups.get(generation.n) ?? [], generation.n)))
}

function renderRoundTable(detail: TopicDetail, rounds: RoundRow[], generation: number): ReturnType<typeof createElement> {
  const header = ['轮次', '裁决', '附件', '提交', '完成', '重试', '操作']
  return createElement('div', { style: { overflowX: 'auto' } },
    createElement('table', { style: { width: '100%', borderCollapse: 'collapse', fontSize: 12, tableLayout: 'auto' } },
      createElement('thead', {}, createElement('tr', {}, header.map(label => createElement('th', {
        key: label,
        style: {
          textAlign: 'left',
          padding: '6px 8px',
          borderBottom: '1px solid rgba(127,127,127,.25)',
          fontSize: 11,
          fontWeight: 500,
          opacity: 0.55,
          whiteSpace: 'nowrap',
        },
      }, label)))),
      createElement('tbody', {}, rounds.flatMap((round, index) => renderRoundRows(detail, round, `${generation}-${index + 1}`)))))
}

function renderRoundRows(detail: TopicDetail, round: RoundRow, label: string): ReturnType<typeof createElement>[] {
  const prefix = `/round-${String(round.n).padStart(2, '0')}/`
  const artifacts = round.artifacts ?? (detail.artifacts ?? []).filter(path => path.includes(prefix))
  const attempts = round.attempts ?? 1
  const verdict = round.verdict ?? (round.answeredAt !== undefined ? '已答复' : '进行中')
  const verdictColor = round.verdict === 'accepted'
    ? '#5f9c7a'
    : round.verdict === 'rejected'
      ? '#c26a6a'
      : round.verdict === 'partial'
        ? '#c39a4a'
        : '#6f9fd0'
  const cell = (child: unknown, extra: Record<string, string | number> = {}) => createElement('td', {
    style: { padding: '8px', borderBottom: '1px solid rgba(127,127,127,.13)', verticalAlign: 'top', ...extra },
  }, child as never)

  const main = createElement('tr', { key: `round-${round.n}` },
    cell(createElement('span', { style: { fontVariantNumeric: 'tabular-nums', fontWeight: 600 } }, label), { whiteSpace: 'nowrap' }),
    cell(createElement('span', { style: { color: verdictColor } }, verdict), { whiteSpace: 'nowrap' }),
    cell(String(round.files)),
    cell(round.submittedAt !== undefined ? formatTime(round.submittedAt) : '—', { whiteSpace: 'nowrap', opacity: 0.7 }),
    cell(round.answeredAt !== undefined ? formatTime(round.answeredAt) : ACTIVE.has(detail.status) ? '进行中' : '—', { whiteSpace: 'nowrap', opacity: 0.7 }),
    cell(attempts > 1 ? String(attempts - 1) : '—', { whiteSpace: 'nowrap', opacity: attempts > 1 ? 0.9 : 0.45 }),
    cell(createElement('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
      createElement('button', { onClick: () => void openAnswer(detail.topic_id, round.n), style: chipStyle() }, '查看回答'),
      artifacts.length > 0
        ? createElement('a', {
          href: bundleUrl(detail.topic_id, round.n),
          download: `round-${String(round.n).padStart(2, '0')}.zip`,
          style: { ...chipStyle(), textDecoration: 'none' },
        }, '下载 ZIP')
        : undefined), { whiteSpace: 'nowrap' }))

  if (artifacts.length === 0) return [main]
  const images = artifacts.filter(path => artifactKind(detail, path) === 'image')
  const files = artifacts.filter(path => artifactKind(detail, path) !== 'image')
  const extra = createElement('tr', { key: `artifacts-${round.n}` },
    createElement('td', {
      colSpan: 7,
      style: { padding: '0 8px 10px', borderBottom: '1px solid rgba(127,127,127,.13)' },
    },
    createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 8 } },
      images.length > 0
        ? createElement('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
          images.map(path => createElement('button', {
            key: path,
            onClick: () => openViewerImage(detail.topic_id, path),
            title: '查看大图',
            style: {
              padding: 0,
              border: '1px solid rgba(127,127,127,.22)',
              borderRadius: 8,
              background: 'transparent',
              cursor: 'zoom-in',
              overflow: 'hidden',
            },
          }, createElement('img', {
            src: assetUrl(detail.topic_id, path),
            alt: path,
            style: { width: 148, height: 96, objectFit: 'cover', display: 'block' },
          }))))
        : undefined,
      files.length > 0
        ? createElement('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
          files.flatMap(path => {
            const chips = [artifactChip(detail.topic_id, path)]
            if (artifactKind(detail, path) === 'demo') {
              chips.push(createElement('button', {
                key: `preview-${path}`,
                onClick: () => showViewer({
                  kind: 'frame',
                  title: path.split('/').pop() ?? path,
                  topicId: detail.topic_id,
                  src: rawUrl(detail.topic_id, path),
                  path,
                }),
                style: chipStyle(),
              }, `预览 ${path.split('/').pop() ?? path}`))
            }
            return chips
          }))
        : undefined)))
  return [main, extra]
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
  if (/\.zip$/i.test(path)) {
    return createElement('a', {
      key: path,
      href: assetUrl(topicId, path),
      download: name,
      style: { ...chipStyle(), textDecoration: 'none' },
      title: '下载压缩包',
    }, name)
  }
  if (/\.html?$/i.test(path)) {
    return createElement('button', {
      key: path,
      onClick: () => showViewer({ kind: 'frame', title: name, topicId, src: rawUrl(topicId, path), path }),
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
