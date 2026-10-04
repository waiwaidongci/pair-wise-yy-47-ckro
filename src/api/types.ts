export type IssueStatus = '待分配' | '修复中' | '待复测' | '已通过' | '已退回' | '不适用'

export type Issue = {
  key: string
  title: string
  site: string
  version: string
  wcag: string[]
  issueType: string
  impact: '致命' | '严重' | '中等' | '轻微'
  affected: string
  reproduction: string
  evidence: string
  rootCause: string
  status: IssueStatus
  priority: 'P0' | 'P1' | 'P2' | 'P3'
  team: string
  owner: string
  dueDate: string
  mergedKeys: string[]
  fixNote?: string
  retestEnv?: string
  /** 数据版本号：每次服务端变更 +1，批量分配/单条调整按此做乐观并发控制 */
  versionNo: number
  /** 最近一次变更人，用于冲突提示 */
  updatedBy: string
  /** 最近一次生效的整改批次号 */
  lastBatchNo?: string
  retestRecords: Array<{ id: string; actor: string; result: string; note: string; at: string }>
  history: Array<{ at: string; actor: string; action: string; detail: string }>
}

export type AssignmentPayload = {
  team: string
  owner: string
  priority: Issue['priority']
  dueDate: string
}

/** pending=待提交 applied=已生效 unchanged=无变化(未写历史) conflict=版本冲突已跳过 failed=网络失败留在批次 */
export type BatchItemStatus = 'pending' | 'applied' | 'unchanged' | 'conflict' | 'failed'

export type BatchItem = {
  key: string
  /** 提交人当时看到的版本号 */
  expectedVersion: number
  status: BatchItemStatus
  message?: string
  /** 批次生效/确认无变化时的版本号，用于后续失效判断 */
  appliedVersion?: number
  /** 冲突时服务端的当前版本号 */
  currentVersion?: number
  /** 冲突时的最近修改人 */
  updatedBy?: string
}

export type AssignmentBatch = {
  batchNo: string
  createdAt: string
  updatedAt: string
  /** 提交次数（断网续传会递增） */
  attempt: number
  payload: AssignmentPayload
  items: BatchItem[]
}

/** 客户端跟踪的批次：在服务端批次基础上补充本地恢复状态 */
export type TrackedBatch = AssignmentBatch & {
  /** 最近一次提交失败的原因（如断网），存在说明批次待恢复 */
  lastError?: string
}
