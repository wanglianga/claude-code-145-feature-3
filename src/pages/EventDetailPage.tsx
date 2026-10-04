import React, { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  Alert,
  Button,
  Card,
  Col,
  Descriptions,
  Form,
  Input,
  Modal,
  Radio,
  Row,
  Select,
  Space,
  Statistic,
  Tag,
  Typography,
  message,
} from 'antd'
import { ArrowLeftOutlined, PhoneOutlined, SafetyOutlined } from '@ant-design/icons'
import { useStore, GRID_WORKERS, nearestWorker } from '../store/useStore'
import { CLOSURE_LABEL, ClosureCategory, ESCALATION_LABEL, THRESHOLD_REVIEW_LABEL } from '../types'
import { FALSE_REASONS, activeChangesForEvent } from '../store/workflow'
import { AlertTypeTag, SeverityTag, StatusTag, fmtMinutes, fmtTime } from '../components/common'
import ElderInfoCard from '../components/ElderInfoCard'
import PlanSteps from '../components/PlanSteps'
import EventTimeline from '../components/EventTimeline'

const { Text, Title } = Typography

const EventDetailPage: React.FC = () => {
  const { id } = useParams()
  const nav = useNavigate()
  const store = useStore()
  const ev = store.events.find((e) => e.id === id)
  const elder = store.elders.find((e) => e.id === ev?.elderId)
  const [familyNote, setFamilyNote] = useState('')
  const [phoneNote, setPhoneNote] = useState('')
  const [visitModal, setVisitModal] = useState(false)
  const [visitResult, setVisitResult] = useState<'ok' | 'no_answer' | 'need_medical'>('ok')
  const [visitNote, setVisitNote] = useState('')
  const [medicalModal, setMedicalModal] = useState(false)
  const [medicalForm] = Form.useForm()
  const [followUpModal, setFollowUpModal] = useState(false)
  const [followUpNote, setFollowUpNote] = useState('')
  const [closeModal, setCloseModal] = useState(false)
  const [closeForm] = Form.useForm()
  const closeCategory = Form.useWatch('category', closeForm)

  if (!ev || !elder) {
    return (
      <Card>
        <Text>事件不存在。</Text>
        <Button onClick={() => nav('/')}>返回工作台</Button>
      </Card>
    )
  }

  const closed = ev.status === 'closed'
  const worker = nearestWorker(elder, GRID_WORKERS)
  const activeChanges = activeChangesForEvent(store.thresholdChanges, ev)

  const familyAct = (response: 'false_alarm' | 'request_call' | 'request_visit' | 'called_120') => {
    store.familyRespond(ev.id, response, familyNote)
    setFamilyNote('')
    message.success('家属操作已记录')
  }

  return (
    <div>
      <Space style={{ marginBottom: 12 }} wrap>
        <Button icon={<ArrowLeftOutlined />} onClick={() => nav('/')}>
          返回
        </Button>
        <Title level={4} style={{ margin: 0 }}>
          事件 {ev.id} · {elder.name}
        </Title>
        <AlertTypeTag v={ev.type} />
        <SeverityTag v={ev.severity} />
        <StatusTag v={ev.status} />
        <Text type="secondary">
          {fmtTime(ev.occurredAt)} · {ev.location}
          {ev.isNight && <Tag color="purple">夜间</Tag>}
        </Text>
      </Space>

      {ev.escalations.length > 0 && !closed && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="已触发升级情形"
          description={
            <Space direction="vertical" size={2}>
              {ev.escalations.map((e, i) => (
                <Text key={i} style={{ fontSize: 12 }}>
                  <Tag color="orange">{ESCALATION_LABEL[e.kind]}</Tag>
                  {fmtTime(e.at)} · {e.note}
                </Text>
              ))}
            </Space>
          }
        />
      )}

      {activeChanges.length > 0 && (
        <Alert
          type={ev.closure?.category === 'real_risk' ? 'error' : 'warning'}
          showIcon
          style={{ marginBottom: 12 }}
          message="本事件发生时存在已审批生效的阈值调整（可回看当时为何降低/延后告警）"
          description={
            <Space direction="vertical" size={4}>
              {activeChanges.map((c) => (
                <div key={c.id}>
                  <Space wrap size={4}>
                    <Tag color="blue">{c.id}</Tag>
                    <Tag>{THRESHOLD_REVIEW_LABEL[c.outcome]}</Tag>
                    <Text style={{ fontSize: 12 }}>
                      {fmtTime(c.createdAt)} 由 {c.approverRole} {c.approvedBy} 审批
                    </Text>
                  </Space>
                  <div>
                    <Text style={{ fontSize: 12 }}>
                      调整：{c.changes.map((x) => `${x.label} ${x.before}→${x.after}`).join('；')}
                    </Text>
                  </div>
                  <div>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      原因：{c.reason}
                    </Text>
                  </div>
                  {ev.closure?.category === 'real_risk' && (
                    <div>
                      <Text type="danger" style={{ fontSize: 12 }}>
                        本事件为真实风险，请回看该阈值调整是否造成告警延迟或遗漏，必要时在「误报分析与阈值审批」中回退阈值。
                      </Text>
                    </div>
                  )}
                </div>
              ))}
            </Space>
          }
        />
      )}

      <Row gutter={12}>
        {/* 左：老人与设备信息（社区视角） */}
        <Col xs={24} lg={7}>
          <ElderInfoCard elder={elder} communityView />
          <Card size="small" title="家属响应状态" style={{ marginBottom: 12 }}>
            <Descriptions column={1} size="small">
              <Descriptions.Item label="第一联系人">
                {ev.family.contactName}（{ev.family.contactPhone}）
              </Descriptions.Item>
              <Descriptions.Item label="通知时间">{fmtTime(ev.family.notifiedAt)}</Descriptions.Item>
              <Descriptions.Item label="响应">
                {ev.family.respondedAt ? (
                  <Tag color="green">
                    {fmtTime(ev.family.respondedAt)} ·{' '}
                    {{ false_alarm: '确认误报', request_call: '请求电话核实', request_visit: '要求上门', called_120: '已拨打120' }[ev.family.response!]}
                  </Tag>
                ) : ev.family.timedOut ? (
                  <Tag color="red">超时未响应，社区已接管</Tag>
                ) : (
                  <Tag color="gold">等待响应中…</Tag>
                )}
              </Descriptions.Item>
              {ev.family.note && <Descriptions.Item label="家属留言">{ev.family.note}</Descriptions.Item>}
            </Descriptions>
          </Card>
        </Col>

        {/* 中：处置流程 + 全程记录 */}
        <Col xs={24} lg={9}>
          <PlanSteps event={ev} />
          <EventTimeline event={ev} />
        </Col>

        {/* 右：操作面板 */}
        <Col xs={24} lg={8}>
          {!closed && (
            <Card size="small" title="社区处置操作" style={{ marginBottom: 12 }}>
              <Space direction="vertical" style={{ width: '100%' }}>
                <Space wrap>
                  <Button
                    icon={<PhoneOutlined />}
                    onClick={() => {
                      store.recordPhoneAttempt(ev.id, 'answered', phoneNote)
                      setPhoneNote('')
                    }}
                  >
                    电话核实：已接听
                  </Button>
                  <Button
                    danger
                    icon={<PhoneOutlined />}
                    onClick={() => {
                      store.recordPhoneAttempt(ev.id, 'no_answer', phoneNote)
                      setPhoneNote('')
                    }}
                  >
                    电话核实：无人接
                  </Button>
                </Space>
                <Input.TextArea
                  rows={1}
                  placeholder="电话核实备注（可选）"
                  value={phoneNote}
                  onChange={(e) => setPhoneNote(e.target.value)}
                />
                {!ev.doorVisit && ev.status !== 'medical' && (
                  <Button type="primary" block onClick={() => store.dispatchVisit(ev.id, worker.name)}>
                    派单上门（就近：{worker.name}，约{worker.distanceMin}分钟）
                  </Button>
                )}
                {ev.doorVisit && !ev.doorVisit.arrivedAt && (
                  <Button block onClick={() => store.recordArrival(ev.id)}>
                    记录到达（{ev.doorVisit.assignee}）
                  </Button>
                )}
                {ev.doorVisit && ev.doorVisit.arrivedAt && !ev.doorVisit.result && (
                  <Button type="primary" block onClick={() => setVisitModal(true)}>
                    记录上门结果
                  </Button>
                )}
                {ev.doorVisit?.result === 'no_answer' && !ev.doorVisit.propertyInvolved && (
                  <Space wrap>
                    <Button onClick={() => store.involveProperty(ev.id, false)}>联动物业开门</Button>
                    <Button onClick={() => store.involveProperty(ev.id, true)}>使用托管钥匙入户</Button>
                  </Space>
                )}
                {ev.doorVisit?.propertyInvolved && !ev.doorVisit.result?.match(/ok|need_medical/) && (
                  <Button type="primary" block onClick={() => setVisitModal(true)}>
                    入户后记录结果
                  </Button>
                )}
                {!ev.medical?.called120 && ev.status !== 'follow_up' && (
                  <Button danger block onClick={() => store.call120(ev.id, 'community')}>
                    呼叫120急救
                  </Button>
                )}
                {ev.medical?.called120 && !ev.medical.outcome && (
                  <Button type="primary" block onClick={() => setMedicalModal(true)}>
                    记录就医结果
                  </Button>
                )}
                {ev.status === 'follow_up' && !ev.followUp && (
                  <Button block onClick={() => setFollowUpModal(true)}>
                    记录回访
                  </Button>
                )}
                {ev.status === 'follow_up' && ev.followUp && (
                  <Button type="primary" block icon={<SafetyOutlined />} onClick={() => setCloseModal(true)}>
                    结案并生成复盘
                  </Button>
                )}
              </Space>
            </Card>
          )}

          {!closed && !ev.family.respondedAt && (
            <Card size="small" title="家属端操作模拟（演示用）" style={{ marginBottom: 12 }}>
              <Text type="secondary" style={{ fontSize: 12 }}>
                家属账号（family/123456）登录后在其门户执行同样操作；此处为社区端演示入口。
              </Text>
              <Input.TextArea
                rows={2}
                style={{ marginTop: 8 }}
                placeholder="家属留言（可选）"
                value={familyNote}
                onChange={(e) => setFamilyNote(e.target.value)}
              />
              <Space wrap style={{ marginTop: 8 }}>
                <Button onClick={() => familyAct('false_alarm')}>确认误报</Button>
                <Button onClick={() => familyAct('request_call')}>请求电话核实</Button>
                <Button type="primary" onClick={() => familyAct('request_visit')}>
                  要求上门
                </Button>
                <Button danger onClick={() => familyAct('called_120')}>
                  直接拨打120
                </Button>
              </Space>
            </Card>
          )}

          {ev.closure && (
            <Card size="small" title="结案复盘报告" style={{ marginBottom: 12 }}>
              <Row gutter={8} style={{ marginBottom: 8 }}>
                <Col span={8}>
                  <Statistic title="家属响应时长" value={fmtMinutes(ev.closure.familyResponseMinutes)} valueStyle={{ fontSize: 16 }} />
                </Col>
                <Col span={8}>
                  <Statistic title="社区处置时效" value={fmtMinutes(ev.closure.communityHandleMinutes)} valueStyle={{ fontSize: 16 }} />
                </Col>
                <Col span={8}>
                  <Statistic title="事件分类" value={CLOSURE_LABEL[ev.closure.category]} valueStyle={{ fontSize: 16 }} />
                </Col>
              </Row>
              <Descriptions column={1} size="small" bordered>
                {ev.closure.falseReason && <Descriptions.Item label="误报原因">{ev.closure.falseReason}</Descriptions.Item>}
                <Descriptions.Item label="设备调整建议">{ev.closure.deviceSuggestion}</Descriptions.Item>
                <Descriptions.Item label="复盘总结">{ev.closure.summary}</Descriptions.Item>
                <Descriptions.Item label="结案">
                  {fmtTime(ev.closure.closedAt)} · {ev.closure.closedBy}
                </Descriptions.Item>
              </Descriptions>
            </Card>
          )}
        </Col>
      </Row>

      {/* 上门结果 */}
      <Modal
        title="记录上门结果"
        open={visitModal}
        onCancel={() => setVisitModal(false)}
        onOk={() => {
          store.recordVisitResult(ev.id, visitResult, visitNote)
          setVisitModal(false)
          setVisitNote('')
        }}
      >
        <Radio.Group
          value={visitResult}
          onChange={(e) => setVisitResult(e.target.value)}
          options={[
            { value: 'ok', label: '老人平安' },
            { value: 'no_answer', label: '无人开门' },
            { value: 'need_medical', label: '需医疗处置' },
          ]}
        />
        <Input.TextArea rows={2} style={{ marginTop: 12 }} placeholder="现场情况备注" value={visitNote} onChange={(e) => setVisitNote(e.target.value)} />
      </Modal>

      {/* 就医结果 */}
      <Modal
        title="记录就医结果"
        open={medicalModal}
        onCancel={() => setMedicalModal(false)}
        onOk={() =>
          medicalForm.validateFields().then((v) => {
            store.recordMedical(ev.id, v.hospital, v.outcome)
            setMedicalModal(false)
          })
        }
      >
        <Form form={medicalForm} layout="vertical">
          <Form.Item name="hospital" label="送医医院" rules={[{ required: true, message: '请填写医院' }]}>
            <Input placeholder="如：区人民医院心内科" />
          </Form.Item>
          <Form.Item name="outcome" label="诊断与处置结果" rules={[{ required: true, message: '请填写结果' }]}>
            <Input.TextArea rows={2} placeholder="如：房颤发作，急诊处理后留观" />
          </Form.Item>
        </Form>
      </Modal>

      {/* 回访 */}
      <Modal
        title="记录回访"
        open={followUpModal}
        onCancel={() => setFollowUpModal(false)}
        onOk={() => {
          store.recordFollowUp(ev.id, followUpNote || '电话回访，老人状态平稳')
          setFollowUpModal(false)
          setFollowUpNote('')
        }}
      >
        <Input.TextArea rows={3} placeholder="回访情况（老人状态、家属反馈、设备检查）" value={followUpNote} onChange={(e) => setFollowUpNote(e.target.value)} />
      </Modal>

      {/* 结案 */}
      <Modal
        title="结案并生成复盘报告"
        open={closeModal}
        onCancel={() => setCloseModal(false)}
        onOk={() =>
          closeForm.validateFields().then((v) => {
            store.closeEvent(ev.id, v.category, v.falseReason, v.summary)
            setCloseModal(false)
            message.success('已结案，复盘报告已生成并沉淀至照护画像')
          })
        }
      >
        <Form form={closeForm} layout="vertical" initialValues={{ category: 'device_false' as ClosureCategory }}>
          <Form.Item name="category" label="事件分类（区分设备误报 / 照护缺口 / 真实风险）" rules={[{ required: true }]}>
            <Radio.Group
              options={Object.entries(CLOSURE_LABEL).map(([v, l]) => ({ value: v, label: l }))}
              optionType="button"
              buttonStyle="solid"
            />
          </Form.Item>
          {closeCategory === 'device_false' && (
            <Form.Item name="falseReason" label="误报原因" rules={[{ required: true, message: '请选择误报原因' }]}>
              <Select options={FALSE_REASONS.map((r) => ({ value: r, label: r }))} />
            </Form.Item>
          )}
          <Form.Item name="summary" label="复盘总结" rules={[{ required: true, message: '请填写复盘总结' }]}>
            <Input.TextArea rows={3} placeholder="处置经过、响应情况、后续注意事项" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}

export default EventDetailPage
