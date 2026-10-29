# Current working-tree code evidence

Captured 2026-10-25; includes pre-existing local edits. Line numbers refer to original files. These excerpts are static evidence, not live acceptance.

## packages/core/src/types.ts:14-115

```text
14:   | 'capped'
15:   | 'reviewing'
16:   | 'stalled'
17:   | 'failed'
18:   | 'cancelled'
19: 
20: export type Verdict = 'accepted' | 'partial' | 'rejected'
21: 
22: export type StallReason = 'login' | 'upload' | 'timeout' | 'ui' | 'config' | 'worker' | 'unknown_submission'
23: 
24: export type StoreMode = 'project' | 'local'
25: 
26: export type AnswerHome = 'local' | 'repo'
27: 
28: /** Persisted before the browser/API submit can have any external side effect. */
29: export interface DispatchIntent {
30:   attemptId: string
31:   at: string
32:   requestHash: string
33:   /** Set only after the transport has observed a submission for this attempt. */
34:   observedAt?: string
35: }
36: 
37: export interface RoundRecord {
38:   n: number
39:   /** Which regeneration/version this round belongs to; 1 is the first run. */
40:   generation?: number
41:   submittedAt?: string
42:   answeredAt?: string
43:   verdict?: Verdict
44:   done?: boolean
45:   files: number
46:   fingerprint?: string
47:   submissionId?: string
48:   /**
49:    * Presence means "this attempt may already have been sent". Never auto-resend
50:    * a round that has a dispatch without an observed submission.
51:    */
52:   dispatch?: DispatchIntent
53:   /** How many submits this round has made; 1 means no retry yet. */
54:   attempts?: number
55:   /** Design directions requested for this round; falls back to the topic default. */
56:   designs?: number
57:   /** Topic-relative artifacts produced by this round. */
58:   artifacts?: string[]
59:   /** Judge transport/format failure for an answer that is already on disk. */
60:   judgeError?: string
61: }
62: 
63: export interface Topic {
64:   schema: 1
65:   id: string
66:   title: string
67:   type: TopicType
68:   parent: string | null
69:   created: string
70:   updated: string
71:   status: Status
72:   stallReason?: StallReason
73:   roundsCap: number
74:   designs?: number
75:   /** Effective round ceiling for the current invocation (continue/regenerate). */
76:   runThrough?: number
77:   /** Design count to apply to the next round created for this topic. */
78:   nextDesigns?: number
79:   /** One entry per generation: the initial run and each explicit regeneration. */
80:   generations?: GenerationRecord[]
81:   rounds: RoundRecord[]
82:   channel: string
83:   model: string
84:   successCriteria: string[]
85:   artifacts: string[]
86:   stopReason?: string
87:   /** Status to restore if a review handoff is withdrawn (`answered` = judge failed after an answer landed). */
88:   reviewFrom?: 'capped' | 'failed' | 'stalled' | 'answered'
89:   /** Previous stop reason, restored when a review handoff is withdrawn. */
90:   reviewStopReason?: string
91:   /** Previous stall reason, restored when a stalled review handoff is withdrawn. */
92:   reviewStallReason?: StallReason
93:   /** Judge-authored brief for the next round, persisted across restarts. */
94:   nextBrief?: string
95:   humanCheck?: HumanCheck
96: }
97: 
98: export interface HumanCheck {
99:   at: string
100:   conclusion: 'submitted' | 'not_submitted' | 'reopen'
101:   note: string
102: }
103: 
104: export interface GenerationRecord {
105:   n: number
106:   createdAt: string
107:   /** Rounds this version is allowed to run (its own budget). */
108:   rounds?: number
109:   /** Why this version was requested, e.g. the user's regeneration feedback. */
110:   reason?: string
111:   /** Topic-relative archived final for this version. */
112:   final?: string
113: }
114: 
115: export interface MaterialRef {
```

## packages/core/src/types.ts:225-258

```text
225:   images?: ImageAsset[]
226:   codeBlocks?: CodeBlock[]
227:   archives?: ArchiveAsset[]
228:   snapshotPath?: string
229: }
230: 
231: export type TransportFailure = 'login' | 'upload' | 'ui' | 'network' | 'worker' | 'timeout' | 'config'
232: 
233: export class TransportError extends Error {
234:   readonly failure: TransportFailure
235: 
236:   constructor(
237:     message: string,
238:     failure: TransportFailure,
239:     options?: { cause?: unknown },
240:   ) {
241:     super(message, options)
242:     this.name = 'TransportError'
243:     this.failure = failure
244:   }
245: }
246: 
247: export interface Transport {
248:   /** `reason` carries a human-readable hint for the api channel (never the key). */
249:   probe(): Promise<{ ok: boolean; loggedIn: boolean; model: string; available: string[]; reason?: string }>
250:   submit(request: SubmitRequest): Promise<SubmitResult>
251:   reattach?(request: ReattachRequest): Promise<ReattachResult>
252:   poll(request: { submissionId: string; timeoutMs: number; signal?: AbortSignal }): Promise<PollResult>
253:   fetch(request: { submissionId: string }): Promise<FetchedAnswer>
254:   cancelSubmission?(submissionId: string): Promise<void>
255:   cancel(): Promise<void>
256: }
257: 
258: export interface JudgeInput {
```

## packages/core/src/engine.ts:278-304

```text
278:   /** Human accepts a capped/reviewing or artifact-bearing failed/stalled result. */
279:   async accept(id: string): Promise<Topic> {
280:     const topic = await this.options.store.load(id)
281:     if (topic.status === 'completed') return topic
282:     const withArtifacts = (topic.status === 'failed' || topic.status === 'stalled') && topic.artifacts.length > 0
283:     const reviewingFrom = topic.status === 'reviewing' ? topic.reviewFrom ?? 'capped' : undefined
284:     const reviewingAcceptable = reviewingFrom !== undefined
285:       && (reviewingFrom === 'capped' || reviewingFrom === 'answered' || topic.artifacts.length > 0)
286:     if (topic.status !== 'capped' && !reviewingAcceptable && !withArtifacts) {
287:       throw new Error(`topic ${id} is ${topic.status}; only capped/reviewing or failed/stalled with artifacts can be accepted`)
288:     }
289:     delete topic.reviewFrom
290:     delete topic.reviewStopReason
291:     delete topic.reviewStallReason
292:     delete topic.runThrough
293:     delete topic.nextDesigns
294:     const existing = await this.options.store.readFinal(topic)
295:     const text = existing === undefined
296:       ? this.finalDocument(topic, undefined, '人工接受结果', 'completed')
297:       : `${existing.replace(/^- 状态：.*$/m, '- 状态：completed').trimEnd()}\n- 人工接受：${new Date().toISOString()}\n`
298:     const accepted = text.includes('（未生成摘要；见各轮裁决与原始答复）')
299:       ? `${text}- 人工接受说明：未生成自动摘要，结论见原始答复。\n`
300:       : text
301:     await this.options.store.writeFinal(topic, accepted)
302:     await this.transition(topic, 'completed', { stopReason: '人工接受结果' })
303:     this.emit({ type: 'finished', topicId: topic.id, status: 'completed' })
304:     return topic
```

## packages/core/src/engine.ts:350-405

```text
350:    * round to the current one. Failed rounds without an answer are retried in
351:    * place; finished topics get a fresh generation.
352:    */
353:   /**
354:    * Each version gets its own round budget, so a regeneration can run as many
355:    * rounds as the initial task did instead of stopping after a single round.
356:    */
357:   private generationBudget(topic: Topic): number {
358:     const configured = topic.generations?.[0]?.rounds ?? this.options.config.rounds
359:     return Number.isInteger(configured) && configured >= 1 ? configured : 1
360:   }
361: 
362:   async regenerate(id: string, brief: string, reason: string, materials?: MaterialRef[]): Promise<Topic> {
363:     const topic = await this.options.store.load(id)
364:     this.assertChannel(topic)
365:     if (brief.trim() === '') throw new Error('brief is required')
366:     const recoverable = topic.status === 'failed' || topic.status === 'stalled'
367:     const last = topic.rounds[topic.rounds.length - 1]
368:     if (recoverable && last !== undefined && last.answeredAt === undefined) {
369:       return await this.continue(id, brief, materials)
370:     }
371:     const finished = topic.status === 'completed' || topic.status === 'capped' || topic.status === 'reviewing' || recoverable
372:     if (!finished) throw new Error(`topic ${id} is ${topic.status}; regenerate needs a terminal topic`)
373: 
374:     if (topic.generations === undefined) {
375:       topic.generations = [{ n: 1, createdAt: topic.created, rounds: this.generationBudget(topic), reason: '初始任务' }]
376:     }
377:     // Older topics finished before generations existed: archive their current
378:     // final as generation 1 before starting generation 2.
379:     if (topic.generations.length === 1 && topic.generations[0]?.final === undefined) {
380:       const previous = await this.options.store.readFinal(topic)
381:       if (previous !== undefined) await this.options.store.writeFinal(topic, previous)
382:     }
383:     const budget = this.generationBudget(topic)
384:     const generation = (topic.generations.at(-1)?.n ?? 1) + 1
385:     topic.generations.push({
386:       n: generation,
387:       createdAt: new Date().toISOString(),
388:       rounds: budget,
389:       reason: reason.trim() || '用户重新生成',
390:     })
391:     const next = topic.rounds.length + 1
392:     topic.roundsCap = Math.max(topic.roundsCap, next + budget - 1)
393:     topic.runThrough = next + budget - 1
394:     delete topic.nextDesigns
395:     delete topic.nextBrief
396:     await this.options.store.writeQuestion(topic, next, brief)
397:     const staged = await this.options.store.addMaterials(topic, materials ?? [])
398:     await this.options.store.writeRoundMaterials(topic, next, staged)
399:     delete topic.reviewFrom
400:     delete topic.reviewStopReason
401:     delete topic.reviewStallReason
402:     delete topic.stopReason
403:     await this.transition(topic, 'queued')
404:     this.enqueue(id)
405:     return topic
```

## packages/core/src/engine.ts:408-428

```text
408:   /**
409:    * Explicit follow-up on a finished topic: one more round with a new brief.
410:    * The round limit grows when the follow-up would exceed it, because this is
411:    * the user-confirmed "+1 round" the design requires.
412:    */
413:   async continue(id: string, brief: string, materials?: MaterialRef[], designs?: number): Promise<Topic> {
414:     const topic = await this.options.store.load(id)
415:     this.assertChannel(topic)
416:     if (brief.trim() === '') throw new Error('brief is required')
417:     if (designs !== undefined && (!Number.isInteger(designs) || designs < 1 || designs > 6)) {
418:       throw new Error('designs must be an integer between 1 and 6')
419:     }
420:     const finished = topic.status === 'completed' || topic.status === 'capped' || topic.status === 'reviewing'
421:     const recoverable = topic.status === 'failed' || topic.status === 'stalled'
422:     if (!finished && !recoverable) {
423:       throw new Error(`topic ${id} is ${topic.status}; only completed/capped/reviewing or failed/stalled topics accept a follow-up`)
424:     }
425:     const last = topic.rounds[topic.rounds.length - 1]
426:     const retryCurrent = recoverable && last !== undefined && last.answeredAt === undefined
427:     if (retryCurrent && hasUnobservedDispatch(last)) {
428:       throw new Error('上一轮可能已经发送；请先人工核对，确认“未提交”后再继续，避免重复发送')
```

## packages/core/src/engine.ts:822-874

```text
822:   private async adjudicate(topic: Topic, round: RoundRecord): Promise<void> {
823:     const answer = await this.options.store.readAnswer(topic, round.n)
824:     if (answer === undefined) {
825:       throw new TransportError('answer file is missing for adjudication', 'ui')
826:     }
827:     await this.transition(topic, 'adjudicating')
828:     const question = (await this.options.store.readQuestion(topic, round.n)) ?? ''
829:     const input = { topic, round: round.n, answer, criteria: topic.successCriteria, question }
830:     let result: JudgeResult
831:     try {
832:       result = await this.options.judge(input)
833:     } catch (first) {
834:       // A malformed/transient judge response must not destroy a completed
835:       // answer. Retry once, then hand the topic to host/human review with the
836:       // answer and verdict placeholder intact.
837:       try {
838:         result = await this.options.judge(input)
839:       } catch (second) {
840:         await this.parkJudgeFailure(topic, round, second ?? first)
841:         return
842:       }
843:     }
844:     delete round.judgeError
845:     await this.options.store.writeVerdict(topic, round.n, this.verdictDocument(round, result))
846:     round.verdict = result.verdict
847:     round.done = result.done
848:     await this.options.store.appendEvent(topic, {
849:       type: 'verdict',
850:       round: round.n,
851:       verdict: result.verdict,
852:       done: result.done,
853:     }).catch(() => undefined)
854:     this.emit({ type: 'round', topicId: topic.id, round: round.n, verdict: result.verdict })
855:     if (result.done) {
856:       delete topic.runThrough
857:       delete topic.nextDesigns
858:       await this.options.store.writeFinal(topic, this.finalDocument(topic, result.summary, result.reason, 'completed'))
859:       await this.transition(topic, 'completed', { stopReason: result.reason })
860:       this.emit({ type: 'finished', topicId: topic.id, status: 'completed' })
861:       return
862:     }
863:     if (round.n >= (topic.runThrough ?? topic.roundsCap)) {
864:       delete topic.runThrough
865:       delete topic.nextDesigns
866:       await this.options.store.writeFinal(topic, this.finalDocument(topic, result.summary, result.reason, 'capped'))
867:       await this.transition(topic, 'capped', { stopReason: result.reason })
868:       this.emit({ type: 'finished', topicId: topic.id, status: 'capped' })
869:       return
870:     }
871:     this.nextBrief.set(topic.id, result.nextBrief)
872:     if (result.nextBrief !== undefined && result.nextBrief.trim() !== '') topic.nextBrief = result.nextBrief
873:     else delete topic.nextBrief
874:     await this.transition(topic, 'queued')
```

## packages/core/src/store.ts:609-635

```text
609:   /** Build a downloadable zip for one round without touching the topic files. */
610:   async bundleRound(topic: Topic, round: number): Promise<{ name: string; bytes: Buffer }> {
611:     const dir = await this.dirOf(topic.id)
612:     const base = resolve(dir, 'artifacts', `round-${pad(round)}`)
613:     const prefix = `artifacts/round-${pad(round)}/`
614:     const files: Record<string, Uint8Array> = {}
615:     let total = 0
616:     for (const path of topic.artifacts) {
617:       if (!path.startsWith(prefix)) continue
618:       const target = resolve(dir, path)
619:       if (target !== base && !target.startsWith(`${base}${sep}`)) continue
620:       let bytes: Buffer
621:       try {
622:         bytes = await readFile(target)
623:       } catch {
624:         // Skip one unreadable file; the rest of the bundle is still useful.
625:         continue
626:       }
627:       total += bytes.length
628:       // Deliberately outside the per-file catch: an over-limit bundle must
629:       // fail loudly instead of silently shipping a truncated zip.
630:       if (total > 100 * 1024 * 1024) throw new Error('round artifacts exceed 100 MB')
631:       files[path.slice(prefix.length)] = bytes
632:     }
633:     if (Object.keys(files).length === 0) throw new Error(`round ${round} has no artifacts to bundle`)
634:     const zipped = zipSync(files, { level: 6 })
635:     return { name: `round-${pad(round)}.zip`, bytes: Buffer.from(zipped) }
```

## packages/core/src/store.ts:692-709

```text
692:   async writeFinal(topic: Topic, text: string): Promise<void> {
693:     const dir = await this.dirOf(topic.id)
694:     await this.atomic(join(dir, 'final.md'), text)
695:     if (!topic.artifacts.includes('final.md')) topic.artifacts.push('final.md')
696:     if (topic.generations === undefined) {
697:       topic.generations = [{ n: 1, createdAt: topic.created, reason: '初始任务' }]
698:     }
699:     const generation = topic.rounds[topic.rounds.length - 1]?.generation ?? topic.generations.at(-1)?.n ?? 1
700:     const relative = `finals/attempt-${pad(generation)}.md`
701:     await this.atomic(join(dir, relative), text)
702:     const record = topic.generations.find(item => item.n === generation)
703:     if (record !== undefined) record.final = relative
704:   }
705: 
706:   async readFinal(topic: Topic): Promise<string | undefined> {
707:     try {
708:       return await readFile(join(await this.dirOf(topic.id), 'final.md'), 'utf8')
709:     } catch {
```

## packages/research/src/plugin.ts:300-342

```text
300: 
301: const JUDGE_SYSTEM = [
302:   '你是研究任务的验收裁判。只输出一个 JSON 对象，不要 Markdown 围栏。',
303:   '字段：verdict（accepted|partial|rejected）、reason（一句话）、done（是否已满足全部成功判据）、',
304:   'summary（不超过 200 字的中文结论摘要）、nextBrief（未完成时下一轮要问什么，已完成可省略）、',
305:   'criteria（数组：每个成功判据一项，字段 criterion、status=met|partial|unmet|unknown、evidence 一句话引用答复中的依据）。',
306:   '必须逐条判断所有成功判据；done 只有在 verdict=accepted 且全部判据 status=met 时才为 true。',
307:   '判断依据只能是答复本身与给定判据；不要因为答复自信或一致就判 accepted。',
308: ].join('\n')
309: 
310: function parseJudge(text: string): Omit<JudgeResult, 'nextBrief'> & { nextBrief?: string } {
311:   const start = text.indexOf('{')
312:   const end = text.lastIndexOf('}')
313:   if (start === -1 || end <= start) throw new Error('judge returned no JSON object')
314:   const parsed = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>
315:   const verdict = parsed.verdict === 'accepted' || parsed.verdict === 'rejected' || parsed.verdict === 'partial'
316:     ? parsed.verdict
317:     : 'partial'
318:   const criteria = Array.isArray(parsed.criteria)
319:     ? parsed.criteria.flatMap(item => {
320:       if (item === null || typeof item !== 'object') return []
321:       const row = item as Record<string, unknown>
322:       if (typeof row.criterion !== 'string' || row.criterion.trim() === '') return []
323:       const status = row.status === 'met' || row.status === 'partial' || row.status === 'unmet' || row.status === 'unknown'
324:         ? row.status
325:         : 'unknown'
326:       return [{
327:         criterion: row.criterion,
328:         status,
329:         ...(typeof row.evidence === 'string' && row.evidence.trim() !== '' ? { evidence: row.evidence } : {}),
330:       }] as JudgeCriterion[]
331:     })
332:     : undefined
333:   return {
334:     verdict,
335:     reason: typeof parsed.reason === 'string' ? parsed.reason : '',
336:     // A judge that says done while reporting a non-accepted verdict is
337:     // contradictory; the conservative reading is "not done".
338:     done: parsed.done === true && verdict === 'accepted',
339:     summary: typeof parsed.summary === 'string' ? parsed.summary : '',
340:     ...(criteria !== undefined && criteria.length > 0 ? { criteria } : {}),
341:     ...(typeof parsed.nextBrief === 'string' ? { nextBrief: parsed.nextBrief } : {}),
342:   }
```

## packages/research/src/plugin.ts:430-451

```text
430:       const assembler = new BlockAssembler()
431:       const user = [
432:         `主题：${input.topic.title}`,
433:         `成功判据：\n${input.criteria.map(item => `- ${item}`).join('\n')}`,
434:         `本轮问题：\n${input.question ?? '（未记录）'}`,
435:         `本轮答复：\n${input.answer.slice(0, 30_000)}`,
436:       ].join('\n\n')
437:       for await (const chunk of llm.stream({
438:         provider: route.provider,
439:         model: route.model,
440:         system: JUDGE_SYSTEM,
441:         messages: [createUserMessage({
442:           content: [{ type: 'text', text: user }],
443:           source: { kind: this.spec.name } as never,
444:         })],
445:         maxTokens: 1_800,
446:         signal: AbortSignal.timeout(120_000),
447:       })) {
448:         assembler.push(chunk as never)
449:       }
450:       const text = assembler.blocks().map(block => (block.type === 'text' ? block.text : '')).join('')
451:       return parseJudge(text)
```

## packages/research/src/plugin.ts:823-871

```text
823:   /**
824:    * A human accepted a result. Wake the originating conversation so the agent
825:    * continues whatever it was doing before it handed this topic off.
826:    */
827:   private async notifyAccepted(id: string, topic: Topic): Promise<{ ok: boolean; resumed?: boolean; reason?: string }> {
828:     try {
829:       const entry = await this.entryFor(id)
830:       const sessionId = entry?.sessionId ?? this.topicSessions.get(id)
831:       if (sessionId === undefined) return { ok: false, reason: '原会话 id 未记录' }
832:       const dir = await this.storeAt(entry?.root ?? this.rootFor(''), entry?.mode ?? this.config.store).dirOf(id)
833:       return await this.wakeSession(sessionId, `<system-reminder>用户已接受「${topic.title}」的当前结果，视为验收通过。请继续这个主题之前被搁置的后续工作，不要重复已经完成的研究/设计轮次。产物目录：${dir}，最终汇总：${join(dir, 'final.md')}。</system-reminder>`)
834:     } catch (error) {
835:       return { ok: false, reason: error instanceof Error ? error.message : String(error) }
836:     }
837:   }
838: 
839:   private async entryFor(id: string): Promise<RegistryEntry | undefined> {
840:     return (await this.readRegistry()).find(entry => entry.id === id)
841:   }
842: 
843:   async listAll(): Promise<Array<Record<string, unknown>>> {
844:     const entries = await this.readRegistry()
845:     const rows: Array<Record<string, unknown>> = []
846:     for (const entry of entries) {
847:       try {
848:         const topic = await this.storeAt(entry.root, entry.mode).load(entry.id)
849:         rows.push({ ...this.view(topic), root: entry.root, store: entry.mode })
850:       } catch {
851:         // A recorded topic that no longer loads is left out instead of faked.
852:       }
853:     }
854:     return rows.sort((a, b) => String(b.updated ?? '').localeCompare(String(a.updated ?? '')))
855:   }
856: 
857:   async detail(id: string): Promise<Record<string, unknown> | undefined> {
858:     const entry = await this.entryFor(id)
859:     if (entry === undefined) return undefined
860:     const store = this.storeAt(entry.root, entry.mode)
861:     const topic = await store.load(id)
862:     const dir = await store.dirOf(id)
863:     return {
864:       ...this.view(topic),
865:       root: entry.root,
866:       store: entry.mode,
867:       path: dir,
868:       report: await access(join(dir, 'report.md')).then(() => 'report.md').catch(() => null),
869:       artifact_details: await this.artifactDetails(dir, topic),
870:       rounds_detail: topic.rounds,
871:     }
```

## packages/research/src/plugin.ts:1014-1040

```text
1014:     if (action === 'continue') {
1015:       // The panel's "continue one round" dialog posts here; the tool path has
1016:       // its own handler. Keep both on one engine call so the resulting record
1017:       // is identical no matter who started the follow-up.
1018:       const brief = (extra?.brief ?? '').trim()
1019:       if (brief === '') throw new Error('brief is required')
1020:       this.assertTextSafe('brief', brief)
1021:       const store = this.storeAt(entry.root, entry.mode)
1022:       const topic = await store.load(id)
1023:       let refs: MaterialRef[] | undefined
1024:       if (materialPaths !== undefined && materialPaths.length > 0) {
1025:         // Panel/route materials resolve against the topic's project root, not
1026:         // the requesting session cwd, so a follow-up cannot silently attach a
1027:         // different project's file with the same relative path.
1028:         refs = this.withSources(entry.root, await buildManifest(entry.root, materialPaths, undefined, this.config.secretGlobs))
1029:         assertMaterialLimits(refs, this.config.maxFiles, this.config.maxTotalMB)
1030:       }
1031:       const requestedDesigns = extra?.designs
1032:       if (requestedDesigns !== undefined
1033:         && (!Number.isInteger(requestedDesigns) || requestedDesigns < 1 || requestedDesigns > 6)) {
1034:         throw new Error('designs must be an integer between 1 and 6')
1035:       }
1036:       const designs = topic.type === 'design'
1037:         ? (requestedDesigns ?? topic.designs ?? this.config.designs)
1038:         : undefined
1039:       const followUp = designs === undefined ? brief : this.withDesignCount(brief, designs)
1040:       return this.view(await engine.continue(id, followUp, refs, designs))
```

## packages/research/src/plugin.ts:1097-1125

```text
1097:     if (action === 'regenerate') {
1098:       const topic = await this.storeAt(entry.root, entry.mode).load(id)
1099:       const finished = topic.status === 'completed' || topic.status === 'capped' || topic.status === 'reviewing'
1100:       const recoverable = topic.status === 'failed' || topic.status === 'stalled'
1101:       if (!finished && !recoverable) {
1102:         throw new Error(`topic ${id} is ${topic.status}; regenerate needs completed/capped/reviewing or failed/stalled`)
1103:       }
1104:       const feedback = (note ?? '').trim()
1105:       this.assertTextSafe('regenerate note', feedback)
1106:       // Materials resolve against the topic's own project root, so the tool
1107:       // path and the panel route agree on what a relative path means.
1108:       let refs: MaterialRef[] | undefined
1109:       if (materialPaths !== undefined && materialPaths.length > 0) {
1110:         refs = this.withSources(entry.root, await buildManifest(entry.root, materialPaths, undefined, this.config.secretGlobs))
1111:         assertMaterialLimits(refs, this.config.maxFiles, this.config.maxTotalMB)
1112:       }
1113:       const brief = [
1114:         `继续主题「${topic.title}」：用户对上一轮结果不满意，请基于已有上下文重新生成并改进。`,
1115:         '## 用户反馈',
1116:         feedback === '' ? '没有具体反馈；请保持成功判据不变，给出与上一轮明显不同的新方案。' : feedback,
1117:         '## 要求',
1118:         '不要重复上一轮已确认的内容；给出新的产物或方向，并说明与上一版的差异。',
1119:       ].join('\n\n')
1120:       return this.view(await engine.regenerate(
1121:         id,
1122:         this.withDesignCount(brief, topic.designs ?? this.config.designs),
1123:         feedback,
1124:         refs,
1125:       ))
```

## packages/research/client/panel.tsx:700-748

```text
700:   if (path === 'report.md') return '宿主交付稿'
701:   const source = generationList(detail).find(item => item.final === path)
702:   return source !== undefined ? `第 ${source.n} 版总结` : '已有总结 · 版本未确认'
703: }
704: 
705: function ResearchOverview({ detail, onTab }: { detail: TopicDetail; onTab: (tab: Tab) => void }): ReactNode {
706:   const report = detail.report ?? undefined
707:   const generated = latestFinal(detail)
708:   const path = report ?? generated
709:   const isReport = report !== undefined
710:   const source = `${detail.topic_id}:${path ?? ''}`
711:   const [document, setDocument] = useState<{ source: string; text?: string; error?: string }>()
712:   const [retry, setRetry] = useState(0)
713:   useEffect(() => {
714:     if (path === undefined) return
715:     const abort = new AbortController()
716:     setDocument({ source })
717:     void fetchText(`${config.routes}/file?id=${encodeURIComponent(detail.topic_id)}&path=${encodeURIComponent(path)}`, abort.signal)
718:       .then(text => { if (!abort.signal.aborted) setDocument({ source, text }) })
719:       .catch((error: unknown) => {
720:         if (!abort.signal.aborted) setDocument({ source, error: error instanceof Error ? error.message : String(error) })
721:       })
722:     return () => abort.abort()
723:   }, [source, detail.updated, retry])
724:   const current = document?.source === source ? document : undefined
725:   const generations = generationList(detail)
726:   const latest = generations.at(-1)
727:   const previous = !isReport && path !== undefined && latest !== undefined && latest.final !== path
728:   const title = path === undefined ? '运行汇总尚未生成' : isReport ? '宿主交付稿' : '运行汇总（自动生成）'
729:   return (
730:     <section className="dshpro-document-card">
731:       <div className="dshpro-section-heading">
732:         <div><span className="dshpro-eyebrow">{isReport ? '交付稿' : '运行汇总'}</span><h3>{title}</h3></div>
733:         {path !== undefined && <button type="button" className="dshpro-btn" onClick={() => { void openTopicFile(detail.topic_id, path) }}>阅读全文 <Glyph name="arrow" /></button>}
734:       </div>
735:       {path === undefined ? <div className="dshpro-content-empty"><Glyph name="file" size={28} /><strong>这里将呈现运行汇总</strong><span>已有轮次的回答可在运行记录中查看；宿主整理后会生成交付稿 report.md，并优先显示在这里。</span><button className="dshpro-btn" type="button" onClick={() => onTab('rounds')}>查看运行记录</button></div> : <>
736:         <div className="dshpro-document-context">
737:           {isReport
738:             ? '宿主按判据整理的交付稿；结论和证据仍应回到轮次与原始答复核对。'
739:             : '自动生成的运行汇总，不是交付稿；宿主交付稿 report.md 尚未生成。'}
740:           {previous ? '当前版本尚无已关联总结，以下为已有文档。' : ''}
741:           {detail.status === 'cancelled' || detail.status === 'failed' || detail.status === 'stalled' || detail.status === 'reviewing' ? '任务未正常结束，请核对内容与完整性。' : '任务状态不代表人工验收。'}
742:         </div>
743:         {current?.error !== undefined ? <div className="dshpro-content-empty" role="alert"><strong>暂时无法读取文档</strong><span>{current.error}</span><button type="button" className="dshpro-btn" onClick={() => setRetry(value => value + 1)}>重新加载</button></div>
744:           : current?.text === undefined ? <div className="dshpro-document-loading" role="status" aria-label="正在读取文档"><div className="dshpro-skeleton" /><div className="dshpro-skeleton" /><div className="dshpro-skeleton" /></div>
745:             : current.text.trim() === '' ? <div className="dshpro-content-empty">此文件暂无内容。</div>
746:               : <DocumentContent text={current.text.slice(0, 18000)} />}
747:         {current?.text !== undefined && current.text.length > 18000 && <button type="button" className="dshpro-btn" onClick={() => { void openTopicFile(detail.topic_id, path) }}>继续阅读全文</button>}
748:       </>}
```

## packages/research/client/panel.tsx:753-806

```text
753: function ArtifactImage({ detail, path }: { detail: TopicDetail; path: string }): ReactNode {
754:   const [failed, setFailed] = useState(false)
755:   const [retry, setRetry] = useState(0)
756:   const source = assetUrl(detail.topic_id, path)
757:   useEffect(() => { setFailed(false); setRetry(0) }, [source])
758:   return <div className="dshpro-art-frame">
759:     {failed ? <div className="dshpro-image-error"><Glyph name="image" size={24} /><span>图片加载失败</span><button type="button" className="dshpro-btn small" onClick={() => { setFailed(false); setRetry(value => value + 1) }}>重新加载</button></div>
760:       : <button type="button" className="dshpro-art" title={`查看 ${artifactDisplayName(path)}`} onClick={() => openViewerImage(detail.topic_id, path)}><img src={`${source}&v=${retry}`} alt={artifactDisplayName(path)} loading="lazy" onError={() => setFailed(true)} /></button>}
761:     <div className="dshpro-art-caption"><Glyph name="image" /><span title={path}>{artifactDisplayName(path)}</span></div>
762:   </div>
763: }
764: 
765: function DemoCard({ detail, path }: { detail: TopicDetail; path: string }): ReactNode {
766:   const name = artifactName(path)
767:   return (
768:     <div className="dshpro-demo">
769:       <div className="dshpro-demo-meta">
770:         <div className="dshpro-file-info">
771:           <div className="dshpro-file-name" title={path}>{name}</div>
772:           <div className="dshpro-file-path">{roundOf(path) !== undefined ? `第 ${roundOf(path)} 轮 · ` : '来源轮次未确认 · '}HTML 交互演示</div>
773:         </div>
774:         <div className="dshpro-demo-actions">
775:           <button type="button" className="dshpro-btn small" onClick={() => openFrame({ kind: 'frame', title: name, topicId: detail.topic_id, src: rawUrl(detail.topic_id, path), path })}>预览</button>
776:           <button type="button" className="dshpro-btn small" onClick={() => { window.open(rawUrl(detail.topic_id, path), '_blank', 'noopener,noreferrer') }}>新窗口</button>
777:         </div>
778:       </div>
779:     </div>
780:   )
781: }
782: 
783: function DesignOverview({ detail, onTab }: { detail: TopicDetail; onTab: (tab: Tab) => void }): ReactNode {
784:   const generation = generationList(detail).at(-1)
785:   const round = generation === undefined ? undefined : generationRounds(detail, generation.n).at(-1)
786:   const artifacts = round === undefined ? [] : roundArtifacts(detail, round)
787:   const images = artifacts.filter(path => artifactKind(detail, path) === 'image')
788:   const demos = artifacts.filter(path => artifactKind(detail, path) === 'demo')
789:   const expected = round?.designs ?? detail.designs ?? 3
790:   const pipeline = round === undefined
791:     ? '等待本轮结果。'
792:     : detail.channel === 'api'
793:       ? `图片通道：本轮取回 ${images.length}/${expected} 张；只产出图片，不产出 HTML demo；视觉待人工确认。`
794:       : `本轮取回 ${images.length}/${expected} 张图；${demos.length > 0 ? `HTML demo ${demos.length} 个` : 'HTML 未取回'}；视觉待人工确认。`
795:   return <div>
796:     <section className="dshpro-design-sheet">
797:       <div className="dshpro-section-heading">
798:         <div><span className="dshpro-eyebrow">设计成果{generation !== undefined ? ` / 第 ${generation.n} 版` : ''}</span><h3>{round !== undefined ? `第 ${round.n} 轮图片` : '等待本版设计'} <span className="dshpro-muted">{images.length > 0 ? `· ${images.length} 张` : ''}</span></h3></div>
799:         <button type="button" className="dshpro-btn ghost" onClick={() => onTab('artifacts')}>全部产物 <Glyph name="arrow" /></button>
800:       </div>
801:       <div className="dshpro-document-context">{pipeline}</div>
802:       {images.length > 0 ? <div className="dshpro-gallery">{images.map(path => <ArtifactImage key={path} detail={detail} path={path} />)}</div>
803:         : <div className="dshpro-content-empty"><Glyph name="image" size={32} /><strong>本轮还没有图片</strong><span>生成的设计图将在这里完整呈现。</span>{imageArtifacts(detail).length > 0 && <button type="button" className="dshpro-btn" onClick={() => onTab('artifacts')}>查看历史图片（{imageArtifacts(detail).length}）</button>}</div>}
804:     </section>
805:     {demos.length > 0 && <section className="dshpro-card"><div className="dshpro-card-head"><h3 className="dshpro-card-title">本轮交互演示</h3></div>{demos.map(path => <DemoCard key={path} detail={detail} path={path} />)}</section>}
806:   </div>
```

## packages/research/client/panel.tsx:1032-1059

```text
1032:         <fieldset className="dshpro-dialog-body" disabled={busy}>
1033:           {dialog.kind === 'regenerate' && (
1034:             <>
1035:               <label htmlFor="dshpro-regen">不满意的地方 / 新要求</label>
1036:               <p>可留空直接换一版；提交后保留已有轮次。</p>
1037:               <textarea id="dshpro-regen" value={regenNote} onChange={event => onRegenNote(event.target.value)} placeholder="例如：保留版式，只改配色；标题必须出现……；不要再用……" />
1038:             </>
1039:           )}
1040:           {dialog.kind === 'continue' && (
1041:             <>
1042:               <label htmlFor="dshpro-continue">这一轮只补充什么</label>
1043:               <p>一次继续只追加一轮，不会顺带跑完剩余上限。</p>
1044:               <textarea id="dshpro-continue" value={continueNote} onChange={event => onContinueNote(event.target.value)} placeholder="例如：只查部署风险；只改配色，保留版式" />
1045:               {designMode && (
1046:                 <div className="dshpro-dialog-row">
1047:                   <label htmlFor="dshpro-directions">本轮方向数</label>
1048:                   <input id="dshpro-directions" type="number" min={1} max={6} value={continueDesigns} onChange={event => onContinueDesigns(event.target.value)} placeholder="3" />
1049:                   <span>1–6</span>
1050:                 </div>
1051:               )}
1052:             </>
1053:           )}
1054:           {(dialog.kind === 'regenerate' || dialog.kind === 'continue') && (
1055:             <>
1056:               <label htmlFor="dshpro-materials">新增材料（可选）</label>
1057:               <p>每行一个相对项目根的路径，只发送本轮新增文件；超限、密钥命中或路径不存在会在提交前报错。</p>
1058:               <textarea id="dshpro-materials" value={materialsNote} onChange={event => onMaterialsNote(event.target.value)} placeholder={'docs/evidence.md\nassets/brand.png'} />
1059:             </>
```

## packages/research/client/panel.tsx:1497-1520

```text
1497:   const hasArtifacts = (current?.artifacts.length ?? 0) > 0
1498:   const canAccept = current !== undefined && (
1499:     current.status === 'capped'
1500:     || (current.status === 'reviewing' && (current.review_from === 'capped' || current.review_from === 'answered' || hasArtifacts))
1501:     || ((current.status === 'failed' || current.status === 'stalled') && hasArtifacts)
1502:   )
1503:   const canRegenerate = current !== undefined && (current.status === 'completed' || current.status === 'capped' || current.status === 'reviewing' || current.status === 'failed' || current.status === 'stalled')
1504:   const canContinue = current !== undefined && (current.status === 'completed' || current.status === 'capped' || current.status === 'reviewing' || current.status === 'failed' || current.status === 'stalled')
1505:   const canReview = current !== undefined && (current.status === 'capped' || (current.status === 'reviewing' && current.review_from !== 'answered') || ((current.status === 'failed' || current.status === 'stalled') && hasArtifacts))
1506:   const canReviewCancel = current !== undefined && current.status === 'reviewing' && current.review_from !== 'answered'
1507:   const canWake = current !== undefined && current.status === 'completed'
1508:   const canCancel = current !== undefined && ACTIVE.has(current.status)
1509:   const retryJudge = current !== undefined && current.status === 'reviewing' && current.review_from === 'answered'
1510:   const canResume = current !== undefined && (current.status === 'stalled' || current.status === 'failed' || retryJudge)
1511:   const canDelete = current !== undefined && (current.status === 'draft' || current.status === 'completed' || current.status === 'cancelled'
1512:     || current.status === 'capped' || current.status === 'failed' || current.status === 'stalled')
1513:   const acceptLabel = current !== undefined && (current.status === 'capped' || current.status === 'reviewing') ? '接受结果' : '接受已有产物'
1514: 
1515:   let primary: { label: string; run: () => void } | undefined
1516:   if (current !== undefined) {
1517:     if (canResume) primary = { label: retryJudge ? '重试自动裁决' : '恢复运行', run: () => { void runExclusive(() => act('resume')) } }
1518:     else if (canAccept) primary = { label: acceptLabel, run: () => { void runExclusive(() => act('accept')) } }
1519:     else if (current.status === 'completed' && canContinue) primary = { label: '继续一轮', run: openContinue }
1520:   }
```

## packages/research/client/document.tsx:1-59

```text
1: import type { ReactNode } from 'react'
2: 
3: /** A deliberately small, text-only Markdown reader. Raw HTML and links stay inert. */
4: function inline(text: string): ReactNode {
5:   return text.split(/(\*\*[^*\n]+\*\*|`[^`\n]+`)/g).map((part, index) =>
6:     part.startsWith('**') && part.endsWith('**') ? <strong key={index}>{part.slice(2, -2)}</strong>
7:       : part.startsWith('`') && part.endsWith('`') ? <code key={index}>{part.slice(1, -1)}</code> : part)
8: }
9: 
10: export function DocumentContent({ text }: { text: string }): ReactNode {
11:   const lines = text.replace(/\r\n?/g, '\n').split('\n')
12:   const blocks: ReactNode[] = []
13:   for (let i = 0; i < lines.length;) {
14:     const line = lines[i] ?? ''
15:     const key = i
16:     if (line.trim() === '') { i++; continue }
17:     if (/^\s*```/.test(line)) {
18:       const code: string[] = []
19:       i++
20:       while (i < lines.length && !/^\s*```/.test(lines[i] ?? '')) code.push(lines[i++] ?? '')
21:       i++
22:       blocks.push(<pre key={key}><code>{code.join('\n')}</code></pre>)
23:       continue
24:     }
25:     const heading = line.match(/^(#{1,6})\s+(.+)$/)
26:     if (heading !== null) {
27:       const Tag = heading[1]?.length === 1 ? 'h2' : heading[1]?.length === 2 ? 'h3' : 'h4'
28:       blocks.push(<Tag key={key}>{inline(heading[2] ?? '')}</Tag>); i++; continue
29:     }
30:     if (/^\s*(?:---+|\*\*\*+)\s*$/.test(line)) { blocks.push(<hr key={key} />); i++; continue }
31:     if (/^\s*[-*+]\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line)) {
32:       const ordered = /^\s*\d+[.)]/.test(line)
33:       const pattern = ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*+]\s+/
34:       const items: ReactNode[] = []
35:       while (i < lines.length && pattern.test(lines[i] ?? '')) {
36:         items.push(<li key={i}>{inline((lines[i++] ?? '').replace(pattern, ''))}</li>)
37:       }
38:       blocks.push(ordered ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>); continue
39:     }
40:     if (/^\s*>/.test(line)) {
41:       const quote: string[] = []
42:       while (i < lines.length && /^\s*>/.test(lines[i] ?? '')) quote.push((lines[i++] ?? '').replace(/^\s*>\s?/, ''))
43:       blocks.push(<blockquote key={key}>{inline(quote.join('\n'))}</blockquote>); continue
44:     }
45:     if (line.includes('|') && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1] ?? '')) {
46:       const cells = (row: string): string[] => row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim())
47:       const headers = cells(line)
48:       const rows: string[][] = []
49:       i += 2
50:       while (i < lines.length && (lines[i] ?? '').includes('|') && (lines[i] ?? '').trim() !== '') rows.push(cells(lines[i++] ?? ''))
51:       blocks.push(<div className="dshpro-document-table" key={key}><table><thead><tr>{headers.map((cell, n) => <th key={n}>{inline(cell)}</th>)}</tr></thead><tbody>{rows.map((row, n) => <tr key={n}>{row.map((cell, c) => <td key={c}>{inline(cell)}</td>)}</tr>)}</tbody></table></div>); continue
52:     }
53:     const paragraph: string[] = [line]
54:     i++
55:     while (i < lines.length && (lines[i] ?? '').trim() !== '' && !/^(?:#{1,6}\s|\s*```|\s*[-*+]\s|\s*\d+[.)]\s|\s*>|---+$)/.test(lines[i] ?? '')) paragraph.push(lines[i++] ?? '')
56:     blocks.push(<p key={key}>{inline(paragraph.join('\n'))}</p>)
57:   }
58:   return <article className="dshpro-document">{blocks}</article>
59: }
```

## packages/transport/src/openai-images.ts:350-388

```text
350:         return { ok: false, loggedIn: false, model, available: [], reason: `预检超时（${this.origin()}）` }
351:       }
352:       return { ok: false, loggedIn: false, model, available: [], reason: `无法连接 ${this.origin()}：${messageOf(error)}` }
353:     }
354:   }
355: 
356:   async submit(request: SubmitRequest): Promise<SubmitResult> {
357:     this.assertReady()
358:     if (isAborted(request.signal)) throw new DOMException('aborted', 'AbortError')
359:     const count = clampCount(request.designs ?? this.options.count)
360:     const references = await this.referenceImages(request.files)
361:     if (isAborted(request.signal)) throw new DOMException('aborted', 'AbortError')
362:     const prompt = this.basePrompt(request)
363:     const controller = new AbortController()
364:     // A cancelled run must stop billable work even if nobody calls
365:     // cancelSubmission: the engine's abort is the earliest cancellation signal.
366:     request.signal?.addEventListener('abort', () => controller.abort(), { once: true })
367:     if (isAborted(request.signal)) controller.abort()
368:     const id = randomUUID()
369:     const job = { request, count, controller, completed: 0, reported: 0 } as Job
370:     const generated = this.generate(job, prompt, references)
371:     job.settled = generated.then(() => undefined, () => undefined)
372:     void generated.then(
373:       result => { job.result = result },
374:       error => { job.error = error },
375:     )
376:     this.jobs.set(id, job)
377:     return {
378:       submissionId: id,
379:       fingerprint: sha256([
380:         this.options.baseUrl,
381:         this.options.model,
382:         this.options.size,
383:         this.options.quality,
384:         String(count),
385:         prompt,
386:         ...references.map(reference => reference.name),
387:       ].join('\n')),
388:       attachments: references.map(reference => reference.name),
```

## packages/transport/src/openai-images.ts:466-475

```text
466:   private directionPrompt(base: string, index: number, count: number, references: number): string {
467:     const parts = [base]
468:     if (count > 1) {
469:       parts.push(`---\n本次只生成第 ${index + 1} 个方向（共 ${count} 个）。构图、配色与字体气质要和其他方向明显不同；只输出这一张图，不要拼图、不要九宫格。`)
470:     }
471:     if (references > 0) {
472:       parts.push(`随附 ${references} 张参考图：按任务约束使用其中的品牌元素与版式，不要照抄与任务无关的内容。`)
473:     }
474:     return parts.join('\n\n')
475:   }
```

## packages/transport/src/openai-images.ts:564-600

```text
564:   private async edit(prompt: string, references: Reference[], signal: AbortSignal): Promise<ImageAsset[]> {
565:     const form = new FormData()
566:     form.set('model', this.options.model)
567:     form.set('prompt', prompt)
568:     form.set('n', '1')
569:     if (this.options.size !== '' && this.options.size !== 'auto') form.set('size', this.options.size)
570:     if (this.options.quality !== '' && this.options.quality !== 'auto') form.set('quality', this.options.quality)
571:     if (this.options.format !== 'png') form.set('output_format', this.options.format)
572:     if (/^dall-e/i.test(this.options.model)) form.set('response_format', 'b64_json')
573:     for (const reference of references) {
574:       // Copy into a plain Uint8Array: Node's Buffer is backed by ArrayBufferLike,
575:       // which the DOM BlobPart type rejects.
576:       const copy = new Uint8Array(reference.bytes.byteLength)
577:       copy.set(reference.bytes)
578:       form.append('image[]', new Blob([copy], { type: reference.mime }), reference.name)
579:     }
580:     let response: Response
581:     try {
582:       response = await this.fetchImpl(this.endpoint('edits'), {
583:         method: 'POST',
584:         headers: this.authHeaders(),
585:         body: form,
586:         signal: this.signalFor(signal),
587:       })
588:     } catch (error) {
589:       throw this.networkError(error)
590:     }
591:     if (!response.ok) {
592:       const detail = redact(await response.text().catch(() => ''))
593:       if (response.status === 400 || response.status === 404 || response.status === 422) {
594:         throw new TransportError(
595:           `参考图接口 /images/edits 被拒（HTTP ${response.status}）：${detail}。若该服务商或模型不支持参考图，把 imageEdit 设为 off 再试。`,
596:           'config',
597:         )
598:       }
599:       throw this.httpError(response.status, detail)
600:     }
```

## packages/transport/src/openai-images.ts:715-734

```text
715:   private async referenceImages(files: readonly string[]): Promise<Reference[]> {
716:     if (this.options.editMode === 'off') return []
717:     const references: Reference[] = []
718:     for (const file of files) {
719:       if (references.length >= MAX_REFERENCES) break
720:       if (!IMAGE_EXTENSIONS.has(extname(file).toLowerCase())) continue
721:       let bytes: Buffer
722:       try {
723:         bytes = await readFile(file)
724:       } catch (error) {
725:         throw new TransportError(`读取参考图失败：${basename(file)}（${messageOf(error)}）`, 'upload')
726:       }
727:       if (bytes.byteLength > MAX_REFERENCE_BYTES) continue
728:       const mime = detectImageMime(bytes)
729:       // A .png that is not actually an image would only confuse the provider.
730:       if (mime === undefined) continue
731:       references.push({ name: basename(file), mime, bytes })
732:     }
733:     return references
734:   }
```

## packages/research/resources/skills/pro-research/SKILL.md:39-61

```text
39: ## 答复回来之后
40: 
41: 宿主模型负责裁决，不把 Pro 的话直接当结论：
42: 
43: 1. 读原始答复与各轮 `verdict.md`（逐条判据表在“## 判据”一节）；
44: 2. 对照成功判据逐条判断：采纳 / 部分采纳 / 有依据驳回；
45: 3. 把裁决写进项目文档，保留分歧和未决项；
46: 4. 只把变化送进下一轮（工具会在同一主题里续轮次），不重复已确认内容。
47: 
48: `final.md` 是运行汇总（自动生成），不是交付物。宿主应在主题目录写 `report.md`：
49: 
50: 1. 当前结论与适用条件；
51: 2. 成功判据逐条：met / partial / unmet / unknown + 对应轮次或答复证据；
52: 3. 未决问题；
53: 4. 产物与轮次入口。
54: 
55: 面板优先展示 `report.md`；没有时明确显示“宿主尚未整理交付稿”。
56: 
57: 自动裁决失败时主题停在 `reviewing`（`review_from=answered`），答复和产物都保留：按成功判据选择 `accept` / `continue` / `regenerate`，或修好 `judgeProvider` / `judgeModel` 后 `resume` 重试。不要把这种情况说成运行失败。
58: 
59: ## 追问
60: 
61: 在同一主题上追加一轮用：
```

## packages/design/resources/skills/pro-design/SKILL.md:42-67

```text
42: ## 产物与裁决
43: 
44: - 图片由传输层抓取或下载，保存到 `<主题>/artifacts/round-NN/image-01.png`；
45: - web 通道的前端代码块保存为 `code-01.html`/`.tsx` 等，HTML 可以直接在设计面板的 iframe 里预览；
46: - api 通道没有代码块；需要 demo 时由你另写，并在交付说明里标明来源；
47: - 面板「Image Design」按项目列出主题，详情是画廊 + demo 预览 + 设计决策；概览显示「取回 X/Y 张、HTML 是否取回、视觉待人工确认」，取回数量不等于验收通过。
48: 
49: 答复/结果回来后由宿主裁决：
50: 
51: 1. 逐张检查图片是否满足判据（文案、比例、方向）；
52: 2. 有 HTML demo 时打开核实能渲染，记录依赖/外链；
53: 3. 选方向、写理由，未采纳项保留驳回依据；
54: 4. 交付 `design.md`，引用实际产物路径，不把模型原文当交付物。
55: 
56: 自动裁决失败时主题停在 `reviewing`（`review_from=answered`），图片与 HTML 保留：接受、继续、重新生成，或修好裁决模型后重试。文本裁决看不到图片，不得用它替“方向可区分 / 文案可读”这类视觉判据盖章。
57: 
58: ## 追问
59: 
60: `gpt_image_design(action="continue", topic_id=..., brief="只改配色，保留版式", materials=[...], confirmed=true)`。
61: web 通道在同一会话里只上传新增材料，会话失效会自动回退整份清单；api 通道每轮重新发提示词，参考图按当轮材料重新附加。
62: 
63: 整版不满意用 `regenerate`（保留历史、开新版本），`note` 写不满意点，可附 `materials=[...]`（相对主题项目根目录）。终态主题确认后可 `delete`，目录与面板记录一并删除，不可恢复。
64: 
65: ## 边界
66: 
67: - 不自动 push、不改仓库代码；demo 只是产物，实施另行授权。
```

## packages/core/test/engine.test.ts:130-148

```text
130:   it('renders per-criterion findings in the verdict document', async () => {
131:     const judge: Judge = async () => ({
132:       verdict: 'accepted',
133:       reason: 'ok',
134:       done: true,
135:       summary: 'done',
136:       criteria: [
137:         { criterion: '覆盖两个市场', status: 'met', evidence: '答复第 2 节' },
138:         { criterion: '给出可执行流程', status: 'partial', evidence: '缺回滚步骤' },
139:       ],
140:     })
141:     const { engine, store } = await harness({ doneAt: 1, judge })
142:     const topic = await engine.start(card())
143:     await engine.drain()
144:     const dir = await store.dirOf(topic.id)
145:     const verdict = await readFile(join(dir, 'rounds', '01-verdict.md'), 'utf8')
146:     expect(verdict).toContain('| 覆盖两个市场 | 满足 | 答复第 2 节 |')
147:     expect(verdict).toContain('| 给出可执行流程 | 部分满足 | 缺回滚步骤 |')
148:   })
```

## packages/research/test/document.test.ts:1-31

```text
1: import { createElement } from 'react'
2: import { renderToStaticMarkup } from 'react-dom/server'
3: import { describe, expect, it } from 'vitest'
4: import { DocumentContent } from '../client/document.tsx'
5: 
6: const render = (text: string): string => renderToStaticMarkup(createElement(DocumentContent, { text }))
7: 
8: describe('saved research document reader', () => {
9:   it('renders structure while keeping untrusted HTML and links inert', () => {
10:     const html = render('# 已有总结\n\n**结论**与`<script>`\n\n<img src=x onerror=alert(1)>\n\n[链接](javascript:alert(1))')
11:     expect(html).toContain('<h2>已有总结</h2>')
12:     expect(html).toContain('<strong>结论</strong>')
13:     expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
14:     expect(html).not.toContain('<img')
15:     expect(html).not.toContain('<script')
16:     expect(html).not.toContain('<a ')
17:   })
18: 
19:   it('preserves code, list items and tabular evidence without interpreting code as markup', () => {
20:     const html = render('## 检查\r\n\r\n- 通过\r\n- 未运行\r\n\r\n| 项目 | 状态 |\n| --- | --- |\n| 本机 | **通过** |\n\n```html\n<h1>不执行</h1>\n```')
21:     expect(html).toContain('<li>未运行</li>')
22:     expect(html).toContain('<th>状态</th>')
23:     expect(html).toContain('<td><strong>通过</strong></td>')
24:     expect(html).toContain('&lt;h1&gt;不执行&lt;/h1&gt;')
25:     expect(html).not.toContain('<h1>')
26:   })
27: 
28:   it('retains incomplete fenced text at the preview cutoff', () => {
29:     expect(render('```\n# 保留原文\n最后一行')).toContain('# 保留原文\n最后一行')
30:   })
31: })
```
