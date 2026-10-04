import React, { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Alert, Button, Card, Drawer, Form, Input, InputNumber, Progress, Space, Table, Tag, Typography, message } from 'antd'
import { AuditOutlined, EditOutlined } from '@ant-design/icons'
import { useStore } from '../store/useStore'
import { Elder } from '../types'
import { fmtTime } from '../components/common'

const { Text } = Typography

/** 老人档案与设备绑定：登记信息、阈值调整、佩戴习惯 */
const EldersPage: React.FC = () => {
  const nav = useNavigate()
  const elders = useStore((s) => s.elders)
  const profiles = useStore((s) => s.profiles)
  const updateThresholds = useStore((s) => s.updateThresholds)
  const updateWearingHabit = useStore((s) => s.updateWearingHabit)
  const [editing, setEditing] = useState<Elder | null>(null)
  const [form] = Form.useForm()

  const openEdit = (e: Elder) => {
    setEditing(e)
    form.setFieldsValue({ ...e.thresholds, wearingHabit: e.wearingHabit })
  }

  return (
    <Card size="small" title="老人档案与手环绑定">
      <Table
        size="small"
        rowKey="id"
        dataSource={elders}
        pagination={false}
        columns={[
          { title: '姓名', render: (_, e: Elder) => `${e.name}（${e.age}岁）`, width: 110 },
          { title: '住址', dataIndex: 'address' },
          { title: '慢病', render: (_, e) => e.chronicDiseases.map((d) => <Tag key={d} color="magenta">{d}</Tag>), width: 160 },
          {
            title: '设备/电量',
            width: 170,
            render: (_, e) => (
              <Space direction="vertical" size={0} style={{ width: 140 }}>
                <Text style={{ fontSize: 12 }}>{e.deviceId}</Text>
                <Progress percent={e.battery} size="small" status={e.battery <= 20 ? 'exception' : 'success'} />
              </Space>
            ),
          },
          {
            title: '告警阈值',
            render: (_, e) => (
              <Space direction="vertical" size={0}>
                <Text style={{ fontSize: 12 }}>
                  心率{e.thresholds.heartRateLow}-{e.thresholds.heartRateHigh} · 静止{e.thresholds.stillnessMinutes}分 · 围栏
                  {e.thresholds.geofenceRadius}米 · 归家{e.thresholds.curfewTime}
                </Text>
                {e.thresholds.napStart ? (
                  <Tag color="blue" style={{ fontSize: 11, marginInlineEnd: 0 }}>
                    午睡延后 {e.thresholds.napStart}-{e.thresholds.napEnd}
                  </Tag>
                ) : (
                  <Text type="secondary" style={{ fontSize: 11 }}>未设午睡延后</Text>
                )}
              </Space>
            ),
          },
          { title: '佩戴习惯', dataIndex: 'wearingHabit', width: 160 },
          { title: '历史误报', render: (_, e) => `${e.historyFalseAlarms}次`, width: 80 },
          {
            title: '画像风险',
            width: 80,
            render: (_, e) => {
              const lv = profiles[e.id]?.riskLevel
              return <Tag color={lv === 'high' ? 'red' : lv === 'medium' ? 'orange' : 'green'}>{lv === 'high' ? '高' : lv === 'medium' ? '中' : '低'}</Tag>
            },
          },
          {
            title: '操作',
            width: 110,
            render: (_, e) => (
              <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(e)}>
                调整阈值
              </Button>
            ),
          },
        ]}
      />
      <Drawer
        title={editing ? `调整绑定信息：${editing.name}` : ''}
        open={!!editing}
        onClose={() => setEditing(null)}
        width={420}
        extra={
          <Space>
            <Button
              icon={<AuditOutlined />}
              onClick={() => {
                setEditing(null)
                nav('/thresholds')
              }}
            >
              误报汇总与审批调整
            </Button>
            <Button
              type="primary"
              onClick={() =>
                form.validateFields().then((v) => {
                  if (!editing) return
                  updateThresholds(editing.id, {
                    heartRateLow: v.heartRateLow,
                    heartRateHigh: v.heartRateHigh,
                    stillnessMinutes: v.stillnessMinutes,
                    geofenceRadius: v.geofenceRadius,
                    curfewTime: v.curfewTime,
                    napStart: v.napStart || undefined,
                    napEnd: v.napEnd || undefined,
                  })
                  updateWearingHabit(editing.id, v.wearingHabit)
                  setEditing(null)
                  message.success('阈值与佩戴习惯已更新，后续告警将按新阈值判定')
                })
              }
            >
              保存
            </Button>
          </Space>
        }
      >
        {editing && (
          <>
            <Text type="secondary" style={{ fontSize: 12 }}>
              设备 {editing.deviceId} · 绑定于 {fmtTime(editing.lastVisit.at)} 前完成建档
            </Text>
            <Alert
              type="warning"
              showIcon
              style={{ margin: '8px 0 12px' }}
              message="因误报需降低/延后告警时，请使用「误报汇总与审批调整」"
              description="审批流程会自动汇总午睡时段、心率、活动轨迹与家属确认记录，并保留审批人、调整原因与观察期记录，供后续真实异常时回看。此处仅用于设备建档参数维护。"
              action={
                <Button size="small" type="link" onClick={() => { setEditing(null); nav('/thresholds') }}>
                  去审批
                </Button>
              }
            />
            <Form form={form} layout="vertical">
              <Space>
                <Form.Item name="heartRateLow" label="心率下限(bpm)" rules={[{ required: true }]}>
                  <InputNumber min={30} max={100} />
                </Form.Item>
                <Form.Item name="heartRateHigh" label="心率上限(bpm)" rules={[{ required: true }]}>
                  <InputNumber min={80} max={200} />
                </Form.Item>
              </Space>
              <Form.Item name="stillnessMinutes" label="静止时长阈值（分钟）" rules={[{ required: true }]}>
                <InputNumber min={15} max={240} style={{ width: '100%' }} />
              </Form.Item>
              <Space>
                <Form.Item name="napStart" label="午睡开始(HH:mm)" tooltip="午睡时段内静止告警延后，心率异常仍立即告警">
                  <Input placeholder="13:00" style={{ width: 120 }} />
                </Form.Item>
                <Form.Item name="napEnd" label="午睡结束(HH:mm)">
                  <Input placeholder="14:30" style={{ width: 120 }} />
                </Form.Item>
              </Space>
              <Form.Item name="geofenceRadius" label="电子围栏半径（米）" rules={[{ required: true }]}>
                <InputNumber min={100} max={3000} step={100} style={{ width: '100%' }} />
              </Form.Item>
              <Form.Item name="curfewTime" label="归家时间（HH:mm）" rules={[{ required: true }]}>
                <Input placeholder="21:00" />
              </Form.Item>
              <Form.Item name="wearingHabit" label="佩戴习惯" rules={[{ required: true }]}>
                <Input.TextArea rows={2} />
              </Form.Item>
            </Form>
          </>
        )}
      </Drawer>
    </Card>
  )
}

export default EldersPage
