import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { AssignmentBatch, Issue, TrackedBatch } from '../api/types'
import { seedIssues } from '../api/seed'

type SavedFilter = { id: string; name: string; query: string; site: string; status: string; priority: string }

type WorkspaceState = {
  issues: Issue[]
  selectedKeys: string[]
  savedFilters: SavedFilter[]
  draft: string
  mergeKeys: string[]
  /** 整改批次：含待恢复批次，刷新/断网后仍在，可按原批次号继续 */
  batches: TrackedBatch[]
  /** 演示开关：模拟断网，提交会失败并保留在批次中 */
  simulateOffline: boolean
  setIssues: (issues: Issue[]) => void
  setSelectedKeys: (keys: string[]) => void
  saveFilter: (filter: Omit<SavedFilter, 'id'>) => void
  removeFilter: (id: string) => void
  setDraft: (draft: string) => void
  mergeIssues: (keys: string[]) => void
  updateIssue: (issue: Issue) => void
  createBatch: (batch: TrackedBatch) => void
  /** 用服务端返回覆盖批次与台账，台账/复测队列/报告随之同步 */
  applyBatchResult: (batch: AssignmentBatch, issues: Issue[]) => void
  /** 提交失败（如断网）：失败项留在原批次等待恢复 */
  markBatchFailed: (batchNo: string, error: string) => void
  discardBatch: (batchNo: string) => void
  setSimulateOffline: (on: boolean) => void
}

export const useWorkspaceStore = create<WorkspaceState>()(
  persist(
    (set) => ({
      issues: structuredClone(seedIssues),
      selectedKeys: [],
      savedFilters: [
        { id: 'f1', name: 'P0/P1 未关闭', query: '', site: '', status: '', priority: 'P0' },
        { id: 'f2', name: '基础组件组待复测', query: '基础组件', site: '', status: '待复测', priority: '' },
      ],
      draft: 'A11Y-1048：需同时验证 Esc 关闭与 Tab/Shift+Tab 环绕顺序，移动端抽屉也需复测。',
      mergeKeys: [],
      batches: [],
      simulateOffline: false,
      setIssues: (issues) => set({ issues }),
      setSelectedKeys: (selectedKeys) => set({ selectedKeys }),
      saveFilter: (filter) => set((state) => ({ savedFilters: [...state.savedFilters, { ...filter, id: crypto.randomUUID() }] })),
      removeFilter: (id) => set((state) => ({ savedFilters: state.savedFilters.filter((item) => item.id !== id) })),
      setDraft: (draft) => set({ draft }),
      mergeIssues: (keys) =>
        set((state) => {
          const primary = state.issues.find((issue) => issue.key === keys[0])
          if (!primary) return state
          return {
            issues: state.issues.map((issue) =>
              keys.includes(issue.key)
                ? {
                    ...issue,
                    rootCause: primary.rootCause,
                    status: issue.key === primary.key ? issue.status : '不适用',
                    mergedKeys: issue.key === primary.key ? keys.slice(1) : [primary.key],
                    history: [...issue.history, { at: '刚刚', actor: '当前用户', action: '重复问题合并', detail: `合并至 ${primary.key}` }],
                  }
                : issue,
            ),
            selectedKeys: [],
          }
        }),
      updateIssue: (updated) => set((state) => ({ issues: state.issues.map((issue) => (issue.key === updated.key ? updated : issue)) })),
      createBatch: (batch) => set((state) => ({ batches: [batch, ...state.batches] })),
      applyBatchResult: (batch, issues) =>
        set((state) => ({
          issues,
          batches: state.batches.some((item) => item.batchNo === batch.batchNo)
            ? state.batches.map((item) => (item.batchNo === batch.batchNo ? { ...batch } : item))
            : [{ ...batch }, ...state.batches],
        })),
      markBatchFailed: (batchNo, error) =>
        set((state) => ({ batches: state.batches.map((item) => (item.batchNo === batchNo ? { ...item, lastError: error } : item)) })),
      discardBatch: (batchNo) => set((state) => ({ batches: state.batches.filter((item) => item.batchNo !== batchNo) })),
      setSimulateOffline: (simulateOffline) => set({ simulateOffline }),
    }),
    {
      name: 'accessibility-remediation-v1',
      version: 2,
      migrate: (persisted, version) => {
        const state = persisted as Partial<WorkspaceState>
        if (version < 2) {
          // 旧缓存的问题数据没有版本号，补齐字段；批次列表初始化为空
          state.issues = (state.issues ?? []).map((issue) => ({ ...issue, versionNo: issue.versionNo ?? 1, updatedBy: issue.updatedBy ?? '系统' }))
          state.batches = state.batches ?? []
          state.simulateOffline = state.simulateOffline ?? false
        }
        return state
      },
    },
  ),
)
