import {
  AlertEvent,
  AlertType,
  ALERT_TYPE_LABEL,
  CareProfile,
  Closure,
  ClosureCategory,
  Elder,
  GridWorker,
  HeartRateSample,
  NapWindow,
  PlanStep,
  Severity,
  StepState,
  ThresholdChange,
  ThresholdChangeItem,
  Thresholds,
  TrajectoryPoint,
} from '../types'

// ===================== 演示参数 =====================
/** 家属响应超时（毫秒）。演示环境设为 3 分钟 */
export const FAMILY_TIMEOUT_MS = 3 * 60 * 1000
/** 电话核实无人接听达到该次数则建议上门 */
export const PHONE_NO_ANSWER_LIMIT = 2
/** 低电量阈值 */
export const LOW_BATTERY = 20

export const isNightTime = (d: Date) => d.getHours() >= 22 || d.getHours() < 6

/** 判断给定时间是否处于登记的午睡时段 */
export function inNapWindow(thresholds: Thresholds, at: number | Date): boolean {
  if (!thresholds.napStart || !thresholds.napEnd) return false
  const d = typeof at === 'number' ? new Date(at) : at
  const cur = d.getHours() * 60 + d.getMinutes()
  const [sh, sm] = thresholds.napStart.split(':').map(Number)
  const [eh, em] = thresholds.napEnd.split(':').map(Number)
  const start = sh * 60 + sm
  const end = eh * 60 + em
  return start <= end ? cur >= start && cur < end : cur >= start || cur < end
}

// ===================== 严重度评估 =====================

export function assessSeverity(
  type: AlertType,
  opts: { isNight: boolean; location: string; battery: number; historyFalseAlarms: number },
): Severity {
  let score = 0
  if (type === 'fall') score += 3
  if (type === 'heart_rate') score += 3
  if (type === 'stillness') score += 2
  if (type === 'away') score += 1
  if (type === 'offline') score += 1
  if (opts.isNight) score += 2
  if (opts.location.includes('浴室')) score += 2
  if (opts.battery <= LOW_BATTERY) score += 1
  // 误报史多可适当降级，但夜间/浴室等高风险场景不降级
  const riskyScene = opts.isNight || opts.location.includes('浴室')
  if (opts.historyFalseAlarms >= 3 && !riskyScene) score -= 1
  if (score >= 5) return 'high'
  if (score >= 3) return 'medium'
  return 'low'
}

// ===================== 处置流程生成 =====================

export interface PlanContext {
  elder: Elder
  type: AlertType
  location: string
  isNight: boolean
  battery: number
  severity: Severity
  gridWorkers: GridWorker[]
  dutyText: string
}

/** 依据告警类型、最近轨迹、历史误报、家属联系方式、值班人员生成处置流程 */
export function generatePlan(ctx: PlanContext): PlanStep[] {
  const { elder, type, location, isNight, battery, severity, gridWorkers, dutyText } = ctx
  const steps: PlanStep[] = []
  const firstContact = [...elder.contacts].sort((a, b) => a.priority - b.priority)[0]
  const worker = nearestWorker(elder, gridWorkers)
  const highFalse = elder.historyFalseAlarms >= 3
  const riskyScene = isNight || location.includes('浴室')

  steps.push({
    key: 'notify_family',
    title: '通知紧急联系人',
    desc: `按优先级通知 ${firstContact.name}（${firstContact.relation}，${firstContact.phone}）${
      firstContact.isLocal ? '，同城可到场' : '，异地需远程确认'
    }`,
    reason: `老人登记 ${elder.contacts.length} 位紧急联系人，按优先级排序`,
    conditional: false,
  })

  steps.push({
    key: 'family_confirm',
    title: '等待家属确认',
    desc: `家属可确认误报 / 请求电话核实 / 要求上门 / 直接拨打120。超过 ${Math.round(
      FAMILY_TIMEOUT_MS / 60000,
    )} 分钟未响应将自动升级社区处置`,
    reason: '家属是第一响应人，限时未响应需社区接管',
    conditional: false,
  })

  // 电话核实：误报史多或中低等级先电话
  if (highFalse || severity !== 'high') {
    steps.push({
      key: 'phone_verify',
      title: '电话核实老人状态',
      desc: `值班人员拨打老人电话 ${elder.phone}，连续 ${PHONE_NO_ANSWER_LIMIT} 次无人接听即升级上门`,
      reason: highFalse
        ? `该老人历史误报 ${elder.historyFalseAlarms} 次，优先电话核实降低无效上门`
        : `告警等级为${severity === 'medium' ? '重要' : '一般'}，先电话核实`,
      conditional: false,
    })
  }

  const visitReasons: string[] = []
  if (type === 'fall') visitReasons.push('跌倒告警需现场确认伤情')
  if (type === 'heart_rate') visitReasons.push(`心率异常，老人有${elder.chronicDiseases.join('、') || '慢病'}史`)
  if (type === 'stillness') visitReasons.push(`静止超阈值 ${elder.thresholds.stillnessMinutes} 分钟`)
  if (type === 'away') visitReasons.push(`超出电子围栏 ${elder.thresholds.geofenceRadius} 米且过归家时间 ${elder.thresholds.curfewTime}`)
  if (type === 'offline') visitReasons.push('设备离线需上门核查人与设备状态')
  if (riskyScene) visitReasons.push(isNight ? '夜间时段风险升级' : '浴室属跌倒高风险场景')
  steps.push({
    key: 'door_visit',
    title: '网格员上门处置',
    desc: `就近派单 ${worker.name}（负责${worker.buildings.join('/')}，约 ${worker.distanceMin} 分钟到达）。门禁：${elder.accessInfo}；钥匙托管：${elder.keyCustody}`,
    reason: visitReasons.join('；'),
    conditional: severity === 'low' && !riskyScene,
  })

  steps.push({
    key: 'link_property',
    title: '联动物业开门',
    desc: '上门无人开门时，联系物业协助开门或使用托管钥匙入户查看',
    reason: '兜底情形：上门无人应答',
    conditional: true,
  })

  steps.push({
    key: 'call_120',
    title: '联动120急救',
    desc: `发现伤情或家属直接呼救时拨打120，同步老人慢病史（${elder.chronicDiseases.join('、') || '无'}）与用药信息`,
    reason: '兜底情形：现场确认需要医疗救援',
    conditional: true,
  })

  steps.push({
    key: 'medical_follow',
    title: '就医跟进',
    desc: '记录送医医院与诊断结果，通知家属赶往，更新事件状态',
    reason: '联动120后必须记录就医去向',
    conditional: true,
  })

  if (battery <= LOW_BATTERY || type === 'offline') {
    steps.push({
      key: 'device_maintain',
      title: '设备维护',
      desc: battery <= LOW_BATTERY
        ? `告警时电量仅 ${battery}%，安排充电提醒或上门更换设备`
        : '设备频繁离线，安排上门检修并核对佩戴习惯',
      reason: battery <= LOW_BATTERY ? '低电量影响告警可靠性' : '离线告警指向设备/佩戴问题',
      conditional: true,
    })
  }

  steps.push({
    key: 'follow_up_close',
    title: '回访与结案复盘',
    desc: `24小时内回访老人与家属，生成误报原因/设备建议/响应时长复盘，沉淀照护画像。今日值班：${dutyText}`,
    reason: '每次事件闭环后优化阈值与照护责任',
    conditional: false,
  })

  return steps
}

/** 根据事件当前状态推导各流程步骤状态 */
export function deriveStepStates(ev: AlertEvent): Record<string, StepState> {
  const s: Record<string, StepState> = {}
  const has = (k: string) => ev.plan.some((p) => p.key === k)

  s.notify_family = 'done'
  if (ev.family.respondedAt) s.family_confirm = 'done'
  else if (ev.status === 'pending_family') s.family_confirm = 'active'
  else s.family_confirm = ev.family.timedOut ? 'skipped' : 'pending'

  if (has('phone_verify')) {
    const answered = ev.phoneAttempts.some((a) => a.result === 'answered')
    if (answered || ev.status === 'door_visit' || ev.status === 'medical' || ev.status === 'follow_up' || ev.status === 'closed')
      s.phone_verify = answered ? 'done' : ev.phoneAttempts.length > 0 ? 'done' : 'skipped'
    else if (ev.status === 'family_verifying') s.phone_verify = 'active'
    else s.phone_verify = 'pending'
  }

  if (has('door_visit')) {
    if (ev.doorVisit?.result) s.door_visit = 'done'
    else if (ev.doorVisit) s.door_visit = 'active'
    else s.door_visit = 'pending'
  }
  if (has('link_property')) {
    s.link_property = ev.doorVisit?.propertyInvolved || ev.doorVisit?.usedKeyCustody ? 'done' : 'pending'
  }
  if (has('call_120')) {
    s.call_120 = ev.medical?.called120 ? 'done' : 'pending'
  }
  if (has('medical_follow')) {
    s.medical_follow = ev.medical?.outcome ? 'done' : ev.medical?.called120 ? 'active' : 'pending'
  }
  if (has('device_maintain')) {
    s.device_maintain = ev.status === 'closed' ? 'done' : 'pending'
  }
  if (has('follow_up_close')) {
    if (ev.status === 'closed') s.follow_up_close = 'done'
    else if (ev.status === 'follow_up') s.follow_up_close = 'active'
    else s.follow_up_close = 'pending'
  }
  return s
}

// ===================== 升级规则检查 =====================

export interface EscalationCheck {
  kind: AlertEvent['escalations'][number]['kind']
  note: string
}

/** 返回本次检查新触发的升级情形（已存在的不重复） */
export function checkEscalations(ev: AlertEvent, elder: Elder, now: number): EscalationCheck[] {
  const out: EscalationCheck[] = []
  const has = (k: EscalationCheck['kind']) => ev.escalations.some((e) => e.kind === k)
  if (ev.status === 'closed') return out

  if (!has('night_bathroom') && (ev.isNight || ev.location.includes('浴室'))) {
    out.push({
      kind: 'night_bathroom',
      note: ev.isNight ? '告警发生在夜间（22:00-06:00），风险等级上调' : '告警发生在浴室，属跌倒高风险场景',
    })
  }
  if (!has('low_battery') && ev.batteryAtAlert <= LOW_BATTERY) {
    out.push({ kind: 'low_battery', note: `告警时设备电量仅 ${ev.batteryAtAlert}%，需同步安排设备维护` })
  }
  if (!has('family_timeout') && ev.status === 'pending_family' && !ev.family.respondedAt && now - ev.family.notifiedAt > FAMILY_TIMEOUT_MS) {
    out.push({ kind: 'family_timeout', note: `家属超过 ${Math.round(FAMILY_TIMEOUT_MS / 60000)} 分钟未响应，社区接管处置` })
  }
  const noAnswer = ev.phoneAttempts.filter((a) => a.result === 'no_answer').length
  if (!has('phone_no_answer') && noAnswer >= PHONE_NO_ANSWER_LIMIT) {
    out.push({ kind: 'phone_no_answer', note: `老人电话连续 ${noAnswer} 次无人接听，建议立即上门` })
  }
  if (!has('door_no_answer') && ev.doorVisit?.result === 'no_answer') {
    out.push({ kind: 'door_no_answer', note: '网格员上门无人开门，建议联动物业/使用托管钥匙' })
  }
  return out
}

// ===================== 工具 =====================

export function nearestWorker(elder: Elder, workers: GridWorker[]): GridWorker {
  return (
    workers.find((w) => w.buildings.includes(elder.building)) ??
    [...workers].sort((a, b) => a.distanceMin - b.distanceMin)[0]
  )
}

export const FALSE_REASONS = [
  '洗澡/充电时未佩戴手环',
  '手环佩戴过松导致误判',
  '老人午睡熟睡被误判（规律午睡时段）',
  '静止阈值过低（看书/看电视久坐）',
  '心率阈值不适配老人基础心率',
  '电子围栏半径过小',
  '设备电量不足导致数据异常',
  '老人正常活动被误判',
]

/** 结案时自动生成设备调整建议 */
export function buildDeviceSuggestion(category: ClosureCategory, falseReason: string | undefined, ev: AlertEvent, elder: Elder): string {
  const tips: string[] = []
  if (category === 'device_false') {
    switch (falseReason) {
      case '洗澡/充电时未佩戴手环':
        tips.push('建议为老人配备防水充电底座并调整夜间充电时段提醒')
        break
      case '手环佩戴过松导致误判':
        tips.push('建议上门指导正确佩戴方式，腕带留一指空隙')
        break
      case '老人午睡熟睡被误判（规律午睡时段）':
        tips.push(
          `建议将午睡时段 ${elder.thresholds.napStart ?? '13:00'}-${elder.thresholds.napEnd ?? '14:30'} 设为静止告警豁免/延后时段，并将静止阈值由 ${elder.thresholds.stillnessMinutes} 分钟上调至 ${elder.thresholds.stillnessMinutes + 30} 分钟，午睡期间结合心率监测兜底`,
        )
        break
      case '静止阈值过低（看书/看电视久坐）':
        tips.push(`建议将静止阈值由 ${elder.thresholds.stillnessMinutes} 分钟上调至 ${elder.thresholds.stillnessMinutes + 15} 分钟`)
        break
      case '心率阈值不适配老人基础心率':
        tips.push(`建议结合基础心率将心率区间由 ${elder.thresholds.heartRateLow}-${elder.thresholds.heartRateHigh} 放宽 5-10bpm`)
        break
      case '电子围栏半径过小':
        tips.push(`建议将电子围栏由 ${elder.thresholds.geofenceRadius} 米扩大至 ${elder.thresholds.geofenceRadius + 200} 米`)
        break
      case '设备电量不足导致数据异常':
        tips.push('建议开启低电自动提醒家属，并纳入每周设备巡检')
        break
      default:
        tips.push('建议复核告警阈值并结合老人作息重新标定')
    }
  }
  if (ev.batteryAtAlert <= LOW_BATTERY) tips.push('本次告警时电量偏低，建议为家属端开启充电提醒')
  if (category === 'care_gap') tips.push('建议提高巡访频次，并将家属提醒方式升级为电话+短信双通道')
  if (category === 'real_risk') tips.push('建议保持现有阈值灵敏度，必要时加装居家毫米波跌倒监测作为手环补充')
  return tips.join('；') || '设备运行正常，暂无调整建议'
}

/** 计算家属响应时长（分钟），未响应返回 null */
export function familyResponseMinutes(ev: AlertEvent, closedAt: number): number | null {
  if (ev.family.respondedAt) return Math.round((ev.family.respondedAt - ev.family.notifiedAt) / 60000)
  return null
}

/** 计算社区处置时效：告警发生到结案（分钟） */
export function communityHandleMinutes(ev: AlertEvent, closedAt: number): number {
  return Math.round((closedAt - ev.occurredAt) / 60000)
}

// ===================== 照护画像沉淀 =====================

export function sedimentProfile(profile: CareProfile, ev: AlertEvent, closure: Closure, now: number): CareProfile {
  const p: CareProfile = { ...profile, strategy: { ...profile.strategy }, riskTags: [...profile.riskTags] }
  if (closure.category === 'device_false') p.falseAlarmCount += 1
  if (closure.category === 'care_gap') p.careGapCount += 1
  if (closure.category === 'real_risk') p.realRiskCount += 1
  if (ev.family.timedOut) p.familyTimeoutCount += 1
  if (ev.type === 'offline') p.offlineCount += 1
  // 上门结果可能被后续入户结果覆盖，以升级记录为准
  if (ev.escalations.some((e) => e.kind === 'door_no_answer') || ev.doorVisit?.result === 'no_answer') p.doorNoAnswerCount += 1

  // 风险评分
  const score =
    p.realRiskCount * 3 + p.careGapCount * 2 + p.familyTimeoutCount * 2 + p.doorNoAnswerCount * 2 + p.offlineCount + p.falseAlarmCount
  p.riskLevel = score >= 10 ? 'high' : score >= 5 ? 'medium' : 'low'

  // 画像标签
  const tags: string[] = []
  if (p.familyTimeoutCount >= 2) tags.push('家属连续无人响应')
  if (p.offlineCount >= 2) tags.push('设备频繁离线')
  if (p.doorNoAnswerCount >= 1) tags.push('上门无人在家')
  if (p.falseAlarmCount >= 3) tags.push('设备误报偏多')
  if (p.realRiskCount >= 1) tags.push('发生过真实风险')
  if (p.careGapCount >= 1) tags.push('存在照护缺口')
  p.riskTags = tags.length ? tags : ['状态平稳']

  // 照护策略建议
  p.strategy.visitFrequency =
    p.riskLevel === 'high' ? '每日上门巡访 + 早晚两次电话' : p.riskLevel === 'medium' ? '隔日电话 + 每周上门一次' : '每周电话巡访一次'
  p.strategy.deviceMaintenance =
    p.offlineCount >= 2 || p.falseAlarmCount >= 3
      ? '安排上门检修设备并重新标定阈值'
      : ev.batteryAtAlert <= LOW_BATTERY
        ? '每周提醒充电，纳入设备巡检清单'
        : '按季度常规巡检'
  p.strategy.familyReminder =
    p.familyTimeoutCount >= 2 ? '升级为电话+短信+APP三通道，并约谈家属明确照护责任' : 'APP推送 + 短信提醒'
  p.updatedAt = now
  return p
}

export function emptyProfile(elderId: string, now: number): CareProfile {
  return {
    elderId,
    falseAlarmCount: 0,
    careGapCount: 0,
    realRiskCount: 0,
    familyTimeoutCount: 0,
    offlineCount: 0,
    doorNoAnswerCount: 0,
    riskLevel: 'low',
    riskTags: ['状态平稳'],
    strategy: {
      visitFrequency: '每周电话巡访一次',
      deviceMaintenance: '按季度常规巡检',
      familyReminder: 'APP推送 + 短信提醒',
    },
    updatedAt: now,
  }
}

export function alertTypeLabel(t: AlertType) {
  return ALERT_TYPE_LABEL[t]
}

// ===================== 午睡误报汇总与阈值审批调整 =====================

/** 午睡误报的统一结案原因（与 FALSE_REASONS 中一致） */
export const NAP_FALSE_REASON = '老人午睡熟睡被误判（规律午睡时段）'

export interface NapFalseSummary {
  elder: Elder
  /** 午睡静止误报事件（时间正序） */
  events: AlertEvent[]
  /** 家属确认次数 */
  confirmCount: number
  /** 误报跨越天数 */
  spanDays: number
  /** 午睡时段 */
  napWindow: NapWindow | undefined
  /** 午睡心率采样 */
  napHrSamples: HeartRateSample[]
  /** 午睡静息心率区间 [min,max] */
  hrRange: [number, number] | null
  /** 家属平均确认耗时（分钟） */
  avgResponseMinutes: number | null
  /** 误报时段附近的活动轨迹 */
  trajectoryAround: TrajectoryPoint[]
  /** 汇总后的调整建议 */
  suggestion: string
  /** 证据摘要文本（审批单与变更记录中留存） */
  evidenceSummary: string
}

/**
 * 汇总某位老人的午睡时段长时间静止误报：
 * 聚合午睡时段、静息心率、活动轨迹与家属确认记录，作为医生/社区调整阈值的依据。
 */
export function summarizeNapFalseAlarms(elder: Elder, allEvents: AlertEvent[], now: number): NapFalseSummary | null {
  const events = allEvents
    .filter(
      (e) =>
        e.elderId === elder.id &&
        e.type === 'stillness' &&
        e.status === 'closed' &&
        e.closure?.category === 'device_false' &&
        e.closure.falseReason === NAP_FALSE_REASON,
    )
    .sort((a, b) => a.occurredAt - b.occurredAt)
  if (!events.length) return null

  const napWindow = elder.napWindows[0]
  const napHrSamples = elder.heartRateSamples
    .filter((s) => s.context === 'nap')
    .sort((a, b) => a.at - b.at)
  const hrRange: [number, number] | null = napHrSamples.length
    ? [Math.min(...napHrSamples.map((s) => s.bpm)), Math.max(...napHrSamples.map((s) => s.bpm))]
    : null
  const responses = events.map((e) => e.closure?.familyResponseMinutes).filter((m): m is number => typeof m === 'number')
  const avgResponseMinutes = responses.length ? Math.round(responses.reduce((a, b) => a + b, 0) / responses.length) : null
  const firstAt = events[0].occurredAt
  const spanDays = Math.max(1, Math.round((now - firstAt) / (24 * 3600 * 1000)))
  const trajectoryAround = [...elder.trajectory].sort((a, b) => b.at - a.at).slice(0, 3)

  const curStill = elder.thresholds.stillnessMinutes
  const suggestion =
    `建议${napWindow ? `将 ${napWindow.start}-${napWindow.end} 设为午睡静止告警延后时段` : '按老人午睡规律设置静止告警延后时段'}，` +
    `午睡时段静止阈值由 ${curStill} 分钟上调至 ${curStill + 30} 分钟，期间心率低于 ${elder.thresholds.heartRateLow}bpm 或长时间无心率数据仍立即告警；` +
    '调整后设置 14 天观察期，跟踪午睡误报是否下降及真实风险有无遗漏。'

  const hrText = hrRange ? `${hrRange[0]}-${hrRange[1]}bpm` : '无采样'
  const evidenceSummary =
    `近 ${spanDays} 天午睡时段（${napWindow ? napWindow.start + '-' + napWindow.end : '未登记'}）连续 ${events.length} 次长时间静止告警，` +
    `均由家属确认误报（平均 ${avgResponseMinutes ?? '—'} 分钟确认）；午睡静息心率 ${hrText}，生命体征平稳；` +
    `告警前后轨迹：${trajectoryAround.map((t) => t.place).join('→') || '家中'}。`

  return {
    elder,
    events,
    confirmCount: events.length,
    spanDays,
    napWindow,
    napHrSamples,
    hrRange,
    avgResponseMinutes,
    trajectoryAround,
    suggestion,
    evidenceSummary,
  }
}

// ===================== 阈值差异与变更记录 =====================

export const THRESHOLD_FIELD_LABEL: Record<keyof Thresholds, string> = {
  heartRateLow: '心率下限',
  heartRateHigh: '心率上限',
  stillnessMinutes: '静止时长阈值',
  geofenceRadius: '电子围栏半径',
  curfewTime: '归家时间',
  napStart: '午睡开始时间',
  napEnd: '午睡结束时间',
}

const formatThresholdValue = (key: keyof Thresholds, v: Thresholds[keyof Thresholds]): string => {
  if (v === undefined || v === '') return '未设置'
  if (key === 'stillnessMinutes') return `${v}分钟`
  if (key === 'heartRateLow' || key === 'heartRateHigh') return `${v}bpm`
  if (key === 'geofenceRadius') return `${v}米`
  return String(v)
}

/** 比对调整前后阈值，返回发生变化的项 */
export function diffThresholds(before: Thresholds, after: Thresholds): ThresholdChangeItem[] {
  const keys = Object.keys(THRESHOLD_FIELD_LABEL) as (keyof Thresholds)[]
  const out: ThresholdChangeItem[] = []
  for (const key of keys) {
    const b = before[key]
    const a = after[key]
    if (String(b ?? '') !== String(a ?? '')) {
      out.push({
        key,
        label: THRESHOLD_FIELD_LABEL[key],
        before: formatThresholdValue(key, b),
        after: formatThresholdValue(key, a),
      })
    }
  }
  return out
}

/** 某事件发生时已生效的阈值变更（供事件详情回看"当时为何降低/延后告警"） */
export function activeChangesForEvent(changes: ThresholdChange[], ev: AlertEvent): ThresholdChange[] {
  return changes
    .filter((c) => c.elderId === ev.elderId && c.createdAt <= ev.occurredAt)
    .sort((a, b) => b.createdAt - a.createdAt)
}

export interface ObservationResult {
  /** 调整后观察期内同类型（静止）误报事件 */
  falseAfter: AlertEvent[]
  /** 调整后观察期内结案的真实风险事件 */
  realAfter: AlertEvent[]
  /** 是否仍在观察期内 */
  inPeriod: boolean
  /** 观察建议结论 */
  outcome: ThresholdChange['outcome']
  note: string
}

/**
 * 调整后的持续观察：误报是否下降、真实风险是否被遗漏。
 * 观察期内一旦出现真实风险事件（尤其静止/心率类），提示回看是否与放宽阈值有关。
 */
export function observeThresholdChange(change: ThresholdChange, allEvents: AlertEvent[], now: number): ObservationResult {
  const after = allEvents
    .filter((e) => e.elderId === change.elderId && e.occurredAt > change.createdAt && e.status === 'closed')
    .sort((a, b) => a.occurredAt - b.occurredAt)
  const falseAfter = after.filter((e) => e.type === 'stillness' && e.closure?.category === 'device_false')
  const realAfter = after.filter((e) => e.closure?.category === 'real_risk')
  const inPeriod = now < change.reviewUntil

  if (realAfter.length > 0) {
    return {
      falseAfter,
      realAfter,
      inPeriod,
      outcome: 'missed_risk',
      note: `观察期内出现 ${realAfter.length} 起真实风险事件，需立即回看阈值调整是否导致告警延迟或遗漏，必要时回退阈值。`,
    }
  }
  if (inPeriod) {
    return {
      falseAfter,
      realAfter,
      inPeriod,
      outcome: 'observing',
      note:
        falseAfter.length === 0
          ? `观察期内暂无午睡静止误报，继续观察至 ${new Date(change.reviewUntil).toLocaleDateString('zh-CN')}。`
          : `观察期内仍有 ${falseAfter.length} 起静止误报，需关注调整是否到位。`,
    }
  }
  return {
    falseAfter,
    realAfter,
    inPeriod: false,
    outcome: falseAfter.length === 0 ? 'effective' : 'observing',
    note:
      falseAfter.length === 0
        ? '观察期结束，午睡静止误报未再发生，且无真实风险遗漏，可确认调整有效。'
        : `观察期结束但仍有 ${falseAfter.length} 起静止误报，建议医生复评是否进一步调整或回退。`,
  }
}
