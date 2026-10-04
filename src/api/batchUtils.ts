import type { AssignmentPayload, BatchItem, Issue, TrackedBatch } from './types'

/** 批次号由客户端生成：断网时批次先落本地，恢复后按原批次号续传且服务端幂等 */
export function generateBatchNo() {
  const now = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `PC-${date}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`
}

export type DerivedItemState = {
  code: 'pending' | 'failed' | 'conflict' | 'applied' | 'unchanged' | 'invalidated'
  label: string
  color: string
}

/**
 * 派生条目的当前有效状态：
 * applied/unchanged 是批次提交时的结论；若之后负责人/优先级/团队/截止被调整，
 * 该结论随之失效，需要按最新台账重算。
 */
export function deriveItemState(item: BatchItem, issue: Issue | undefined, payload: AssignmentPayload): DerivedItemState {
  if (item.status === 'pending') return { code: 'pending', label: '待提交', color: 'default' }
  if (item.status === 'failed') return { code: 'failed', label: '失败待恢复', color: 'warning' }
  if (item.status === 'conflict') return { code: 'conflict', label: '冲突已跳过', color: 'error' }
  if (!issue) return { code: 'invalidated', label: '已失效', color: 'default' }
  const baseLabel = item.status === 'applied' ? '已生效' : '无变化'
  const baseColor = item.status === 'applied' ? 'success' : 'default'
  if (item.appliedVersion != null && issue.versionNo === item.appliedVersion) {
    return { code: item.status, label: baseLabel, color: baseColor }
  }
  const drifted =
    issue.owner !== payload.owner || issue.priority !== payload.priority || issue.team !== payload.team || issue.dueDate !== payload.dueDate
  if (drifted) return { code: 'invalidated', label: '已失效·待重算', color: 'warning' }
  // 版本前进但指派未变（如复测流转），结论仍然有效
  return { code: item.status, label: baseLabel, color: baseColor }
}

export type BatchSummary = {
  counts: { applied: number; unchanged: number; conflict: number; pending: number; invalidated: number }
  total: number
  code: 'recoverable' | 'stale' | 'expired' | 'done'
  label: string
  color: string
}

/** 批次结论：由当前台账实时重算，后续调整负责人/优先级会自动反映为失效 */
export function summarizeBatch(batch: TrackedBatch, issues: Issue[]): BatchSummary {
  const counts = { applied: 0, unchanged: 0, conflict: 0, pending: 0, invalidated: 0 }
  batch.items.forEach((item) => {
    const state = deriveItemState(item, issues.find((issue) => issue.key === item.key), batch.payload)
    if (state.code === 'pending' || state.code === 'failed') counts.pending += 1
    else counts[state.code as 'applied' | 'unchanged' | 'conflict' | 'invalidated'] += 1
  })
  const total = batch.items.length
  if (counts.pending > 0) {
    return { counts, total, code: 'recoverable', label: batch.lastError ? '中断待恢复' : '待继续', color: 'orange' }
  }
  if (counts.invalidated > 0 && counts.invalidated + counts.conflict === total) {
    return { counts, total, code: 'expired', label: '已失效', color: 'default' }
  }
  if (counts.invalidated > 0) {
    return { counts, total, code: 'stale', label: '部分失效·需重算', color: 'warning' }
  }
  return { counts, total, code: 'done', label: counts.conflict > 0 ? '已生效·含跳过' : '已生效', color: 'success' }
}

export function formatBatchTime(iso: string) {
  const date = new Date(iso)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}
