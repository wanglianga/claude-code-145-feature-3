/* 端到端流程验证脚本：模拟一次完整告警处置闭环（esbuild 打包后由 node 执行） */
import { useStore } from '../src/store/useStore'
import {
  activeChangeAt,
  describeChange,
  evaluateObservation,
  isInNapWindow,
  suggestNapThresholdChange,
  summarizeNapFalseAlarms,
  thresholdsAtEvent,
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

// ===================== 扩展：误报阈值调整（午睡误报 → 审批 → 观察期 → 回退/生效 → 留痕回看） =====================

// 9. 午睡误报汇总：时段、心率、轨迹、家属确认记录
const e1 = s().elders.find((x) => x.id === 'e1')!
check('王秀兰登记了午睡时段', e1.napWindow?.start === '13:00' && e1.napWindow.end === '14:30')
const nap = summarizeNapFalseAlarms(e1, s().events)!
check('汇总出3起午睡时段静止误报', nap.total === 3)
check('误报均经家属王莉确认', nap.familyConfirmers.some((c) => c.name === '王莉' && c.count === 3))
check('汇总含误报发生时刻', nap.times.length === 3)
check('午睡心率采样平稳', nap.heartRateStats !== null && nap.heartRateStats.stable === true)
check('汇总含活动轨迹位置', nap.places.includes('家-卧室'))
const sug = suggestNapThresholdChange(e1, nap)!
check('系统建议午睡时段延后30分钟', sug.napDelayMinutes === 30 && sug.basis.includes('延后 30 分钟'))
check('午睡时段判断正确', isInNapWindow(nap.events[0].occurredAt, e1.napWindow) === true)

// 10. 历史阈值变更留痕（张桂芳 12天前审批，观察期通过后持续生效）
const seedRec = s().thresholdChanges.find((c) => c.id === 'TC-0001')!
check('种子阈值变更已持续生效', seedRec.status === 'effective' && seedRec.elderId === 'e3')
check('种子变更保留审批人与原因', seedRec.approver.length > 0 && seedRec.approverRole.includes('医生') && seedRec.reason.length > 20)
check('种子变更观察结论为误报下降且无漏报', seedRec.observation!.missedRisk === false && seedRec.observation!.falseAlarmsAfter < seedRec.observation!.falseAlarmsBefore)
check('变更内容文案正确', describeChange(seedRec).includes('30→40'))
// 旧事件时点回看：当时已适用该审批调整
const e3 = s().elders.find((x) => x.id === 'e3')!
const ev0998 = s().events.find((e) => e.id === 'EV-0998')!
check('历史事件可回看当时生效的阈值变更', thresholdsAtEvent(s().thresholdChanges, e3, ev0998.occurredAt).change?.id === 'TC-0001')

// 11. 发起阈值调整审批（必须带审批人/原因/依据事件/观察期）
const evidenceIds = nap.events.map((e) => e.id)
s().applyThresholdChange('e1', {
  approver: '陈医生',
  approverRole: '社区医生',
  reason: '王秀兰连续3次午睡静止误报，心率平稳符合睡眠特征，经家属申请与社区医生评估，午睡时段延后静止告警并适度上调阈值，心率/跌倒灵敏度不变。',
  after: { stillnessMinutes: 60 },
  napDelayMinutes: 30,
  observeDays: 7,
  evidenceEventIds: evidenceIds,
})
const rec = s().thresholdChanges.find((c) => c.elderId === 'e1' && c.status === 'observing')!
check('调整已留痕并进入观察期', rec.status === 'observing' && rec.approver === '陈医生' && rec.reason.length > 20)
check('记录保留调整前后阈值', rec.before.stillnessMinutes === 45 && rec.after.stillnessMinutes === 60)
check('记录保留午睡延后策略与观察期', rec.napDelayMinutes === 30 && rec.observeUntil > rec.changedAt)
check('记录保留依据误报事件', rec.evidenceEventIds.length === 3)
check('档案阈值已按审批结果更新', s().elders.find((x) => x.id === 'e1')!.thresholds.stillnessMinutes === 60)

// 12. 调整后午睡时段告警按延后阈值判定（60+30=90分钟）
const jumpToNap = (minuteInWindow: number) => {
  const st = s()
  const target = new Date(st.now())
  target.setHours(13, 0, 0, 0)
  target.setMinutes(target.getMinutes() + minuteInWindow)
  let delta = Math.round((target.getTime() - st.now()) / 60000)
  if (delta <= 0) delta += 24 * 60
  st.fastForward(delta)
}
jumpToNap(10)
s().raiseAlert('e1', 'stillness', '家-卧室')
const napFalseEv = s().events[0]
check('午睡时段新告警按延后阈值90分钟生成流程', napFalseEv.plan.find((p) => p.key === 'door_visit')!.reason.includes('90'))
s().familyRespond(napFalseEv.id, 'false_alarm', '老人午睡，确认误报')

// 13. 观察期内发现被漏报的真实异常（午睡叫不醒 → 家属要求上门 → 现场需医疗）
jumpToNap(40)
s().raiseAlert('e1', 'stillness', '家-卧室')
const missedEv = s().events[0]
s().familyRespond(missedEv.id, 'request_visit', '午睡时间太久叫不醒，请马上上门')
s().dispatchVisit(missedEv.id, '刘敏')
s().recordArrival(missedEv.id)
s().recordVisitResult(missedEv.id, 'need_medical', '老人呼之不应、意识模糊')
check('观察期评估识别出漏报的真实风险', evaluateObservation(rec, s().events, s().now()).passed === false)

// 14. 观察期结束评估 → 发现漏报自动回退，记录永久保留
s().fastForward(7 * 24 * 60)
s().reviewThresholdChange(rec.id)
const recAfter = s().thresholdChanges.find((c) => c.id === rec.id)!
check('漏报后变更自动回退', recAfter.status === 'reverted')
check('档案阈值恢复为调整前45分钟', s().elders.find((x) => x.id === 'e1')!.thresholds.stillnessMinutes === 45)
check('回退记录保留回退人与原因', !!recAfter.revertedBy && (recAfter.revertReason ?? '').includes('漏报'))
check('观察结论记录误报与漏报情况', recAfter.observation!.missedRisk === true && recAfter.observation!.falseAlarmsAfter === 1)
// 回退后午睡告警恢复默认阈值（不再延后）
jumpToNap(15)
s().raiseAlert('e1', 'stillness', '家-卧室')
const restoredEv = s().events[0]
check('回退后午睡告警恢复默认阈值', restoredEv.plan.find((p) => p.key === 'door_visit')!.reason.includes('45') && !restoredEv.plan.find((p) => p.key === 'door_visit')!.reason.includes('延后'))

// 15. 后续真实异常可回看：当时为何降低/延后告警（即使该调整已回退）
const lookBack = thresholdsAtEvent(s().thresholdChanges, e1, missedEv.occurredAt)
check('真实异常事件可回看当时生效（后已回退）的调整', lookBack.change?.id === rec.id)
check('回看记录保留审批人与调整原因', lookBack.change?.approver === '陈医生' && lookBack.change!.reason.includes('午睡'))
check('回看标记事件发生在午睡时段', lookBack.inNap === true)

// 16. 观察期通过路径（周淑珍：无漏报、误报清零 → 持续生效）
s().applyThresholdChange('e5', {
  approver: '王书记',
  approverRole: '社区负责人',
  reason: '家属反映久坐阅读误报，社区负责人审批后适度上调静止阈值观察一周。',
  after: { stillnessMinutes: 60 },
  napDelayMinutes: null,
  observeDays: 7,
  evidenceEventIds: [],
})
const rec5 = s().thresholdChanges.find((c) => c.elderId === 'e5' && c.status === 'observing')!
s().fastForward(8 * 24 * 60)
s().reviewThresholdChange(rec5.id)
const rec5After = s().thresholdChanges.find((c) => c.id === rec5.id)!
check('无漏报且误报未增长 → 调整持续生效', rec5After.status === 'effective')
check('生效后保留观察评估结论', rec5After.observation!.missedRisk === false && rec5After.observation!.falseAlarmsAfter === 0)

// 17. 人工回退路径（李建国：医生复查认为不宜放宽）
s().applyThresholdChange('e2', {
  approver: '陈医生',
  approverRole: '社区医生',
  reason: '家属申请放宽静止阈值，先行观察。',
  after: { stillnessMinutes: 75 },
  napDelayMinutes: null,
  observeDays: 7,
  evidenceEventIds: [],
})
const rec2 = s().thresholdChanges.find((c) => c.elderId === 'e2' && c.status === 'observing')!
s().revertThresholdChange(rec2.id, '医生复查认为老人有房颤史，继续放宽存在漏报风险')
const rec2After = s().thresholdChanges.find((c) => c.id === rec2.id)!
check('人工回退成功且阈值恢复', rec2After.status === 'reverted' && s().elders.find((x) => x.id === 'e2')!.thresholds.stillnessMinutes === 60)
check('人工回退原因已留痕', (rec2After.revertReason ?? '').includes('房颤'))
check('阈值变更记录永久保留（不因回退删除）', s().thresholdChanges.filter((c) => c.elderId === 'e2').length >= 1)

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECKS FAILED`)
process.exit(failures === 0 ? 0 : 1)
