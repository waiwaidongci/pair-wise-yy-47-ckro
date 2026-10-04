import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import axios from 'axios'
import {
  Alert,
  Button,
  DatePicker,
  Drawer,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Table,
  Tag,
  Typography,
  message,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { CloudSyncOutlined, FilterOutlined, MergeCellsOutlined, SaveOutlined, TeamOutlined, ThunderboltOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import { useIssues } from '../api/useIssues'
import { useWorkspaceStore } from '../store/useWorkspaceStore'
import { useBatchStore } from '../store/useBatchStore'
import { queryClient } from '../api/queryClient'
import type { Issue } from '../api/types'

const impactColor: Record<string, string> = { 致命: 'red', 严重: 'volcano', 中等: 'gold', 轻微: 'blue' }
const statusColor: Record<string, string> = { 待分配: 'default', 修复中: 'processing', 待复测: 'orange', 已通过: 'success', 已退回: 'error', 不适用: 'default' }

const batchItemMeta: Record<string, { color: string; label: string }> = {
  pending: { color: 'default', label: '待处理' },
  applied: { color: 'success', label: '已生效' },
  conflict: { color: 'warning', label: '冲突跳过' },
  failed: { color: 'error', label: '失败待续' },
}

async function refreshIssues() {
  await queryClient.invalidateQueries({ queryKey: ['issues'] })
  const issues = queryClient.getQueryData<Issue[]>(['issues']) ?? []
  useWorkspaceStore.getState().setIssues(issues)
  return issues
}

export default function IssuesPage() {
  useIssues()
  const navigate = useNavigate()
  const issues = useWorkspaceStore((state) => state.issues)
  const selectedKeys = useWorkspaceStore((state) => state.selectedKeys)
  const setSelectedKeys = useWorkspaceStore((state) => state.setSelectedKeys)
  const savedFilters = useWorkspaceStore((state) => state.savedFilters)
  const saveFilter = useWorkspaceStore((state) => state.saveFilter)
  const removeFilter = useWorkspaceStore((state) => state.removeFilter)
  const mergeIssues = useWorkspaceStore((state) => state.mergeIssues)
  const createBatch = useBatchStore((state) => state.createBatch)
  const dispatchBatch = useBatchStore((state) => state.dispatchBatch)
  const invalidateBatchesForIssue = useBatchStore((state) => state.invalidateBatchesForIssue)
  const [filters, setFilters] = useState({ query: '', site: '', status: '', priority: '' })
  const [detail, setDetail] = useState<Issue | null>(null)
  const [assignOpen, setAssignOpen] = useState(false)
  const [mergeOpen, setMergeOpen] = useState(false)
  const [resultOpen, setResultOpen] = useState(false)
  const [resultBatchId, setResultBatchId] = useState<string | null>(null)
  const [dispatching, setDispatching] = useState(false)
  const [form] = Form.useForm()
  const [adjustForm] = Form.useForm()

  const resultBatch = useBatchStore((state) => (resultBatchId ? state.batches.find((item) => item.id === resultBatchId) : undefined))

  const data = useMemo(
    () =>
      issues.filter(
        (issue) =>
          (!filters.query || `${issue.key}${issue.title}${issue.rootCause}`.toLowerCase().includes(filters.query.toLowerCase())) &&
          (!filters.site || issue.site === filters.site) &&
          (!filters.status || issue.status === filters.status) &&
          (!filters.priority || issue.priority === filters.priority),
      ),
    [issues, filters],
  )

  const columns: ColumnsType<Issue> = [
    {
      title: '问题',
      dataIndex: 'title',
      width: 300,
      render: (_, record) => (
        <div><Typography.Text strong>{record.key}</Typography.Text> <Tag>v{record.version}</Tag><div>{record.title}</div><Typography.Text type="secondary" style={{ fontSize: 11 }}>{record.wcag.join(' / ')}</Typography.Text></div>
      ),
    },
    { title: '站点 / 版本', dataIndex: 'site', width: 130, render: (_, record) => <div>{record.site}<br /><Typography.Text type="secondary">{record.siteVersion}</Typography.Text></div> },
    { title: '影响', dataIndex: 'impact', width: 86, render: (value) => <Tag color={impactColor[value]}>{value}</Tag> },
    { title: '根因', dataIndex: 'rootCause', width: 220, render: (value) => <span className="root-cause" title={value}>{value}</span> },
    { title: '优先级', dataIndex: 'priority', width: 76, render: (value) => <Tag>{value}</Tag> },
    { title: '团队 / 负责人', dataIndex: 'team', width: 160, render: (_, record) => <div>{record.team}<br /><Typography.Text type="secondary">{record.owner}</Typography.Text></div> },
    { title: '状态', dataIndex: 'status', width: 95, render: (value) => <Tag color={statusColor[value]}>{value}</Tag> },
    { title: '截止', dataIndex: 'dueDate', width: 105 },
    { title: '', width: 76, fixed: 'right', render: (_, record) => <Button type="link" onClick={() => setDetail(record)}>详情</Button> },
  ]

  const applyFilter = () => {
    const input = window.prompt('筛选方案名称')
    if (input?.trim()) {
      saveFilter({ name: input.trim(), ...filters })
      message.success('筛选条件已保存')
    }
  }

  const submitAssign = async (values: { team: string; owner: string; priority: Issue['priority']; dueDate: dayjs.Dayjs }) => {
    const payload = { team: values.team, owner: values.owner, priority: values.priority, dueDate: values.dueDate.format('YYYY-MM-DD') }
    const batchId = createBatch(
      payload,
      selectedKeys.map((key) => {
        const issue = issues.find((item) => item.key === key)!
        return { key, title: issue.title, seenVersion: issue.version }
      }),
    )
    setAssignOpen(false)
    form.resetFields()
    setSelectedKeys([])
    setResultBatchId(batchId)
    setResultOpen(true)
    setDispatching(true)
    try {
      await dispatchBatch(batchId)
    } finally {
      setDispatching(false)
    }
  }

  const continueDispatch = async () => {
    if (!resultBatch) return
    setDispatching(true)
    try {
      await dispatchBatch(resultBatch.id)
    } finally {
      setDispatching(false)
    }
  }

  const submitAdjust = async (values: { owner: string; priority: Issue['priority']; dueDate: dayjs.Dayjs }) => {
    if (!detail) return
    try {
      await axios.post(`/api/issues/${detail.key}/adjust`, {
        owner: values.owner,
        priority: values.priority,
        dueDate: values.dueDate.format('YYYY-MM-DD'),
        seenVersion: detail.version,
      })
      const fresh = await refreshIssues()
      invalidateBatchesForIssue(detail.key, `${detail.key} 负责人/优先级已调整，旧批次结论失效`)
      setDetail(fresh.find((item) => item.key === detail.key) ?? null)
      message.success('已调整，相关批次结论已标记失效并重算')
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 409) {
        message.error(`保存冲突：该问题已被他人修改（当前 v${error.response.data.currentVersion}），列表已刷新，请重新打开后再调整`)
        await refreshIssues()
        setDetail(null)
      } else {
        message.error('保存失败，请重试')
      }
    }
  }

  const simulateEdit = async () => {
    if (!detail) return
    await axios.post(`/api/issues/${detail.key}/simulate-edit`)
    const fresh = await refreshIssues()
    setDetail(fresh.find((item) => item.key === detail.key) ?? null)
    message.info('已模拟他人并发保存：版本号 +1，历史已记录')
  }

  const appliedCount = resultBatch?.items.filter((item) => item.status === 'applied').length ?? 0
  const conflictCount = resultBatch?.items.filter((item) => item.status === 'conflict').length ?? 0
  const failedCount = resultBatch?.items.filter((item) => item.status === 'failed' || item.status === 'pending').length ?? 0

  return (
    <section className="page">
      <div className="page-head">
        <div>
          <p className="eyebrow">ISSUE LEDGER / 问题台账</p>
          <h1>问题流转与批量处理</h1>
          <p className="muted">筛选条件可复用；选择多条问题后可合并同根因项或批量指派，失败条目按批次号续传。</p>
        </div>
        <Space>
          <Button icon={<MergeCellsOutlined />} disabled={selectedKeys.length < 2} onClick={() => setMergeOpen(true)}>合并重复问题</Button>
          <Button type="primary" icon={<TeamOutlined />} disabled={!selectedKeys.length} onClick={() => setAssignOpen(true)}>批量分配</Button>
        </Space>
      </div>

      <div className="toolbar panel">
        <Input.Search placeholder="搜索编号、标题或根因" allowClear style={{ width: 270 }} value={filters.query} onChange={(event) => setFilters({ ...filters, query: event.target.value })} />
        <Select placeholder="站点" allowClear style={{ width: 130 }} value={filters.site || undefined} onChange={(value) => setFilters({ ...filters, site: value ?? '' })} options={[...new Set(issues.map((item) => item.site))].map((value) => ({ value }))} />
        <Select placeholder="状态" allowClear style={{ width: 120 }} value={filters.status || undefined} onChange={(value) => setFilters({ ...filters, status: value ?? '' })} options={['待分配', '修复中', '待复测', '已通过', '已退回', '不适用'].map((value) => ({ value }))} />
        <Select placeholder="优先级" allowClear style={{ width: 110 }} value={filters.priority || undefined} onChange={(value) => setFilters({ ...filters, priority: value ?? '' })} options={['P0', 'P1', 'P2', 'P3'].map((value) => ({ value }))} />
        <Button icon={<SaveOutlined />} onClick={applyFilter}>保存筛选</Button>
        <span className="spacer" />
        <Typography.Text type="secondary">已选 {selectedKeys.length} 条 · 共 {data.length} 条</Typography.Text>
      </div>

      <div className="panel">
        <div className="saved-filters">
          <FilterOutlined />
          {savedFilters.map((filter) => (
            <Tag key={filter.id} closable onClose={(event) => { event.preventDefault(); removeFilter(filter.id) }} onClick={() => setFilters({ query: filter.query, site: filter.site, status: filter.status, priority: filter.priority })} style={{ cursor: 'pointer' }}>
              {filter.name}
            </Tag>
          ))}
        </div>
        <div className="table-wrap">
          <Table
            rowKey="key"
            columns={columns}
            dataSource={data}
            pagination={{ pageSize: 10, showSizeChanger: true, showTotal: (total) => `共 ${total} 条` }}
            rowSelection={{ selectedRowKeys: selectedKeys, onChange: (keys) => setSelectedKeys(keys as string[]) }}
            scroll={{ x: 1250 }}
          />
        </div>
      </div>

      <Drawer title={detail ? `${detail.key} · ${detail.title}` : ''} open={Boolean(detail)} onClose={() => setDetail(null)} width={560}>
        {detail && (
          <Space direction="vertical" size={18} style={{ width: '100%' }}>
            <Space wrap><Tag color={impactColor[detail.impact]}>{detail.impact}</Tag><Tag>{detail.priority}</Tag><Tag color={statusColor[detail.status]}>{detail.status}</Tag><Tag>乐观锁 v{detail.version}</Tag></Space>
            <dl className="detail-list">
              <dt>站点版本</dt><dd>{detail.site} / {detail.siteVersion}</dd>
              <dt>WCAG</dt><dd>{detail.wcag.join('、')}</dd>
              <dt>影响范围</dt><dd>{detail.affected}</dd>
              <dt>复现条件</dt><dd>{detail.reproduction}</dd>
              <dt>证据链接</dt><dd><Typography.Link href={detail.evidence} target="_blank">{detail.evidence}</Typography.Link></dd>
              <dt>根因</dt><dd>{detail.rootCause}</dd>
              <dt>关联重复</dt><dd>{detail.mergedKeys.length ? detail.mergedKeys.join('、') : '无'}</dd>
              <dt>修复说明</dt><dd>{detail.fixNote ?? '开发尚未提交'}</dd>
              <dt>复测环境</dt><dd>{detail.retestEnv ?? '待开发提交'}</dd>
            </dl>
            <div>
              <Typography.Title level={5}>操作历史</Typography.Title>
              {detail.history.map((event, index) => <div className="timeline-item" key={index}><Typography.Text strong>{event.action}</Typography.Text><div>{event.detail}</div><Typography.Text type="secondary" style={{ fontSize: 11 }}>{event.actor} · {event.at}</Typography.Text></div>)}
            </div>
            <Form key={detail.key} form={adjustForm} layout="vertical" onFinish={submitAdjust} initialValues={{ owner: detail.owner, priority: detail.priority, dueDate: dayjs(detail.dueDate) }}>
              <Typography.Title level={5}>调整负责人 / 优先级</Typography.Title>
              <Alert type="warning" showIcon style={{ marginBottom: 12 }} message="保存时携带当前版本号；若已被他人改过会提示冲突。调整后旧批次结论失效并按当前台账重算。" />
              <Form.Item name="owner" label="负责人" rules={[{ required: true }]}><Input placeholder="输入负责人姓名" /></Form.Item>
              <Space style={{ display: 'flex' }}>
                <Form.Item name="priority" label="优先级" rules={[{ required: true }]}><Select style={{ width: 140 }} options={['P0', 'P1', 'P2', 'P3'].map((value) => ({ value }))} /></Form.Item>
                <Form.Item name="dueDate" label="截止日期" rules={[{ required: true }]}><DatePicker /></Form.Item>
              </Space>
              <Space>
                <Button type="primary" htmlType="submit">保存调整</Button>
                <Button icon={<ThunderboltOutlined />} onClick={simulateEdit}>模拟他人并发保存</Button>
              </Space>
            </Form>
          </Space>
        )}
      </Drawer>

      <Modal title="批量分配整改项" open={assignOpen} onCancel={() => setAssignOpen(false)} onOk={() => form.submit()} okText="确认分配">
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="按所见版本号乐观锁提交"
          description="每条问题携带你当前看到的版本号；提交前若被他人改过，该条会被跳过并列出冲突原因，其余条目继续生效。失败条目保留在批次中，恢复后按原批次号续传。"
        />
        <div style={{ marginBottom: 12 }}>
          {selectedKeys.map((key) => {
            const issue = issues.find((item) => item.key === key)
            return issue ? <Tag key={key} style={{ marginBottom: 4 }}>{key} · v{issue.version}</Tag> : null
          })}
        </div>
        <Form form={form} layout="vertical" onFinish={submitAssign}>
          <Form.Item name="team" label="目标团队" rules={[{ required: true }]}><Select options={['前端基础组件组', '结算体验组', '数据可视化组', '供应链前端组'].map((value) => ({ value }))} /></Form.Item>
          <Form.Item name="owner" label="负责人" rules={[{ required: true }]}><Input placeholder="输入负责人姓名" /></Form.Item>
          <Space style={{ display: 'flex' }}>
            <Form.Item name="priority" label="优先级" rules={[{ required: true }]}><Select style={{ width: 140 }} options={['P0', 'P1', 'P2', 'P3'].map((value) => ({ value }))} /></Form.Item>
            <Form.Item name="dueDate" label="截止日期" rules={[{ required: true }]}><DatePicker /></Form.Item>
          </Space>
        </Form>
      </Modal>

      <Modal
        title={`整改批次 ${resultBatch?.id ?? ''}`}
        open={resultOpen}
        onCancel={() => setResultOpen(false)}
        width={720}
        footer={[
          <Button key="close" onClick={() => setResultOpen(false)}>关闭</Button>,
          <Button key="batches" onClick={() => { setResultOpen(false); navigate('/batches') }}>前往批次中心</Button>,
          <Button key="continue" type="primary" icon={<CloudSyncOutlined />} loading={dispatching} disabled={!failedCount} onClick={continueDispatch}>继续处理失败项{failedCount ? `（${failedCount}）` : ''}</Button>,
        ]}
      >
        {resultBatch && (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Alert
              type={conflictCount ? 'warning' : 'success'}
              showIcon
              message={conflictCount ? '部分条目已跳过' : '批次条目已全部处理'}
              description={conflictCount ? `${conflictCount} 条问题在你打开后被他人修改，已跳过并列出；其余条目正常生效。` : '失败条目会保留在本批次中，恢复后可按原批次号继续。'}
            />
            <Space wrap>
              <Tag color="success">已生效 {appliedCount}</Tag>
              <Tag color="warning">冲突跳过 {conflictCount}</Tag>
              <Tag color="error">失败待续 {failedCount}</Tag>
            </Space>
            <Table
              size="small"
              rowKey="key"
              pagination={false}
              dataSource={resultBatch.items}
              columns={[
                {
                  title: '问题',
                  dataIndex: 'key',
                  width: 150,
                  render: (value, record) => (
                    <span><Typography.Text strong>{value}</Typography.Text><div className="muted" style={{ fontSize: 11 }}>提交版本 v{record.seenVersion}{record.currentVersion ? ` → 当前 v${record.currentVersion}` : ''}</div></span>
                  ),
                },
                { title: '状态', dataIndex: 'status', width: 100, render: (value: string) => <Tag color={batchItemMeta[value].color}>{batchItemMeta[value].label}</Tag> },
                { title: '说明', dataIndex: 'reason', render: (value: string | undefined, record) => value ?? (record.unchanged ? '内容未变化，未重复写历史' : '已按批量指派更新并写入历史') },
              ]}
            />
          </Space>
        )}
      </Modal>

      <Modal title="合并为同一整改项" open={mergeOpen} onCancel={() => setMergeOpen(false)} onOk={() => { mergeIssues(selectedKeys); setMergeOpen(false); message.success('问题已按根因合并，子项仍可追溯') }} okText="确认合并">
        <Typography.Paragraph>将以 <Typography.Text code>{selectedKeys[0]}</Typography.Text> 为主问题，其余 {selectedKeys.length - 1} 项保留历史并关联到该主问题。</Typography.Paragraph>
        <Space wrap>{selectedKeys.map((key) => <Tag key={key}>{key}</Tag>)}</Space>
      </Modal>
    </section>
  )
}
