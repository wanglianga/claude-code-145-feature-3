/* 端到端流程验证脚本：模拟一次完整告警处置闭环（esbuild 打包后由 node 执行） */
import { useStore } from '../src/store/useStore'
import {
  NAP_FALSE_REASON,
  activeChangesForEvent,
  inNapWindow,
  observeThresholdChange,
  summarizeNapFalseAlarms,
} from '../src/store/workflow'

const s = () => useStore.getState()
let failures = 0
const check = (name: string, cond: boolean) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`)
  if (!cond) failures++
}

// 1. 发起告警（王秀兰，浴室跌倒）
const before = s().events.length
s().raiseAlert('e1', 'fall', '家-浴室')
const ev1 = s().events[0]
check('新告警已生成', s().events.length === before + 1)
check('浴室跌倒等级为紧急', ev1.severity === 'high')
check('初始状态为待家属确认', ev1.status === 'pending_family')
check('已生成处置流程', ev1.plan.length >= 6)
check('流程含上门与120步骤', ev1.plan.some((p) => p.key === 'door_visit') && ev1.plan.some((p) => p.key === 'call_120'))
check('浴室场景触发升级', ev1.escalations.some((e) => e.kind === 'night_bathroom'))

// 2. 家属超时未响应（快进5分钟）
s().fastForward(5)
const ev2 = s().events.find((e) => e.id === ev1.id)!
check('家属超时升级已触发', ev2.escalations.some((e) => e.kind === 'family_timeout'))
check('家属标记为超时', ev2.family.timedOut)

// 3. 电话核实两次无人接 → 升级
s().recordPhoneAttempt(ev1.id, 'no_answer', '响铃30秒无人接')
s().recordPhoneAttempt(ev1.id, 'no_answer', '')
const ev3 = s().events.find((e) => e.id === ev1.id)!
check('电话无人接升级已触发', ev3.escalations.some((e) => e.kind === 'phone_no_answer'))

// 4. 家属要求上门
s().familyRespond(ev1.id, 'request_visit', '我在外地，请社区上门')
const ev4 = s().events.find((e) => e.id === ev1.id)!
check('家属响应已记录', ev4.family.response === 'request_visit')
check('状态转为上门处置', ev4.status === 'door_visit')

// 5. 派单 → 到达 → 无人开门 → 物业+钥匙 → 需就医
s().dispatchVisit(ev1.id, '刘敏')
s().recordArrival(ev1.id)
s().recordVisitResult(ev1.id, 'no_answer', '敲门5分钟无人应答')
const ev5 = s().events.find((e) => e.id === ev1.id)!
check('上门无人开门升级已触发', ev5.escalations.some((e) => e.kind === 'door_no_answer'))
s().involveProperty(ev1.id, true)
const ev5b = s().events.find((e) => e.id === ev1.id)!
check('物业与托管钥匙已联动', ev5b.doorVisit?.propertyInvolved === true && ev5b.doorVisit?.usedKeyCustody === true)
s().recordVisitResult(ev1.id, 'need_medical', '老人浴室滑倒，无法起身')
const ev6 = s().events.find((e) => e.id === ev1.id)!
check('状态转为就医中', ev6.status === 'medical')
check('需联动120升级已触发', ev6.escalations.some((e) => e.kind === 'need_120'))

// 6. 120 → 就医 → 回访 → 结案
s().call120(ev1.id, 'community')
s().recordMedical(ev1.id, '区人民医院骨科', '软组织挫伤，无骨折，当日返家')
const ev7 = s().events.find((e) => e.id === ev1.id)!
check('就医后转回访', ev7.status === 'follow_up' && ev7.medical?.hospital === '区人民医院骨科')
s().recordFollowUp(ev1.id, '电话回访，老人已返家休养')
s().closeEvent(ev1.id, 'real_risk', undefined, '浴室滑倒真实风险，处置链条完整，建议加装防滑设施')
const ev8 = s().events.find((e) => e.id === ev1.id)!
check('事件已结案', ev8.status === 'closed')
check('复盘含家属响应时长', typeof ev8.closure?.familyResponseMinutes === 'number')
check('复盘含社区处置时效', (ev8.closure?.communityHandleMinutes ?? 0) > 0)
check('复盘含设备建议', (ev8.closure?.deviceSuggestion ?? '').length > 0)
check('时间线覆盖告警到结案全流程', ['alert', 'confirm', 'visit', 'medical', 'followup', 'close'].every((k) => ev8.timeline.some((t) => t.kind === k)))

// 7. 照护画像沉淀
const p = s().profiles['e1']
check('画像真实风险+1', p.realRiskCount === 1)
check('画像家属未响应+1', p.familyTimeoutCount === 1)
check('画像上门无人+1', p.doorNoAnswerCount === 1)
check('画像标签已生成', p.riskTags.some((t) => t.includes('真实风险')) && p.riskTags.some((t) => t.includes('上门无人')))
check('照护策略已生成', p.strategy.visitFrequency.length > 0 && p.strategy.familyReminder.length > 0)

// 8. 误报结案路径（张桂芳 静止误报）
const e3FalseBefore = s().profiles['e3'].falseAlarmCount
s().raiseAlert('e3', 'stillness', '家-客厅')
const evB = s().events[0]
s().familyRespond(evB.id, 'false_alarm', '老人看电视久坐，手环误报')
s().recordFollowUp(evB.id, '电话回访确认无恙')
s().closeEvent(evB.id, 'device_false', '静止阈值过低（看书/看电视久坐）', '久坐误判，建议上调静止阈值')
const evB2 = s().events.find((e) => e.id === evB.id)!
check('误报结案分类正确', evB2.closure?.category === 'device_false')
check('误报建议针对阈值', evB2.closure?.deviceSuggestion.includes('静止阈值') === true)
check('画像误报计数+1', s().profiles['e3'].falseAlarmCount === e3FalseBefore + 1)

// 9. 午睡误报汇总 → 阈值审批调整 → 观察期跟踪 → 真实风险回看 → 回退
const e1 = s().elders.find((e) => e.id === 'e1')!
const summary = summarizeNapFalseAlarms(e1, s().events, s().now())
check('已汇总王秀兰午睡静止误报', summary !== null)
check('汇总到 3 起家属确认的午睡误报', summary?.events.length === 3 && summary.confirmCount === 3)
check('汇总含午睡时段', summary?.napWindow?.start === '13:00' && summary.napWindow.end === '14:30')
check('汇总含午睡静息心率区间', summary?.hrRange?.[0] === 62 && summary.hrRange[1] === 69)
check('汇总含家属平均确认耗时', summary?.avgResponseMinutes === 7)
check('汇总依据含轨迹与确认记录', (summary?.evidenceSummary ?? '').includes('轨迹') && (summary?.suggestion ?? '').includes('午睡'))
check('未登记午睡时段的老人不产生汇总', summarizeNapFalseAlarms(s().elders.find((e) => e.id === 'e4')!, s().events, s().now()) === null)
const napSample = new Date()
napSample.setHours(13, 30, 0, 0)
const nonNapSample = new Date()
nonNapSample.setHours(10, 0, 0, 0)
check('午睡时段判断准确', inNapWindow({ napStart: '13:00', napEnd: '14:30' } as any, napSample) === true && inNapWindow({ napStart: '13:00', napEnd: '14:30' } as any, nonNapSample) === false)

// 10. 医生审批调整（保留审批人/原因/依据/前后快照/观察期）
const beforeT = { ...e1.thresholds }
const afterT = { ...beforeT, stillnessMinutes: 75, napStart: '13:00', napEnd: '14:30' }
const change = s().approveThresholdChange('e1', {
  after: afterT,
  approvedBy: '陈医生',
  approverRole: '社区医生',
  reason: '近10天午睡时段连续3次静止告警家属均确认误报，午睡心率平稳，系午睡熟睡误报',
  advice: summary!.suggestion,
  reviewDays: 14,
  evidenceEventIds: summary!.events.map((e) => e.id),
  evidenceSummary: summary!.evidenceSummary,
})
check('阈值变更记录已生成', change !== null && change.id.startsWith('TC-'))
check('变更保留审批人与原因', change?.approvedBy === '陈医生' && change.approverRole === '社区医生' && change.reason.length > 10)
check('变更记录保留前后阈值快照', change?.before.stillnessMinutes === 45 && change.after.stillnessMinutes === 75)
check('变更项含静止阈值与午睡时段', change?.changes.length === 3 && change.changes.some((c) => c.key === 'stillnessMinutes' && c.before === '45分钟' && c.after === '75分钟'))
check('变更已生效到老人档案', s().elders.find((e) => e.id === 'e1')!.thresholds.stillnessMinutes === 75)
check('变更初始为观察中', change?.status === 'active' && change.outcome === 'observing')
check('观察期为14天', Math.round((change!.reviewUntil - change!.createdAt) / 86400000) === 14)
check('依据事件时间线已关联变更记录', s().events.find((e) => e.id === 'EV-0990')!.timeline.some((t) => t.kind === 'threshold'))
const obs0 = observeThresholdChange(change!, s().events, s().now())
check('调整后立即评估为观察中', obs0.outcome === 'observing' && obs0.inPeriod === true)

// 11. 调整后午睡时段上报静止告警 → 延后处理（心率兜底），心率异常仍立即告警
const target1330 = new Date(s().now() + 60000)
target1330.setHours(13, 30, 0, 0)
if (target1330.getTime() <= s().now()) target1330.setDate(target1330.getDate() + 1)
s().fastForward(Math.round((target1330.getTime() - s().now()) / 60000))
check('当前处于午睡时段', inNapWindow(s().elders.find((e) => e.id === 'e1')!.thresholds, s().now()))
check('午睡告警发生在审批之后', s().now() > change!.createdAt)
s().raiseAlert('e1', 'stillness', '家-卧室')
const napEv = s().events[0]
check('午睡静止告警降级延后', napEv.severity === 'low')
check('午睡静止告警含延后处理记录', napEv.timeline.some((t) => t.title.includes('午睡时段静止告警延后')))
check('午睡延后暂不通知家属（午睡结束再通知）', napEv.timeline.every((t) => !t.title.includes('已通知紧急联系人')) && napEv.family.notifiedAt > napEv.occurredAt)
s().raiseAlert('e1', 'heart_rate', '家-浴室')
const hrEv = s().events[0]
check('午睡时段心率异常不受延后影响', hrEv.severity === 'high' && hrEv.timeline.some((t) => t.title.includes('已通知紧急联系人')))

// 11b. 午睡结束仍静止 → 延后结束，自动补发家属通知
s().raiseAlert('e1', 'stillness', '家-卧室')
const deferredEvId = s().events[0].id
check('午睡告警初始无家属通知', s().events.find((e) => e.id === deferredEvId)!.timeline.every((t) => !t.title.includes('已通知紧急联系人')))
s().fastForward(61) // 13:30 → 14:31，跨过午睡结束 14:30
const deferredEv2 = s().events.find((e) => e.id === deferredEvId)!
check('午睡结束后自动补发家属通知', deferredEv2.timeline.some((t) => t.title === '午睡结束仍静止，已通知紧急联系人'))

// 12. 观察期内：午睡静止误报结案 → 自动归入误报跟踪（验证误报下降）
s().familyRespond(napEv.id, 'false_alarm', '老人在午睡，手环又报了')
s().recordFollowUp(napEv.id, '电话回访确认在午睡')
s().closeEvent(napEv.id, 'device_false', NAP_FALSE_REASON, '午睡误报，观察阈值调整效果')
const changeAfterFalse = s().thresholdChanges.find((c) => c.id === change!.id)!
check('观察期误报事件已归入变更记录', changeAfterFalse.falseAlarmEventIds.includes(napEv.id))
check('误报事件时间线含观察期跟踪记录', s().events.find((e) => e.id === napEv.id)!.timeline.some((t) => t.kind === 'threshold'))

// 13. 观察期内出现真实风险 → 标记疑似漏报并可回看当时为何延后告警
s().raiseAlert('e1', 'fall', '家-卧室')
const realEvId = s().events[0].id
s().familyRespond(realEvId, 'request_visit', '午睡后叫不醒，麻烦上门')
s().dispatchVisit(realEvId, '刘敏')
s().recordArrival(realEvId)
s().recordVisitResult(realEvId, 'need_medical', '老人倒地，疑似脑梗')
s().call120(realEvId, 'community')
s().recordMedical(realEvId, '区人民医院神经内科', '急性脑梗，急诊溶栓')
s().recordFollowUp(realEvId, '住院治疗中')
s().closeEvent(realEvId, 'real_risk', undefined, '午睡后跌倒合并脑梗，需回看阈值延后是否延误告警')
const changeAfterReal = s().thresholdChanges.find((c) => c.id === change!.id)!
check('真实风险已标记到变更观察记录', changeAfterReal.missedRiskEventIds.includes(realEvId))
const realEv = s().events.find((e) => e.id === realEvId)!
check('真实风险事件可回看生效中的阈值调整', activeChangesForEvent(s().thresholdChanges, realEv).some((c) => c.id === change!.id))
check('观察评估提示疑似漏报', observeThresholdChange(changeAfterReal, s().events, s().now()).outcome === 'missed_risk')

// 14. 社区回退阈值：恢复调整前快照，变更记录完整保留
s().concludeThresholdChange(change!.id, 'reverted', '观察期内发生真实风险，午睡延后可能延误发现，回退阈值，变更记录留存备查')
const reverted = s().thresholdChanges.find((c) => c.id === change!.id)!
check('变更记录已归档为已回退', reverted.status === 'reviewed' && reverted.outcome === 'reverted')
check('回退保留评估人与说明', !!reverted.reviewedBy && (reverted.reviewNote ?? '').includes('回退'))
check('阈值已恢复为调整前快照', s().elders.find((e) => e.id === 'e1')!.thresholds.stillnessMinutes === 45 && s().elders.find((e) => e.id === 'e1')!.thresholds.napStart === undefined)
check('历史变更记录仍保留审批人/原因/依据', reverted.approvedBy === '陈医生' && reverted.evidenceEventIds.length === 3)

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECKS FAILED`)
process.exit(failures === 0 ? 0 : 1)
