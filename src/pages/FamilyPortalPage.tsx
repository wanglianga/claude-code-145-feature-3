import React, { useState } from 'react'
import { Alert, Button, Card, Col, Empty, Input, Layout, List, Row, Space, Tag, Typography, message } from 'antd'
import { CheckCircleOutlined, HistoryOutlined, HomeOutlined, LogoutOutlined, MedicineBoxOutlined, PhoneOutlined, SafetyOutlined } from '@ant-design/icons'
import { useStore } from '../store/useStore'
import { AlertTypeTag, SeverityTag, StatusTag, fmtTime } from '../components/common'
import { describeChange } from '../store/workflow'
import ElderInfoCard from '../components/ElderInfoCard'
import EventTimeline from '../components/EventTimeline'

const { Header, Content } = Layout
const { Title, Text } = Typography

/** 家属端门户：确认误报 / 请求电话核实 / 要求上门 / 直接联系急救 */
const FamilyPortalPage: React.FC = () => {
  const session = useStore((s) => s.session)!
  const logout = useStore((s) => s.logout)
  const elders = useStore((s) => s.elders)
  const events = useStore((s) => s.events)
  const familyRespond = useStore((s) => s.familyRespond)
  const [notes, setNotes] = useState<Record<string, string>>({})

  const elder = elders.find((e) => e.id === session.elderId)
  const myEvents = events.filter((e) => e.elderId === session.elderId)
  const active = myEvents.filter((e) => e.status !== 'closed')
  const history = myEvents.filter((e) => e.status === 'closed')
  const thresholdChanges = useStore((s) => s.thresholdChanges).filter((c) => c.elderId === session.elderId).sort((a, b) => b.changedAt - a.changedAt)

  if (!elder) return null

  const act = (eventId: string, response: 'false_alarm' | 'request_call' | 'request_visit' | 'called_120') => {
    familyRespond(eventId, response, notes[eventId] ?? '')
    message.success('您的操作已通知社区值班中心')
  }

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Header style={{ background: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 24px' }}>
        <Space>
          <SafetyOutlined style={{ fontSize: 20, color: '#1677ff' }} />
          <Title level={4} style={{ margin: 0 }}>
            家属端 · {elder.name}的告警确认
          </Title>
          <Tag color="green">{session.userName}</Tag>
        </Space>
        <Button size="small" icon={<LogoutOutlined />} onClick={logout}>
          退出
        </Button>
      </Header>
      <Content style={{ padding: 16, maxWidth: 1200, margin: '0 auto', width: '100%' }}>
        <Row gutter={12}>
          <Col xs={24} lg={9}>
            <ElderInfoCard elder={elder} communityView={false} />
            {thresholdChanges.length > 0 && (
              <Card size="small" title={<Space><HistoryOutlined />老人告警阈值调整记录</Space>} style={{ marginBottom: 12 }}>
                <Alert
                  type="info"
                  showIcon
                  style={{ marginBottom: 8 }}
                  message="社区汇总您多次确认的午睡误报后，经医生审批调整了静止告警阈值；调整原因与审批人永久留痕，观察期如漏报真实风险将自动回退。"
                />
                <List
                  size="small"
                  dataSource={thresholdChanges}
                  renderItem={(c) => (
                    <List.Item>
                      <List.Item.Meta
                        title={
                          <Space wrap size={4}>
                            <Text style={{ fontSize: 12 }}>{c.id} · {fmtTime(c.changedAt)}</Text>
                            <Tag color={c.status === 'effective' ? 'success' : c.status === 'observing' ? 'processing' : 'error'}>
                              {c.status === 'effective' ? '持续生效' : c.status === 'observing' ? '观察期中' : '已回退'}
                            </Tag>
                          </Space>
                        }
                        description={
                          <Space direction="vertical" size={0}>
                            <Text style={{ fontSize: 12 }}>{describeChange(c)}</Text>
                            <Text type="secondary" style={{ fontSize: 11 }}>审批人：{c.approver}（{c.approverRole}）</Text>
                            <Text type="secondary" style={{ fontSize: 11 }}>原因：{c.reason}</Text>
                          </Space>
                        }
                      />
                    </List.Item>
                  )}
                />
              </Card>
            )}
          </Col>
          <Col xs={24} lg={15}>
            {active.length === 0 && (
              <Card size="small" style={{ marginBottom: 12 }}>
                <Empty description="当前没有待处理的告警，老人状态平稳" />
              </Card>
            )}
            {active.map((ev) => (
              <Card
                key={ev.id}
                size="small"
                style={{ marginBottom: 12, borderColor: '#ff4d4f' }}
                title={
                  <Space wrap>
                    <Tag color="red">新告警</Tag>
                    <AlertTypeTag v={ev.type} />
                    <SeverityTag v={ev.severity} />
                    <StatusTag v={ev.status} />
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {fmtTime(ev.occurredAt)} · {ev.location}
                      {ev.isNight && ' · 夜间'}
                    </Text>
                  </Space>
                }
              >
                <Alert
                  type="error"
                  showIcon
                  style={{ marginBottom: 12 }}
                  message={`手环上报${ev.location}发生告警，请您尽快确认老人情况`}
                  description="如确认为误报请点击「确认误报」；如需社区协助请选择电话核实或要求上门；紧急情况请直接拨打120。"
                />
                {!ev.family.respondedAt ? (
                  <>
                    <Input.TextArea
                      rows={2}
                      placeholder="给社区值班员留言（可选）"
                      style={{ marginBottom: 8 }}
                      value={notes[ev.id] ?? ''}
                      onChange={(e) => setNotes({ ...notes, [ev.id]: e.target.value })}
                    />
                    <Space wrap>
                      <Button icon={<CheckCircleOutlined />} onClick={() => act(ev.id, 'false_alarm')}>
                        确认误报
                      </Button>
                      <Button icon={<PhoneOutlined />} onClick={() => act(ev.id, 'request_call')}>
                        请求电话核实
                      </Button>
                      <Button type="primary" icon={<HomeOutlined />} onClick={() => act(ev.id, 'request_visit')}>
                        要求上门查看
                      </Button>
                      <Button danger icon={<MedicineBoxOutlined />} onClick={() => act(ev.id, 'called_120')}>
                        直接拨打120
                      </Button>
                    </Space>
                  </>
                ) : (
                  <Alert
                    type="success"
                    showIcon
                    message={`您已于 ${fmtTime(ev.family.respondedAt)} 响应：${
                      { false_alarm: '确认误报', request_call: '请求电话核实', request_visit: '要求上门查看', called_120: '已拨打120' }[ev.family.response!]
                    }，社区正在处置中`}
                  />
                )}
                <div style={{ marginTop: 12 }}>
                  <EventTimeline event={ev} />
                </div>
              </Card>
            ))}

            {history.length > 0 && (
              <Card size="small" title="历史事件">
                {history.map((ev) => (
                  <Card key={ev.id} size="small" type="inner" style={{ marginBottom: 8 }}
                    title={
                      <Space>
                        <AlertTypeTag v={ev.type} />
                        <Text type="secondary" style={{ fontSize: 12 }}>
                          {fmtTime(ev.occurredAt)}
                        </Text>
                        {ev.closure && (
                          <Tag color={ev.closure.category === 'real_risk' ? 'red' : ev.closure.category === 'care_gap' ? 'orange' : 'default'}>
                            {ev.closure.category === 'real_risk' ? '真实风险' : ev.closure.category === 'care_gap' ? '照护缺口' : '设备误报'}
                          </Tag>
                        )}
                      </Space>
                    }
                  >
                    {ev.closure && (
                      <Text style={{ fontSize: 12 }}>
                        {ev.closure.summary}
                        {ev.closure.falseReason && `（误报原因：${ev.closure.falseReason}）`}
                      </Text>
                    )}
                  </Card>
                ))}
              </Card>
            )}
          </Col>
        </Row>
      </Content>
    </Layout>
  )
}

export default FamilyPortalPage
