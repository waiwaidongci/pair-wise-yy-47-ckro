import { useState } from 'react'
import { Alert, Button, Modal, Space, Switch, Table, Tag, Typography, message } from 'antd'
import { CloudSyncOutlined, ReloadOutlined } from '@ant-design/icons'
import { useQueryClient } from '@tanstack/react-query'
import type { ColumnsType } from 'antd/es/table'
import type { BatchItem, TrackedBatch } from '../api/types'
import { submitAssignmentBatch } from '../api/batches'
import { deriveItemState, formatBatchTime, summarizeBatch } from '../api/batchUtils'
import { useWorkspaceStore } from '../store/useWorkspaceStore'

/** 批次条目明细表：状态为按当前台账派生的有效结论（后续调整会使旧结论失效） */
export function BatchItemsTable({ batch }: { batch: TrackedBatch }) {
  const issues = useWorkspaceStore((state) => state.issues)
  const columns: ColumnsType<BatchItem> = [
    { title: '问题', dataIndex: 'key', width: 110, render: (value) => <Typography.Text strong>{value}</Typography.Text> },
    { title: '提交时版本', dataIndex: 'expectedVersion', width: 96, render: (value) => `v${value}` },
    {
      title: '当前结论',
      key: 'state',
      width: 120,
      render: (_, record) => {
        const state = deriveItemState(record, issues.find((issue) => issue.key === record.key), batch.payload)
        return <Tag color={state.color}>{state.label}</Tag>
      },
    },
    { title: '说明', dataIndex: 'message', render: (value, record) => value ?? (record.appliedVersion != null ? `生效于版本 v${record.appliedVersion}` : '—') },
  ]
  return <Table rowKey="key" size="small" columns={columns} dataSource={batch.items} pagination={false} scroll={{ x: 640 }} />
}

export default function BatchCenter() {
  const queryClient = useQueryClient()
  const issues = useWorkspaceStore((state) => state.issues)
  const batches = useWorkspaceStore((state) => state.batches)
  const simulateOffline = useWorkspaceStore((state) => state.simulateOffline)
  const setSimulateOffline = useWorkspaceStore((state) => state.setSimulateOffline)
  const applyBatchResult = useWorkspaceStore((state) => state.applyBatchResult)
  const markBatchFailed = useWorkspaceStore((state) => state.markBatchFailed)
  const discardBatch = useWorkspaceStore((state) => state.discardBatch)
  const [detail, setDetail] = useState<TrackedBatch | null>(null)
  const [resuming, setResuming] = useState('')

  const resume = async (batch: TrackedBatch) => {
    setResuming(batch.batchNo)
    try {
      const { batch: serverBatch, issues: serverIssues } = await submitAssignmentBatch(batch)
      applyBatchResult(serverBatch, serverIssues)
      queryClient.setQueryData(['issues'], serverIssues)
      const summary = summarizeBatch(serverBatch, serverIssues)
      message.success(`批次 ${batch.batchNo} 已按原批次号继续：生效 ${summary.counts.applied} 条，冲突跳过 ${summary.counts.conflict} 条`)
    } catch {
      markBatchFailed(batch.batchNo, '网络中断：失败条目已留在原批次，恢复后可继续')
      message.warning(`仍无法连接，批次 ${batch.batchNo} 保留待恢复`)
    } finally {
      setResuming('')
    }
  }

  return (
    <div className="panel" style={{ marginBottom: 14 }}>
      <div className="panel-head">
        <h3>整改批次</h3>
        <Space>
          {simulateOffline && <Tag color="orange">模拟断网中</Tag>}
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>模拟断网</Typography.Text>
          <Switch size="small" checked={simulateOffline} onChange={setSimulateOffline} />
        </Space>
      </div>
      {simulateOffline && (
        <Alert
          type="warning"
          showIcon
          style={{ margin: '12px 16px 0' }}
          message="当前为模拟断网状态"
          description="提交批次会失败并保留在下方列表中；关闭开关恢复网络后，可按原批次号继续，已生效条目不会重复写入历史。"
        />
      )}
      <div style={{ padding: '4px 16px 14px' }}>
        {batches.length === 0 && <Typography.Text type="secondary">暂无批次：在上方选择问题后点击「批量分配」创建可恢复的整改批次。</Typography.Text>}
        {batches.map((batch) => {
          const summary = summarizeBatch(batch, issues)
          return (
            <div key={batch.batchNo} className="batch-row">
              <div style={{ flex: 1, minWidth: 0 }}>
                <Space size={8} wrap>
                  <Typography.Text strong>{batch.batchNo}</Typography.Text>
                  <Tag color={summary.color}>{summary.label}</Tag>
                  {batch.attempt > 1 && <Tag>第 {batch.attempt} 次提交</Tag>}
                </Space>
                <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                  {formatBatchTime(batch.createdAt)} · 指派至 {batch.payload.team} / {batch.payload.owner} · {batch.payload.priority} · 截止 {batch.payload.dueDate}
                </div>
                <div style={{ fontSize: 12, marginTop: 4 }}>
                  <Typography.Text type="secondary">
                    生效 {summary.counts.applied} · 无变化 {summary.counts.unchanged} · 冲突跳过 {summary.counts.conflict} · 待恢复 {summary.counts.pending} · 已失效 {summary.counts.invalidated} / 共 {summary.total} 条
                  </Typography.Text>
                </div>
                {batch.lastError && <Typography.Text type="warning" style={{ fontSize: 12 }}>{batch.lastError}</Typography.Text>}
              </div>
              <Space>
                {summary.code === 'recoverable' && (
                  <Button size="small" type="primary" icon={<ReloadOutlined />} loading={resuming === batch.batchNo} onClick={() => resume(batch)}>
                    按原批次号继续
                  </Button>
                )}
                <Button size="small" icon={<CloudSyncOutlined />} onClick={() => setDetail(batch)}>条目明细</Button>
                {summary.code !== 'recoverable' && (
                  <Button size="small" type="text" danger onClick={() => discardBatch(batch.batchNo)}>移除</Button>
                )}
              </Space>
            </div>
          )
        })}
      </div>

      <Modal title={detail ? `批次 ${detail.batchNo} 条目明细` : ''} open={Boolean(detail)} onCancel={() => setDetail(null)} footer={<Button onClick={() => setDetail(null)}>关闭</Button>} width={760}>
        {detail && (
          <>
            <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
              结论按当前台账实时重算：若条目在批次生效后又被调整负责人或优先级，对应结论会标记为「已失效·待重算」。
            </Typography.Paragraph>
            <BatchItemsTable batch={detail} />
          </>
        )}
      </Modal>
    </div>
  )
}
