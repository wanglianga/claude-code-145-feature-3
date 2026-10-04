import { create } from 'zustand'
import {
  AlertEvent,
  AlertType,
  ALERT_TYPE_LABEL,
  CareProfile,
  ClosureCategory,
  CLOSURE_LABEL,
  Elder,
  ESCALATION_LABEL,
  EventStatus,
  Session,
  ThresholdChange,
  Thresholds,
  TimelineEntry,
} from '../types'
import { DUTY_STAFF, GRID_WORKERS, dutyText, seedElders, seedEvents, seedProfiles } from './seed'
import {
  assessSeverity,
  buildDeviceSuggestion,
  checkEscalations,
  communityHandleMinutes,
  diffThresholds,
  emptyProfile,
  familyResponseMinutes,
  generatePlan,
  inNapWindow,
  isNightTime,
  nearestWorker,
  sedimentProfile,
} from './workflow'

let idSeq = 1002
const nextEventId = () => `EV-${++idSeq}`
let changeSeq = 20
const nextChangeId = () => `TC-${++changeSeq}`
const DAY_MS = 24 * 60 * 60 * 1000

export interface ApproveThresholdInput {
  after: Thresholds
  approvedBy: string
  approverRole: ThresholdChange['approverRole']
  reason: string
  advice: string
  reviewDays: number
  evidenceEventIds?: string[]
  evidenceSummary?: string
}

export interface StoreState {
  session: Session | null
  timeOffset: number // 演示用时间快进（毫秒）
  elders: Elder[]
  events: AlertEvent[]
  profiles: Record<string, CareProfile>
  thresholdChanges: ThresholdChange[] // 阈值变更审批记录（保留审批人/原因，供后续照护评估回看）

  now: () => number
  login: (role: 'community' | 'family', userName: string, elderId?: string) => void
  logout: () => void
  fastForward: (minutes: number) => void
  tick: () => void

  raiseAlert: (elderId: string, type: AlertType, location: string) => void
  familyRespond: (eventId: string, response: NonNullable<AlertEvent['family']['response']>, note: string) => void
  recordPhoneAttempt: (eventId: string, result: 'answered' | 'no_answer', note: string) => void
  dispatchVisit: (eventId: string, assignee: string) => void
  recordArrival: (eventId: string) => void
  recordVisitResult: (eventId: string, result: 'ok' | 'no_answer' | 'need_medical', note: string) => void
  involveProperty: (eventId: string, useKey: boolean) => void
  call120: (eventId: string, by: 'family' | 'community') => void
  recordMedical: (eventId: string, hospital: string, outcome: string) => void
  recordFollowUp: (eventId: string, note: string) => void
  closeEvent: (eventId: string, category: ClosureCategory, falseReason: string | undefined, summary: string) => void

  updateThresholds: (elderId: string, t: Thresholds) => void
  updateWearingHabit: (elderId: string, habit: string) => void
  updateStrategy: (elderId: string, strategy: CareProfile['strategy']) => void

  /** 审批调整阈值：生成带审批人/原因/依据的变更记录并生效，开启观察期 */
  approveThresholdChange: (elderId: string, input: ApproveThresholdInput) => ThresholdChange | null
  /** 观察期结束评估：确认有效（误报下降且无漏报） */
  concludeThresholdChange: (changeId: string, outcome: 'effective' | 'reverted', note: string) => void
}

function pushTimeline(ev: AlertEvent, entry: TimelineEntry): AlertEvent {
  return { ...ev, timeline: [...ev.timeline, entry] }
}

/** 午睡结束时间戳（当天午睡结束时刻；若已过则次日） */
function napEndTs(t: Thresholds, now: number): number {
  if (!t.napEnd) return now
  const d = new Date(now)
  const [eh, em] = t.napEnd.split(':').map(Number)
  d.setHours(eh, em, 0, 0)
  if (d.getTime() <= now) d.setDate(d.getDate() + 1)
  return d.getTime()
}

function applyEscalations(ev: AlertEvent, elder: Elder, now: number): AlertEvent {
  let next = ev
  // 午睡延后的静止告警：午睡结束仍未解除（未结案/无家属响应）→ 自动补发家属通知
  const deferred = ev.timeline.some((t) => t.title === '午睡时段静止告警延后处理')
  const notified = ev.timeline.some((t) => t.title === '午睡结束仍静止，已通知紧急联系人')
  if (deferred && !notified && !ev.family.respondedAt && ev.status !== 'closed' && now >= ev.family.notifiedAt) {
    next = pushTimeline(next, {
      at: ev.family.notifiedAt,
      actor: 'system',
      kind: 'handle',
      title: '午睡结束仍静止，已通知紧急联系人',
      detail: `午睡时段（${elder.thresholds.napStart}-${elder.thresholds.napEnd}）已结束，手环仍判定静止，延后结束并立即通知家属：${ev.family.contactName}（${ev.family.contactPhone}）`,
    })
  }
  const fresh = checkEscalations(next, elder, now)
  if (!fresh.length) return next
  next = { ...next, escalations: [...next.escalations] }
  for (const f of fresh) {
    next.escalations.push({ kind: f.kind, at: now, note: f.note })
    next = pushTimeline(next, { at: now, actor: 'system', kind: 'escalation', title: `升级：${ESCALATION_LABEL[f.kind]}`, detail: f.note })
    if (f.kind === 'family_timeout') next.family = { ...next.family, timedOut: true }
  }
  return next
}

export const useStore = create<StoreState>((set, get) => {
  const boot = Date.now()
  return {
    session: null,
    timeOffset: 0,
    elders: seedElders(boot),
    events: seedEvents(boot),
    profiles: seedProfiles(boot),
    thresholdChanges: [],

    now: () => Date.now() + get().timeOffset,

    login: (role, userName, elderId) => set({ session: { role, userName, elderId } }),
    logout: () => set({ session: null }),

    fastForward: (minutes) => {
      set((s) => ({ timeOffset: s.timeOffset + minutes * 60 * 1000 }))
      get().tick()
    },

    /** 周期性检查所有未结案事件的升级情形 */
    tick: () => {
      const now = get().now()
      set((s) => ({
        events: s.events.map((ev) => {
          if (ev.status === 'closed') return ev
          const elder = s.elders.find((e) => e.id === ev.elderId)
          if (!elder) return ev
          return applyEscalations(ev, elder, now)
        }),
      }))
    },

    /** 手环上报新告警 */
    raiseAlert: (elderId, type, location) => {
      const s = get()
      const elder = s.elders.find((e) => e.id === elderId)
      if (!elder) return
      const now = s.now()
      const isNight = isNightTime(new Date(now))
      const inNap = type === 'stillness' && inNapWindow(elder.thresholds, now)
      const severity0 = assessSeverity(type, {
        isNight,
        location,
        battery: elder.battery,
        historyFalseAlarms: elder.historyFalseAlarms,
      })
      // 午睡延后时段：静止告警降为一般等级，先心率兜底观察，不立即打扰家属（心率等其他告警不受影响）
      const severity = inNap && severity0 !== 'low' ? ('low' as const) : severity0
      const contact = [...elder.contacts].sort((a, b) => a.priority - b.priority)[0]
      let ev: AlertEvent = {
        id: nextEventId(),
        elderId,
        type,
        severity,
        location,
        isNight,
        occurredAt: now,
        batteryAtAlert: elder.battery,
        status: 'pending_family',
        plan: generatePlan({
          elder,
          type,
          location,
          isNight,
          battery: elder.battery,
          severity,
          gridWorkers: GRID_WORKERS,
          dutyText,
        }),
        escalations: [],
        family: { contactName: contact.name, contactPhone: contact.phone, notifiedAt: inNap ? napEndTs(elder.thresholds, now) : now, timedOut: false },
        phoneAttempts: [],
        timeline: [
          { at: now, actor: 'device', kind: 'alert', title: `手环上报${ALERT_TYPE_LABEL[type]}`, detail: `位置：${location}${isNight ? '，夜间时段' : ''}${inNap ? '，处于午睡延后时段' : ''}` },
          ...(inNap
            ? [
                {
                  at: now,
                  actor: 'system' as const,
                  kind: 'handle' as const,
                  title: '午睡时段静止告警延后处理',
                  detail: `当前处于登记午睡时段（${elder.thresholds.napStart}-${elder.thresholds.napEnd}），按审批后的阈值策略先以心率监测兜底、暂不打扰家属；午睡结束（${elder.thresholds.napEnd}）仍静止或心率异常将立即通知家属并升级`,
                },
              ]
            : [
                { at: now, actor: 'system' as const, kind: 'handle' as const, title: '已通知紧急联系人', detail: `短信+APP推送：${contact.name}（${contact.relation}）${contact.phone}` },
              ]),
        ],
      }
      ev = applyEscalations(ev, elder, now)
      set((st) => ({ events: [ev, ...st.events] }))
    },

    /** 家属端操作 */
    familyRespond: (eventId, response, note) => {
      const now = get().now()
      const labelMap = {
        false_alarm: '家属确认误报',
        request_call: '家属请求电话核实',
        request_visit: '家属要求上门',
        called_120: '家属直接拨打120',
      } as const
      const statusMap: Record<typeof response, EventStatus> = {
        false_alarm: 'follow_up',
        request_call: 'family_verifying',
        request_visit: 'door_visit',
        called_120: 'medical',
      }
      set((s) => ({
        events: s.events.map((ev) => {
          if (ev.id !== eventId || ev.family.respondedAt) return ev
          let next: AlertEvent = {
            ...ev,
            status: statusMap[response],
            family: { ...ev.family, respondedAt: now, response, note },
          }
          next = pushTimeline(next, { at: now, actor: 'family', kind: 'confirm', title: labelMap[response], detail: note || undefined })
          if (response === 'called_120') {
            next.medical = { called120: true, at: now }
            next.escalations = [...next.escalations, { kind: 'need_120', at: now, note: '家属已直接拨打120，社区同步联动' }]
            next = pushTimeline(next, { at: now, actor: 'system', kind: 'escalation', title: '升级：需联动120急救', detail: '家属已拨打120，社区值班员同步跟进' })
          }
          return next
        }),
      }))
    },

    /** 社区电话核实 */
    recordPhoneAttempt: (eventId, result, note) => {
      const now = get().now()
      set((s) => ({
        events: s.events.map((ev) => {
          if (ev.id !== eventId) return ev
          const by = s.session?.userName ?? '值班员'
          let next: AlertEvent = { ...ev, phoneAttempts: [...ev.phoneAttempts, { at: now, by, result, note }] }
          next = pushTimeline(next, {
            at: now,
            actor: 'community',
            kind: 'handle',
            title: result === 'answered' ? '电话核实：老人接听' : '电话核实：无人接听',
            detail: note || undefined,
          })
          if (result === 'answered') {
            // 接通后确认无异常 → 进入回访结案
            next.status = 'follow_up'
            next = pushTimeline(next, { at: now, actor: 'community', kind: 'handle', title: '电话确认老人状态平稳', detail: '转入回访结案流程' })
          }
          const elder = s.elders.find((e) => e.id === ev.elderId)
          return elder ? applyEscalations(next, elder, now) : next
        }),
      }))
    },

    /** 派单上门 */
    dispatchVisit: (eventId, assignee) => {
      const now = get().now()
      set((s) => ({
        events: s.events.map((ev) => {
          if (ev.id !== eventId) return ev
          let next: AlertEvent = {
            ...ev,
            status: 'door_visit',
            doorVisit: { dispatchedAt: now, assignee, propertyInvolved: false, usedKeyCustody: false },
          }
          return pushTimeline(next, { at: now, actor: 'community', kind: 'visit', title: '派单网格员上门', detail: `${assignee} 已接单出发` })
        }),
      }))
    },

    recordArrival: (eventId) => {
      const now = get().now()
      set((s) => ({
        events: s.events.map((ev) => {
          if (ev.id !== eventId || !ev.doorVisit) return ev
          let next: AlertEvent = { ...ev, doorVisit: { ...ev.doorVisit, arrivedAt: now } }
          return pushTimeline(next, { at: now, actor: 'community', kind: 'visit', title: '网格员到达老人家门口' })
        }),
      }))
    },

    /** 上门结果 */
    recordVisitResult: (eventId, result, note) => {
      const now = get().now()
      set((s) => ({
        events: s.events.map((ev) => {
          if (ev.id !== eventId || !ev.doorVisit) return ev
          let next: AlertEvent = { ...ev, doorVisit: { ...ev.doorVisit, result, note } }
          const titleMap = { ok: '上门确认老人平安', no_answer: '上门无人开门', need_medical: '上门发现需医疗处置' }
          next = pushTimeline(next, { at: now, actor: 'community', kind: 'visit', title: titleMap[result], detail: note || undefined })
          if (result === 'ok') next.status = 'follow_up'
          if (result === 'need_medical') {
            next.status = 'medical'
            next.escalations = [...next.escalations, { kind: 'need_120', at: now, note: '现场确认需医疗救援' }]
            next = pushTimeline(next, { at: now, actor: 'system', kind: 'escalation', title: '升级：需联动120急救', detail: '网格员现场确认需医疗救援' })
          }
          const elder = s.elders.find((e) => e.id === ev.elderId)
          return elder ? applyEscalations(next, elder, now) : next
        }),
      }))
    },

    /** 联动物业/托管钥匙开门 */
    involveProperty: (eventId, useKey) => {
      const now = get().now()
      set((s) => ({
        events: s.events.map((ev) => {
          if (ev.id !== eventId || !ev.doorVisit) return ev
          let next: AlertEvent = { ...ev, doorVisit: { ...ev.doorVisit, propertyInvolved: true, usedKeyCustody: useKey } }
          if (!next.escalations.some((e) => e.kind === 'need_property')) {
            next.escalations = [...next.escalations, { kind: 'need_property', at: now, note: '上门无人开门，联动物业协助入户' }]
          }
          next = pushTimeline(next, {
            at: now,
            actor: 'community',
            kind: 'handle',
            title: useKey ? '联动物业并使用托管钥匙入户' : '联动物业协助开门',
            detail: useKey ? `物业值班 ${DUTY_STAFF[2].name} 到场，使用社区托管备用钥匙` : `物业值班 ${DUTY_STAFF[2].name} 到场协助`,
          })
          return next
        }),
      }))
    },

    /** 呼叫120 */
    call120: (eventId, by) => {
      const now = get().now()
      set((s) => ({
        events: s.events.map((ev) => {
          if (ev.id !== eventId) return ev
          let next: AlertEvent = { ...ev, status: 'medical', medical: { called120: true, at: now } }
          if (!next.escalations.some((e) => e.kind === 'need_120')) {
            next.escalations = [...next.escalations, { kind: 'need_120', at: now, note: by === 'community' ? '社区值班员呼叫120' : '家属呼叫120' }]
          }
          return pushTimeline(next, {
            at: now,
            actor: by === 'community' ? 'community' : 'family',
            kind: 'medical',
            title: '呼叫120急救',
            detail: '已同步老人慢病史与用药信息',
          })
        }),
      }))
    },

    /** 记录就医结果 */
    recordMedical: (eventId, hospital, outcome) => {
      const now = get().now()
      set((s) => ({
        events: s.events.map((ev) => {
          if (ev.id !== eventId) return ev
          let next: AlertEvent = {
            ...ev,
            status: 'follow_up',
            medical: { called120: ev.medical?.called120 ?? true, at: ev.medical?.at ?? now, hospital, outcome },
          }
          return pushTimeline(next, { at: now, actor: 'medical', kind: 'medical', title: `送医：${hospital}`, detail: outcome })
        }),
      }))
    },

    /** 回访记录 */
    recordFollowUp: (eventId, note) => {
      const now = get().now()
      set((s) => ({
        events: s.events.map((ev) => {
          if (ev.id !== eventId) return ev
          const by = s.session?.userName ?? '值班员'
          let next: AlertEvent = { ...ev, followUp: { at: now, by, note } }
          return pushTimeline(next, { at: now, actor: 'community', kind: 'followup', title: '回访完成', detail: note })
        }),
      }))
    },

    /** 结案：生成复盘报告并沉淀照护画像 */
    closeEvent: (eventId, category, falseReason, summary) => {
      const now = get().now()
      set((s) => {
        const ev = s.events.find((e) => e.id === eventId)
        if (!ev) return s
        const elder = s.elders.find((e) => e.id === ev.elderId)!
        const closure = {
          closedAt: now,
          closedBy: s.session?.userName ?? '值班员',
          category,
          falseReason,
          deviceSuggestion: buildDeviceSuggestion(category, falseReason, ev, elder),
          familyResponseMinutes: familyResponseMinutes(ev, now),
          communityHandleMinutes: communityHandleMinutes(ev, now),
          summary,
        }
        let next = pushTimeline(
          { ...ev, status: 'closed', closure },
          { at: now, actor: 'community', kind: 'close', title: '事件结案', detail: `分类：${CLOSURE_LABEL[category]}` },
        )
        const profile = sedimentProfile(s.profiles[ev.elderId] ?? emptyProfile(ev.elderId, now), next, closure, now)
        // 阈值调整观察期跟踪：结案事件自动归入对应变更记录（误报下降 / 真实风险遗漏）
        let withThresholdNote = next
        const thresholdChanges = s.thresholdChanges.map((c) => {
          if (c.elderId !== ev.elderId || c.status !== 'active' || ev.occurredAt < c.createdAt || now > c.reviewUntil + 7 * DAY_MS) return c
          if (category === 'real_risk' && !c.missedRiskEventIds.includes(ev.id)) {
            withThresholdNote = pushTimeline(withThresholdNote, {
              at: now,
              actor: 'system',
              kind: 'threshold',
              title: `已纳入阈值变更 ${c.id} 观察期跟踪`,
              detail: `本事件为真实风险，发生于 ${c.approverRole}${c.approvedBy} 审批的阈值调整观察期内，需回看调整是否导致告警延迟/遗漏`,
            })
            return { ...c, missedRiskEventIds: [...c.missedRiskEventIds, ev.id] }
          }
          if (category === 'device_false' && ev.type === 'stillness' && !c.falseAlarmEventIds.includes(ev.id)) {
            withThresholdNote = pushTimeline(withThresholdNote, {
              at: now,
              actor: 'system',
              kind: 'threshold',
              title: `已纳入阈值变更 ${c.id} 观察期跟踪`,
              detail: '午睡静止误报，用于评估阈值调整后误报是否下降',
            })
            return { ...c, falseAlarmEventIds: [...c.falseAlarmEventIds, ev.id] }
          }
          return c
        })
        return {
          events: s.events.map((e) => (e.id === eventId ? withThresholdNote : e)),
          profiles: { ...s.profiles, [ev.elderId]: profile },
          thresholdChanges,
        }
      })
    },

    updateThresholds: (elderId, t) =>
      set((s) => ({ elders: s.elders.map((e) => (e.id === elderId ? { ...e, thresholds: t } : e)) })),
    updateWearingHabit: (elderId, habit) =>
      set((s) => ({ elders: s.elders.map((e) => (e.id === elderId ? { ...e, wearingHabit: habit } : e)) })),
    updateStrategy: (elderId, strategy) =>
      set((s) => {
        const p = s.profiles[elderId] ?? emptyProfile(elderId, s.now())
        return { profiles: { ...s.profiles, [elderId]: { ...p, strategy, updatedAt: s.now() } } }
      }),

    /** 审批调整阈值：保留审批人、原因、汇总依据与前后快照，生效并开启观察期 */
    approveThresholdChange: (elderId, input) => {
      const s = get()
      const elder = s.elders.find((e) => e.id === elderId)
      if (!elder) return null
      const now = s.now()
      const before = { ...elder.thresholds }
      const changes = diffThresholds(before, input.after)
      if (!changes.length) return null
      const record: ThresholdChange = {
        id: nextChangeId(),
        elderId,
        createdAt: now,
        approvedBy: input.approvedBy,
        approverRole: input.approverRole,
        reason: input.reason,
        evidenceEventIds: input.evidenceEventIds ?? [],
        evidenceSummary: input.evidenceSummary ?? '',
        advice: input.advice,
        reviewDays: input.reviewDays,
        reviewUntil: now + input.reviewDays * DAY_MS,
        changes,
        before,
        after: { ...input.after },
        status: 'active',
        outcome: 'observing',
        missedRiskEventIds: [],
        falseAlarmEventIds: [],
      }
      set((st) => ({
        elders: st.elders.map((e) => (e.id === elderId ? { ...e, thresholds: { ...input.after }, historyFalseAlarms: e.historyFalseAlarms } : e)),
        thresholdChanges: [record, ...st.thresholdChanges],
        events: st.events.map((ev) =>
          record.evidenceEventIds.includes(ev.id)
            ? pushTimeline(ev, {
                at: now,
                actor: 'community',
                kind: 'threshold',
                title: `误报汇总已用于阈值变更 ${record.id}`,
                detail: `${record.approverRole}${record.approvedBy} 依据本事件等 ${record.evidenceEventIds.length} 起午睡误报审批调整阈值`,
              })
            : ev,
        ),
      }))
      return record
    },

    /** 观察期评估结案：确认有效或回退阈值（回退时恢复调整前快照，保留完整记录） */
    concludeThresholdChange: (changeId, outcome, note) => {
      const s = get()
      const now = s.now()
      const change = s.thresholdChanges.find((c) => c.id === changeId)
      if (!change) return
      set((st) => ({
        thresholdChanges: st.thresholdChanges.map((c) =>
          c.id === changeId
            ? {
                ...c,
                status: 'reviewed',
                outcome,
                reviewedAt: now,
                reviewedBy: st.session?.userName ?? '值班员',
                reviewNote: note,
              }
            : c,
        ),
        elders:
          outcome === 'reverted'
            ? st.elders.map((e) => (e.id === change.elderId ? { ...e, thresholds: { ...change.before } } : e))
            : st.elders,
      }))
    },
  }
})

export { GRID_WORKERS, DUTY_STAFF, nearestWorker }
