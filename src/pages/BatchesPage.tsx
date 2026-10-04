import { useState } from 'react'
import {
  Alert,
  Button,
  Popconfirm,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
  message,
} from 'antd'
import { CloudSyncOutlined, DeleteOutlined, ReloadOutlined } from '@ant-design/icons'
import { useIssues } from '../api/useIssues'
import { useBatchStore } from '../store/useBatchStore'
import type { BatchItem, RemediationBatch } from '../api/types'

const batchItemMeta: Record<string, { color: string; label: string }> = {
  pending: { color: 'default', label: '待处理' },
  applied: { color: 'success', label: '已生效' },
  conflict: { color: 'warning', label: '冲突跳过' },
  failed: { color: 'error', label: '失败待续' },
}

function BatchCard({ batch }: { batch: RemediationBatch }) {
  const dispatchBatch = useBatchStore((state) => state.dispatchBatch)
  const recomputeConclusion = useBatchStore((state) => state.recomputeConclusion)
  const removeBatch = useBatchStore((state) => state.removeBatch)
  const [busy, setBusy] = useState(false)

  const applied = batch.items.filter((item) => item.status === 'applied').length
  const conflicts = batch.items.filter((item) => item.status === 'conflict').length
  const failed = batch.items.filter((item) => item.status === 'failed' || item.status === 'pending').length

  const continueDispatch = async () => {
    setBusy(true)
    try {
      await dispatchBatch(batch.id)
      message.success('批次已按原批次号继续处理')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="panel batch-card">
      <div className="panel-head">
        <Space wrap>
          <Typography.Text strong code>{batch.id}</Typography.Text>
          <Tag color={batch.status === 'completed' ? 'success' : 'processing'}>{batch.status === 'completed' ? '已完成' : '进行中'}</Tag>
          <Tag color="blue">{batch.payload.team} / {batch.payload.owner}</Tag>
          <Tag>{batch.payload.priority}</Tag>
          <Tag>截止 {batch.payload.dueDate}</Tag>
        </Space>
        <Space>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>{new Date(batch.createdAt).toLocaleString('zh-CN')}</Typography.Text>
          <Popconfirm title="删除该批次记录？" description="仅删除批次留痕，已生效的问题改动不会回滚。" onConfirm={() => removeBatch(batch.id)} okText="删除" cancelText="取消">
            <Button size="small" type="text" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      </div>

      <div className="batch-body">
        {batch.conclusionStale ? (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 12 }}
            message="批次结论已失效"
            description={
              <Space direction="vertical" size={6} style={{ width: '100%' }}>
                <span>{batch.staleReason ?? '批次条目后续被调整，原结论不再成立。'}</span>
                <span>{batch.conclusion}</span>
                <Button size="small" icon={<ReloadOutlined />} onClick={() => recomputeConclusion(batch.id)} style={{ alignSelf: 'flex-start' }}>重算结论</Button>
              </Space>
            }
          />
        ) : (
          <Alert type="info" showIcon style={{ marginBottom: 12 }} message={batch.conclusion} />
        )}

        <Space wrap style={{ marginBottom: 10 }}>
          <Tag color="success">已生效 {applied}/{batch.items.length}</Tag>
          {conflicts > 0 && <Tag color="warning">冲突跳过 {conflicts}</Tag>}
          {failed > 0 && <Tag color="error">失败待续 {failed}</Tag>}
          {batch.status === 'active' && (
            <Button size="small" type="primary" ghost icon={<CloudSyncOutlined />} loading={busy} onClick={continueDispatch}>
              按原批次号继续{failed ? `（${failed}）` : ''}
            </Button>
          )}
        </Space>

        <Table<BatchItem>
          size="small"
          rowKey="key"
          pagination={false}
          dataSource={batch.items}
          columns={[
            {
              title: '问题',
              dataIndex: 'key',
              width: 170,
              render: (value: string, record) => (
                <span><Typography.Text strong>{value}</Typography.Text><div className="muted" style={{ fontSize: 11 }}>提交版本 v{record.seenVersion}{record.currentVersion ? ` → 当前 v${record.currentVersion}` : ''}</div></span>
              ),
            },
            { title: '状态', dataIndex: 'status', width: 100, render: (value: string) => <Tag color={batchItemMeta[value].color}>{batchItemMeta[value].label}</Tag> },
            { title: '说明', dataIndex: 'reason', render: (value: string | undefined, record) => value ?? (record.unchanged ? '内容未变化，未重复写历史' : '已按批量指派更新并写入历史') },
          ]}
        />
      </div>
    </div>
  )
}

export default function BatchesPage() {
  useIssues()
  const batches = useBatchStore((state) => state.batches)
  const simulateOffline = useBatchStore((state) => state.simulateOffline)
  const setSimulateOffline = useBatchStore((state) => state.setSimulateOffline)

  return (
    <section className="page">
      <div className="page-head">
        <div>
          <p className="eyebrow">REMEDIATION BATCHES / 整改批次</p>
          <h1>可恢复的整改批次</h1>
          <p className="muted">每条问题携带所见版本号提交，冲突条目跳过并列明；失败条目留在原批次，恢复后按原批次号续传，未变化的问题不重复写历史。</p>
        </div>
        <Space>
          <Switch checked={simulateOffline} onChange={setSimulateOffline} />
          <span className={simulateOffline ? '' : 'muted'} style={{ color: simulateOffline ? '#b84f32' : undefined }}>{simulateOffline ? '模拟断网中' : '模拟断网（演示断点续传）'}</span>
        </Space>
      </div>

      {simulateOffline && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 14 }}
          message="已开启模拟断网"
          description="新提交的批次会全部失败并按原批次号缓存；关闭断网后点击「按原批次号继续」即可续传，已生效条目不会重复提交。"
        />
      )}

      {batches.length === 0 ? (
        <div className="panel" style={{ padding: 32, textAlign: 'center' }}>
          <Typography.Paragraph type="secondary">暂无整改批次。前往问题台账选择多条问题进行批量分配。</Typography.Paragraph>
        </div>
      ) : (
        <Space direction="vertical" size={14} style={{ width: '100%' }}>
          {batches.map((batch) => <BatchCard key={batch.id} batch={batch} />)}
        </Space>
      )}
    </section>
  )
}
