import {
  AlertEvent,
  AlertType,
  ALERT_TYPE_LABEL,
  CareProfile,
  Closure,
  ClosureCategory,
  Elder,
  GridWorker,
  NapWindow,
  PlanStep,
  Severity,
  StepState,
  ThresholdChangeRecord,
} from '../types'

// ===================== 演示参数 =====================
/** 家属响应超时（毫秒）。演示环境设为 3 分钟 */
export const FAMILY_TIMEOUT_MS = 3 * 60 * 1000
/** 电话核实无人接听达到该次数则建议上门 */
export const PHONE_NO_ANSWER_LIMIT = 2
/** 低电量阈值 */
export const LOW_BATTERY = 20

export const isNightTime = (d: Date) => d.getHours() >= 22 || d.getHours() < 6

// ===================== 午睡时段与误报汇总 =====================

/** HH:mm 转当天分钟数 */
export function hhmmToMin(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}

/** 时间戳是否落在午睡时段（支持跨正午，不跨午夜） */
export function isInNapWindow(ts: number, nap?: NapWindow): boolean {
  if (!nap) return false
  const d = new Date(ts)
  const cur = d.getHours() * 60 + d.getMinutes()
  const start = hhmmToMin(nap.start)
  let end = hhmmToMin(nap.end)
  if (end <= start) end += 24 * 60
  let c = cur
  if (c < start) c += 24 * 60
  return c >= start && c < end
}

export interface NapFalseAlarmSummary {
  window: NapWindow
  total: number // 午睡时段静止误报数（家属确认）
  events: AlertEvent[]
  dates: string[] // 误报发生的日期（MM-DD）
  times: string[] // 误报发生的具体时间（HH:mm）
  heartRateStats: { min: number; max: number; avg: number; stable: boolean } | null
  familyConfirmers: { name: string; count: number }[]
  places: string[]
}

/**
 * 汇总某老人午睡时段的长时间静止误报：
 * 时段、心率（午睡采样是否平稳）、活动轨迹（告警位置）、家属确认记录。
 * 仅统计「家属确认误报」或「已结案为设备误报」的静止告警。
 */
export function summarizeNapFalseAlarms(elder: Elder, events: AlertEvent[]): NapFalseAlarmSummary | null {
  if (!elder.napWindow) return null
  const napEvents = events.filter(
    (ev) =>
      ev.elderId === elder.id &&
      ev.type === 'stillness' &&
      isInNapWindow(ev.occurredAt, elder.napWindow) &&
      (ev.family.response === 'false_alarm' || ev.closure?.category === 'device_false'),
  )
  if (napEvents.length === 0) return null

  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const samples = (elder.heartRateSamples ?? []).filter((s) => isInNapWindow(s.at, elder.napWindow))
  let heartRateStats: NapFalseAlarmSummary['heartRateStats'] = null
  if (samples.length) {
    const bpms = samples.map((s) => s.bpm)
    const min = Math.min(...bpms)
    const max = Math.max(...bpms)
    const avg = Math.round(bpms.reduce((a, b) => a + b, 0) / bpms.length)
    heartRateStats = { min, max, avg, stable: max - min <= 12 }
  }

  const confirmerMap = new Map<string, number>()
  for (const ev of napEvents) {
    const name = ev.family.contactName
    confirmerMap.set(name, (confirmerMap.get(name) ?? 0) + 1)
  }

  return {
    window: elder.napWindow,
    total: napEvents.length,
    events: [...napEvents].sort((a, b) => b.occurredAt - a.occurredAt),
    dates: napEvents.map((ev) => `${pad(new Date(ev.occurredAt).getMonth() + 1)}-${pad(new Date(ev.occurredAt).getDate())}`),
    times: napEvents.map((ev) => `${pad(new Date(ev.occurredAt).getHours())}:${pad(new Date(ev.occurredAt).getMinutes())}`),
    heartRateStats,
    familyConfirmers: [...confirmerMap.entries()].map(([name, count]) => ({ name, count })),
    places: [...new Set(napEvents.map((ev) => ev.location))],
  }
}

/** 系统依据午睡误报汇总给出的阈值调整建议 */
export function suggestNapThresholdChange(elder: Elder, summary: NapFalseAlarmSummary | null): {
  stillnessMinutes: number
  napDelayMinutes: number
  basis: string
} | null {
  if (!summary || summary.total < 2) return null
  const current = elder.thresholds.stillnessMinutes
  // 午睡场景心率平稳（真实睡眠），建议把午睡时段静止告警延后 15~30 分钟
  const napDelayMinutes = summary.heartRateStats?.stable ? 30 : 15
  return {
    stillnessMinutes: current,
    napDelayMinutes,
    basis:
      `近 ${summary.total} 次午睡时段（${summary.window.start}-${summary.window.end}）长时间静止告警均经家属确认误报，` +
      `误报时刻集中在 ${summary.times.slice(0, 4).join('、')}；` +
      (summary.heartRateStats
        ? `午睡时段心率 ${summary.heartRateStats.min}-${summary.heartRateStats.max}bpm（均值${summary.heartRateStats.avg}），${summary.heartRateStats.stable ? '波动平稳符合睡眠特征' : '略有波动'}，`
        : '午睡时段缺少连续心率采样，') +
      `活动轨迹显示告警位置为${summary.places.join('、')}，符合午睡作息。` +
      `建议仅在午睡时段将静止告警延后 ${napDelayMinutes} 分钟（心率异常/跌倒告警不受影响），并经医生审批后进入观察期。`,
  }
}

// ===================== 阈值变更：时点查询与观察评估 =====================

/** 某一时点生效中的阈值变更（观察期与生效期均参与判定；已回退的不参与） */
export function activeChangeAt(changes: ThresholdChangeRecord[], elderId: string, at: number): ThresholdChangeRecord | null {
  return (
    changes
      .filter((c) => c.elderId === elderId && c.changedAt <= at && c.status !== 'reverted')
      .sort((a, b) => b.changedAt - a.changedAt)[0] ?? null
  )
}

/**
 * 时点回看：返回 at 时刻实际生效的变更——即使该变更后来因漏报被回退也照样返回，
 * 供真实异常事件回看「当时为何降低或延后告警」。
 * 回退生效时刻（revertedAt）之后该记录不再算生效。
 */
export function changeActiveAtPoint(changes: ThresholdChangeRecord[], elderId: string, at: number): ThresholdChangeRecord | null {
  return (
    changes
      .filter((c) => c.elderId === elderId && c.changedAt <= at)
      .filter((c) => !(c.status === 'reverted' && (c.revertedAt ?? Infinity) <= at))
      .sort((a, b) => b.changedAt - a.changedAt)[0] ?? null
  )
}

/** 当前生效（含观察期）的阈值变更 */
export function currentChange(changes: ThresholdChangeRecord[], elderId: string, now: number): ThresholdChangeRecord | null {
  return activeChangeAt(changes, elderId, now)
}

/** 事件发生时刻的阈值快照（用于事件回看：当时依据哪条阈值变更判定，含后来被回退的变更） */
export function thresholdsAtEvent(changes: ThresholdChangeRecord[], elder: Elder, at: number) {
  const change = changeActiveAtPoint(changes, elder.id, at)
  return {
    change,
    inNap: isInNapWindow(at, elder.napWindow),
  }
}

export interface ObservationResult {
  falseAlarmsBefore: number
  falseAlarmsAfter: number
  missedRiskEvents: AlertEvent[]
  passed: boolean
  note: string
}

/**
 * 观察期评估：对比变更依据的误报与观察期内同类型误报是否下降，
 * 并检查观察期内是否发生被漏报的真实风险（午睡静止类事件中上门/120确认真实异常，
 * 或结案分类为真实风险/照护缺口）。
 */
export function evaluateObservation(change: ThresholdChangeRecord, events: AlertEvent[], now: number): ObservationResult {
  const windowStart = change.changedAt
  const windowEnd = Math.min(now, change.observeUntil)

  const isMissedRealRisk = (ev: AlertEvent): boolean => {
    if (ev.elderId !== change.elderId || ev.occurredAt < windowStart || ev.occurredAt > windowEnd) return false
    // 同类（静止）告警最终被确认真实异常：家属要求上门/拨打120，或结案为真实风险/照护缺口
    const realByClosure = ev.closure ? ev.closure.category === 'real_risk' || ev.closure.category === 'care_gap' : false
    const realByHandle =
      ev.family.response === 'request_visit' ||
      ev.family.response === 'called_120' ||
      !!ev.medical?.outcome ||
      ev.doorVisit?.result === 'need_medical'
    return ev.type === 'stillness' && (realByClosure || realByHandle)
  }

  const afterEvents = events.filter((ev) => {
    if (ev.elderId !== change.elderId || ev.type !== 'stillness') return false
    if (ev.occurredAt < windowStart || ev.occurredAt > windowEnd) return false
    return ev.family.response === 'false_alarm' || ev.closure?.category === 'device_false'
  })
  const falseAlarmsBefore = change.evidenceEventIds.length
  const falseAlarmsAfter = afterEvents.length
  const missedRiskEvents = events.filter(isMissedRealRisk)
  const passed = missedRiskEvents.length === 0

  const note = passed
    ? `观察期内午睡静止误报 ${falseAlarmsAfter} 起（调整依据 ${falseAlarmsBefore} 起），` +
      (falseAlarmsAfter < falseAlarmsBefore ? '误报明显下降' : falseAlarmsAfter === 0 ? '未再发生误报' : '误报未见下降，建议继续观察或回退') +
      '，未发现被遗漏的真实风险。'
    : `观察期内发现 ${missedRiskEvents.length} 起午睡静止相关真实异常（${missedRiskEvents
        .map((e) => e.id)
        .join('、')}），延后告警可能延误处置，系统已自动回退阈值。`

  return { falseAlarmsBefore, falseAlarmsAfter, missedRiskEvents, passed, note }
}

/** 把阈值变更描述为文案 */
export function describeChange(c: ThresholdChangeRecord): string {
  const parts: string[] = []
  const fieldLabel: Record<string, string> = {
    heartRateLow: '心率下限',
    heartRateHigh: '心率上限',
    stillnessMinutes: '静止时长',
    geofenceRadius: '围栏半径',
    curfewTime: '归家时间',
  }
  for (const k of Object.keys(c.after)) {
    const b = c.before[k as keyof typeof c.before]
    const a = c.after[k as keyof typeof c.after]
    if (b !== a) parts.push(`${fieldLabel[k] ?? k} ${b}→${a}`)
  }
  if (c.napDelayMinutes != null) parts.push(`午睡时段静止告警延后 ${c.napDelayMinutes} 分钟`)
  return parts.join('；') || '阈值无变化'
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
  /** 告警时点实际生效的静止阈值（含午睡延后），不传则取老人档案阈值 */
  effectiveStillnessMinutes?: number
  /** 是否因午睡时段差异化策略而延后 */
  napDelayed?: boolean
}

/** 依据告警类型、最近轨迹、历史误报、家属联系方式、值班人员生成处置流程 */
export function generatePlan(ctx: PlanContext): PlanStep[] {
  const { elder, type, location, isNight, battery, severity, gridWorkers, dutyText, effectiveStillnessMinutes, napDelayed } = ctx
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
  if (type === 'stillness') {
    const eff = effectiveStillnessMinutes ?? elder.thresholds.stillnessMinutes
    visitReasons.push(
      napDelayed
        ? `午睡时段静止超延后阈值 ${eff} 分钟（基础阈值 ${elder.thresholds.stillnessMinutes} 分钟 + 午睡延后）仍无活动`
        : `静止超阈值 ${elder.thresholds.stillnessMinutes} 分钟`,
    )
  }
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
  '午睡时段正常午睡被误判',
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
      case '午睡时段正常午睡被误判':
        tips.push(
          elder.napWindow
            ? `建议仅在午睡时段（${elder.napWindow.start}-${elder.napWindow.end}）将静止告警延后 30 分钟，心率/跌倒告警灵敏度不变，调整须经医生审批并进入观察期`
            : '建议登记老人午睡作息，仅在午睡时段延后静止告警，调整须经医生审批并进入观察期',
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
