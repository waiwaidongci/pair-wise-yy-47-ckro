import axios, { AxiosError } from 'axios'
import type { AssignmentBatch, Issue, TrackedBatch } from './types'
import { useWorkspaceStore } from '../store/useWorkspaceStore'

export type BatchResponse = { batch: AssignmentBatch; issues: Issue[] }

/** 断网（真实或模拟）时直接抛网络错误，让批次留在本地等待恢复 */
function assertOnline() {
  if (useWorkspaceStore.getState().simulateOffline || navigator.onLine === false) {
    throw new AxiosError('Network Error', AxiosError.ERR_NETWORK)
  }
}

/** 提交或继续整改批次：同一 batchNo 幂等，断网恢复后按原批次号继续 */
export async function submitAssignmentBatch(batch: TrackedBatch): Promise<BatchResponse> {
  assertOnline()
  const { data } = await axios.post<BatchResponse>('/api/assignment-batches', {
    batchNo: batch.batchNo,
    payload: batch.payload,
    items: batch.items.map(({ key, expectedVersion }) => ({ key, expectedVersion })),
  })
  return data
}

export async function adjustIssue(key: string, body: { owner: string; priority: Issue['priority']; expectedVersion: number }) {
  assertOnline()
  const { data } = await axios.post<{ issue: Issue; unchanged: boolean }>(`/api/issues/${key}/adjust`, body)
  return data
}

/** 演示用途：模拟他人抢先保存 */
export async function simulateConcurrentEdit(keys: string[]) {
  const { data } = await axios.post<{ issues: Issue[] }>('/api/simulate/concurrent-edit', { keys })
  return data
}
