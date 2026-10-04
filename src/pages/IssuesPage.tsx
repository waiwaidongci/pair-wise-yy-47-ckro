import { useMemo, useState } from 'react'
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
import { FilterOutlined, MergeCellsOutlined, SaveOutlined, TeamOutlined } from '@ant-design/icons'
import { useQueryClient } from '@tanstack/react-query'
import dayjs from 'dayjs'
import { useIssues } from '../api/useIssues'
import { adjustIssue, simulateConcurrentEdit, submitAssignmentBatch } from '../api/batches'
import { generateBatchNo, summarizeBatch } from '../api/batchUtils'
import { useWorkspaceStore } from '../store/useWorkspaceStore'
import BatchCenter, { BatchItemsTable } from '../components/BatchCenter'
import type { Issue, TrackedBatch } from '../api/types'

const impactColor: Record<string, string> = { 致命: 'red', 严重: 'volcano', 中等: 'gold', 轻微: 'blue' }
const statusColor: Record<string, string> = { 待分配: 'default', 修复中: 'processing', 待复测: 'orange', 已通过: 'success', 已退回: 'error', 不适用: 'default' }

export default function IssuesPage() {
  useIssues()
  const queryClient = useQueryClient()
  const issues = useWorkspaceStore((state) => state.issues)
  const selectedKeys = useWorkspaceStore((state) => state.selectedKeys)
  const setSelectedKeys = useWorkspaceStore((state) => state.setSelectedKeys)
  const savedFilters = useWorkspaceStore((state) => state.savedFilters)
  const saveFilter = useWorkspaceStore((state) => state.saveFilter)
  const removeFilter = useWorkspaceStore((state) => state.removeFilter)
  const mergeIssues = useWorkspaceStore((state) => state.mergeIssues)
  const setIssues = useWorkspaceStore((state) => state.setIssues)
  const updateIssue = useWorkspaceStore((state) => state.updateIssue)
  const createBatch = useWorkspaceStore((state) => state.createBatch)
  const applyBatchResult = useWorkspaceStore((state) => state.applyBatchResult)
  const markBatchFailed = useWorkspaceStore((state) => state.markBatchFailed)
  const [filters, setFilters] = useState({ query: '', site: '', status: '', priority: '' })
  const [detail, setDetail] = useState<Issue | null>(null)
  const [assignOpen, setAssignOpen] = useState(false)
  const [assignTargets, setAssignTargets] = useState<Issue[]>([])
  const [mergeOpen, setMergeOpen] = useState(false)
  const [adjustOpen, setAdjustOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [resultBatchNo, setResultBatchNo] = useState('')
  const resultBatch = useWorkspaceStore((state) => state.batches.find((batch) => batch.batchNo === resultBatchNo))
  const [form] = Form.useForm()
  const [adjustForm] = Form.useForm()

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
      width: 290,
      render: (_, record) => (
        <div><Typography.Text strong>{record.key}</Typography.Text><div>{record.title}</div><Typography.Text type="secondary" style={{ fontSize: 11 }}>{record.wcag.join(' / ')}</Typography.Text></div>
      ),
    },
    { title: '站点 / 版本', dataIndex: 'site', width: 130, render: (_, record) => <div>{record.site}<br /><Typography.Text type="secondary">{record.version}</Typography.Text></div> },
    { title: '影响', dataIndex: 'impact', width: 86, render: (value) => <Tag color={impactColor[value]}>{value}</Tag> },
    { title: '根因', dataIndex: 'rootCause', width: 220, render: (value) => <span className="root-cause" title={value}>{value}</span> },
    { title: '优先级', dataIndex: 'priority', width: 76, render: (value) => <Tag>{value}</Tag> },
    { title: '团队 / 负责人', dataIndex: 'team', width: 160, render: (_, record) => <div>{record.team}<br /><Typography.Text type="secondary">{record.owner}</Typography.Text></div> },
    { title: '状态', dataIndex: 'status', width: 95, render: (value) => <Tag color={statusColor[value]}>{value}</Tag> },
    { title: '数据版本', dataIndex: 'versionNo', width: 90, render: (value, record) => <div>v{value}<br /><Typography.Text type="secondary" style={{ fontSize: 11 }}>{record.updatedBy}</Typography.Text></div> },
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

  const openAssign = () => {
    // 打开时快照所选问题及其版本号，提交时带上负责人看到的版本
    setAssignTargets(issues.filter((issue) => selectedKeys.includes(issue.key)))
    setAssignOpen(true)
  }

  const submitBatch = async (values: { team: string; owner: string; priority: Issue['priority']; dueDate: dayjs.Dayjs }) => {
    const now = new Date().toISOString()
    const batch: TrackedBatch = {
      batchNo: generateBatchNo(),
      createdAt: now,
      updatedAt: now,
      attempt: 1,
      payload: { team: values.team, owner: values.owner, priority: values.priority, dueDate: values.dueDate.format('YYYY-MM-DD') },
      items: assignTargets.map((issue) => ({ key: issue.key, expectedVersion: issue.versionNo, status: 'pending' as const })),
    }
    createBatch(batch)
    setSubmitting(true)
    try {
      const { batch: serverBatch, issues: serverIssues } = await submitAssignmentBatch(batch)
      applyBatchResult(serverBatch, serverIssues)
      queryClient.setQueryData(['issues'], serverIssues)
    } catch {
      markBatchFailed(batch.batchNo, '网络中断：失败条目已留在原批次，恢复网络后按原批次号继续')
    } finally {
      setSubmitting(false)
      setAssignOpen(false)
      setSelectedKeys([])
      setResultBatchNo(batch.batchNo)
    }
  }

  const simulateConcurrent = async () => {
    const keys = assignTargets.slice(0, 2).map((issue) => issue.key)
    if (!keys.length) return
    const { issues: serverIssues } = await simulateConcurrentEdit(keys)
    setIssues(serverIssues)
    queryClient.setQueryData(['issues'], serverIssues)
    message.info(`已模拟他人保存对 ${keys.join('、')} 的修改：提交本批次时这些条目会因版本冲突被跳过`)
  }

  const submitAdjust = async (values: { owner: string; priority: Issue['priority'] }) => {
    if (!detail) return
    try {
      const { issue, unchanged } = await adjustIssue(detail.key, { owner: values.owner, priority: values.priority, expectedVersion: detail.versionNo })
      updateIssue(issue)
      queryClient.setQueryData(['issues'], useWorkspaceStore.getState().issues)
      setDetail(issue)
      setAdjustOpen(false)
      message.success(unchanged ? '与当前指派一致，未重复写入历史' : '已调整，相关批次结论随之失效并重算')
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 409) {
        const body = error.response.data as { message: string; issue: Issue }
        updateIssue(body.issue)
        setDetail(body.issue)
        setAdjustOpen(false)
        Modal.warning({ title: '保存冲突', content: body.message })
      } else {
        message.error('网络异常，本次调整未保存')
      }
    }
  }

  const resultSummary = resultBatch ? summarizeBatch(resultBatch, issues) : null
  const resultConflicts = resultBatch?.items.filter((item) => item.status === 'conflict') ?? []

  return (
    <section className="page">
      <div className="page-head">
        <div>
          <p className="eyebrow">ISSUE LEDGER / 问题台账</p>
          <h1>问题流转与批量处理</h1>
          <p className="muted">筛选条件可复用；选择多条问题后可合并同根因项或批量指派。</p>
        </div>
        <Space>
          <Button icon={<MergeCellsOutlined />} disabled={selectedKeys.length < 2} onClick={() => setMergeOpen(true)}>合并重复问题</Button>
          <Button type="primary" icon={<TeamOutlined />} disabled={!selectedKeys.length} onClick={openAssign}>批量分配</Button>
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

      <BatchCenter />

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
            scroll={{ x: 1340 }}
          />
        </div>
      </div>

      <Drawer title={detail ? `${detail.key} · ${detail.title}` : ''} open={Boolean(detail)} onClose={() => setDetail(null)} width={560}>
        {detail && (
          <Space direction="vertical" size={18} style={{ width: '100%' }}>
            <Space wrap><Tag color={impactColor[detail.impact]}>{detail.impact}</Tag><Tag>{detail.priority}</Tag><Tag color={statusColor[detail.status]}>{detail.status}</Tag></Space>
            <dl className="detail-list">
              <dt>站点版本</dt><dd>{detail.site} / {detail.version}</dd>
              <dt>数据版本</dt><dd>v{detail.versionNo} · 最近由 {detail.updatedBy} 修改{detail.lastBatchNo ? ` · 最近批次 ${detail.lastBatchNo}` : ''}</dd>
              <dt>WCAG</dt><dd>{detail.wcag.join('、')}</dd>
              <dt>影响范围</dt><dd>{detail.affected}</dd>
              <dt>复现条件</dt><dd>{detail.reproduction}</dd>
              <dt>证据链接</dt><dd><Typography.Link href={detail.evidence} target="_blank">{detail.evidence}</Typography.Link></dd>
              <dt>根因</dt><dd>{detail.rootCause}</dd>
              <dt>关联重复</dt><dd>{detail.mergedKeys.length ? detail.mergedKeys.join('、') : '无'}</dd>
              <dt>修复说明</dt><dd>{detail.fixNote ?? '开发尚未提交'}</dd>
              <dt>复测环境</dt><dd>{detail.retestEnv ?? '待开发提交'}</dd>
            </dl>
            <Button onClick={() => { adjustForm.setFieldsValue({ owner: detail.owner, priority: detail.priority }); setAdjustOpen(true) }}>调整负责人 / 优先级</Button>
            <div>
              <Typography.Title level={5}>操作历史</Typography.Title>
              {detail.history.map((event, index) => <div className="timeline-item" key={index}><Typography.Text strong>{event.action}</Typography.Text><div>{event.detail}</div><Typography.Text type="secondary" style={{ fontSize: 11 }}>{event.actor} · {event.at}</Typography.Text></div>)}
            </div>
          </Space>
        )}
      </Drawer>

      <Modal title="批量分配整改项" open={assignOpen} onCancel={() => setAssignOpen(false)} onOk={() => form.submit()} okText="确认分配" confirmLoading={submitting}>
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 14 }}
          message={`将创建可恢复的整改批次，共 ${assignTargets.length} 条`}
          description={
            <>
              <div>每条问题会带上你当前看到的版本号提交；已被他人修改的条目将跳过并列出，其余条目继续生效。</div>
              <div style={{ marginTop: 6 }}>{assignTargets.map((issue) => <Tag key={issue.key}>{issue.key} · v{issue.versionNo}</Tag>)}</div>
            </>
          }
        />
        <Form form={form} layout="vertical" onFinish={submitBatch}>
          <Form.Item name="team" label="目标团队" rules={[{ required: true }]}><Select options={['前端基础组件组', '结算体验组', '数据可视化组', '供应链前端组'].map((value) => ({ value }))} /></Form.Item>
          <Form.Item name="owner" label="负责人" rules={[{ required: true }]}><Input placeholder="输入负责人姓名" /></Form.Item>
          <Space style={{ display: 'flex' }}>
            <Form.Item name="priority" label="优先级" rules={[{ required: true }]}><Select style={{ width: 140 }} options={['P0', 'P1', 'P2', 'P3'].map((value) => ({ value }))} /></Form.Item>
            <Form.Item name="dueDate" label="截止日期" rules={[{ required: true }]} initialValue={dayjs('2026-10-10')}><DatePicker /></Form.Item>
          </Space>
        </Form>
        <Button type="link" size="small" style={{ padding: 0 }} onClick={simulateConcurrent}>演示：模拟他人抢先修改前 2 条，再提交查看冲突</Button>
      </Modal>

      <Modal
        title={resultBatch ? `批次 ${resultBatch.batchNo} 提交结果` : ''}
        open={Boolean(resultBatch)}
        onCancel={() => setResultBatchNo('')}
        footer={<Button type="primary" onClick={() => setResultBatchNo('')}>知道了</Button>}
        width={780}
      >
        {resultBatch && resultSummary && (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            {resultBatch.lastError && (
              <Alert type="warning" showIcon message="网络中断，批次未完整提交" description={`失败条目已保留在原批次 ${resultBatch.batchNo}，网络恢复后在「整改批次」面板点击「按原批次号继续」即可，已生效条目不会重复写入历史。`} />
            )}
            <Space wrap>
              <Tag color="success">已生效 {resultSummary.counts.applied}</Tag>
              <Tag>无变化 {resultSummary.counts.unchanged}（未重复写历史）</Tag>
              <Tag color="error">冲突跳过 {resultSummary.counts.conflict}</Tag>
              <Tag color="warning">待恢复 {resultSummary.counts.pending}</Tag>
            </Space>
            {resultConflicts.length > 0 && (
              <Alert
                type="error"
                showIcon
                message={`${resultConflicts.length} 条已被他人修改，已跳过未生效`}
                description={<ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>{resultConflicts.map((item) => <li key={item.key}><Typography.Text strong>{item.key}</Typography.Text>：{item.message}</li>)}</ul>}
              />
            )}
            <BatchItemsTable batch={resultBatch} />
          </Space>
        )}
      </Modal>

      <Modal title={`调整负责人 / 优先级${detail ? `（${detail.key} · 基于版本 v${detail.versionNo}）` : ''}`} open={adjustOpen} onCancel={() => setAdjustOpen(false)} onOk={() => adjustForm.submit()} okText="保存">
        <Form form={adjustForm} layout="vertical" onFinish={submitAdjust}>
          <Form.Item name="owner" label="负责人" rules={[{ required: true }]}><Input placeholder="输入负责人姓名" /></Form.Item>
          <Form.Item name="priority" label="优先级" rules={[{ required: true }]}><Select options={['P0', 'P1', 'P2', 'P3'].map((value) => ({ value }))} /></Form.Item>
        </Form>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>保存后，覆盖该问题的旧批次结论会失效并按最新台账重算；若保存前已被他人修改，将提示版本冲突。</Typography.Text>
      </Modal>

      <Modal title="合并为同一整改项" open={mergeOpen} onCancel={() => setMergeOpen(false)} onOk={() => { mergeIssues(selectedKeys); setMergeOpen(false); message.success('问题已按根因合并，子项仍可追溯') }} okText="确认合并">
        <Typography.Paragraph>将以 <Typography.Text code>{selectedKeys[0]}</Typography.Text> 为主问题，其余 {selectedKeys.length - 1} 项保留历史并关联到该主问题。</Typography.Paragraph>
        <Space wrap>{selectedKeys.map((key) => <Tag key={key}>{key}</Tag>)}</Space>
      </Modal>
    </section>
  )
}
