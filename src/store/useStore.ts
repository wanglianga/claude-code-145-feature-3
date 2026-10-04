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
  ThresholdChangeRecord,
  Thresholds,
  TimelineEntry,
} from '../types'
import { DUTY_STAFF, GRID_WORKERS, dutyText, seedElders, seedEvents, seedProfiles, seedThresholdChanges } from './seed'
import {
  activeChangeAt,
  assessSeverity,
  buildDeviceSuggestion,
  checkEscalations,
  communityHandleMinutes,
  describeChange,
  emptyProfile,
  evaluateObservation,
  familyResponseMinutes,
  generatePlan,
  isInNapWindow,
  isNightTime,
  nearestWorker,
  sedimentProfile,
} from './workflow'

let idSeq = 1002
let changeSeq = 1
const nextEventId = () => `EV-${++idSeq}`
const nextChangeId = () => `TC-${String(++changeSeq).padStart(4, '0')}`

/** 阈值调整申请入参 */
export interface ThresholdChangeInput {
  approver: string
  approverRole: string
  reason: string
  after: Partial<Thresholds>
  napDelayMinutes: number | null
  observeDays: number
  evidenceEventIds: string[]
}

export interface StoreState {
  session: Session | null
  timeOffset: number // 演示用时间快进（毫秒）
  elders: Elder[]
  events: AlertEvent[]
  profiles: Record<string, CareProfile>
  thresholdChanges: ThresholdChangeRecord[] // 阈值变更审批留痕（永久保留）

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

  /** 阈值调整（必须带审批人与原因，进入观察期） */
  applyThresholdChange: (elderId: string, input: ThresholdChangeInput) => void
  /** 观察期人工评估：通过转持续生效；发现漏报则自动回退 */
  reviewThresholdChange: (recordId: string) => void
  /** 人工回退阈值（仍保留记录与回退原因） */
  revertThresholdChange: (recordId: string, reason: string) => void
  updateWearingHabit: (elderId: string, habit: string) => void
  updateStrategy: (elderId: string, strategy: CareProfile['strategy']) => void
}

function pushTimeline(ev: AlertEvent, entry: TimelineEntry): AlertEvent {
  return { ...ev, timeline: [...ev.timeline, entry] }
}

/** 某时点实际生效的静止阈值（午睡时段在阈值变更基础上再延后） */
function effectiveStillness(
  elder: Elder,
  changes: ThresholdChangeRecord[],
  at: number,
): { minutes: number; napDelayed: boolean; change: ThresholdChangeRecord | null } {
  const change = activeChangeAt(changes, elder.id, at)
  let minutes = change?.after.stillnessMinutes ?? elder.thresholds.stillnessMinutes
  let napDelayed = false
  if (change?.napDelayMinutes != null && isInNapWindow(at, elder.napWindow)) {
    minutes += change.napDelayMinutes
    napDelayed = true
  }
  return { minutes, napDelayed, change }
}

/** 回退阈值：把档案阈值恢复为变更前取值，记录标记为 reverted（记录本身永久保留） */
function buildRevert(
  s: { elders: Elder[]; thresholdChanges: ThresholdChangeRecord[] },
  rec: ThresholdChangeRecord,
  now: number,
  by: string,
  reason: string,
  observation?: {
    note: string
    falseAlarmsBefore: number
    falseAlarmsAfter: number
    missedRisk: boolean
  },
): { elders: Elder[]; thresholdChanges: ThresholdChangeRecord[] } {
  const elders = s.elders.map((e) =>
    e.id === rec.elderId ? { ...e, thresholds: { ...e.thresholds, ...rec.before } } : e,
  )
  const reverted: ThresholdChangeRecord = {
    ...rec,
    status: 'reverted',
    revertedAt: now,
    revertedBy: by,
    revertReason: reason,
    observation: observation
      ? {
          reviewedAt: now,
          reviewedBy: by,
          falseAlarmsBefore: observation.falseAlarmsBefore,
          falseAlarmsAfter: observation.falseAlarmsAfter,
          missedRisk: observation.missedRisk,
          note: observation.note,
        }
      : rec.observation,
  }
  return { elders, thresholdChanges: s.thresholdChanges.map((c) => (c.id === rec.id ? reverted : c)) }
}

function applyEscalations(ev: AlertEvent, elder: Elder, now: number): AlertEvent {
  const fresh = checkEscalations(ev, elder, now)
  if (!fresh.length) return ev
  let next = { ...ev, escalations: [...ev.escalations] }
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
    thresholdChanges: seedThresholdChanges(boot),

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
      const severity = assessSeverity(type, {
        isNight,
        location,
        battery: elder.battery,
        historyFalseAlarms: elder.historyFalseAlarms,
      })
      const { minutes: effStillness, napDelayed } = effectiveStillness(elder, s.thresholdChanges, now)
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
          effectiveStillnessMinutes: effStillness,
          napDelayed,
        }),
        escalations: [],
        family: { contactName: contact.name, contactPhone: contact.phone, notifiedAt: now, timedOut: false },
        phoneAttempts: [],
        timeline: [
          {
            at: now,
            actor: 'device',
            kind: 'alert',
            title: `手环上报${ALERT_TYPE_LABEL[type]}`,
            detail:
              `位置：${location}${isNight ? '，夜间时段' : ''}` +
              (type === 'stillness' && napDelayed ? `；午睡时段生效延后阈值 ${effStillness} 分钟` : ''),
          },
          { at: now, actor: 'system', kind: 'handle', title: '已通知紧急联系人', detail: `短信+APP推送：${contact.name}（${contact.relation}）${contact.phone}` },
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
        return {
          events: s.events.map((e) => (e.id === eventId ? next : e)),
          profiles: { ...s.profiles, [ev.elderId]: profile },
        }
      })
    },

    /**
     * 阈值调整申请：必须填写审批人与原因，记录依据事件，进入观察期。
     * 审批通过后阈值立即用于后续告警判定，观察期结束须评估：误报下降则继续生效，发现漏报自动回退。
     */
    applyThresholdChange: (elderId, input) => {
      const now = get().now()
      set((s) => {
        const elder = s.elders.find((e) => e.id === elderId)
        if (!elder) return s
        const before: Partial<Thresholds> = {}
        const after: Partial<Thresholds> = {}
        for (const k of Object.keys(input.after) as (keyof Thresholds)[]) {
          const nv = input.after[k]
          if (nv !== undefined && nv !== elder.thresholds[k]) {
            ;(before as Record<string, string | number>)[k] = elder.thresholds[k]
            ;(after as Record<string, string | number>)[k] = nv
          }
        }
        const record: ThresholdChangeRecord = {
          id: nextChangeId(),
          elderId,
          changedAt: now,
          approver: input.approver.trim(),
          approverRole: input.approverRole.trim(),
          reason: input.reason.trim(),
          evidenceEventIds: input.evidenceEventIds,
          before,
          after,
          napDelayMinutes: input.napDelayMinutes,
          observeUntil: now + input.observeDays * 24 * 3600 * 1000,
          status: 'observing',
        }
        const elders = s.elders.map((e) => (e.id === elderId ? { ...e, thresholds: { ...e.thresholds, ...after } } : e))
        return { elders, thresholdChanges: [record, ...s.thresholdChanges] }
      })
    },

    /** 观察期评估：误报未增长且无漏报 → 转持续生效；发现被漏报的真实风险 → 自动回退 */
    reviewThresholdChange: (recordId) => {
      const now = get().now()
      const s = get()
      const rec = s.thresholdChanges.find((c) => c.id === recordId)
      if (!rec || rec.status !== 'observing') return
      const result = evaluateObservation(rec, s.events, now)
      if (result.passed) {
        const reviewed: ThresholdChangeRecord = {
          ...rec,
          status: 'effective',
          observation: {
            reviewedAt: now,
            reviewedBy: s.session?.userName ?? '值班员',
            falseAlarmsBefore: result.falseAlarmsBefore,
            falseAlarmsAfter: result.falseAlarmsAfter,
            missedRisk: false,
            note: result.note,
          },
        }
        set((st) => ({ thresholdChanges: st.thresholdChanges.map((c) => (c.id === recordId ? reviewed : c)) }))
      } else {
        set((st) =>
          buildRevert(st, rec, now, st.session?.userName ?? '值班员', '观察期评估发现漏报的真实风险，系统自动回退至调整前阈值', {
            note: result.note,
            falseAlarmsBefore: result.falseAlarmsBefore,
            falseAlarmsAfter: result.falseAlarmsAfter,
            missedRisk: true,
          }),
        )
      }
    },

    /** 人工回退（医生/社区判断继续放宽不安全），记录与回退原因永久保留 */
    revertThresholdChange: (recordId, reason) => {
      const now = get().now()
      set((st) => {
        const rec = st.thresholdChanges.find((c) => c.id === recordId)
        if (!rec || rec.status === 'reverted') return st
        return buildRevert(st, rec, now, st.session?.userName ?? '值班员', reason)
      })
    },

    updateWearingHabit: (elderId, habit) =>
      set((s) => ({ elders: s.elders.map((e) => (e.id === elderId ? { ...e, wearingHabit: habit } : e)) })),
    updateStrategy: (elderId, strategy) =>
      set((s) => {
        const p = s.profiles[elderId] ?? emptyProfile(elderId, s.now())
        return { profiles: { ...s.profiles, [elderId]: { ...p, strategy, updatedAt: s.now() } } }
      }),
  }
})

export { GRID_WORKERS, DUTY_STAFF, nearestWorker, describeChange }
