import React, { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Alert, Button, Card, Col, Descriptions, Modal, Row, Select, Space, Statistic, Table, Tag, Typography, message } from 'antd'
import { EditOutlined, IdcardOutlined, SlidersOutlined } from '@ant-design/icons'
import { useStore } from '../store/useStore'
import { CareProfile } from '../types'
import { fmtTime } from '../components/common'
import { describeChange } from '../store/workflow'

const { Text } = Typography

const RISK_COLOR = { high: 'red', medium: 'orange', low: 'green' } as const
const RISK_LABEL = { high: '高风险', medium: '中风险', low: '低风险' } as const

const VISIT_OPTIONS = ['每日上门巡访 + 早晚两次电话', '隔日电话 + 每周上门一次', '每周电话巡访一次']
const DEVICE_OPTIONS = ['安排上门检修设备并重新标定阈值', '每周提醒充电，纳入设备巡检清单', '按季度常规巡检']
const REMINDER_OPTIONS = ['升级为电话+短信+APP三通道，并约谈家属明确照护责任', 'APP推送 + 短信提醒', '仅APP推送']

/** 照护画像：由事件结案沉淀，区分设备误报 / 照护缺口 / 真实风险 */
const ProfilesPage: React.FC = () => {
  const nav = useNavigate()
  const elders = useStore((s) => s.elders)
  const profiles = useStore((s) => s.profiles)
  const changes = useStore((s) => s.thresholdChanges)
  const updateStrategy = useStore((s) => s.updateStrategy)
  const [editing, setEditing] = useState<CareProfile | null>(null)
  const [strategy, setStrategy] = useState<CareProfile['strategy'] | null>(null)

  const elderName = (id: string) => elders.find((e) => e.id === id)?.name ?? id
  const changesOf = (elderId: string) =>
    changes.filter((c) => c.elderId === elderId).sort((a, b) => b.changedAt - a.changedAt)

  const openEdit = (p: CareProfile) => {
    setEditing(p)
    setStrategy({ ...p.strategy })
  }

  return (
    <div>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="照护画像由每次事件结案自动沉淀：连续无人响应、频繁离线、多次上门无人在家都会累积为画像标签，社区据此调整巡访频次、设备维护与家属提醒方式。"
      />
      <Row gutter={[12, 12]}>
        {Object.values(profiles).map((p) => (
          <Col xs={24} md={12} xl={8} key={p.elderId}>
            <Card
              size="small"
              title={
                <Space>
                  <IdcardOutlined />
                  {elderName(p.elderId)}
                  <Tag color={RISK_COLOR[p.riskLevel]}>{RISK_LABEL[p.riskLevel]}</Tag>
                </Space>
              }
              extra={
                <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(p)}>
                  调整照护策略
                </Button>
              }
            >
              <Space wrap size={4} style={{ marginBottom: 8 }}>
                {p.riskTags.map((t) => (
                  <Tag key={t} color={t === '状态平稳' ? 'green' : 'volcano'}>
                    {t}
                  </Tag>
                ))}
              </Space>
              <Row gutter={4}>
                <Col span={8}>
                  <Statistic title="设备误报" value={p.falseAlarmCount} valueStyle={{ fontSize: 16 }} />
                </Col>
                <Col span={8}>
                  <Statistic title="照护缺口" value={p.careGapCount} valueStyle={{ fontSize: 16 }} />
                </Col>
                <Col span={8}>
                  <Statistic title="真实风险" value={p.realRiskCount} valueStyle={{ fontSize: 16 }} />
                </Col>
                <Col span={8}>
                  <Statistic title="家属未响应" value={p.familyTimeoutCount} valueStyle={{ fontSize: 16 }} />
                </Col>
                <Col span={8}>
                  <Statistic title="设备离线" value={p.offlineCount} valueStyle={{ fontSize: 16 }} />
                </Col>
                <Col span={8}>
                  <Statistic title="上门无人" value={p.doorNoAnswerCount} valueStyle={{ fontSize: 16 }} />
                </Col>
              </Row>
              <Descriptions column={1} size="small" style={{ marginTop: 8 }} bordered>
                <Descriptions.Item label="巡访频次">{p.strategy.visitFrequency}</Descriptions.Item>
                <Descriptions.Item label="设备维护">{p.strategy.deviceMaintenance}</Descriptions.Item>
                <Descriptions.Item label="家属提醒">{p.strategy.familyReminder}</Descriptions.Item>
              </Descriptions>
              {changesOf(p.elderId).length > 0 && (
                <div style={{ marginTop: 8 }}>
                  <Text strong style={{ fontSize: 12 }}>
                    阈值调整史（照护评估依据）
                  </Text>
                  {changesOf(p.elderId).slice(0, 2).map((c) => (
                    <div key={c.id} style={{ marginTop: 4 }}>
                      <Space size={4} wrap>
                        <Tag color={c.status === 'effective' ? 'success' : c.status === 'observing' ? 'processing' : 'error'} style={{ marginInlineEnd: 0 }}>
                          {c.status === 'effective' ? '生效中' : c.status === 'observing' ? '观察期' : '已回退'}
                        </Tag>
                        <Text style={{ fontSize: 11 }}>{describeChange(c)}</Text>
                      </Space>
                      <div>
                        <Text type="secondary" style={{ fontSize: 11 }}>
                          {fmtTime(c.changedAt)} · {c.approver}（{c.approverRole}）
                        </Text>
                      </div>
                    </div>
                  ))}
                  <Button size="small" type="link" style={{ padding: 0, fontSize: 12 }} icon={<SlidersOutlined />} onClick={() => nav(`/thresholds?elder=${p.elderId}`)}>
                    查看完整变更记录与观察结论
                  </Button>
                </div>
              )}
              <Text type="secondary" style={{ fontSize: 11 }}>
                更新于 {fmtTime(p.updatedAt)}
              </Text>
            </Card>
          </Col>
        ))}
      </Row>

      <Modal
        title={editing ? `调整照护策略：${elderName(editing.elderId)}` : ''}
        open={!!editing}
        onCancel={() => setEditing(null)}
        onOk={() => {
          if (editing && strategy) {
            updateStrategy(editing.elderId, strategy)
            setEditing(null)
            message.success('照护策略已更新')
          }
        }}
      >
        {strategy && (
          <Space direction="vertical" style={{ width: '100%' }}>
            <Text strong>巡访频次</Text>
            <Select
              style={{ width: '100%' }}
              value={strategy.visitFrequency}
              onChange={(v) => setStrategy({ ...strategy, visitFrequency: v })}
              options={VISIT_OPTIONS.map((o) => ({ value: o, label: o }))}
            />
            <Text strong>设备维护</Text>
            <Select
              style={{ width: '100%' }}
              value={strategy.deviceMaintenance}
              onChange={(v) => setStrategy({ ...strategy, deviceMaintenance: v })}
              options={DEVICE_OPTIONS.map((o) => ({ value: o, label: o }))}
            />
            <Text strong>家属提醒方式</Text>
            <Select
              style={{ width: '100%' }}
              value={strategy.familyReminder}
              onChange={(v) => setStrategy({ ...strategy, familyReminder: v })}
              options={REMINDER_OPTIONS.map((o) => ({ value: o, label: o }))}
            />
          </Space>
        )}
      </Modal>
    </div>
  )
}

export default ProfilesPage
