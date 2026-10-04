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

/** 午睡时段（HH:mm，午睡均在白天，不做跨天处理） */
export interface NapWindow {
  start: string // 开始时间 HH:mm
  end: string // 结束时间 HH:mm
}

/** 心率采样（午睡静息心率佐证，用于判断静止期间生命体征平稳） */
export interface HeartRateSample {
  at: number
  bpm: number
  context: 'nap' | 'rest' | 'activity' // 采样场景
}

/** 告警阈值（绑定手环时设定，可调整） */
export interface Thresholds {
  heartRateLow: number // 心率下限 bpm
  heartRateHigh: number // 心率上限 bpm
  stillnessMinutes: number // 静止时长阈值（分钟）
  geofenceRadius: number // 电子围栏半径（米）
  curfewTime: string // 归家时间 HH:mm
  napStart?: string // 午睡开始时间 HH:mm（该时段静止告警延后/放宽）
  napEnd?: string // 午睡结束时间 HH:mm
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
  napWindows: NapWindow[] // 规律午睡时段（家属多次确认后沉淀）
  heartRateSamples: HeartRateSample[] // 近期心率采样（午睡静息佐证）
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
  kind: 'alert' | 'confirm' | 'visit' | 'handle' | 'medical' | 'followup' | 'escalation' | 'close' | 'threshold'
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

// ===================== 误报阈值审批调整 =====================

/** 变更中的单个阈值项 */
export interface ThresholdChangeItem {
  key: keyof Thresholds
  label: string
  before: string
  after: string
}

/** 观察期评估结论 */
export type ThresholdReviewOutcome = 'observing' | 'effective' | 'missed_risk' | 'reverted'

export const THRESHOLD_REVIEW_LABEL: Record<ThresholdReviewOutcome, string> = {
  observing: '观察中',
  effective: '观察通过·误报下降',
  missed_risk: '观察告警·疑似漏报真实风险',
  reverted: '已回退阈值',
}

/**
 * 阈值变更审批记录。
 * 家属多次确认午睡静止误报后，社区汇总午睡时段/心率/轨迹/确认记录，
 * 由医生或社区审批调整；调整后持续观察误报是否下降、真实风险是否被遗漏。
 * 后续出现真实异常时，凭此记录回看当时为何降低或延后告警。
 */
export interface ThresholdChange {
  id: string
  elderId: string
  createdAt: number
  /** 审批人 */
  approvedBy: string
  approverRole: '社区医生' | '社区值班员'
  /** 调整原因 */
  reason: string
  /** 汇总依据：关联的误报事件 id（午睡时段静止告警、家属确认记录） */
  evidenceEventIds: string[]
  /** 汇总依据摘要：午睡时段、心率区间、活动轨迹、家属确认次数 */
  evidenceSummary: string
  /** 医生/社区的调整意见 */
  advice: string
  /** 观察期天数 */
  reviewDays: number
  reviewUntil: number
  changes: ThresholdChangeItem[]
  /** 调整前/后阈值快照 */
  before: Thresholds
  after: Thresholds
  status: 'active' | 'reviewed'
  outcome: ThresholdReviewOutcome
  /** 观察期评估时间与评估人 */
  reviewedAt?: number
  reviewedBy?: string
  reviewNote?: string
  /** 观察期内漏报/迟报的真实风险事件 id（若有） */
  missedRiskEventIds: string[]
  /** 观察期内该老人同类型的误报事件 id（验证误报是否下降） */
  falseAlarmEventIds: string[]
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
