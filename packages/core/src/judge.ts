import type { JudgeResult } from './types.ts'

/** A completion claim must account for every original criterion, once. */
export function assertCompletion(criteria: readonly string[], result: JudgeResult): void {
  if (!result.done) return
  const normalize = (text: string): string => text.trim().replace(/\s+/g, ' ')
  const expected = criteria.map(normalize)
  const findings = result.criteria ?? []
  const actual = findings.map(item => normalize(item.criterion))
  if (result.verdict !== 'accepted' || expected.length === 0
    || new Set(expected).size !== expected.length
    || findings.length !== expected.length || new Set(actual).size !== actual.length
    || actual.some(item => !expected.includes(item))
    || findings.some(item => item.status !== 'met' || !item.evidence?.trim())) {
    throw new Error('完成声明与判据证据不一致：必须逐条对应原判据、无缺项或重复，且全部满足并提供依据')
  }
}
