import React, { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button, Card, Drawer, Form, Input, Progress, Space, Table, Tag, Typography, message } from 'antd'
import { EditOutlined, SlidersOutlined } from '@ant-design/icons'
import { useStore } from '../store/useStore'
import { Elder } from '../types'
import { fmtTime } from '../components/common'
import { describeChange } from '../store/workflow'

const { Text } = Typography

/** 老人档案与设备绑定：登记信息、佩戴习惯维护；告警阈值须经审批在「误报阈值调整」页变更并留痕 */
const EldersPage: React.FC = () => {
  const nav = useNavigate()
  const elders = useStore((s) => s.elders)
  const profiles = useStore((s) => s.profiles)
  const changes = useStore((s) => s.thresholdChanges)
  const updateWearingHabit = useStore((s) => s.updateWearingHabit)
  const [editing, setEditing] = useState<Elder | null>(null)
  const [form] = Form.useForm()

  const openEdit = (e: Elder) => {
    setEditing(e)
    form.setFieldsValue({ wearingHabit: e.wearingHabit })
  }

  const activeChangeOf = (elderId: string) => changes.find((c) => c.elderId === elderId && c.status !== 'reverted')

  return (
    <Card
      size="small"
      title="老人档案与手环绑定"
      extra={
        <Button type="primary" ghost icon={<SlidersOutlined />} onClick={() => nav('/thresholds')}>
          误报阈值调整（审批留痕）
        </Button>
      }
    >
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
            render: (_, e) => {
              const ac = activeChangeOf(e.id)
              return (
                <Space direction="vertical" size={0}>
                  <Text style={{ fontSize: 12 }}>
                    心率{e.thresholds.heartRateLow}-{e.thresholds.heartRateHigh} · 静止{e.thresholds.stillnessMinutes}分 · 围栏
                    {e.thresholds.geofenceRadius}米 · 归家{e.thresholds.curfewTime}
                  </Text>
                  {ac ? (
                    <Text type="warning" style={{ fontSize: 11 }}>
                      {ac.status === 'observing' ? '观察期中' : '已审批调整'}：{describeChange(ac)}
                    </Text>
                  ) : e.napWindow ? (
                    <Text type="secondary" style={{ fontSize: 11 }}>
                      午睡 {e.napWindow.start}-{e.napWindow.end}（未配置时段延后）
                    </Text>
                  ) : null}
                </Space>
              )
            },
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
            width: 200,
            render: (_, e) => (
              <Space size={4}>
                <Button size="small" icon={<SlidersOutlined />} onClick={() => nav(`/thresholds?elder=${e.id}`)}>
                  阈值审批
                </Button>
                <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(e)}>
                  佩戴习惯
                </Button>
              </Space>
            ),
          },
        ]}
      />
      <Drawer
        title={editing ? `维护佩戴习惯：${editing.name}` : ''}
        open={!!editing}
        onClose={() => setEditing(null)}
        width={420}
        extra={
          <Button
            type="primary"
            onClick={() =>
              form.validateFields().then((v) => {
                if (!editing) return
                updateWearingHabit(editing.id, v.wearingHabit)
                setEditing(null)
                message.success('佩戴习惯已更新')
              })
            }
          >
            保存
          </Button>
        }
      >
        {editing && (
          <>
            <Text type="secondary" style={{ fontSize: 12 }}>
              设备 {editing.deviceId} · 告警阈值调整需经医生或社区负责人审批，请进入「误报阈值调整」页办理并留存原因。
            </Text>
            <Form form={form} layout="vertical" style={{ marginTop: 12 }}>
              <Form.Item name="wearingHabit" label="佩戴习惯" rules={[{ required: true }]}>
                <Input.TextArea rows={3} />
              </Form.Item>
            </Form>
            <Text type="secondary" style={{ fontSize: 12 }}>
              建档回访：{fmtTime(editing.lastVisit.at)} · {editing.lastVisit.worker}：{editing.lastVisit.note}
            </Text>
          </>
        )}
      </Drawer>
    </Card>
  )
}

export default EldersPage
