import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import axios from 'axios'
import type { Issue, RemediationBatch, BatchItem } from '../api/types'
import { queryClient } from '../api/queryClient'
import { useWorkspaceStore } from './useWorkspaceStore'

/** 按优先级给出的复测 SLA（天），用于批次结论中的预计复测窗口 */
const SLA_DAYS: Record<string, number> = { P0: 3, P1: 7, P2: 14, P3: 30 }

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00`)
  d.setDate(d.getDate() + days)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 批次结论：生效条目按当前问题台账重算，判断原指派是否仍全部成立 */
export function buildConclusion(batch: RemediationBatch, issues: Issue[]): string {
  const applied = batch.items.filter((item) => item.status === 'applied')
  const expected = addDays(batch.payload.dueDate, SLA_DAYS[batch.payload.priority] ?? 14)
  if (applied.length === 0) {
    return `本批次 ${batch.items.length} 项尚未生效；原计划指派至 ${batch.payload.team} / ${batch.payload.owner}（${batch.payload.priority}），截止 ${batch.payload.dueDate}。`
  }
  const same = applied.filter((item) => {
    const issue = issues.find((x) => x.key === item.key)
    return issue && issue.team === batch.payload.team && issue.owner === batch.payload.owner && issue.priority === batch.payload.priority
  }).length
  const changed = applied.length - same
  if (changed === 0) {
    return `重算结论：${applied.length} 项均按原指派执行（${batch.payload.team} / ${batch.payload.owner}，${batch.payload.priority}，截止 ${batch.payload.dueDate}），预计 ${expected} 前完成复测。`
  }
  return `重算结论：原指派 ${applied.length} 项至 ${batch.payload.team} / ${batch.payload.owner}（${batch.payload.priority}）；其中 ${changed} 项已调整负责人或优先级，${same} 项仍按原结论执行，复测窗口按当前优先级重新排定。`
}

type BatchState = {
  batches: RemediationBatch[]
  /** 演示用：模拟断网，验证失败条目按原批次号缓存、恢复后续传 */
  simulateOffline: boolean
  setSimulateOffline: (value: boolean) => void
  createBatch: (payload: RemediationBatch['payload'], items: Array<Pick<BatchItem, 'key' | 'title' | 'seenVersion'>>) => string
  dispatchBatch: (batchId: string) => Promise<void>
  recomputeConclusion: (batchId: string) => void
  invalidateBatchesForIssue: (key: string, reason: string) => void
  removeBatch: (batchId: string) => void
}

export const useBatchStore = create<BatchState>()(
  persist(
    (set, get) => ({
      batches: [],
      simulateOffline: false,
      setSimulateOffline: (simulateOffline) => set({ simulateOffline }),

      createBatch: (payload, items) => {
        const id = `BATCH-${Date.now()}`
        const now = new Date().toISOString()
        const batch: RemediationBatch = {
          id,
          createdAt: now,
          updatedAt: now,
          payload,
          status: 'active',
          conclusion: `本批次 ${items.length} 项指派至 ${payload.team} / ${payload.owner}（${payload.priority}），截止 ${payload.dueDate}；按优先级 SLA 预计 ${addDays(payload.dueDate, SLA_DAYS[payload.priority] ?? 14)} 前完成复测。`,
          conclusionStale: false,
          items: items.map((item) => ({ ...item, status: 'pending' })),
        }
        set((state) => ({ batches: [batch, ...state.batches] }))
        return id
      },

      dispatchBatch: async (batchId) => {
        const batch = get().batches.find((item) => item.id === batchId)
        if (!batch) return
        const pending = batch.items.filter((item) => item.status === 'pending' || item.status === 'failed')
        if (!pending.length) return

        set((state) => ({
          batches: state.batches.map((item) =>
            item.id === batchId
              ? { ...item, updatedAt: new Date().toISOString(), items: item.items.map((row) => (pending.some((p) => p.key === row.key) ? { ...row, status: 'pending' } : row)) }
              : item,
          ),
        }))

        if (get().simulateOffline) {
          set((state) => ({
            batches: state.batches.map((item) =>
              item.id === batchId
                ? {
                    ...item,
                    updatedAt: new Date().toISOString(),
                    items: item.items.map((row) =>
                      row.status === 'pending'
                        ? { ...row, status: 'failed', reason: '网络不可用（模拟断网）：已按原批次号缓存，恢复后可继续' }
                        : row,
                    ),
                  }
                : item,
            ),
          }))
          return
        }

        try {
          const { data } = await axios.post<{ batchId: string; results: Array<{ key: string; status: 'applied' | 'conflict' | 'failed'; reason?: string; currentVersion?: number; unchanged?: boolean }> }>(
            '/api/issues/bulk-assign',
            { batchId, items: pending.map((item) => ({ key: item.key, seenVersion: item.seenVersion })), ...batch.payload },
          )
          const resultMap = new Map(data.results.map((row) => [row.key, row]))
          set((state) => {
            const batches: RemediationBatch[] = state.batches.map((item) => {
              if (item.id !== batchId) return item
              const items: BatchItem[] = item.items.map((row) => {
                const result = resultMap.get(row.key)
                return result ? { ...row, status: result.status, reason: result.reason, currentVersion: result.currentVersion, unchanged: result.unchanged } : row
              })
              const hasPending = items.some((row) => row.status === 'pending' || row.status === 'failed')
              return { ...item, updatedAt: new Date().toISOString(), status: hasPending ? 'active' : 'completed', items }
            })
            return { batches }
          })
          // 同步问题台账 / 复测队列 / 整改报告共用的问题数据
          await queryClient.invalidateQueries({ queryKey: ['issues'] })
          const issues = queryClient.getQueryData<Issue[]>(['issues']) ?? useWorkspaceStore.getState().issues
          useWorkspaceStore.getState().setIssues(issues)
          get().recomputeConclusion(batchId)
        } catch {
          set((state) => ({
            batches: state.batches.map((item) =>
              item.id === batchId
                ? {
                    ...item,
                    updatedAt: new Date().toISOString(),
                    items: item.items.map((row) =>
                      row.status === 'pending'
                        ? { ...row, status: 'failed', reason: '网络请求失败：已缓存至原批次，恢复后按原批次号继续' }
                        : row,
                    ),
                  }
                : item,
            ),
          }))
        }
      },

      recomputeConclusion: (batchId) => {
        const issues = queryClient.getQueryData<Issue[]>(['issues']) ?? useWorkspaceStore.getState().issues
        set((state) => ({
          batches: state.batches.map((item) =>
            item.id === batchId ? { ...item, conclusion: buildConclusion(item, issues), conclusionStale: false, staleReason: undefined } : item,
          ),
        }))
      },

      invalidateBatchesForIssue: (key, reason) =>
        set((state) => ({
          batches: state.batches.map((batch) =>
            batch.items.some((item) => item.key === key && item.status === 'applied') && !batch.conclusionStale
              ? { ...batch, conclusionStale: true, staleReason: reason }
              : batch,
          ),
        })),

      removeBatch: (batchId) => set((state) => ({ batches: state.batches.filter((item) => item.id !== batchId) })),
    }),
    { name: 'accessibility-remediation-batches-v1', version: 1 },
  ),
)
