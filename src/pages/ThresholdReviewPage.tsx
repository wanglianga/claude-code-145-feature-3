import React, { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Alert,
  Badge,
  Button,
  Card,
  Col,
  Descriptions,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Radio,
  Row,
  Space,
  Statistic,
  Table,
  Tag,
  Timeline,
  Typography,
  message,
} from 'antd'
import {
  AuditOutlined,
  CheckCircleOutlined,
  ClockCircleOutlined,
  EnvironmentOutlined,
  HeartOutlined,
  RollbackOutlined,
  UserOutlined,
  WarningOutlined,
} from '@ant-design/icons'
import { useStore } from '../store/useStore'
import { Elder, THRESHOLD_REVIEW_LABEL, ThresholdChange } from '../types'
import {
  NapFalseSummary,
  THRESHOLD_FIELD_LABEL,
  observeThresholdChange,
  summarizeNapFalseAlarms,
} from '../store/workflow'
import { fmtTime, fmtTimeFull } from '../components/common'

const { Text, Paragraph } = Typography

const OUTCOME_COLOR: Record<string, string> = {
  observing: 'gold',
  effective: 'green',
  missed_risk: 'red',
  reverted: 'default',
}

/** 单个老人的误报汇总卡 + 审批入口 */
const SummaryCard: React.FC<{ elder: Elder; summary: NapFalseSummary; onApprove: () => void }> = ({ elder, summary, onApprove }) => (
  <Card
    size="small"
    style={{ marginBottom: 12 }}
    title={
      <Space wrap>
        <AuditOutlined />
        {elder.name} · 午睡静止误报汇总
        <Tag color="volcano">近{summary.spanDays}天 {summary.confirmCount} 次家属确认误报</Tag>
        {summary.napWindow && <Tag color="blue">午睡 {summary.napWindow.start}-{summary.napWindow.end}</Tag>}
      </Space>
    }
    extra={
      <Button type="primary" size="small" onClick={onApprove}>
        发起阈值调整审批
      </Button>
    }
  >
    <Row gutter={12}>
      <Col xs={24} md={6}>
        <Statistic title="家属确认误报" value={summary.confirmCount} suffix="次" valueStyle={{ fontSize: 18, color: '#cf1322' }} />
        <Text type="secondary" style={{ fontSize: 12 }}>
          平均 {summary.avgResponseMinutes ?? '—'} 分钟确认
        </Text>
      </Col>
      <Col xs={24} md={6}>
        <Card size="small" type="inner" title={<><HeartOutlined /> 午睡心率</>} styles={{ body: { padding: 8 } }}>
          {summary.hrRange ? (
            <Space direction="vertical" size={0}>
              <Text strong>{summary.hrRange[0]}-{summary.hrRange[1]} bpm</Text>
              <Text type="secondary" style={{ fontSize: 12 }}>静息心率平稳，无心率异常</Text>
              {summary.napHrSamples.slice(0, 3).map((s, i) => (
                <Text key={i} type="secondary" style={{ fontSize: 11 }}>
                  {fmtTime(s.at)} · {s.bpm}bpm
                </Text>
              ))}
            </Space>
          ) : (
            <Text type="secondary">无采样</Text>
          )}
        </Card>
      </Col>
      <Col xs={24} md={6}>
        <Card size="small" type="inner" title={<><EnvironmentOutlined /> 告警前后活动轨迹</>} styles={{ body: { padding: 8 } }}>
          <Timeline
            items={summary.trajectoryAround.map((t) => ({
              children: (
                <Text style={{ fontSize: 12 }}>
                  {fmtTime(t.at)} {t.place}
                </Text>
              ),
            }))}
          />
        </Card>
      </Col>
      <Col xs={24} md={6}>
        <Card size="small" type="inner" title="当前阈值" styles={{ body: { padding: 8 } }}>
          <Text style={{ fontSize: 12 }}>
            静止 {elder.thresholds.stillnessMinutes} 分钟
            <br />
            心率 {elder.thresholds.heartRateLow}-{elder.thresholds.heartRateHigh}bpm
            <br />
            午睡时段：{elder.thresholds.napStart ? `${elder.thresholds.napStart}-${elder.thresholds.napEnd}` : '未设置延后'}
          </Text>
        </Card>
      </Col>
    </Row>

    <Alert
      style={{ marginTop: 12 }}
      type="info"
      showIcon
      message="系统汇总的调整建议（供医生/社区审批参考）"
      description={summary.suggestion}
    />

    <Text strong style={{ display: 'block', margin: '12px 0 6px', fontSize: 13 }}>
      家属确认记录（{summary.events.length}）
    </Text>
    <Table
      size="small"
      rowKey="id"
      pagination={false}
      dataSource={summary.events}
      columns={[
        { title: '事件', dataIndex: 'id', width: 90, render: (v) => <Text code>{v}</Text> },
        { title: '告警时间', render: (_, e) => fmtTime(e.occurredAt), width: 110 },
        { title: '位置', dataIndex: 'location', width: 90 },
        {
          title: '家属确认',
          render: (_, e) => (
            <Space direction="vertical" size={0}>
              <Text style={{ fontSize: 12 }}>
                {e.family.contactName} · {e.closure?.familyResponseMinutes ?? '—'}分钟确认
              </Text>
              <Text type="secondary" style={{ fontSize: 11 }}>
                {e.family.note}
              </Text>
            </Space>
          ),
        },
        { title: '误报原因', render: (_, e) => e.closure?.falseReason, width: 180 },
      ]}
    />
  </Card>
)

/** 一条阈值变更记录：审批信息 + 调整后持续观察 */
const ChangeCard: React.FC<{ change: ThresholdChange; elder: Elder; onConclude: (outcome: 'effective' | 'reverted') => void }> = ({
  change,
  elder,
  onConclude,
}) => {
  const events = useStore((s) => s.events)
  const now = useStore((s) => s.now())
  const nav = useNavigate()
  const obs = observeThresholdChange(change, events, now)
  const missed = change.missedRiskEventIds.map((id) => events.find((e) => e.id === id)).filter(Boolean)
  const falses = change.falseAlarmEventIds.map((id) => events.find((e) => e.id === id)).filter(Boolean)
  const evidence = change.evidenceEventIds.map((id) => events.find((e) => e.id === id)).filter(Boolean)
  const totalDays = Math.max(1, Math.round((change.reviewUntil - change.createdAt) / 86400000))
  const elapsed = Math.min(totalDays, Math.max(0, Math.round((now - change.createdAt) / 86400000)))

  return (
    <Card
      size="small"
      style={{ marginBottom: 12 }}
      title={
        <Space wrap>
          <Tag color="blue">{change.id}</Tag>
          <Text strong>{elder.name}</Text>
          <Tag color={OUTCOME_COLOR[change.outcome]}>{THRESHOLD_REVIEW_LABEL[change.outcome]}</Tag>
          {change.status === 'active' ? (
            <Badge status="processing" text={<Text type="secondary" style={{ fontSize: 12 }}>观察期 {elapsed}/{totalDays} 天（至 {fmtTime(change.reviewUntil)}）</Text>} />
          ) : (
            <Text type="secondary" style={{ fontSize: 12 }}>
              已于 {fmtTime(change.reviewedAt!)} 由 {change.reviewedBy} 完成观察评估
            </Text>
          )}
        </Space>
      }
    >
      <Descriptions column={2} size="small" bordered>
        <Descriptions.Item label="审批人">
          <UserOutlined /> {change.approverRole} · {change.approvedBy}
        </Descriptions.Item>
        <Descriptions.Item label="审批时间">{fmtTimeFull(change.createdAt)}</Descriptions.Item>
        <Descriptions.Item label="调整原因" span={2}>
          {change.reason}
        </Descriptions.Item>
        <Descriptions.Item label="审批意见" span={2}>
          {change.advice}
        </Descriptions.Item>
        <Descriptions.Item label="调整内容" span={2}>
          <Space wrap>
            {change.changes.map((c) => (
              <Tag key={c.key} color="orange">
                {c.label}：{c.before} → {c.after}
              </Tag>
            ))}
          </Space>
        </Descriptions.Item>
        <Descriptions.Item label="汇总依据" span={2}>
          <Space direction="vertical" size={2}>
            <Text type="secondary" style={{ fontSize: 12 }}>{change.evidenceSummary}</Text>
            <Space wrap size={4}>
              {evidence.map((e) => (
                <Tag
                  key={e!.id}
                  color="volcano"
                  style={{ cursor: 'pointer' }}
                  onClick={() => nav(`/events/${e!.id}`)}
                >
                  {e!.id} 午睡误报 · {fmtTime(e!.occurredAt)}
                </Tag>
              ))}
            </Space>
          </Space>
        </Descriptions.Item>
      </Descriptions>

      {change.status === 'active' && (
        <Alert
          style={{ marginTop: 12 }}
          type={missed.length > 0 ? 'error' : 'info'}
          showIcon
          icon={missed.length > 0 ? <WarningOutlined /> : <ClockCircleOutlined />}
          message={missed.length > 0 ? `观察期内发现 ${missed.length} 起真实风险事件，请立即回看本次调整` : obs.note}
          description={
            missed.length > 0 ? (
              <Space direction="vertical" size={2}>
                <Text style={{ fontSize: 12 }}>
                  社区可依据本记录回看：{fmtTime(change.createdAt)} 经 {change.approverRole}{change.approvedBy} 审批，
                  因「{change.reason}」降低/延后了告警。请核查真实风险是否被延迟或遗漏，并决定回退阈值。
                </Text>
                {missed.map((e) => (
                  <Tag key={e!.id} color="red" style={{ cursor: 'pointer' }} onClick={() => nav(`/events/${e!.id}`)}>
                    {e!.id} · {fmtTime(e!.occurredAt)} · {e!.location} 查看事件 →
                  </Tag>
                ))}
              </Space>
            ) : (
              <Space direction="vertical" size={2}>
                <Text style={{ fontSize: 12 }}>
                  调整后午睡静止误报 {falses.length} 起；真实风险 0 起遗漏。
                </Text>
                {falses.map((e) => (
                  <Tag key={e!.id} style={{ cursor: 'pointer' }} onClick={() => nav(`/events/${e!.id}`)}>
                    {e!.id} · {fmtTime(e!.occurredAt)}
                  </Tag>
                ))}
              </Space>
            )
          }
        />
      )}

      {change.status === 'reviewed' && (
        <Alert
          style={{ marginTop: 12 }}
          type={change.outcome === 'reverted' || change.outcome === 'missed_risk' ? 'warning' : 'success'}
          showIcon
          message={`观察评估结论：${THRESHOLD_REVIEW_LABEL[change.outcome]}`}
          description={
            <Space direction="vertical" size={2}>
              <Text style={{ fontSize: 12 }}>{change.reviewNote}</Text>
              {change.outcome === 'reverted' && <Text type="secondary" style={{ fontSize: 12 }}>阈值已恢复为调整前：{Object.entries(change.before).filter(([k]) => k in THRESHOLD_FIELD_LABEL).map(([k, v]) => `${THRESHOLD_FIELD_LABEL[k as keyof typeof THRESHOLD_FIELD_LABEL]} ${v}`).join(' · ')}</Text>}
              {(missed.length > 0 || falses.length > 0) && (
                <Space wrap size={4}>
                  {missed.map((e) => (
                    <Tag key={e!.id} color="red" style={{ cursor: 'pointer' }} onClick={() => nav(`/events/${e!.id}`)}>{e!.id} 真实风险</Tag>
                  ))}
                  {falses.map((e) => (
                    <Tag key={e!.id} style={{ cursor: 'pointer' }} onClick={() => nav(`/events/${e!.id}`)}>{e!.id} 误报</Tag>
                  ))}
                </Space>
              )}
            </Space>
          }
        />
      )}

      {change.status === 'active' && (
        <Space wrap style={{ marginTop: 12 }}>
          <Button type="primary" ghost icon={<CheckCircleOutlined />} onClick={() => onConclude('effective')}>
            观察期满：确认有效（误报下降、无漏报）
          </Button>
          <Button danger icon={<RollbackOutlined />} onClick={() => onConclude('reverted')}>
            回退阈值并结束观察
          </Button>
        </Space>
      )}
    </Card>
  )
}

/** 误报分析与阈值审批：午睡误报汇总 → 医生/社区审批（保留审批人/原因）→ 调整后持续观察 */
const ThresholdReviewPage: React.FC = () => {
  const elders = useStore((s) => s.elders)
  const events = useStore((s) => s.events)
  const changes = useStore((s) => s.thresholdChanges)
  const nowFn = useStore((s) => s.now)
  const approveThresholdChange = useStore((s) => s.approveThresholdChange)
  const concludeThresholdChange = useStore((s) => s.concludeThresholdChange)
  const [approving, setApproving] = useState<{ elder: Elder; summary: NapFalseSummary } | null>(null)
  const [form] = Form.useForm()
  const [concluding, setConcluding] = useState<{ change: ThresholdChange; outcome: 'effective' | 'reverted' } | null>(null)
  const [concludeNote, setConcludeNote] = useState('')

  const summaries = useMemo(
    () =>
      elders
        .map((e) => ({ elder: e, summary: summarizeNapFalseAlarms(e, events, nowFn()) }))
        .filter((x): x is { elder: Elder; summary: NapFalseSummary } => !!x.summary),
    [elders, events, nowFn],
  )

  const changesSorted = [...changes].sort((a, b) => b.createdAt - a.createdAt)

  const openApprove = (elder: Elder, summary: NapFalseSummary) => {
    setApproving({ elder, summary })
    form.setFieldsValue({
      stillnessMinutes: elder.thresholds.stillnessMinutes + 30,
      napStart: summary.napWindow?.start ?? '13:00',
      napEnd: summary.napWindow?.end ?? '14:30',
      approverRole: '社区医生',
      approvedBy: '陈医生',
      reason: `近${summary.spanDays}天午睡时段连续${summary.confirmCount}次长时间静止告警，家属均确认误报；午睡静息心率${summary.hrRange ? summary.hrRange[0] + '-' + summary.hrRange[1] + 'bpm' : '平稳'}，活动轨迹无异常，判断为午睡熟睡误报。`,
      advice: summary.suggestion,
      reviewDays: 14,
    })
  }

  return (
    <div>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="误报阈值调整闭环：午睡静止告警被家属多次确认误报后，系统汇总午睡时段、静息心率、活动轨迹与确认记录，建议医生或社区调整阈值；调整必须保留审批人与调整原因，并进入观察期持续跟踪误报是否下降、真实风险是否被遗漏。后续出现真实异常时，可凭变更记录回看当时为何降低或延后告警。"
      />

      {summaries.length === 0 && changes.length === 0 && (
        <Card>
          <Empty description="暂无需调整阈值的午睡误报汇总。家属多次确认午睡静止误报并结案后，将在此自动汇总。" />
        </Card>
      )}

      {summaries.map(({ elder, summary }) => (
        <SummaryCard key={elder.id} elder={elder} summary={summary} onApprove={() => openApprove(elder, summary)} />
      ))}

      {changesSorted.length > 0 && (
        <>
          <Paragraph strong style={{ marginTop: 8 }}>
            阈值变更记录与观察跟踪（保留给后续照护评估）
          </Paragraph>
          {changesSorted.map((c) => (
            <ChangeCard
              key={c.id}
              change={c}
              elder={elders.find((e) => e.id === c.elderId)!}
              onConclude={(outcome) => {
                setConcluding({ change: c, outcome })
                setConcludeNote(
                  outcome === 'effective'
                    ? '观察期内午睡静止误报未再发生，未发现真实风险遗漏，确认调整有效，纳入长期阈值。'
                    : '观察期内发现告警延迟/真实风险信号，回退至调整前阈值并重新评估。',
                )
              }}
            />
          ))}
        </>
      )}

      <Modal
        title={approving ? `阈值调整审批：${approving.elder.name}` : ''}
        open={!!approving}
        width={620}
        onCancel={() => setApproving(null)}
        onOk={() =>
          form.validateFields().then((v) => {
            if (!approving) return
            const after = {
              ...approving.elder.thresholds,
              stillnessMinutes: v.stillnessMinutes,
              napStart: v.napStart,
              napEnd: v.napEnd,
            }
            const rec = approveThresholdChange(approving.elder.id, {
              after,
              approvedBy: v.approvedBy,
              approverRole: v.approverRole,
              reason: v.reason,
              advice: v.advice,
              reviewDays: v.reviewDays,
              evidenceEventIds: approving.summary.events.map((e) => e.id),
              evidenceSummary: approving.summary.evidenceSummary,
            })
            if (rec) {
              message.success(`阈值调整已审批生效（${rec.id}），进入 ${v.reviewDays} 天观察期`)
              setApproving(null)
            } else {
              message.warning('阈值未发生变化，无需审批')
            }
          })
        }
      >
        {approving && (
          <Form form={form} layout="vertical">
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 12 }}
              message="阈值调整将降低/延后告警，必须由医生或社区审批并留存原因，观察期内出现真实风险可随时回看与回退。"
            />
            <Row gutter={12}>
              <Col span={12}>
                <Form.Item name="stillnessMinutes" label="午睡时段静止阈值（分钟）" rules={[{ required: true }]}>
                  <InputNumber min={30} max={240} style={{ width: '100%' }} />
                </Form.Item>
              </Col>
              <Col span={6}>
                <Form.Item name="napStart" label="午睡开始" rules={[{ required: true, pattern: /^\d{2}:\d{2}$/, message: 'HH:mm' }]}>
                  <Input placeholder="13:00" />
                </Form.Item>
              </Col>
              <Col span={6}>
                <Form.Item name="napEnd" label="午睡结束" rules={[{ required: true, pattern: /^\d{2}:\d{2}$/, message: 'HH:mm' }]}>
                  <Input placeholder="14:30" />
                </Form.Item>
              </Col>
            </Row>
            <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: -8, marginBottom: 12 }}>
              午睡时段内静止告警延后至午睡结束，期间心率越限或无心率数据仍立即告警；心率阈值 {approving.elder.thresholds.heartRateLow}-
              {approving.elder.thresholds.heartRateHigh}bpm 保持不变作为安全兜底。
            </Text>
            <Row gutter={12}>
              <Col span={12}>
                <Form.Item name="approverRole" label="审批人身份" rules={[{ required: true }]}>
                  <Radio.Group
                    options={[
                      { value: '社区医生', label: '社区医生' },
                      { value: '社区值班员', label: '社区值班员' },
                    ]}
                  />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item name="approvedBy" label="审批人姓名" rules={[{ required: true, message: '请填写审批人' }]}>
                  <Input placeholder="如：陈医生" />
                </Form.Item>
              </Col>
            </Row>
            <Form.Item name="reason" label="调整原因（留存备查）" rules={[{ required: true, message: '请填写调整原因' }]}>
              <Input.TextArea rows={3} />
            </Form.Item>
            <Form.Item name="advice" label="审批意见" rules={[{ required: true, message: '请填写审批意见' }]}>
              <Input.TextArea rows={2} />
            </Form.Item>
            <Form.Item name="reviewDays" label="观察期（天）" rules={[{ required: true }]}>
              <InputNumber min={7} max={90} style={{ width: '100%' }} />
            </Form.Item>
          </Form>
        )}
      </Modal>

      <Modal
        title={concluding ? `${concluding.outcome === 'effective' ? '确认调整有效' : '回退阈值'}：${concluding.change.id}` : ''}
        open={!!concluding}
        onCancel={() => setConcluding(null)}
        onOk={() => {
          if (concluding) {
            concludeThresholdChange(concluding.change.id, concluding.outcome, concludeNote || '观察期结束评估')
            message.success(concluding.outcome === 'effective' ? '已确认调整有效，记录归档' : '已回退至调整前阈值，记录归档')
            setConcluding(null)
          }
        }}
      >
        {concluding?.outcome === 'reverted' && (
          <Alert type="warning" showIcon style={{ marginBottom: 12 }} message="回退后老人阈值将恢复为调整前数值，变更记录仍完整保留。" />
        )}
        <Input.TextArea rows={3} value={concludeNote} onChange={(e) => setConcludeNote(e.target.value)} placeholder="观察评估说明（误报变化、真实风险情况）" />
      </Modal>
    </div>
  )
}

export default ThresholdReviewPage
