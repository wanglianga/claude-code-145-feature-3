import React from 'react'
import { Card, Descriptions, Progress, Space, Tag, Timeline, Typography } from 'antd'
import { EnvironmentOutlined, MedicineBoxOutlined, PhoneOutlined } from '@ant-design/icons'
import { Elder } from '../types'
import { fmtTime } from './common'

const { Text } = Typography

/** 老人信息卡：绑定信息 + 设备 + 轨迹（社区端视角含门禁/钥匙/回访） */
const ElderInfoCard: React.FC<{ elder: Elder; communityView?: boolean }> = ({ elder, communityView = true }) => {
  const batteryStatus = elder.battery <= 20 ? 'exception' : elder.battery <= 50 ? 'normal' : 'success'
  return (
    <Card size="small" title={`${elder.name} · ${elder.age}岁 · ${elder.gender}`} style={{ marginBottom: 12 }}>
      <Descriptions column={1} size="small" bordered>
        <Descriptions.Item label="住址">{elder.address}</Descriptions.Item>
        <Descriptions.Item label="慢病">
          <Space wrap size={4}>
            {elder.chronicDiseases.map((d) => (
              <Tag key={d} icon={<MedicineBoxOutlined />} color="magenta">
                {d}
              </Tag>
            ))}
          </Space>
        </Descriptions.Item>
        <Descriptions.Item label="紧急联系人">
          <Space direction="vertical" size={2}>
            {[...elder.contacts]
              .sort((a, b) => a.priority - b.priority)
              .map((c) => (
                <Text key={c.phone} style={{ fontSize: 12 }}>
                  <PhoneOutlined /> {c.name}（{c.relation}）{c.phone} {c.isLocal ? <Tag color="green">同城</Tag> : <Tag>异地</Tag>}
                </Text>
              ))}
          </Space>
        </Descriptions.Item>
        <Descriptions.Item label="常用活动范围">
          <Space wrap size={4}>
            {elder.activityRange.map((p) => (
              <Tag key={p} icon={<EnvironmentOutlined />}>
                {p}
              </Tag>
            ))}
          </Space>
        </Descriptions.Item>
        <Descriptions.Item label="设备电量">
          <Space>
            <Progress percent={elder.battery} size="small" status={batteryStatus} style={{ width: 120 }} />
            <Text type={elder.battery <= 20 ? 'danger' : undefined}>{elder.deviceId}</Text>
          </Space>
        </Descriptions.Item>
        <Descriptions.Item label="佩戴习惯">{elder.wearingHabit}</Descriptions.Item>
        <Descriptions.Item label="告警阈值">
          心率 {elder.thresholds.heartRateLow}-{elder.thresholds.heartRateHigh}bpm · 静止{elder.thresholds.stillnessMinutes}分钟 · 围栏
          {elder.thresholds.geofenceRadius}米 · 归家{elder.thresholds.curfewTime}
        </Descriptions.Item>
        {elder.napWindow && (
          <Descriptions.Item label="午睡时段">
            {elder.napWindow.start}-{elder.napWindow.end}（该时段静止告警可按审批策略延后）
          </Descriptions.Item>
        )}
        <Descriptions.Item label="历史误报">{elder.historyFalseAlarms} 次</Descriptions.Item>
        {communityView && (
          <>
            <Descriptions.Item label="门禁信息">{elder.accessInfo}</Descriptions.Item>
            <Descriptions.Item label="钥匙托管">{elder.keyCustody}</Descriptions.Item>
            <Descriptions.Item label="上次回访">
              {fmtTime(elder.lastVisit.at)} · {elder.lastVisit.worker}：{elder.lastVisit.note}
            </Descriptions.Item>
          </>
        )}
      </Descriptions>
      <div style={{ marginTop: 8 }}>
        <Text strong style={{ fontSize: 12 }}>
          最近活动轨迹
        </Text>
        <Timeline
          style={{ marginTop: 8 }}
          items={elder.trajectory.map((t) => ({
            children: (
              <Text style={{ fontSize: 12 }}>
                {fmtTime(t.at)} {t.place}
              </Text>
            ),
          }))}
        />
      </div>
    </Card>
  )
}

export default ElderInfoCard
