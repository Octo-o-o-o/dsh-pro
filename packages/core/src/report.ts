import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Topic } from './types.ts'

export interface ReportInfo {
  path: 'report.md' | 'design.md'
  revision: string
  updated: string
  status: 'current' | 'stale' | 'unknown'
  generation?: number
  throughRound?: number
}

/** Provenance is supplied by the report author, never inferred from file age. */
export async function readReportInfo(dir: string, topic: Topic): Promise<ReportInfo | null> {
  let path: ReportInfo['path'] = topic.type === 'design' ? 'design.md' : 'report.md'
  let text: string
  let updated: string
  try {
    try {
      text = await readFile(join(dir, path), 'utf8')
    } catch (error) {
      if (path !== 'design.md' || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      // Preserve reports written by older hosts using the shared report name.
      path = 'report.md'
      text = await readFile(join(dir, path), 'utf8')
    }
    updated = (await stat(join(dir, path))).mtime.toISOString()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  const info: ReportInfo = {
    path, revision: createHash('sha256').update(text).digest('hex'), updated, status: 'unknown',
  }
  const header = /^\s*<!--\s*dsh-pro-report:\s*(\{[^\r\n]*\})\s*-->/.exec(text)
  if (header === null) return info
  try {
    const meta = JSON.parse(header[1] as string) as { generation: number; throughRound: number }
    const round = topic.rounds.find(item => item.n === meta.throughRound)
    if (!Number.isInteger(meta.generation) || !Number.isInteger(meta.throughRound)
      || round?.answeredAt === undefined || (round.generation ?? 1) !== meta.generation) return info
    info.generation = meta.generation
    info.throughRound = meta.throughRound
    const last = topic.rounds.at(-1)
    info.status = meta.generation === (topic.generations?.at(-1)?.n ?? 1)
      && last?.n === meta.throughRound && (topic.runThrough ?? last.n) <= last.n
      && !['queued', 'uploading', 'submitted', 'waiting', 'answered', 'adjudicating'].includes(topic.status)
      && updated >= round.answeredAt ? 'current' : 'stale'
  } catch { /* A legacy/malformed header has no trustworthy coverage. */ }
  return info
}
