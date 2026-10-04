/**
 * 整改批次核心流程集成测试（Node + msw/node，走真实 HTTP 拦截）：
 * 1. 批量提交：版本冲突跳过并列出、其余生效、不存在条目标记失败
 * 2. 断网续传：同批次号重复提交幂等，已生效条目不重复写历史
 * 3. 内容没变不写历史（unchanged）
 * 4. 后续调整负责人/优先级 → 旧批次结论失效重算
 * 5. 复测推进版本但指派未变 → 批次结论仍有效
 * 6. 单条调整版本冲突 → 409
 */
import assert from 'node:assert/strict'
import { setupServer } from 'msw/node'
import { handlers, resetServerState } from '../src/api/handlers'
import { deriveItemState, summarizeBatch } from '../src/api/batchUtils'
import type { AssignmentBatch, Issue, TrackedBatch } from '../src/api/types'

const server = setupServer(...handlers)
server.listen({ onUnhandledRequest: 'error' })

const BASE = 'http://localhost'
const post = async (url: string, body: unknown) => {
  const res = await fetch(`${BASE}${url}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  return { status: res.status, data: (await res.json()) as never }
}
const getIssues = async () => (await (await fetch(`${BASE}/api/issues`)).json()) as Issue[]

const payload = { team: '前端基础组件组', owner: '何沐', priority: 'P1', dueDate: '2026-10-20' }

async function main() {
  resetServerState()
  const seed = await getIssues()
  const byKey = (issues: Issue[], key: string) => issues.find((item) => item.key === key)!
  const v = (key: string) => byKey(seed, key).versionNo

  // ── 场景 1：批量提交，含版本冲突与不存在条目 ──────────────────────────
  const batchNo = 'PC-TEST-0001'
  const { data: first } = await post('/api/assignment-batches', {
    batchNo,
    payload,
    items: [
      { key: 'A11Y-1061', expectedVersion: v('A11Y-1061') }, // 版本匹配 → 生效
      { key: 'A11Y-1083', expectedVersion: v('A11Y-1083') - 1 }, // 版本过旧 → 冲突跳过
      { key: 'A11Y-9999', expectedVersion: 1 }, // 不存在 → 失败
    ],
  }) as { data: { batch: AssignmentBatch; issues: Issue[] } }

  const itemOf = (batch: AssignmentBatch, key: string) => batch.items.find((item) => item.key === key)!
  assert.equal(first.batch.attempt, 1)
  assert.equal(itemOf(first.batch, 'A11Y-1061').status, 'applied')
  assert.equal(itemOf(first.batch, 'A11Y-1083').status, 'conflict')
  assert.match(itemOf(first.batch, 'A11Y-1083').message!, /v\d+.*已将其更新为.*跳过/)
  assert.equal(itemOf(first.batch, 'A11Y-1083').updatedBy, '系统')
  assert.equal(itemOf(first.batch, 'A11Y-9999').status, 'failed')

  const afterFirst = first.issues
  const applied1061 = byKey(afterFirst, 'A11Y-1061')
  assert.equal(applied1061.versionNo, v('A11Y-1061') + 1)
  assert.equal(applied1061.owner, '何沐')
  assert.equal(applied1061.status, '修复中') // 待分配 → 修复中
  assert.equal(applied1061.lastBatchNo, batchNo)
  assert.equal(applied1061.history.filter((h) => h.action === '批量分配').length, 1)
  // 冲突条目未被改动
  assert.equal(byKey(afterFirst, 'A11Y-1083').versionNo, v('A11Y-1083'))
  console.log('✓ 场景1：冲突跳过并列出，其余条目生效')

  // ── 场景 2：断网续传，同批次号幂等 ──────────────────────────────────
  const { data: resumed } = await post('/api/assignment-batches', {
    batchNo,
    payload,
    items: [
      { key: 'A11Y-1061', expectedVersion: v('A11Y-1061') },
      { key: 'A11Y-1083', expectedVersion: v('A11Y-1083') - 1 },
      { key: 'A11Y-9999', expectedVersion: 1 },
    ],
  }) as { data: { batch: AssignmentBatch; issues: Issue[] } }

  assert.equal(resumed.batch.attempt, 2)
  assert.equal(itemOf(resumed.batch, 'A11Y-1061').status, 'applied') // 保持首次结论
  assert.equal(itemOf(resumed.batch, 'A11Y-1083').status, 'conflict') // 冲突不自动重试
  assert.equal(itemOf(resumed.batch, 'A11Y-9999').status, 'failed') // 失败项留在原批次重试
  const again1061 = byKey(resumed.issues, 'A11Y-1061')
  assert.equal(again1061.versionNo, v('A11Y-1061') + 1, '续传不得重复推进版本')
  assert.equal(again1061.history.filter((h) => h.action === '批量分配').length, 1, '续传不得重复写历史')
  console.log('✓ 场景2：断网续传按原批次号继续，已生效条目不重复写历史')

  // ── 场景 3：内容没变不写历史 ────────────────────────────────────────
  const { data: same } = await post('/api/assignment-batches', {
    batchNo: 'PC-TEST-0002',
    payload,
    items: [{ key: 'A11Y-1061', expectedVersion: v('A11Y-1061') + 1 }],
  }) as { data: { batch: AssignmentBatch; issues: Issue[] } }
  assert.equal(itemOf(same.batch, 'A11Y-1061').status, 'unchanged')
  assert.equal(byKey(same.issues, 'A11Y-1061').versionNo, v('A11Y-1061') + 1, '无变化不得推进版本')
  assert.equal(byKey(same.issues, 'A11Y-1061').history.filter((h) => h.action === '批量分配').length, 1, '无变化不得写历史')
  console.log('✓ 场景3：内容没变的问题不重复写历史')

  // ── 场景 4：后续调整负责人 → 旧批次结论失效重算 ──────────────────────
  // 干净批次：1061 与当前指派一致（unchanged），1074 指派有变化（applied）
  const { data: invBatch } = await post('/api/assignment-batches', {
    batchNo: 'PC-TEST-INV',
    payload,
    items: [
      { key: 'A11Y-1061', expectedVersion: v('A11Y-1061') + 1 },
      { key: 'A11Y-1074', expectedVersion: v('A11Y-1074') },
    ],
  }) as { data: { batch: AssignmentBatch; issues: Issue[] } }
  const tracked: TrackedBatch = { ...invBatch.batch }
  assert.equal(itemOf(tracked, 'A11Y-1061').status, 'unchanged')
  assert.equal(itemOf(tracked, 'A11Y-1074').status, 'applied')
  const before = summarizeBatch(tracked, invBatch.issues)
  assert.equal(before.counts.invalidated, 0)
  assert.equal(before.code, 'done')

  const current1061 = byKey(await getIssues(), 'A11Y-1061')
  const { status: adjustStatus, data: adjusted } = await post('/api/issues/A11Y-1061/adjust', {
    owner: '顾雪',
    priority: 'P0',
    expectedVersion: current1061.versionNo,
  }) as { status: number; data: { issue: Issue; unchanged: boolean } }
  assert.equal(adjustStatus, 200)
  assert.equal(adjusted.issue.owner, '顾雪')

  const latest = await getIssues()
  const after = summarizeBatch(tracked, latest)
  assert.equal(after.counts.invalidated, 1, '负责人被调整后旧批次结论应失效')
  assert.equal(after.code, 'stale')
  const drifted = deriveItemState(itemOf(tracked, 'A11Y-1061'), byKey(latest, 'A11Y-1061'), tracked.payload)
  assert.equal(drifted.code, 'invalidated')
  assert.equal(drifted.label, '已失效·待重算')
  console.log('✓ 场景4：后续调整负责人/优先级，旧批次结论失效并重算')

  // ── 场景 5：复测推进版本但指派未变 → 结论仍有效 ──────────────────────
  await post('/api/issues/A11Y-1074/review', { result: '已通过', note: '对比度达标', environment: 'Safari 26' })
  const afterReview = await getIssues()
  assert.notEqual(byKey(afterReview, 'A11Y-1074').versionNo, itemOf(tracked, 'A11Y-1074').appliedVersion, '复测应推进版本号')
  const stillValid = deriveItemState(itemOf(tracked, 'A11Y-1074'), byKey(afterReview, 'A11Y-1074'), tracked.payload)
  assert.equal(stillValid.code, 'applied', '复测流转不应使指派结论失效')
  console.log('✓ 场景5：复测推进版本但指派未变，批次结论仍有效')

  // ── 场景 6：单条调整版本冲突 → 409 ──────────────────────────────────
  const current = byKey(await getIssues(), 'A11Y-1083')
  const { status: conflictStatus, data: conflictBody } = await post('/api/issues/A11Y-1083/adjust', {
    owner: '张三',
    priority: 'P3',
    expectedVersion: current.versionNo - 1,
  }) as { status: number; data: { message: string; issue: Issue } }
  assert.equal(conflictStatus, 409)
  assert.match(conflictBody.message, /版本 v\d+.*已更新为/)
  assert.equal(conflictBody.issue.owner, current.owner, '冲突时返回当前服务端数据')
  console.log('✓ 场景6：单条调整版本冲突返回 409 并说明差异')

  console.log('\n全部 6 个场景通过')
  server.close()
  process.exit(0)
}

main().catch((error) => {
  console.error('测试失败：', error)
  server.close()
  process.exit(1)
})
