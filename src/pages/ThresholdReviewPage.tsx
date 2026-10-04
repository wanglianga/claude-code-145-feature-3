import React, { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  Alert,
  Button,
  Card,
  Col,
  Collapse,
  Descriptions,
  Form,
  Input,
  InputNumber,
  Modal,
  Progress,
  Row,
  Select,
  Space,
  Table,
  Tag,
  Timeline,
  Typography,
  message,
} from 'antd'
import {
  ClockCircleOutlined,
  EditOutlined,
  HeartOutlined,
  HistoryOutlined,
  HomeOutlined,
  RollbackOutlined,
  SafetyCertificateOutlined,
  ThunderboltOutlined,
  UserOutlined,
} from '@ant-design/icons'
import { useStore } from '../store/useStore'
import { ThresholdChangeRecord, Thresholds, THRESHOLD_FIELD_LABEL } from '../types'
import { fmtTime, fmtTimeFull } from '../components/common'
import {
  currentChange,
  describeChange,
  evaluateObservation,
  suggestNapThresholdChange,
  summarizeNapFalseAlarms,
} from '../store/workflow'

const { Text, Paragraph } = Typography

const STATUS_META: Record<ThresholdChangeRecord['status'], { color: string; label: string }> = {
  observing: { color: 'processing', label: '观察期中' },
  effective: { color: 'success', label: '持续生效' },
  reverted: { color: 'error', label: '已回退' },
}

/** 误报阈值调整：午睡误报汇总（时段/心率/轨迹/确认记录）→ 医生审批调整 → 观察期评估/回退 → 变更永久留痕 */
const ThresholdReviewPage: React.FC = () => {
  const elders = useStore((s) => s.elders)
  const events = useStore((s) => s.events)
  const changes = useStore((s) => s.thresholdChanges)
  const applyThresholdChange = useStore((s) => s.applyThresholdChange)
  const reviewThresholdChange = useStore((s) => s.reviewThresholdChange)
  const revertThresholdChange = useStore((s) => s.revertThresholdChange)
  const raiseAlert = useStore((s) => s.raiseAlert)
  const familyRespond = useStore((s) => s.familyRespond)
  const dispatchVisit = useStore((s) => s.dispatchVisit)
  const recordArrival = useStore((s) => s.recordArrival)
  const recordVisitResult = useStore((s) => s.recordVisitResult)
  const fastForward = useStore((s) => s.fastForward)
  const now = useStore((s) => s.now)
  const [params, setParams] = useSearchParams()

  const [elderId, setElderId] = useState<string>(params.get('elder') ?? 'e1')
  const elder = elders.find((e) => e.id === elderId) ?? elders[0]
  const [applyOpen, setApplyOpen] = useState(false)
  const [form] = Form.useForm()
  const [revertTarget, setRevertTarget] = useState<ThresholdChangeRecord | null>(null)
  const [revertReason, setRevertReason] = useState('')

  const elderChanges = useMemo(
    () => changes.filter((c) => c.elderId === elder.id).sort((a, b) => b.changedAt - a.changedAt),
    [changes, elder.id],
  )
  const summary = useMemo(() => summarizeNapFalseAlarms(elder, events), [elder, events])
  const suggestion = useMemo(() => suggestNapThresholdChange(elder, summary), [elder, summary])
  const active = currentChange(changes, elder.id, now())
  // 观察卡优先展示生效中/观察期记录；没有时展示最近一条（含已回退），便于查看回退结论
  const focus: ThresholdChangeRecord | null = active ?? elderChanges[0] ?? null
  const observation = focus ? evaluateObservation(focus, events, now()) : null
  const observeProgress = focus
    ? Math.min(100, Math.round(((now() - focus.changedAt) / (focus.observeUntil - focus.changedAt)) * 100))
    : 0

  const selectElder = (id: string) => {
    setElderId(id)
    setParams(id === 'e1' ? {} : { elder: id })
  }

  /** 快进到下一个午睡时段的指定分钟点 */
  const jumpToNap = (minuteInWindow: number) => {
    const napStart = elder.napWindow?.start ?? '13:00'
    const [h, m] = napStart.split(':').map(Number)
    const target = new Date(now())
    target.setHours(h, m, 0, 0)
    target.setMinutes(target.getMinutes() + minuteInWindow)
    let delta = Math.round((target.getTime() - now()) / 60000)
    if (delta <= 0) delta += 24 * 60
    fastForward(delta)
  }

  const openApply = (useSuggestion: boolean) => {
    const p = useSuggestion && suggestion
      ? { stillness: suggestion.stillnessMinutes, delay: suggestion.napDelayMinutes, reason: suggestion.basis }
      : { stillness: elder.thresholds.stillnessMinutes, delay: null, reason: '' }
    form.setFieldsValue({
      approver: '陈医生',
      approverRole: '社区医生',
      stillnessMinutes: p.stillness,
      napDelayMinutes: p.delay ?? 0,
      observeDays: 7,
      reason: p.reason,
      evidenceEventIds: summary?.events.map((e) => e.id) ?? [],
      heartRateLow: elder.thresholds.heartRateLow,
      heartRateHigh: elder.thresholds.heartRateHigh,
      geofenceRadius: elder.thresholds.geofenceRadius,
      curfewTime: elder.thresholds.curfewTime,
    })
    setApplyOpen(true)
  }

  const submitApply = () =>
    form.validateFields().then((v) => {
      const after: Partial<Thresholds> = { stillnessMinutes: v.stillnessMinutes }
      if (v.heartRateLow !== elder.thresholds.heartRateLow) after.heartRateLow = v.heartRateLow
      if (v.heartRateHigh !== elder.thresholds.heartRateHigh) after.heartRateHigh = v.heartRateHigh
      if (v.geofenceRadius !== elder.thresholds.geofenceRadius) after.geofenceRadius = v.geofenceRadius
      if (v.curfewTime !== elder.thresholds.curfewTime) after.curfewTime = v.curfewTime
      applyThresholdChange(elder.id, {
        approver: v.approver,
        approverRole: v.approverRole,
        reason: v.reason,
        after,
        napDelayMinutes: v.napDelayMinutes > 0 ? v.napDelayMinutes : null,
        observeDays: v.observeDays,
        evidenceEventIds: v.evidenceEventIds ?? [],
      })
      setApplyOpen(false)
      message.success('阈值调整已审批留痕并进入观察期，后续告警按新阈值判定')
    })

  /** 演示：观察期内午睡误报仍发生（家属确认） */
  const simFalseAlarm = () => {
    jumpToNap(10)
    raiseAlert(elder.id, 'stillness', '家-卧室')
    const ev = useStore.getState().events[0]
    familyRespond(ev.id, 'false_alarm', '老人午睡，确认误报')
    message.info('已模拟：观察期内午睡时段再发 1 起静止告警，家属确认误报')
  }

  /** 演示：观察期内午睡静止告alert实为真实异常（家属要求上门→现场需医疗） */
  const simMissedRisk = () => {
    jumpToNap(40)
    raiseAlert(elder.id, 'stillness', '家-卧室')
    const ev = useStore.getState().events[0]
    familyRespond(ev.id, 'request_visit', '午睡时间太久叫不醒，请马上上门')
    dispatchVisit(ev.id, '刘敏')
    recordArrival(ev.id)
    recordVisitResult(ev.id, 'need_medical', '老人呼之不应、意识模糊，需立即医疗处置')
    message.warning('已模拟：观察期内午睡静止告警实为真实异常（家属要求上门且现场需医疗）')
  }

  const evidenceEvents = events.filter((e) => e.elderId === elder.id && e.type === 'stillness')

  return (
    <div>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="误报阈值调整流程：系统汇总午睡时段、心率、活动轨迹与家属确认记录 → 医生或社区负责人审批（必须填写原因）→ 调整后进入观察期持续跟踪误报是否下降、有无漏报真实风险 → 变更记录永久保留，后续出现真实异常可回看当时为何降低或延后告警。"
      />

      <Card
        size="small"
        style={{ marginBottom: 12 }}
        title={
          <Space>
            <span>选择老人</span>
            <Select
              size="small"
              style={{ width: 260 }}
              value={elder.id}
              onChange={selectElder}
              options={elders.map((e) => ({
                value: e.id,
                label: `${e.name}（${e.address}）· 静止阈值${e.thresholds.stillnessMinutes}分钟`,
              }))}
            />
            {active && (
              <Tag color={STATUS_META[active.status].color}>
                当前策略：{STATUS_META[active.status].label} · {describeChange(active)}
              </Tag>
            )}
          </Space>
        }
      >
        <Descriptions column={{ xs: 1, md: 3 }} size="small">
          <Descriptions.Item label="当前静止阈值">{elder.thresholds.stillnessMinutes} 分钟</Descriptions.Item>
          <Descriptions.Item label="午睡时段">{elder.napWindow ? `${elder.napWindow.start}-${elder.napWindow.end}` : '未登记'}</Descriptions.Item>
          <Descriptions.Item label="历史误报">{elder.historyFalseAlarms} 次</Descriptions.Item>
        </Descriptions>
      </Card>

      <Row gutter={12}>
        {/* 左：午睡误报汇总 */}
        <Col xs={24} lg={12}>
          <Card
            size="small"
            title={
              <Space>
                <ClockCircleOutlined />
                午睡时段长时间静止误报汇总
              </Space>
            }
            style={{ marginBottom: 12 }}
          >
            {!summary ? (
              <Text type="secondary">该老人暂无午睡时段经家属确认的静止误报记录。</Text>
            ) : (
              <Space direction="vertical" style={{ width: '100%' }} size={8}>
                <Row gutter={8}>
                  <Col span={8}>
                    <Card size="small">
                      <Text type="secondary" style={{ fontSize: 12 }}>午睡时段</Text>
                      <div><Text strong>{summary.window.start}-{summary.window.end}</Text></div>
                    </Card>
                  </Col>
                  <Col span={8}>
                    <Card size="small">
                      <Text type="secondary" style={{ fontSize: 12 }}>午睡误报（家属确认）</Text>
                      <div><Text strong style={{ color: '#cf1322' }}>{summary.total} 起</Text></div>
                    </Card>
                  </Col>
                  <Col span={8}>
                    <Card size="small">
                      <Text type="secondary" style={{ fontSize: 12 }}>误报时刻</Text>
                      <div style={{ fontSize: 12 }}>{summary.times.join('、')}</div>
                    </Card>
                  </Col>
                </Row>

                <Card size="small" type="inner" title={<Space><HeartOutlined /> 午睡时段心率</Space>}>
                  {summary.heartRateStats ? (
                    <>
                      <Text>
                        {summary.heartRateStats.min}-{summary.heartRateStats.max} bpm，均值 {summary.heartRateStats.avg} bpm；
                        {summary.heartRateStats.stable ? (
                          <Tag color="green" style={{ marginLeft: 6 }}>波动平稳，符合睡眠特征</Tag>
                        ) : (
                          <Tag color="orange" style={{ marginLeft: 6 }}>波动偏大</Tag>
                        )}
                      </Text>
                    </>
                  ) : (
                    <Text type="secondary">午睡时段暂无连续心率采样。</Text>
                  )}
                </Card>

                <Card size="small" type="inner" title={<Space><HomeOutlined /> 活动轨迹与告警位置</Space>}>
                  <Space wrap style={{ marginBottom: 6 }}>
                    {summary.places.map((p) => (
                      <Tag key={p}>{p}</Tag>
                    ))}
                  </Space>
                  <Timeline
                    items={elder.trajectory.map((t) => ({
                      children: <Text style={{ fontSize: 12 }}>{fmtTime(t.at)} {t.place}</Text>,
                    }))}
                  />
                </Card>

                <Card size="small" type="inner" title="家属确认记录">
                  <Table
                    size="small"
                    rowKey="id"
                    pagination={false}
                    dataSource={summary.events}
                    columns={[
                      { title: '事件', dataIndex: 'id', width: 90 },
                      { title: '时间', render: (_, e) => fmtTime(e.occurredAt), width: 100 },
                      { title: '确认人', render: (_, e) => `${e.family.contactName}`, width: 70 },
                      { title: '家属留言', render: (_, e) => <Text style={{ fontSize: 12 }}>{e.family.note}</Text> },
                    ]}
                  />
                </Card>
              </Space>
            )}
          </Card>
        </Col>

        {/* 右：系统建议 + 观察期 */}
        <Col xs={24} lg={12}>
          {suggestion && (
            <Card
              size="small"
              title={<Space><ThunderboltOutlined /> 系统调整建议（供医生/社区审批参考）</Space>}
              style={{ marginBottom: 12 }}
            >
              <Paragraph style={{ fontSize: 13, marginBottom: 8 }}>{suggestion.basis}</Paragraph>
              <Space wrap>
                <Button type="primary" icon={<SafetyCertificateOutlined />} onClick={() => openApply(true)} disabled={active?.status === 'observing'}>
                  按建议发起阈值调整审批
                </Button>
                <Button icon={<EditOutlined />} onClick={() => openApply(false)} disabled={active?.status === 'observing'}>
                  自定义调整
                </Button>
                {active?.status === 'observing' && <Text type="warning">当前有观察期中的调整，需先完成观察评估或回退</Text>}
              </Space>
            </Card>
          )}
          {!suggestion && (
            <Card size="small" title="阈值调整" style={{ marginBottom: 12 }}>
              <Text type="secondary">午睡误报样本不足 2 起，暂无系统建议。如医生评估后仍需调整，可自定义发起审批。</Text>
              <div style={{ marginTop: 8 }}>
                <Button icon={<EditOutlined />} onClick={() => openApply(false)} disabled={active?.status === 'observing'}>
                  发起阈值调整审批
                </Button>
              </div>
            </Card>
          )}

          {focus && (
            <Card
              size="small"
              title={
                <Space>
                  <SafetyCertificateOutlined />
                  {focus.status === 'observing' ? '观察期跟踪' : '最近一次阈值调整结论'}：{focus.id}
                  <Tag color={STATUS_META[focus.status].color}>{STATUS_META[focus.status].label}</Tag>
                </Space>
              }
              style={{ marginBottom: 12 }}
            >
              {focus.status === 'observing' && (
                <>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    观察期 {fmtTime(focus.changedAt)} 至 {fmtTime(focus.observeUntil)}
                  </Text>
                  <Progress percent={observeProgress} size="small" status={now() >= focus.observeUntil ? 'exception' : 'active'} />
                </>
              )}
              <Descriptions column={1} size="small" bordered>
                <Descriptions.Item label="调整内容">{describeChange(focus)}</Descriptions.Item>
                <Descriptions.Item label="审批人">{focus.approver}（{focus.approverRole}）</Descriptions.Item>
                <Descriptions.Item label="调整原因">{focus.reason}</Descriptions.Item>
                {focus.status === 'observing' && observation ? (
                  <>
                    <Descriptions.Item label="调整后误报">
                      <Text>观察依据 {observation.falseAlarmsBefore} 起 → 观察期内 {observation.falseAlarmsAfter} 起</Text>
                      {observation.falseAlarmsAfter < observation.falseAlarmsBefore && <Tag color="green" style={{ marginLeft: 6 }}>误报下降</Tag>}
                    </Descriptions.Item>
                    <Descriptions.Item label="漏报真实风险">
                      {observation.missedRiskEvents.length === 0 ? (
                        <Tag color="green">未发现</Tag>
                      ) : (
                        <Space direction="vertical" size={2}>
                          <Tag color="red">发现 {observation.missedRiskEvents.length} 起疑似被漏报异常</Tag>
                          {observation.missedRiskEvents.map((e) => (
                            <Text key={e.id} style={{ fontSize: 12 }}>{e.id} · {fmtTime(e.occurredAt)} · {e.location}</Text>
                          ))}
                        </Space>
                      )}
                    </Descriptions.Item>
                  </>
                ) : focus.observation ? (
                  <>
                    <Descriptions.Item label="调整后误报">
                      观察依据 {focus.observation.falseAlarmsBefore} 起 → 观察期内 {focus.observation.falseAlarmsAfter} 起
                      {focus.observation.falseAlarmsAfter < focus.observation.falseAlarmsBefore && <Tag color="green" style={{ marginLeft: 6 }}>误报下降</Tag>}
                    </Descriptions.Item>
                    <Descriptions.Item label="漏报真实风险">
                      {focus.observation.missedRisk ? <Tag color="red">发现漏报，已回退</Tag> : <Tag color="green">未发现</Tag>}
                    </Descriptions.Item>
                    <Descriptions.Item label="评估结论">
                      {focus.observation.note}（评估人：{focus.observation.reviewedBy}，{fmtTime(focus.observation.reviewedAt)}）
                    </Descriptions.Item>
                  </>
                ) : null}
                {focus.status === 'reverted' && (
                  <Descriptions.Item label="回退信息">
                    {fmtTime(focus.revertedAt!)} · {focus.revertedBy}：{focus.revertReason}
                  </Descriptions.Item>
                )}
              </Descriptions>

              {focus.status === 'observing' && (
                <Space direction="vertical" style={{ width: '100%', marginTop: 8 }}>
                  <Card size="small" type="inner" title="观察期演示（一键模拟后续场景）">
                    <Space wrap>
                      <Button size="small" onClick={simFalseAlarm}>模拟午睡误报（家属确认）</Button>
                      <Button size="small" danger onClick={simMissedRisk}>模拟午睡真实异常被漏报</Button>
                    </Space>
                  </Card>
                  <Space wrap>
                    <Button type="primary" onClick={() => { reviewThresholdChange(focus.id); message.success('已完成观察期评估') }}>
                      完成观察评估（误报下降→生效 / 漏报→自动回退）
                    </Button>
                    <Button danger icon={<RollbackOutlined />} onClick={() => { setRevertTarget(focus); setRevertReason('') }}>
                      人工回退阈值
                    </Button>
                  </Space>
                </Space>
              )}
            </Card>
          )}
        </Col>
      </Row>

      {/* 阈值变更记录（永久留痕） */}
      <Card
        size="small"
        title={
          <Space>
            <HistoryOutlined />
            阈值变更记录（{elder.name}）· 永久保留，供后续照护评估与异常回看
          </Space>
        }
      >
        <Table
          size="small"
          rowKey="id"
          pagination={false}
          dataSource={elderChanges}
          locale={{ emptyText: '暂无阈值变更记录' }}
          expandable={{
            expandedRowRender: (c) => (
              <Descriptions column={1} size="small" bordered>
                <Descriptions.Item label="调整原因（审批留痕）">{c.reason}</Descriptions.Item>
                <Descriptions.Item label="依据事件">{c.evidenceEventIds.length ? c.evidenceEventIds.join('、') : '—'}</Descriptions.Item>
                {c.observation && <Descriptions.Item label="观察期结论">{c.observation.note}（评估人：{c.observation.reviewedBy}，{fmtTime(c.observation.reviewedAt)}）</Descriptions.Item>}
                {c.status === 'reverted' && <Descriptions.Item label="回退原因">{c.revertReason}（{c.revertedBy}，{fmtTime(c.revertedAt!)}）</Descriptions.Item>}
              </Descriptions>
            ),
          }}
          columns={[
            { title: '记录', dataIndex: 'id', width: 90 },
            { title: '时间', render: (_, c) => fmtTime(c.changedAt), width: 110 },
            {
              title: '审批人',
              width: 130,
              render: (_, c) => (
                <Space size={2}>
                  <UserOutlined />
                  {c.approver}
                  <Tag>{c.approverRole}</Tag>
                </Space>
              ),
            },
            { title: '调整内容', render: (_, c) => <Text style={{ fontSize: 12 }}>{describeChange(c)}</Text> },
            { title: '观察期至', render: (_, c) => fmtTime(c.observeUntil), width: 110 },
            {
              title: '状态',
              width: 100,
              render: (_, c) => <Tag color={STATUS_META[c.status].color}>{STATUS_META[c.status].label}</Tag>,
            },
            {
              title: '回退',
              width: 110,
              render: (_, c) =>
                c.status === 'reverted' ? (
                  <Text type="secondary" style={{ fontSize: 12 }}>{fmtTime(c.revertedAt!)}<br />{c.revertedBy}</Text>
                ) : c.status === 'observing' ? (
                  <Button size="small" danger icon={<RollbackOutlined />} onClick={() => { setRevertTarget(c); setRevertReason('') }}>回退</Button>
                ) : (
                  <Button size="small" icon={<RollbackOutlined />} onClick={() => { setRevertTarget(c); setRevertReason('') }}>回退</Button>
                ),
            },
          ]}
        />
      </Card>

      {/* 调整审批弹窗 */}
      <Modal
        title={`阈值调整审批：${elder.name}`}
        open={applyOpen}
        onCancel={() => setApplyOpen(false)}
        onOk={submitApply}
        okText="提交审批并进入观察期"
        width={620}
      >
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="阈值调整必须记录审批人与原因；午睡延后仅作用于长时间静止告警，心率异常、跌倒等告警灵敏度不变。调整后进入观察期，发现漏报真实风险将自动回退。"
        />
        <Form form={form} layout="vertical">
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="approver" label="审批人" rules={[{ required: true, message: '请填写审批人' }]}>
                <Input placeholder="如：陈医生" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="approverRole" label="审批人身份" rules={[{ required: true, message: '请填写身份' }]}>
                <Input placeholder="社区医生 / 社区负责人" />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="stillnessMinutes" label="静止时长阈值（分钟）" rules={[{ required: true }]}>
                <InputNumber min={15} max={180} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="napDelayMinutes" label="午睡时段额外延后（分钟，0=不延后）" tooltip={`午睡时段 ${elder.napWindow?.start ?? ''}-${elder.napWindow?.end ?? ''} 内，静止告警在阈值基础上延后`}>
                <InputNumber min={0} max={60} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="observeDays" label="观察期（天）" rules={[{ required: true }]}>
                <InputNumber min={1} max={30} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={24} style={{ flex: '0 0 100%' }}>
              <Form.Item name="evidenceEventIds" label="调整依据事件（家属确认的误报记录）">
                <Select
                  mode="multiple"
                  placeholder="选择作为调整依据的误报事件"
                  options={evidenceEvents.map((e) => ({
                    value: e.id,
                    label: `${e.id} · ${fmtTimeFull(e.occurredAt)} · ${e.family.note ?? (e.closure ? `结案：${e.closure.falseReason ?? ''}` : '')}`,
                  }))}
                />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="reason" label="调整原因（必填，后续异常回看依据）" rules={[{ required: true, message: '请填写调整原因' }]}>
            <Input.TextArea rows={3} placeholder="说明误报情况、医生评估结论、为何降低或延后告警" />
          </Form.Item>
          <Collapse
            items={[
              {
                key: 'adv',
                label: '其他阈值（一般保持不变；修改同样留痕）',
                children: (
                  <Row gutter={12}>
                    <Col span={12}>
                      <Form.Item name="heartRateLow" label="心率下限(bpm)"><InputNumber min={30} max={100} style={{ width: '100%' }} /></Form.Item>
                    </Col>
                    <Col span={12}>
                      <Form.Item name="heartRateHigh" label="心率上限(bpm)"><InputNumber min={80} max={200} style={{ width: '100%' }} /></Form.Item>
                    </Col>
                    <Col span={12}>
                      <Form.Item name="geofenceRadius" label="围栏半径(米)"><InputNumber min={100} max={3000} step={100} style={{ width: '100%' }} /></Form.Item>
                    </Col>
                    <Col span={12}>
                      <Form.Item name="curfewTime" label="归家时间"><Input placeholder="21:00" /></Form.Item>
                    </Col>
                  </Row>
                ),
              },
            ]}
          />
        </Form>
      </Modal>

      {/* 人工回退 */}
      <Modal
        title={`人工回退阈值：${revertTarget?.id ?? ''}`}
        open={!!revertTarget}
        onCancel={() => setRevertTarget(null)}
        onOk={() => {
          if (!revertTarget) return
          if (!revertReason.trim()) {
            message.warning('请填写回退原因（将随记录永久保留）')
            return
          }
          revertThresholdChange(revertTarget.id, revertReason.trim())
          setRevertTarget(null)
          message.success('阈值已回退，回退原因已留痕')
        }}
        okText="确认回退"
        okButtonProps={{ danger: true }}
      >
        {revertTarget && (
          <Space direction="vertical" style={{ width: '100%' }}>
            <Text>
              本次调整：{describeChange(revertTarget)}。回退后将恢复为调整前取值：
              {Object.entries(revertTarget.before).map(([k, v]) => `${THRESHOLD_FIELD_LABEL[k as keyof Thresholds]}=${v}`).join('；') ||
                '（档案阈值无变更，仅取消午睡延后策略）'}
            </Text>
            <Input.TextArea rows={3} placeholder="回退原因（必填）：如医生复查认为继续延后存在漏报风险" value={revertReason} onChange={(e) => setRevertReason(e.target.value)} />
          </Space>
        )}
      </Modal>
    </div>
  )
}

export default ThresholdReviewPage
