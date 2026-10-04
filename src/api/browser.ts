import { setupWorker } from 'msw/browser'
import { http, HttpResponse } from 'msw'
import { seedIssues } from './seed'
import type { Issue } from './types'

let issues = structuredClone(seedIssues)

export const worker = setupWorker(
  http.get('/api/issues', ({ request }) => {
    const url = new URL(request.url)
    const query = url.searchParams.get('query')?.toLowerCase() ?? ''
    const status = url.searchParams.get('status') ?? ''
    const site = url.searchParams.get('site') ?? ''
    const filtered = issues.filter((issue) => (!query || `${issue.key}${issue.title}${issue.rootCause}`.toLowerCase().includes(query)) && (!status || issue.status === status) && (!site || issue.site === site))
    return HttpResponse.json(filtered)
  }),

  http.post('/api/issues/:key/review', async ({ params, request }) => {
    const issue = issues.find((item) => item.key === params.key)
    const body = (await request.json()) as { result: string; note: string; environment: string }
    if (!issue) return new HttpResponse(null, { status: 404 })
    issue.status = body.result as Issue['status']
    issue.retestEnv = body.environment
    issue.version += 1
    issue.retestRecords.push({ id: `RT-${Date.now()}`, actor: '当前用户', result: body.result, note: body.note, at: '刚刚' })
    issue.history.push({ at: '刚刚', actor: '当前用户', action: `复测${body.result}`, detail: body.note })
    return HttpResponse.json(issue)
  }),

  /**
   * 批量分配（整改批次）。
   * 每条条目携带负责人所见版本号 seenVersion：
   *  - 版本不一致 → 判为冲突，跳过该条并列出原因，其余条目继续生效
   *  - 内容未变化 → 不重复写历史（幂等）
   *  - 批次号 batchId 由客户端生成，失败条目可按原批次号继续提交
   */
  http.post('/api/issues/bulk-assign', async ({ request }) => {
    const body = (await request.json()) as {
      batchId?: string
      items: Array<{ key: string; seenVersion: number }>
      team: string
      owner: string
      dueDate: string
      priority: Issue['priority']
    }
    const results = body.items.map((item) => {
      const issue = issues.find((x) => x.key === item.key)
      if (!issue) {
        return { key: item.key, status: 'failed' as const, reason: '问题不存在或已被删除' }
      }
      if (issue.version !== item.seenVersion) {
        return {
          key: item.key,
          status: 'conflict' as const,
          seenVersion: item.seenVersion,
          currentVersion: issue.version,
          reason: `该问题已被他人修改：你看到的是 v${item.seenVersion}，当前为 v${issue.version}（当前负责人 ${issue.owner} / ${issue.priority}），本条已跳过`,
        }
      }
      const unchanged =
        issue.team === body.team &&
        issue.owner === body.owner &&
        issue.dueDate === body.dueDate &&
        issue.priority === body.priority &&
        issue.status === '修复中'
      if (!unchanged) {
        issue.team = body.team
        issue.owner = body.owner
        issue.dueDate = body.dueDate
        issue.priority = body.priority
        issue.status = '修复中'
        issue.version += 1
        issue.history.push({ at: '刚刚', actor: '当前用户', action: '批量分配', detail: `指派至 ${body.team} / ${body.owner}（批次 ${body.batchId ?? '—'}）` })
      }
      return { key: item.key, status: 'applied' as const, currentVersion: issue.version, unchanged }
    })
    return HttpResponse.json({ batchId: body.batchId, results })
  }),

  /** 单条调整负责人 / 优先级 / 截止日期，同样携带所见版本号 */
  http.post('/api/issues/:key/adjust', async ({ params, request }) => {
    const issue = issues.find((item) => item.key === params.key)
    if (!issue) return new HttpResponse(null, { status: 404 })
    const body = (await request.json()) as { owner: string; priority: Issue['priority']; dueDate: string; seenVersion: number }
    if (issue.version !== body.seenVersion) {
      return HttpResponse.json({ error: 'conflict', currentVersion: issue.version }, { status: 409 })
    }
    const changed = issue.owner !== body.owner || issue.priority !== body.priority || issue.dueDate !== body.dueDate
    if (changed) {
      const from = `${issue.owner} / ${issue.priority} / ${issue.dueDate}`
      issue.owner = body.owner
      issue.priority = body.priority
      issue.dueDate = body.dueDate
      issue.version += 1
      issue.history.push({ at: '刚刚', actor: '当前用户', action: '调整分配', detail: `${from} → ${body.owner} / ${body.priority} / ${body.dueDate}` })
    }
    return HttpResponse.json(issue)
  }),

  /** 演示用：模拟他人在你打开详情期间并发保存（版本号 +1） */
  http.post('/api/issues/:key/simulate-edit', async ({ params }) => {
    const issue = issues.find((item) => item.key === params.key)
    if (!issue) return new HttpResponse(null, { status: 404 })
    issue.version += 1
    issue.history.push({ at: '刚刚', actor: '他人（并发保存）', action: '并发修改', detail: '在你打开详情期间，其他人保存了该问题。' })
    return HttpResponse.json(issue)
  }),
)

export { issues }
