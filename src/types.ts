// ===================== 基础类型 =====================

/** 告警类型 */
export type AlertType = 'fall' | 'heart_rate' | 'stillness' | 'away' | 'offline'

export const ALERT_TYPE_LABEL: Record<AlertType, string> = {
  fall: '跌倒告警',
  heart_rate: '心率异常',
  stillness: '长时间静止',
  away: '离家未归',
  offline: '设备离线',
}

/** 事件状态机 */
export type EventStatus =
  | 'pending_family' // 待家属确认
  | 'family_verifying' // 电话核实中
  | 'door_visit' // 上门处置中
  | 'medical' // 就医中
  | 'follow_up' // 待回访结案
  | 'closed' // 已结案

export const EVENT_STATUS_LABEL: Record<EventStatus, string> = {
  pending_family: '待家属确认',
  family_verifying: '电话核实中',
  door_visit: '上门处置中',
  medical: '就医中',
  follow_up: '待回访结案',
  closed: '已结案',
}

export type Severity = 'high' | 'medium' | 'low'
export const SEVERITY_LABEL: Record<Severity, string> = {
  high: '紧急',
  medium: '重要',
  low: '一般',
}

/** 升级情形（触发即记录在事件内） */
export type EscalationKind =
  | 'family_timeout' // 家属迟迟未响应
  | 'phone_no_answer' // 老人电话无人接
  | 'low_battery' // 设备低电
  | 'night_bathroom' // 夜间/浴室高风险场景
  | 'door_no_answer' // 网格员上门无人开门
  | 'need_property' // 需联动物业
  | 'need_120' // 需联动120

export const ESCALATION_LABEL: Record<EscalationKind, string> = {
  family_timeout: '家属超时未响应',
  phone_no_answer: '老人电话无人接听',
  low_battery: '设备电量过低',
  night_bathroom: '夜间/浴室高风险场景',
  door_no_answer: '上门无人开门',
  need_property: '需联动物业开门',
  need_120: '需联动120急救',
}

// ===================== 老人与设备 =====================

export interface EmergencyContact {
  name: string
  relation: string
  phone: string
  isLocal: boolean // 是否同城
  priority: number // 通知顺序
}

/** 告警阈值（绑定手环时设定，可调整） */
export interface Thresholds {
  heartRateLow: number // 心率下限 bpm
  heartRateHigh: number // 心率上限 bpm
  stillnessMinutes: number // 静止时长阈值（分钟）
  geofenceRadius: number // 电子围栏半径（米）
  curfewTime: string // 归家时间 HH:mm
}

/** 可调整的阈值项 */
export type ThresholdKey = keyof Thresholds

export const THRESHOLD_FIELD_LABEL: Record<ThresholdKey, string> = {
  heartRateLow: '心率下限',
  heartRateHigh: '心率上限',
  stillnessMinutes: '静止时长阈值',
  geofenceRadius: '电子围栏半径',
  curfewTime: '归家时间',
}

/** 午睡时段（误报高发场景，用于汇总与按时段差异化阈值） */
export interface NapWindow {
  start: string // 午睡开始 HH:mm
  end: string // 午睡结束 HH:mm
}

/** 心率采样点（午睡时段心率佐证：真实静止时心率平稳） */
export interface HeartRateSample {
  at: number
  bpm: number
}

/**
 * 阈值变更记录（审批留痕，永久保留）。
 * 状态机：observing（观察期）→ effective（观察通过，持续生效）/ reverted（观察期发现漏报，已回退）。
 * 后续出现真实异常时，社区可凭本记录回看当时为何降低或延后告警。
 */
export interface ThresholdChangeRecord {
  id: string
  elderId: string
  changedAt: number
  approver: string // 审批人（医生/社区负责人）
  approverRole: string // 审批人身份，如：社区医生
  reason: string // 调整原因（必填）
  evidenceEventIds: string[] // 依据的误报事件（家属确认记录）
  before: Partial<Thresholds>
  after: Partial<Thresholds>
  /** 午睡时段延后策略：仅午睡时段把静止告警延后 N 分钟（null 表示不延后） */
  napDelayMinutes: number | null
  observeUntil: number // 观察期截止时间
  status: 'observing' | 'effective' | 'reverted'
  observation?: {
    reviewedAt: number
    reviewedBy: string
    falseAlarmsBefore: number // 观察依据：调整前同口径误报数
    falseAlarmsAfter: number // 观察期内误报数
    missedRisk: boolean // 观察期内是否发现被遗漏的真实风险
    note: string
  }
  revertedAt?: number
  revertedBy?: string
  revertReason?: string
}

export interface TrajectoryPoint {
  at: number
  place: string
}

export interface Elder {
  id: string
  name: string
  age: number
  gender: string
  phone: string
  address: string
  building: string // 楼栋，用于匹配网格员
  chronicDiseases: string[] // 慢病
  contacts: EmergencyContact[] // 紧急联系人
  activityRange: string[] // 常用活动范围
  wearingHabit: string // 佩戴习惯
  deviceId: string
  battery: number // 设备电量 %
  thresholds: Thresholds
  accessInfo: string // 门禁信息
  keyCustody: string // 钥匙托管
  historyFalseAlarms: number // 历史误报次数
  lastVisit: { at: number; worker: string; note: string } // 上一次回访记录
  trajectory: TrajectoryPoint[] // 最近活动轨迹
  napWindow?: NapWindow // 午睡时段（老人日常午睡作息）
  heartRateSamples?: HeartRateSample[] // 最近心率采样（午睡时段心率佐证）
}

// ===================== 处置流程 =====================

export type PlanStepKey =
  | 'notify_family'
  | 'family_confirm'
  | 'phone_verify'
  | 'door_visit'
  | 'link_property'
  | 'call_120'
  | 'medical_follow'
  | 'device_maintain'
  | 'follow_up_close'

export interface PlanStep {
  key: PlanStepKey
  title: string
  desc: string
  reason: string // 生成该步骤的依据
  conditional: boolean // 是否条件触发
}

export type StepState = 'done' | 'active' | 'pending' | 'skipped'

// ===================== 事件 =====================

export interface TimelineEntry {
  at: number
  actor: 'device' | 'system' | 'family' | 'community' | 'medical'
  kind: 'alert' | 'confirm' | 'visit' | 'handle' | 'medical' | 'followup' | 'escalation' | 'close'
  title: string
  detail?: string
}

export interface PhoneAttempt {
  at: number
  by: string
  result: 'answered' | 'no_answer'
  note?: string
}

export interface AlertEvent {
  id: string
  elderId: string
  type: AlertType
  severity: Severity
  location: string // 告警位置：家-浴室 / 家-客厅 / 社区花园 / —（离线）
  isNight: boolean
  occurredAt: number
  batteryAtAlert: number
  status: EventStatus
  plan: PlanStep[]
  escalations: { kind: EscalationKind; at: number; note: string }[]

  family: {
    contactName: string
    contactPhone: string
    notifiedAt: number
    respondedAt?: number
    response?: 'false_alarm' | 'request_call' | 'request_visit' | 'called_120'
    note?: string
    timedOut: boolean
  }
  phoneAttempts: PhoneAttempt[]
  doorVisit?: {
    dispatchedAt: number
    assignee: string
    arrivedAt?: number
    result?: 'ok' | 'no_answer' | 'need_medical'
    note?: string
    propertyInvolved: boolean
    usedKeyCustody: boolean
  }
  medical?: {
    called120: boolean
    at?: number
    hospital?: string
    outcome?: string
  }
  followUp?: { at: number; by: string; note: string }
  closure?: Closure
  timeline: TimelineEntry[]
}

// ===================== 结案与复盘 =====================

export type ClosureCategory = 'device_false' | 'care_gap' | 'real_risk'
export const CLOSURE_LABEL: Record<ClosureCategory, string> = {
  device_false: '设备误报',
  care_gap: '照护缺口',
  real_risk: '真实风险',
}

export interface Closure {
  closedAt: number
  closedBy: string
  category: ClosureCategory
  falseReason?: string // 误报原因
  deviceSuggestion: string // 设备调整建议
  familyResponseMinutes: number | null // 家属响应时长（分钟）
  communityHandleMinutes: number // 社区处置时效（分钟）
  summary: string
}

// ===================== 照护画像 =====================

export interface CareProfile {
  elderId: string
  falseAlarmCount: number // 设备误报
  careGapCount: number // 照护缺口
  realRiskCount: number // 真实风险
  familyTimeoutCount: number // 家属无人响应
  offlineCount: number // 设备频繁离线
  doorNoAnswerCount: number // 上门无人在家
  riskLevel: 'high' | 'medium' | 'low'
  riskTags: string[] // 画像标签
  strategy: {
    visitFrequency: string // 巡访频次
    deviceMaintenance: string // 设备维护
    familyReminder: string // 家属提醒方式
  }
  updatedAt: number
}

// ===================== 人员 =====================

export interface GridWorker {
  id: string
  name: string
  phone: string
  buildings: string[] // 负责楼栋
  distanceMin: number // 预计到达分钟
}

export interface DutyStaff {
  role: string
  name: string
  phone: string
}

export type Role = 'community' | 'family'

export interface Session {
  role: Role
  userName: string
  elderId?: string // 家属账号绑定的老人
}
