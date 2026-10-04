import { http, HttpResponse } from 'msw'
import { seedIssues } from './seed'
import type { AssignmentBatch, AssignmentPayload, BatchItem, Issue } from './types'

/**
 * 模拟服务端：数据持久化到 localStorage（Node 测试环境用内存兜底），
 * 刷新/断网重开后批次与问题台账仍可恢复。
 * 所有变更都会把 issue.versionNo +1，批量分配按 expectedVersion 做乐观并发校验。
 */
const STORAGE_KEY = 'a11y-remediation-server-v2'

const memoryStore = new Map<string, string>()
const storage = {
  getItem: (key: string) => (typeof localStorage === 'undefined' ? (memoryStore.get(key) ?? null) : localStorage.getItem(key)),
  setItem: (key: string, value: string) => {
    if (typeof localStorage === 'undefined') memoryStore.set(key, value)
    else localStorage.setItem(key, value)
  },
}

type ServerState = { issues: Issue[]; batches: AssignmentBatch[] }

function loadState(): ServerState {
  try {
    const raw = storage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as ServerState
      if (Array.isArray(parsed.issues) && Array.isArray(parsed.batches)) return parsed
    }
  } catch {
    // 存储损坏时回退到种子数据
  }
  return { issues: structuredClone(seedIssues), batches: [] }
}

const state = loadState()
const save = () => storage.setItem(STORAGE_KEY, JSON.stringify(state))
const stamp = () => new Date().toISOString()
const findIssue = (key: string) => state.issues.find((item) => item.key === key)

/** 测试辅助：重置服务端数据 */
export function resetServerState() {
  state.issues = structuredClone(seedIssues)
  state.batches = []
  save()
}

const touch = (issue: Issue, actor: string) => {
  issue.versionNo += 1
  issue.updatedBy = actor
}

/** 处理批次中的单条问题：版本冲突跳过、内容没变不写历史、其余生效 */
function processItem(item: { key: string; expectedVersion: number }, batch: AssignmentBatch): BatchItem {
  const issue = findIssue(item.key)
  if (!issue) {
    return { ...item, status: 'failed', message: '问题不存在或已被删除' }
  }
  if (issue.versionNo !== item.expectedVersion) {
    return {
      ...item,
      status: 'conflict',
      currentVersion: issue.versionNo,
      updatedBy: issue.updatedBy,
      message: `你基于版本 v${item.expectedVersion} 提交，${issue.updatedBy} 已将其更新为 v${issue.versionNo}（当前 ${issue.team} / ${issue.owner} / ${issue.priority}），本条已跳过`,
    }
  }
  const { payload } = batch
  const unchanged =
    issue.team === payload.team && issue.owner === payload.owner && issue.priority === payload.priority && issue.dueDate === payload.dueDate
  if (unchanged) {
    return { ...item, status: 'unchanged', appliedVersion: issue.versionNo, message: '与当前指派一致，未重复写入历史' }
  }
  issue.team = payload.team
  issue.owner = payload.owner
  issue.priority = payload.priority
  issue.dueDate = payload.dueDate
  if (issue.status === '待分配' || issue.status === '已退回') issue.status = '修复中'
  issue.lastBatchNo = batch.batchNo
  touch(issue, '当前用户')
  issue.history.push({
    at: '刚刚',
    actor: '当前用户',
    action: '批量分配',
    detail: `批次 ${batch.batchNo}：指派至 ${payload.team} / ${payload.owner}，优先级 ${payload.priority}，截止 ${payload.dueDate}`,
  })
  return { ...item, status: 'applied', appliedVersion: issue.versionNo }
}

export const handlers = [
  http.get('*/api/issues', ({ request }) => {
    const url = new URL(request.url)
    const query = url.searchParams.get('query')?.toLowerCase() ?? ''
    const status = url.searchParams.get('status') ?? ''
    const site = url.searchParams.get('site') ?? ''
    const filtered = state.issues.filter((issue) => (!query || `${issue.key}${issue.title}${issue.rootCause}`.toLowerCase().includes(query)) && (!status || issue.status === status) && (!site || issue.site === site))
    return HttpResponse.json(filtered)
  }),

  http.post('*/api/issues/:key/review', async ({ params, request }) => {
    const issue = findIssue(String(params.key))
    const body = (await request.json()) as { result: string; note: string; environment: string }
    if (!issue) return new HttpResponse(null, { status: 404 })
    issue.status = body.result as Issue['status']
    issue.retestEnv = body.environment
    touch(issue, '当前用户')
    issue.retestRecords.push({ id: `RT-${Date.now()}`, actor: '当前用户', result: body.result, note: body.note, at: '刚刚' })
    issue.history.push({ at: '刚刚', actor: '当前用户', action: `复测${body.result}`, detail: body.note })
    save()
    return HttpResponse.json(issue)
  }),

  // 单条调整负责人/优先级：带版本号，冲突返回 409；成功后旧批次结论由前端派生失效
  http.post('*/api/issues/:key/adjust', async ({ params, request }) => {
    const issue = findIssue(String(params.key))
    if (!issue) return new HttpResponse(null, { status: 404 })
    const body = (await request.json()) as { owner: string; priority: Issue['priority']; expectedVersion: number }
    if (issue.versionNo !== body.expectedVersion) {
      return HttpResponse.json(
        { message: `保存失败：你基于版本 v${body.expectedVersion} 编辑，${issue.updatedBy} 已更新为 v${issue.versionNo}（当前 ${issue.owner} / ${issue.priority}），请刷新后重试`, issue },
        { status: 409 },
      )
    }
    const changes: string[] = []
    if (body.owner !== issue.owner) changes.push(`负责人 ${issue.owner} → ${body.owner}`)
    if (body.priority !== issue.priority) changes.push(`优先级 ${issue.priority} → ${body.priority}`)
    if (!changes.length) return HttpResponse.json({ issue, unchanged: true })
    issue.owner = body.owner
    issue.priority = body.priority
    touch(issue, '当前用户')
    issue.history.push({ at: '刚刚', actor: '当前用户', action: '调整负责人/优先级', detail: `${changes.join('；')}，相关批次结论已失效并重算` })
    save()
    return HttpResponse.json({ issue, unchanged: false })
  }),

  // 整改批次：按批次号幂等。首次提交创建批次；同一批次号重复提交（断网续传）只处理仍待提交的条目
  http.post('*/api/assignment-batches', async ({ request }) => {
    const body = (await request.json()) as { batchNo: string; payload: AssignmentPayload; items: Array<{ key: string; expectedVersion: number }> }
    let batch = state.batches.find((item) => item.batchNo === body.batchNo)
    if (batch) {
      batch.attempt += 1
      batch.updatedAt = stamp()
      batch.payload = body.payload
      batch.items = batch.items.map((item) => (item.status === 'pending' || item.status === 'failed' ? processItem(item, batch!) : item))
    } else {
      batch = { batchNo: body.batchNo, createdAt: stamp(), updatedAt: stamp(), attempt: 1, payload: body.payload, items: [] }
      batch.items = body.items.map((item) => processItem(item, batch!))
      state.batches.unshift(batch)
    }
    save()
    return HttpResponse.json({ batch, issues: state.issues })
  }),

  http.get('*/api/assignment-batches', () => HttpResponse.json(state.batches)),

  // 演示用途：模拟另一负责人同时保存，让所选问题版本号 +1
  http.post('*/api/simulate/concurrent-edit', async ({ request }) => {
    const { keys } = (await request.json()) as { keys: string[] }
    state.issues.forEach((issue) => {
      if (!keys.includes(issue.key)) return
      issue.owner = '王璟'
      issue.priority = issue.priority === 'P0' ? 'P1' : 'P0'
      touch(issue, '王璟')
      issue.history.push({ at: '刚刚', actor: '王璟', action: '调整负责人/优先级', detail: '另一负责人同时保存了修改（并发演示）' })
    })
    save()
    return HttpResponse.json({ issues: state.issues })
  }),
]
