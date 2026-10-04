import React from 'react'
import { Card, Tag, Timeline, Typography } from 'antd'
import {
  AlertOutlined,
  CheckCircleOutlined,
  HomeOutlined,
  MedicineBoxOutlined,
  PhoneOutlined,
  SettingOutlined,
  UserOutlined,
  WarningOutlined,
} from '@ant-design/icons'
import { AlertEvent, TimelineEntry } from '../types'
import { fmtTime } from './common'

const { Text } = Typography

const KIND_META: Record<TimelineEntry['kind'], { color: string; icon: React.ReactNode; label: string }> = {
  alert: { color: 'red', icon: <AlertOutlined />, label: '告警' },
  confirm: { color: 'blue', icon: <UserOutlined />, label: '确认' },
  visit: { color: 'purple', icon: <HomeOutlined />, label: '上门' },
  handle: { color: 'geekblue', icon: <PhoneOutlined />, label: '处置' },
  medical: { color: 'volcano', icon: <MedicineBoxOutlined />, label: '就医' },
  followup: { color: 'cyan', icon: <CheckCircleOutlined />, label: '回访' },
  escalation: { color: 'orange', icon: <WarningOutlined />, label: '升级' },
  close: { color: 'green', icon: <CheckCircleOutlined />, label: '结案' },
  threshold: { color: 'gold', icon: <SettingOutlined />, label: '阈值' },
}

const ACTOR_LABEL: Record<TimelineEntry['actor'], string> = {
  device: '设备',
  system: '系统',
  family: '家属',
  community: '社区',
  medical: '医疗',
}

/** 同一事件内的完整记录：告警、确认、上门、处置、就医、回访 */
const EventTimeline: React.FC<{ event: AlertEvent }> = ({ event }) => (
  <Card size="small" title="事件全程记录（告警 · 确认 · 上门 · 处置 · 就医 · 回访）" style={{ marginBottom: 12 }}>
    <Timeline
      items={[...event.timeline]
        .sort((a, b) => a.at - b.at)
        .map((t) => ({
          color: KIND_META[t.kind].color,
          dot: KIND_META[t.kind].icon,
          children: (
            <div>
              <Text strong style={{ fontSize: 13 }}>
                {t.title}
              </Text>{' '}
              <Tag style={{ marginLeft: 4 }}>{KIND_META[t.kind].label}</Tag>
              <Tag color="default">{ACTOR_LABEL[t.actor]}</Tag>
              <div>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {fmtTime(t.at)}
                  {t.detail ? ` · ${t.detail}` : ''}
                </Text>
              </div>
            </div>
          ),
        }))}
    />
  </Card>
)

export default EventTimeline
