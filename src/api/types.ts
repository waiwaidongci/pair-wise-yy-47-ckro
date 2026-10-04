export type IssueStatus = '待分配' | '修复中' | '待复测' | '已通过' | '已退回' | '不适用'

export type Issue = {
  key: string
  title: string
  site: string
  /** 站点版本，如 v4.18 */
  siteVersion: string
  /** 乐观锁版本号：每次他人保存 +1，提交时携带所见版本 */
  version: number
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
  retestRecords: Array<{ id: string; actor: string; result: string; note: string; at: string }>
  history: Array<{ at: string; actor: string; action: string; detail: string }>
}

/** 批次条目状态：待处理 / 已生效 / 冲突跳过 / 失败待续 */
export type BatchItemStatus = 'pending' | 'applied' | 'conflict' | 'failed'

export type BatchItem = {
  key: string
  title: string
  /** 负责人提交时看到的版本号（乐观锁） */
  seenVersion: number
  status: BatchItemStatus
  reason?: string
  /** 服务端当前版本号（冲突时回传） */
  currentVersion?: number
  /** 内容未发生变化，未重复写历史 */
  unchanged?: boolean
}

export type RemediationBatch = {
  id: string
  createdAt: string
  updatedAt: string
  payload: {
    team: string
    owner: string
    dueDate: string
    priority: Issue['priority']
  }
  items: BatchItem[]
  /** active = 仍有失败/待处理条目可继续；completed = 全部处理完毕 */
  status: 'active' | 'completed'
  /** 批次结论：按当前条目状态重算的指派/SLA 结论 */
  conclusion: string
  /** 结论是否已因后续调整而失效 */
  conclusionStale: boolean
  staleReason?: string
}
