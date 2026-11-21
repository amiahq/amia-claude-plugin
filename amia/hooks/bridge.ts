import type { EngineInterface, Frozen, PermissionRequestDecision, Register, SessionContextUsage, StreamNext, TurnStepInput } from 'claude-code'
import { LiveBlocks, bytesOf } from './live_blocks.ts'
import type { Out, Step } from './live_blocks.ts'
import { POST_MAX, Posts } from './posts.ts'
import { Queue, prompt as queuedPrompt, typed as typedLine } from './queue.ts'
import type { Held } from './queue.ts'
import { runShell, shells } from './shell.ts'
import { FORK_STEPS, Kept as SideKept, NO_TOOLS, added as sideAdded, again as sideAgain, ask as sideAsk, postWords } from './side.ts'
import type { SideOut, SideWords } from './side.ts'
import { asked, continuesInMs } from './questions.ts'
import { NextTaken, TAKEN_BACK } from './taken.ts'
import { FAILED, Wheel, calledBy, checkedBy, placed } from './wheel.ts'
import { meter } from './resets.ts'

// docs/538 §4, the bridge v1: this session to and from this computer's `ac serve`. Out: the
// session's turns, the owner's acts as done, the questions it asks and, while ac watches it,
// each main-loop response piece by piece with the row each block became. In: the owner's
// acts, on one request ac holds for the session. Nothing Claude Code shows, records or sends
// changes but by those acts, and a bridge that fails costs the session nothing (I-OBSERVE).
//
// The module is loaded once per session process, so its state is this session's. Every call
// that outlives a hook is made by one worker on `session.start`'s `$`: a call made inside a
// turn's hook is cancelled when that turn is stopped (§6.2, measured), and the turn's hooks
// only queue what the worker sends.

type Engine = EngineInterface
type Heard = { v?: unknown; watched?: unknown; restate?: unknown; do?: unknown; notices?: unknown }
/** One `$.command.run` of this module; `act` is answered `said` with its row, none for an act
 *  answered already, whose row is only journaled as the owner's; a queued command's row is the
 *  queue's `read` of its `batch` (docs/569 Q3). */
type Run = { act: string | undefined; ran: boolean; batch?: Held[] }
/** A prompt submitted as the owner's: the say act it answers and the words it entered, or the
 *  queued lines it carries (docs/569), whose acts were answered `queued` already. */
type Saying = { act: string | undefined; text: string; batch?: Held[] }

const V = 1
/** The append hook's observation budget; the host retains a row until its receipt arrives. */
const BIND_MS = 50
/** How long a step's `end` waits for its blocks' rows. */
const ROWS_MS = 250
/** How often a session with no bridge looks for one, at most. */
const LOOK_MS = 15_000
/** The wait after a look that found none, doubling to LOOK_MS: an ac that restarts answers
 *  again within seconds, and its sessions' prompts reach the owner only once it is found. */
const RELOOK_MS = 250
/** A failed hold open this long was cut while waiting, not refused. */
const HOLD_CUT_MS = 5_000
const ACT = /^[0-9a-f]{32}$/
/** The act ids a hold acks, and the ids done that a re-send must not do again. */
const ACTS_KEPT = 256
/** Background work remembered per session, newest last. */
const TASKS_KEPT = 64
/** How long a stop waits for its turn to complete before it ends the command its abort sent to
 *  the background. */
const STOP_WAIT_MS = 10_000
/** The commands one list carries, as the host keeps them (docs/539 W8). */
const COMMANDS_MAX = 256
/** The breakdown rows one context reading carries, as the host keeps them (docs/571). */
const KINDS_MAX = 16
/** What a Bash result says when its command went on in the background (2.1.306). */
const BACKGROUNDED = /running in background with ID: ([A-Za-z0-9_-]+)/
/** docs/587 P7: what a Monitor result says once its watch is armed, first (2.1.311: "Monitor
 *  started (task <id>, expires in 30m unless the source ends …"). */
const WATCHING = /^Monitor started \(task ([A-Za-z0-9_-]+), expires in /
/** docs/539 W7: the command a tune runs for each setting, and how Claude Code says it set one
 *  (every `/model` and `/effort` that set one in this Mac's 400 newest records, 2.1.309). */
const TUNES = [
  { setting: 'model', set: 'Set model to ' },
  { setting: 'effort', set: 'Set effort level to ' },
] as const

const prose = new LiveBlocks(out => {
  if (live.watched) void send(live.session, out)
})

/** docs/539 W8: each command as the engine last described it. A command can be described in a
 *  mid-turn form and an idle one (`model`: `[model]` immediate, `<model>` not; 2.1.309,
 *  measured): its hint is the idle form's, else the other's; it runs now if any form does; it is
 *  hidden only if every form is. */
const described = new Map<string, { hint: string | undefined; now: boolean; hidden: boolean }>()

const live = {
  /** The worker runs, on the first `session.start`'s `$`. */
  working: false,
  wake: undefined as (() => void) | undefined,
  session: undefined as string | undefined,
  interactive: false,
  transcript: undefined as string | undefined,
  /** docs/539 W8: the session's permission mode, as its last classic hook said; none, never said. */
  mode: undefined as string | undefined,
  /** The one face answering, or none: no bridge, and nothing is posted. */
  face: undefined as string | undefined,
  /** The face and session last announced with `start`. */
  announced: undefined as { key: string; before: number | undefined } | undefined,
  /** No look before this, unless the retry fires or a turn starts. */
  lookAfter: Number.NEGATIVE_INFINITY,
  lookIn: RELOOK_MS,
  retry: undefined as { cancel: () => void } | undefined,
  tick: undefined as { cancel: () => void } | undefined,
  watched: false,
  /** docs/582 P19: what the host would have this chat told now, as words the next prompt carries;
   *  each hold answer replaces them, so a notice carried twice is told once. */
  notices: [] as string[],
  /** The main loop's running turn. */
  running: undefined as string | undefined,
  /** Main-loop turns begun: a queued command whose run failed once one began was taken (a stop
   *  of its turn), and never runs again. */
  turns: 0,
  steps: prose.steps,
  holds: new Set<string>(),
  /** Acts submitted as the owner's prompt, with their words, oldest first, until their row is
   *  stored. */
  saying: [] as Saying[],
  /** docs/557 R6: the act whose prompt row was stored, until the next turn starts: it opened
   *  that turn only when the turn begins with its words (2.1.309, measured: the row is appended
   *  before its turn.start, whose `text` is the prompt). */
  opening: undefined as Saying | undefined,
  /** docs/557 R6: the act each running turn was opened by, until the turn completes. */
  opened: new Map<string, string>(),
  /** Commands run, oldest first, until their row is stored. */
  runs: [] as Run[],
  /** This module's `$.command.run` calls not yet settled: the session runs a command, with or
   *  without a turn of its own (a local one has none), and words wait behind it (docs/569 Q1). */
  commanding: 0,
  /** docs/539 W8: the typeahead's list as the host last heard it, and whether to read it again. */
  listed: undefined as string | undefined,
  listDue: true,
  /** The last ACTS_KEPT act ids done, oldest first. */
  performed: [] as string[],
  /** Background commands and watches the main loop's turns started: what a stopJob may name
   *  (docs/587). */
  jobs: [] as string[],
  /** docs/769 P6: those of them no task notification has said ended yet. A turn that ends with
   *  any is no finish: the session's own work wakes it again. */
  unfinished: [] as string[],
  /** Commands a turn's abort sent from its foreground to the background, by turn: what a stop
   *  of that turn ends (docs/587 D6). */
  aborted: [] as { turn: string; id: string }[],
  /** Stopped turns a stop waits on until they complete. */
  ending: new Map<string, () => void>(),
  /** Background work a stop ended, whose notifications are dropped (TASKS_KEPT). */
  silenced: [] as string[],
  queue: new Posts(),
  /** Dropped live statements are recovered from the retained blocks once the queue drains. */
  overflowed: false,
  /** docs/569 Q1: the owner's words said while a turn runs, and whether a turn's end owes them. */
  waiting: new Queue(),
  flushDue: false,
  /** When the main conversation's compaction running now began, on this clock; none runs. */
  compacting: undefined as number | undefined,
}

function nudge(): void {
  const wake = live.wake
  live.wake = undefined
  wake?.()
}

/** docs/643 E's routes: a wheel door's answer for this session. Nothing is sent with no face to ask, and nothing runs
 *  when the face refuses the ask (a 4xx: a malformed body, or an older ac with no such door), so each could not tell,
 *  in words. Undefined is only an ask that was sent and never answered: a 5xx (the face's "may have run") or a
 *  request dropped on the way, which may have run. A dropped request on a face that no longer says hello loses it. */
async function wheelAsk($: Engine, route: string, body: Record<string, unknown>): Promise<unknown> {
  const at = live.face
  const s = live.session
  if (at === undefined || s === undefined) return { wheel: 'could_not_tell', why: 'no ac answers here' }
  let answer: { status: number; text: string }
  try {
    answer = await $.http.fetch(`http://ac${route}`, {
      method: 'POST',
      socketPath: at,
      body: JSON.stringify({ v: V, s, ...body }),
    })
  } catch {
    if ((await call($, at, '/v1/hello'))?.v !== V) lost($, at)
    return undefined
  }
  if (answer.status >= 500) return undefined
  if (answer.status !== 200) {
    let why = `ac refused it (HTTP ${answer.status})`
    try {
      const said = JSON.parse(answer.text) as { why?: unknown }
      if (typeof said.why === 'string' && said.why !== '') why = `${why}: ${said.why}`
    } catch {}
    return { wheel: 'could_not_tell', why }
  }
  try {
    return JSON.parse(answer.text)
  } catch {
    return answer.text
  }
}

async function call($: Engine, at: string, route: string, body?: string): Promise<Heard | undefined> {
  try {
    const answer = await $.http.fetch(
      `http://ac${route}`,
      body === undefined ? { socketPath: at } : { method: 'POST', socketPath: at, body },
    )
    if (answer.status !== 200) return undefined
    const heard: unknown = JSON.parse(answer.text)
    return typeof heard === 'object' && heard !== null ? (heard as Heard) : undefined
  } catch {
    return undefined
  }
}

function lost($: Engine, at: string): void {
  if (live.face !== at) return
  live.face = undefined
  live.announced = undefined
  live.watched = false
  live.queue.clear()
  live.lookIn = RELOOK_MS
  missed($)
}

/** No bridge answers: look again after `lookIn`, which doubles to LOOK_MS until one is found. */
function missed($: Engine): void {
  const wait = live.lookIn
  live.lookIn = Math.min(wait * 2, LOOK_MS)
  live.lookAfter = Date.now() + wait
  live.retry?.cancel()
  live.retry = $.clock.after(wait, () => {
    live.retry = undefined
    live.lookAfter = Number.NEGATIVE_INFINITY
    nudge()
  })
}

/** Queues `out` for session `s` behind every line before it; resolves once ac answered it. */
function send(s: string | undefined, out: Out): Promise<void> {
  if (live.face === undefined || s === undefined) return Promise.resolve()
  const line = JSON.stringify({ v: V, s, ...out })
  return new Promise((sent) => {
    const result = live.queue.push(s, line, out.op, sent)
    live.overflowed ||= result.dropped
    if (!result.queued) sent()
    nudge()
  })
}

async function pump($: Engine): Promise<void> {
  for (let batch = live.queue.take(); batch.length !== 0; batch = live.queue.take()) {
    const first = batch[0]
    const at = live.face
    const heard = at === undefined ? undefined : await call($, at, '/v1/post', batch.map((q) => q.line).join('\n'))
    live.queue.finish(batch)
    if (at === undefined) continue
    if (heard === undefined) lost($, at)
    else hear(first.s, heard)
  }
}

/** Waits for `posted` at most `ms`: ac's binding is worth no more of the session's time. */
function within($: Engine, posted: Promise<unknown>, ms: number): Promise<void> {
  return new Promise((done) => {
    const timer = $.clock.after(ms, done)
    void posted.then(() => {
      timer.cancel()
      done()
    })
  })
}

/** docs/557 R7: what ac said became of a send it carries. `unknown` is the state SendMessage's answer has no
 *  room for: 2.1.322 words every `isDelivered: false` "Not sent: a plugin hook refused it (…)". */
type Carried =
  | { kind: 'delivered'; id: string; said: string | undefined }
  | { kind: 'refused'; why: string }
  | { kind: 'unknown'; id: string; why: string }

/** docs/786 T1: how long one ask about a send may go unanswered before it counts as broken. ac
 *  answers every ask inside `HOLD_FOR` (25 s, `face.rs`), `held` while it still delivers, and the
 *  engine cuts a `$.http.fetch` at 30 s whatever this module waits (2.1.306 and 2.1.323, measured).
 *  This bounds the ask, never the delivery: this module cannot see a delivery, so ac says what the
 *  send became and ends one that never does (`CARRY_FOR`). MEASURED: a 10 s deadline here read 118
 *  delivered sends "Not sent" (2026-11-05/12), and a 130 s one read "could not tell" 27 s before
 *  the message arrived (2026-11-13). */
const ASK_MS = 45_000
/** This module gives up on a send only on what it sees itself: no ac answering, or this many of
 *  its own asks broken in a row. */
const SEND_BREAKS = 3
/** A send is posted once; every later ask is a read by its id, which sends nothing. Only ac's
 *  record holding no such send posts it again, under the same id, this many times at most. */
const SEND_POSTS = 3
/** Two asks about one send are at least this far apart, should ac answer `held` without holding. */
const ASK_GAP_MS = 1_000
/** mobile's `tool_message.dart` reads a send with these words as perhaps delivered. */
const MAY_HAVE = 'ac may have taken this message — do not send it again'
/** This module's sends so far: each one's id, unique for the process. */
let sends = 0

/** What ac said of each send it carried, by loop, `to` and words, until its SendMessage result is
 *  worded from it; a plugin's own send has no result to word, so the oldest go first. */
const carriedSends = new Map<string, Carried & { to: string }>()
const CARRIED_KEPT = 64

function sendKey(agentId: string | undefined, to: string, text: string): string {
  return `${agentId ?? ''}\u0000${to}\u0000${text}`
}

/** The SendMessage result a send ac carried reads as: delivered with ac's words and the send's id,
 *  or not told either way, never "Not sent". None for a refusal: Claude Code's own words stand. */
function carriedResult(carried: Carried & { to: string }): { success: boolean; message: string } | undefined {
  switch (carried.kind) {
    case 'delivered':
      return { success: true, message: `Delivered by ac (send ${carried.id}). ${carried.said ?? `Sent to "${carried.to}".`}` }
    case 'unknown':
      return {
        success: false,
        message: `Could not tell whether it was delivered (ac send ${carried.id}): ${carried.why}. ${MAY_HAVE}.`,
      }
    case 'refused':
      return undefined
  }
}

/** How long a send waits to hear where it goes; past it, Claude Code's own answer stands. */
const ADDRESS_MS = 3_000

/** docs/677 E: Claude Code's own in-process addressees (its main conversation, a subagent or a
 *  teammate by name or id) stay its own, ahead of any chat of ac's that shares the name. */
async function ownAddressee($: Engine, to: string): Promise<boolean> {
  if (to === 'main') return true
  try {
    const agents = await $.agent.list()
    return agents.some((one) => one.id === to || one.name === to || one.teammateId === to || one.teammateId?.split('@')[0] === to)
  } catch {
    return false
  }
}

/** docs/677 E: whether ac carries a send, asked of ac before Claude Code resolves `to`; with no
 *  answer from ac, the send is Claude Code's, as without ac. `to` is never rewritten: auto mode
 *  judges the call as the model wrote it, and 2.1.318 refused every send whose `to` a hook moved
 *  after (measured 2026-11-06). */
async function carries($: Engine, to: string): Promise<boolean> {
  const at = live.face
  const s = live.session
  if (at === undefined || s === undefined) return false
  let heard: { carries?: unknown } | undefined
  await within(
    $,
    call($, at, '/v1/address', JSON.stringify({ v: V, s, to })).then((got) => { heard = got as typeof heard }),
    ADDRESS_MS,
  )
  return heard?.carries === true
}

/** docs/557 R7, docs/677 E: a send ac carries: a room, an ac agent, a start, or any chat of this
 *  computer Claude Code cannot reach itself. Answered here, never passed on to Claude Code, whose
 *  own resolution of a name it does not hold would answer "not reachable" over ac's delivery. */
async function sendToAc($: Engine, to: string, text: string): Promise<Carried> {
  const at = live.face
  const s = live.session
  if (at === undefined || s === undefined) return { kind: 'refused', why: 'ac is not running here' }
  sends += 1
  const id = `${Date.now().toString(36)}-${sends.toString(36)}`
  const post = JSON.stringify({ v: V, s, to, text, id })
  const read = JSON.stringify({ v: V, s, to, id })
  const unknown = (why: string): Carried => ({ kind: 'unknown', id, why })
  let face = at
  let posting = true
  let posts = 0
  let breaks = 0
  for (;;) {
    const posted = posting
    posting = false
    if (posted) posts += 1
    const asked = Date.now()
    let answer: { status: number; text: string } | undefined
    let broke: string | undefined
    await within(
      $,
      $.http.fetch(`http://ac${posted ? '/v1/send' : '/v1/became'}`, { method: 'POST', socketPath: face, body: posted ? post : read }).then(
        (got) => { answer = got },
        (error: unknown) => { broke = error instanceof Error ? error.message : String(error) },
      ),
      ASK_MS,
    )
    if (answer === undefined) {
      broke ??= `ac did not answer within ${ASK_MS / 1000} s`
      breaks += 1
      if ((await call($, face, '/v1/hello'))?.v !== V) {
        // The ac that took the post is gone, and what it carried with it. One that answers now
        // reads the send's own record; with none, nobody is left to say.
        lost($, face)
        const now = await look($)
        if (now === undefined) return unknown(`the request to ac broke: ${broke}`)
        face = now
      }
      if (breaks >= SEND_BREAKS) return unknown(`${breaks} asks of ac broke in a row: ${broke}`)
      continue
    }
    breaks = 0
    let said: { delivered?: unknown; held?: unknown; unsent?: unknown; why?: unknown; said?: unknown }
    try {
      said = JSON.parse(answer.text) as typeof said
    } catch {
      return unknown(`ac answered ${answer.status} with no words it speaks`)
    }
    if (said.held === true || said.unsent === true) {
      if (said.unsent === true) {
        if (posts >= SEND_POSTS) return unknown(`ac's record holds no such send after ${posts} posts of it`)
        posting = true
      }
      const early = ASK_GAP_MS - (Date.now() - asked)
      if (early > 0) await within($, new Promise<void>(() => {}), early)
      continue
    }
    const why = typeof said.why === 'string' && said.why !== '' ? said.why : undefined
    if (answer.status >= 500) return unknown(why ?? `ac answered ${answer.status}`)
    if (answer.status === 200 && said.delivered === true) {
      return { kind: 'delivered', id, said: typeof said.said === 'string' && said.said !== '' ? said.said : undefined }
    }
    // A refusal is the post's own, or the end ac kept for it. A read ac could not answer is neither.
    if (posted || (answer.status === 200 && said.delivered === false)) {
      return { kind: 'refused', why: `ac: ${why ?? 'ac did not take it'}` }
    }
    return unknown(`ac could not say what became of it: ${why ?? `HTTP ${answer.status}`}`)
  }
}

/** docs/557 G4: a send Claude Code delivered between two of its sessions, for ac to post in their
 *  pair inside the one room both are in. `to` is as written; ac reads whose it is. */
function reportSent($: Engine, to: string, text: string): void {
  const at = live.face
  const s = live.session
  if (at === undefined || s === undefined) return
  sends += 1
  const id = `${Date.now().toString(36)}-${sends.toString(36)}`
  void call($, at, '/v1/sent', JSON.stringify({ v: V, s, to, text, id }))
}

/** How long ListAgents waits for ac's listing; past it, Claude Code's own stands alone. */
const REACH_MS = 3_000

/** docs/557 R7: what this session can write to in ac, as ListAgents shows it; none without ac. */
async function reachOf($: Engine): Promise<string | undefined> {
  const at = live.face
  const s = live.session
  if (at === undefined || s === undefined) return undefined
  let heard: { listing?: unknown } | undefined
  await within(
    $,
    call($, at, `/v1/reach?s=${encodeURIComponent(s)}`).then((got) => { heard = got as typeof heard }),
    REACH_MS,
  )
  return typeof heard?.listing === 'string' ? heard.listing : undefined
}

function restate(): void {
  prose.restate()
}
function hear(s: string, heard: Heard): void {
  if (s !== live.session) return
  const was = live.watched
  live.watched = heard.watched === true
  if (live.watched && (!was || heard.restate === true)) restate()
}

/** Notices one prompt carries, and the longest: the host words each within it (`NOTICE_UNITS`),
 *  so one past it is a host's fault, dropped whole and said, never cut (its last words name it,
 *  and only they move its told mark). */
const NOTICES_MAX = 16
const NOTICE_CHARS = 4096

function noticesOf($: Engine, notices: unknown): string[] {
  if (!Array.isArray(notices)) return []
  const words: string[] = []
  for (const notice of notices.slice(0, NOTICES_MAX)) {
    const { id, words: said } = (notice ?? {}) as { id?: unknown; words?: unknown }
    if (typeof said !== 'string' || said.trim() === '') continue
    if (said.length <= NOTICE_CHARS) words.push(said)
    else $.ui.log(`ac: notice ${String(id)} not carried: ${said.length} characters, past ${NOTICE_CHARS}`, { to: 'debug' })
  }
  return words
}

function sayFailed(s: string, id: string, why: string | undefined): void {
  if (why === undefined) return
  const at = live.saying.findIndex((said) => said.act === id)
  if (at !== -1) live.saying.splice(at, 1)
  void send(s, { op: 'failed', act: id, why })
}

/** Ends the running turn and the command running in its foreground, as Claude Code's Esc does
 *  and nothing more (docs/587 D6, measured 2.1.312): every job already in the background runs
 *  on. `$.turn.abort` sends that command to the background, where it would run on and wake the
 *  session when it ends (§6.2, measured), so it is stopped there. With no turn running, a stop
 *  ends nothing. */
async function stop($: Engine, s: string, id: string): Promise<void> {
  const turn = live.running
  if (turn === undefined) {
    void send(s, { op: 'failed', act: id, why: 'nothing is running' })
    return
  }
  const done = new Promise<void>((over) => live.ending.set(turn, over))
  try {
    await $.turn.abort({ turnId: turn })
  } catch (error) {
    live.ending.delete(turn)
    void send(s, { op: 'failed', act: id, why: String(error) })
    return
  }
  // The abort's command is known before the turn completes.
  await Promise.race([done, new Promise<void>((late) => $.clock.after(STOP_WAIT_MS, late))])
  live.ending.delete(turn)
  const tasks = live.aborted.filter((task) => task.turn === turn).map((task) => task.id)
  live.aborted = live.aborted.filter((task) => task.turn !== turn)
  live.jobs = live.jobs.filter((job) => !tasks.includes(job))
  live.unfinished = live.unfinished.filter((job) => !tasks.includes(job))
  // A stopped task's notification wakes the session, and the model starts the work again
  // (§6.2, measured): the wake is dropped, and the model reads the stop once, below.
  for (const task of tasks) silence(task)
  const stopped = (await Promise.all(tasks.map((task) => ended($, task)))).filter(
    (task): task is Stopped => task !== undefined,
  )
  await told($, stopped)
  void send(s, { op: 'stopped', act: id, turn })
  // docs/569 S1: after a stop the queue goes next, behind the interruption the model reads.
  flush($)
}

/** docs/587 P7: one background job ends, and nothing else does (I6): `TaskStop` of a command or
 *  watch a main-loop turn here started, its wake dropped, the model told. Any other id, a
 *  subagent's included, is refused in words. */
async function stopJob($: Engine, s: string, id: string, job: unknown): Promise<void> {
  if (typeof job !== 'string' || !live.jobs.includes(job)) {
    const why = typeof job === 'string' ? `${job} is not a background job of this session` : 'a stopJob that names no job'
    void send(s, { op: 'failed', act: id, why })
    return
  }
  silence(job)
  const stopped = await taskStop($, job)
  if ('why' in stopped) {
    // Not stopped: an ending it comes to on its own still wakes the session.
    live.silenced = live.silenced.filter((silenced) => silenced !== job)
    void send(s, { op: 'failed', act: id, why: stopped.why })
    return
  }
  live.jobs = live.jobs.filter((other) => other !== job)
  live.unfinished = live.unfinished.filter((other) => other !== job)
  const text = stopped.what === job ? `[The user stopped the background job ${job}.]` : `[The user stopped the background job ${job}: ${stopped.what}.]`
  await note($, text, [job])
  void send(s, { op: 'stopped', act: id, job })
}

/** A task whose notification is dropped, as a stop ended it (TASKS_KEPT). */
function silence(task: string): void {
  live.silenced.push(task)
  if (live.silenced.length > TASKS_KEPT) live.silenced.shift()
}

/** docs/569 I-NEVER-LOST: said of words that meet the one turn of a print-mode run
 *  (`interactive: false`, docs/538 measured: `-p` false, `--bg` and a terminal true). */
const ONE_TURN = 'this chat is running its one turn in print mode and ends with it, so nothing can wait for it; say it again once the turn ends'

/** docs/569 Q1: the queue, whole, each time it changes. */
function postQueue(): void {
  void send(live.session, { op: 'queue', lines: live.waiting.lines() })
}

/** Neither a main-loop turn nor a command of this module's runs: a line said now goes at once. */
function idle(): boolean {
  return live.running === undefined && live.commanding === 0
}

/** Lines wait and the session is idle, or about to be: the worker sends the next. */
function due(): void {
  if (live.waiting.waitingCount === 0) return
  live.flushDue = true
  nudge()
}

/** docs/569 D1 (M10): the waiting lines that go next, oldest first. Words go as the owner's own
 *  next prompt, one line each, as Claude Code's dequeue opens a turn with them; a command runs
 *  as typed. A plugin's prompt and command run once the session is idle (M9); the lines stay
 *  listed until their row is stored, then leave read, and the lines behind go once it settles. A
 *  command Claude Code refused before any turn began waits again at the head, shown, to be sent
 *  again or taken back; one that failed after (its turn stopped) leaves, read. Why Claude Code
 *  refused the prompt that went, once it answered. */
function flush($: Engine): Promise<string | undefined> | undefined {
  const batch = live.waiting.take()
  if (batch === undefined) return
  const bangLine = batch[0].shell
  if (bangLine !== undefined) {
    void shellNow($, live.session ?? '', batch[0].entry, bangLine.line, bangLine.out, batch)
    return
  }
  const run = batch[0].run
  if (run !== undefined) {
    const turns = live.turns
    void command($, undefined, run.command, run.args, batch).then(due, () => {
      if (live.turns === turns) live.waiting.dropped(batch)
      else live.waiting.stored(batch)
      postQueue()
    })
    return
  }
  const text = queuedPrompt(batch)
  const said: Saying = { act: undefined, text, batch }
  live.saying.push(said)
  const unentered = (): void => {
    live.saying = live.saying.filter((saying) => saying !== said)
    live.waiting.dropped(batch)
    postQueue()
  }
  return $.prompt.submit({ text, asUser: true }).then(
    (entered) => {
      if (entered.drop !== undefined) unentered()
      return entered.drop
    },
    (error: unknown) => {
      unentered()
      return String(error)
    },
  )
}

/** docs/569 Q4: Claude Code's send now. A running turn is aborted, which sends a running Bash to
 *  the background where it runs on (§6.2, measured), and nothing it started is stopped; then the
 *  queue goes as the owner's next prompt. `next`: the host holds lines in Claude Code's own queue,
 *  which open the next turn as the owner's (§14 M38), so the abort alone sends them. */
async function sendNow($: Engine, s: string, id: string, next: boolean): Promise<void> {
  if (live.waiting.waitingCount === 0 && !next) {
    void send(s, { op: 'failed', act: id, why: 'nothing is waiting' })
    return
  }
  const turn = live.running
  if (turn !== undefined) {
    const done = new Promise<void>((over) => live.ending.set(turn, over))
    try {
      await $.turn.abort({ turnId: turn })
    } catch (error) {
      live.ending.delete(turn)
      void send(s, { op: 'failed', act: id, why: String(error) })
      return
    }
    await Promise.race([done, new Promise<void>((late) => $.clock.after(STOP_WAIT_MS, late))])
    live.ending.delete(turn)
  }
  const why = await Promise.race([flush($), new Promise<undefined>((late) => $.clock.after(STOP_WAIT_MS, () => late(undefined)))])
  void send(s, why === undefined ? { op: 'sent', act: id } : { op: 'failed', act: id, why })
}

/** docs/614: a `!` line, run now in the session's shell, or, while a turn, a command or a line
 *  ahead of it runs, a line of the queue as Claude Code queues a `!` typed mid-turn. */
function bang($: Engine, s: string, id: string, act: { line?: unknown; out?: unknown }): void {
  const { line, out } = act
  if (typeof line !== 'string' || typeof out !== 'string' || line === '' || !out.startsWith('/')) {
    void send(s, { op: 'failed', act: id, why: 'a ! line with no line or no file' })
    return
  }
  if (idle() && live.waiting.empty) {
    void shellNow($, s, id, line, out)
    return
  }
  const why = live.interactive ? live.waiting.add({ entry: id, text: `! ${line}`, at_ms: Date.now(), shell: { line, out } }) : ONE_TURN
  if (why !== undefined) {
    void send(s, { op: 'failed', act: id, why })
    return
  }
  postQueue()
  void send(s, { op: 'queued', act: id })
  if (idle()) flush($)
}

/** The line runs as a command of this module's does: words said meanwhile wait behind it. */
async function shellNow($: Engine, s: string, id: string, line: string, out: string, batch?: Held[]): Promise<void> {
  live.commanding++
  try {
    await runShell($, (posted) => send(s, posted as Out), id, line, out)
  } finally {
    live.commanding--
    if (batch !== undefined) {
      live.waiting.stored(batch)
      postQueue()
    }
    due()
  }
}

/** docs/569 Q4: `entry` leaves the queue while it waits, its words for the owner's line. */
function withdraw($: Engine, s: string, id: string, entry: unknown): void {
  if (typeof entry !== 'string') {
    void send(s, { op: 'failed', act: id, why: 'a withdraw that names no line' })
    return
  }
  const taken = live.waiting.withdraw(entry)
  if ('why' in taken) {
    void send(s, { op: 'failed', act: id, why: taken.why })
    return
  }
  postQueue()
  // `entry`: a `!` line's file goes with it (docs/614).
  void send(s, { op: 'withdrawn', act: id, entry, text: taken.text })
  // A refused command taken from the head lets the lines behind it go.
  if (idle()) flush($)
}

/** docs/539 W7: `/model`, then `/effort`, each as if the owner typed it; Claude Code queues each
 *  until its turn ends. Done once Claude Code said it set each; else failed in its own words, and
 *  nothing after it runs. While a turn or a command of this module's runs it is queued, answered at
 *  once: what Claude Code says when it ends is its own receipt in the transcript. Measured: an
 *  `/effort` behind a queued line's `/compact` waited 20 s, past ac's 15 s for an answer. */
async function tune($: Engine, s: string, id: string, settings: Record<string, unknown>): Promise<void> {
  const queued = !idle()
  if (queued) void send(s, { op: 'queued', act: id })
  const answer = (out: Out): void => {
    if (!queued) void send(s, out)
  }
  let ran = 0
  for (const { setting, set } of TUNES) {
    const args = settings[setting]
    if (args === undefined || args === null) continue
    if (typeof args !== 'string') {
      answer({ op: 'failed', act: id, why: `a ${setting} that is not words` })
      return
    }
    let text: string | undefined
    try {
      text = (await command($, undefined, setting, args)).text
    } catch (error) {
      answer({ op: 'failed', act: id, why: String(error) })
      return
    }
    if (text === undefined || !text.startsWith(set)) {
      answer({ op: 'failed', act: id, why: text?.trim() || `/${setting} ${args} printed nothing` })
      return
    }
    ran++
  }
  answer(ran === 0 ? { op: 'failed', act: id, why: 'a tune with no model or effort' } : { op: 'tuned', act: id })
}

/** docs/539 W8: `$.command.run`, the one door every run of this module takes. Claude Code runs
 *  one at a time, appends a run's rows once it resolves (a prompt command's after the model's
 *  reply) and names no run on them (2.1.309, measured), so a row binds the oldest run waiting:
 *  an older one that ran and bound none by the time this one resolves left none, and a queued
 *  command among them leaves the queue, read. Settled, the lines waiting go, but for a queued
 *  command's own batch, whose caller says what follows it. */
async function command($: Engine, act: string | undefined, name: string, args: string, batch?: Held[]) {
  const run: Run = { act, ran: false, batch }
  live.runs.push(run)
  if (live.runs.length > ACTS_KEPT) live.runs.shift()
  live.commanding++
  try {
    const result = await $.command.run({ command: name, args })
    const unbound = live.runs.filter((older) => older !== run && older.ran)
    live.runs = live.runs.filter((older) => older === run || !older.ran)
    run.ran = true
    for (const older of unbound) if (older.batch !== undefined) live.waiting.stored(older.batch)
    if (unbound.some((older) => older.batch !== undefined)) postQueue()
    return result
  } catch (error) {
    live.runs = live.runs.filter((older) => older !== run)
    throw error
  } finally {
    live.commanding--
    if (batch === undefined) due()
  }
}

/** docs/539 W8: `/command args` as the owner typed it. docs/569 Q1: one the session lists is a
 *  line of the queue, idle or not, answered queued at once: shown, in its place among the words,
 *  taken back or sent now as any line, and no act of the chat waits on it while it runs. One it
 *  does not list (an alias), or one said in print mode, runs as before: said once Claude Code
 *  wrote its row, or failed in its own words; while a turn runs Claude Code queues it, and a
 *  name it lists is answered queued at once. */
async function runTyped($: Engine, s: string, id: string, typed: { command?: unknown; args?: unknown }): Promise<void> {
  const { command: name, args } = typed
  if (typeof name !== 'string' || typeof args !== 'string') {
    void send(s, { op: 'failed', act: id, why: 'a command with no name' })
    return
  }
  const listed = await $.command.list().then((all) => all.some((command) => command.name === name), () => false)
  if (listed && live.interactive) {
    const run = { command: name, args }
    const why = live.waiting.add({ entry: id, text: typedLine(run), at_ms: Date.now(), run })
    if (why !== undefined) {
      void send(s, { op: 'failed', act: id, why })
      return
    }
    postQueue()
    void send(s, { op: 'queued', act: id })
    if (idle()) flush($)
    return
  }
  const queued = listed && live.running !== undefined
  if (queued) void send(s, { op: 'queued', act: id })
  try {
    await command($, queued ? undefined : id, name, args)
  } catch (error) {
    if (!queued) void send(s, { op: 'failed', act: id, why: String(error) })
  }
}

/** The row a run wrote for the owner: a local command's `<command-name>` line, or a prompt
 *  command's line as typed (2.1.309, measured); never its caveat, nor what the module appends. */
function commandRow(content: unknown): boolean {
  const first = Array.isArray(content) ? (content[0] as { text?: unknown } | undefined)?.text : content
  return typeof first === 'string' && (first.startsWith('<command-name>') || first.startsWith('/'))
}

/** The run a command row is the record of, journaled as the owner's before it is stored: a
 *  run's as `said`, a queued command's as the queue's `read` (docs/569 Q3). */
async function ranRow($: Engine, uuid: string): Promise<Run | undefined> {
  const run = live.runs.shift()
  if (run?.batch !== undefined) {
    const entries = run.batch.map((line) => line.entry)
    await within($, send(live.session, { op: 'read', entries, uuid }), BIND_MS)
  } else if (run !== undefined) {
    await within($, send(live.session, { op: 'said', act: run.act, uuid }), BIND_MS)
  }
  return run
}

/** docs/539 W8: posts what the typeahead lists, joined with each command's describes, when it
 *  differs from what the host last heard. */
async function list($: Engine): Promise<void> {
  live.listDue = false
  const rows = (await $.command.list()).slice(0, COMMANDS_MAX).flatMap((command) => {
    const seen = described.get(command.name)
    if (seen?.hidden === true) return []
    const now = seen?.now === true ? true : undefined
    const { name, description: about, plugin, source } = command
    return [{ name, about, hint: seen?.hint, plugin, source, now }]
  })
  // A line past what the face takes would be dropped and never sent again: the typeahead's last rows go.
  while (rows.length > 0 && bytesOf(JSON.stringify(rows)) > POST_MAX / 2) rows.pop()
  const line = JSON.stringify(rows)
  if (line === live.listed) return
  live.listed = line
  void send(live.session, { op: 'commands', list: rows })
}

/** TaskStop of `task`: what it was once stopped, or none when it had ended or could not be. */
async function ended($: Engine, task: string): Promise<Stopped | undefined> {
  const stopped = await taskStop($, task)
  return 'what' in stopped ? { id: task, what: stopped.what } : undefined
}

/** A task a stop ended: its id, and its command, else its id again. */
type Stopped = { id: string; what: string }

/** TaskStop of `task`: what it was once stopped (its command, else its id), or why not in
 *  Claude Code's words. */
async function taskStop($: Engine, task: string): Promise<{ what: string } | { why: string }> {
  try {
    const result = await $.tool.call({ tool: 'TaskStop', task_id: task })
    if (result.deny !== undefined) return { why: result.deny }
    if (result.isError !== undefined) return { why: result.text ?? `${task} could not be stopped` }
    const command = (result.result as { command?: unknown } | undefined)?.command
    return { what: typeof command === 'string' ? command : task }
  } catch (error) {
    return { why: String(error) }
  }
}

/** The model reads the stop as it reads Esc's interruption, which `$.turn.abort` leaves out. */
async function told($: Engine, stopped: Stopped[]): Promise<void> {
  const work = stopped.map((task) => task.what).join('; ')
  const text =
    stopped.length === 0 ? '[Request interrupted by user]'
    : `[Request interrupted by user. The background work was stopped too: ${work}.]`
  const ids = stopped.map((task) => task.id)
  // The host draws an interruption only from its exact words (record_status.rs is_interruption):
  // its mark rides a note of its own, right after it.
  await note($, text, [])
  if (ids.length !== 0) await note($, '', ids)
}

/** docs/587 §4: a stop note ends with the mark naming the tasks it stopped, in order, the row
 *  Claude Code writes no other ending for (a module's TaskStop records no result, measured
 *  2.1.312). A note that stopped none carries none; `text` empty, the note is the mark alone. */
async function note($: Engine, text: string, ids: string[]): Promise<void> {
  const mark = ids.length === 0 ? [] : [`[ac stopped ${ids.join(' ')}]`]
  const said = [text, ...mark].filter((part) => part !== '').join(' ')
  await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: said }] } }).catch(() => undefined)
}

/** A task notification of work a stop ended, which would wake the session to redo it. */
function silenced(origin: unknown, text: string): boolean {
  if ((origin as { kind?: unknown } | undefined)?.kind !== 'task-notification') return false
  const tasks = [...text.matchAll(/<task-id>([^<]+)<\/task-id>/g)].map((found) => found[1])
  return tasks.length > 0 && tasks.every((task) => task !== undefined && live.silenced.includes(task))
}

/** The acts perform() takes, named in `start`: ac sends no other, since an act this module did
 *  not know would never be acked and would come back on every hold. */
const ACTS = ['say', 'stop', 'answer', 'answers', 'tune', 'run', 'withdraw', 'takeBack', 'sendNow', 'stopJob', 'shell', 'side', 'sideStop'] as const

/** docs/652 B1: side questions, answered beside the turn, their answers kept until ac takes them. */
const sides = new SideKept()

/** docs/652 I-NEVER-LOST: the re-post of the answers ac has not taken, one at a time. */
let sidesOwed: Promise<void> | undefined

/** Posts again each answer ac has not taken: after `start`, and on every hold ac answers, so a
 *  post that failed waits for the next hold, never for a reconnect. */
function postOwed($: Engine): void {
  if (sides.waiting === 0 || sidesOwed !== undefined) return
  sidesOwed = sideAgain(sides, (to, out) => postNow($, to, out)).finally(() => {
    sidesOwed = undefined
  })
}

/** docs/569 §12 Q4‴: the owner's next-step lines taken back, dropped as the turn reads them; a
 *  session's own, as a /clear starts another session in this process. */
let taken = { session: '', lines: new NextTaken(Date.now()) }

function takenIn(session: string): NextTaken {
  if (taken.session !== session) taken = { session, lines: new NextTaken(Date.now()) }
  return taken.lines
}

/** docs/652 B1: one line posted now, outside the queue a lost face drops: whether ac took it. */
async function postNow($: Engine, s: string, out: SideOut | SideWords): Promise<boolean> {
  const at = live.face
  if (at === undefined) return false
  return (await call($, at, '/v1/post', JSON.stringify({ v: V, s, ...out }))) !== undefined
}

/** Does the act the first time its id arrives (ac sends each until a hold acks it), and
 *  answers its id for the next hold's `got`, or none for an item that names no act. */
function perform($: Engine, s: string, item: unknown): string | undefined {
  if (typeof item !== 'object' || item === null) return undefined
  const { say, stop: halt, answer, answers: set, tune: retune, run: typed, withdraw: unsay, takeBack: back, sendNow: now, stopJob: end, shell, side: aside, sideStop: unside } =
    item as { say?: unknown; stop?: unknown; answer?: unknown; answers?: unknown; tune?: unknown; run?: unknown; withdraw?: unknown; takeBack?: unknown; sendNow?: unknown; stopJob?: unknown; shell?: unknown; side?: unknown; sideStop?: unknown }
  const body = [say, halt, answer, set, retune, typed, unsay, back, now, end, shell, aside, unside].find((part) => typeof part === 'object' && part !== null)
  const id = (body as { act?: unknown } | undefined)?.act
  if (typeof id !== 'string' || !ACT.test(id)) return undefined
  if (live.performed.includes(id)) return id
  live.performed.push(id)
  if (live.performed.length > ACTS_KEPT) live.performed.shift()
  if (body === say) {
    const { text } = say as { text?: unknown }
    if (typeof text !== 'string') {
      void send(s, { op: 'failed', act: id, why: 'a say with no text' })
      return id
    }
    // docs/569 Q1: words that meet a running turn or command, or lines still ahead of them, wait
    // their turn.
    if (!idle() || !live.waiting.empty) {
      // A print-mode run (`claude -p`, a rewind's first turn) ends with its turn, and a prompt
      // left for its end may never run: nothing waits in it (I-NEVER-LOST).
      const why = live.interactive ? live.waiting.add({ entry: id, text, at_ms: Date.now() }) : ONE_TURN
      if (why !== undefined) {
        void send(s, { op: 'failed', act: id, why })
        return id
      }
      postQueue()
      void send(s, { op: 'queued', act: id })
      if (idle()) flush($)
      return id
    }
    live.saying.push({ act: id, text })
    void $.prompt.submit({ text, asUser: true }).then(
      (entered) => sayFailed(s, id, entered.drop),
      (error: unknown) => sayFailed(s, id, String(error)),
    )
  } else if (body === halt) {
    void stop($, s, id)
  } else if (body === retune) {
    void tune($, s, id, retune as Record<string, unknown>)
  } else if (body === typed) {
    void runTyped($, s, id, typed as { command?: unknown; args?: unknown })
  } else if (body === unsay) {
    withdraw($, s, id, (unsay as { entry?: unknown }).entry)
  } else if (body === back) {
    const { entry, text, sentAtMs } = back as { entry?: unknown; text?: unknown; sentAtMs?: unknown }
    const why =
      typeof entry !== 'string' || typeof text !== 'string' || typeof sentAtMs !== 'number'
        ? 'a take-back that names no line'
        : takenIn(s).take(entry, text, sentAtMs)
    void send(s, why === undefined ? { op: 'withdrawn', act: id, text: text as string } : { op: 'failed', act: id, why })
  } else if (body === now) {
    void sendNow($, s, id, (now as { next?: unknown }).next === true)
  } else if (body === end) {
    void stopJob($, s, id, (end as { job?: unknown }).job)
  } else if (body === shell) {
    bang($, s, id, shell as { line?: unknown; out?: unknown })
  } else if (body === aside) {
    const asking = () => void send(s, { op: 'asking', act: id })
    void sideAsk($, sides, s, id, aside as { prompt?: unknown }, asking, (to, out) => postNow($, to, out))
  } else if (body === unside) {
    // docs/845 W-Stop: ac filed it Stopped; its fork is shown no more and the chat may be asked again.
    const { exchange } = unside as { exchange?: unknown }
    if (typeof exchange === 'string') sides.stop(exchange)
    void send(s, { op: 'asking', act: id })
  } else if (body === set) {
    asked.answered(set)
  } else {
    asked.answeredBefore(answer)
  }
  return id
}

async function hold($: Engine, s: string): Promise<void> {
  if (live.holds.has(s)) return
  live.holds.add(s)
  try {
    let got: string[] = []
    for (let at = live.face; at !== undefined && live.session === s; at = live.face) {
      const asked = Date.now()
      const heard = await call($, at, '/v1/hold', JSON.stringify({ v: V, s, got }))
      if (heard === undefined) {
        // A hold cut after a real wait (`$.http.fetch` drops one at 30 s, measured) is
        // asked again at once, its acks with it, while the face still answers; any other
        // failure is no bridge.
        if (Date.now() - asked >= HOLD_CUT_MS && (await call($, at, '/v1/hello'))?.v === V) continue
        lost($, at)
        return
      }
      got = []
      hear(s, heard)
      postOwed($)
      // Only a hold answer carries the notices: a post's answer never does, so it changes none.
      if (s === live.session) live.notices = noticesOf($, heard.notices)
      if (!Array.isArray(heard.do)) continue
      for (const item of heard.do) {
        const id = perform($, s, item)
        if (id !== undefined && got.length < ACTS_KEPT) got.push(id)
      }
    }
  } finally {
    live.holds.delete(s)
  }
}

async function look($: Engine): Promise<string | undefined> {
  const named = await $.env.get('AC_LIVE_SOCKET')
  let paths = [named ?? '']
  if (named === undefined || named === '') {
    const dir = `${((await $.env.get('TMPDIR')) ?? '/tmp').replace(/\/+$/, '')}/ac-live`
    const entries = await $.fs.list(dir).catch(() => [])
    paths = entries.filter((entry) => /^\d+\.live$/.test(entry.name)).map((entry) => `${dir}/${entry.name}`)
  }
  const answering: string[] = []
  for (const path of paths) {
    if ((await call($, path, '/v1/hello'))?.v === V) answering.push(path)
  }
  return answering.length === 1 ? answering[0] : undefined
}

/** Brings the bridge up for the session running now: found, announced, held. */
async function adopt($: Engine): Promise<void> {
  if (live.session === undefined) return
  if (live.face === undefined) {
    if (Date.now() < live.lookAfter) return
    live.face = await look($)
    if (live.face === undefined) {
      missed($)
      return
    }
    live.lookIn = RELOOK_MS
  }
  const s = live.session
  const key = `${live.face}\n${s}`
  if (live.announced?.key !== key) {
    const before = await recordedThrough($)
    live.announced = { key, before }
    live.listed = undefined
    live.listDue = true
    void send(s, { op: 'start', interactive: live.interactive, before, acts: ACTS })
    asked.announce((out) => send(s, out as Out))
    // ac keeps each queue on disk and sends a module that never queued a line back the lines it
    // kept; one that did posts its queue, emptied too, or lines it read while ac was away (posts
    // to an absent ac are dropped) would stay listed as waiting.
    if (live.waiting.touched) postQueue()
    // docs/571 W4: ac keeps no reading across its own restart, and a measure posted while it was
    // away was dropped; each announce says where the context stands now.
    void postContext($).catch(() => undefined)
    if (live.compacting !== undefined) void send(s, { op: 'compacting', at: live.compacting })
    // docs/652 I-NEVER-LOST: an answer posted while ac was away goes again.
    postOwed($)
  }
  void hold($, s)
}

/** Posts the step's `end` once, while watched: its blocks whose rows were stored. */
function close(step: Step): void {
  if (step.closed) return
  step.closed = true
  prose.close(step)
  if (live.watched) void send(live.session, { op: 'end', turn: step.turn, step: step.step, rows: [...step.stored] })
}

/** Closes the steps whose rows are in or whose wait is over; arms the worker for the next. */
function closeDue($: Engine): void {
  const now = Date.now()
  let next = Number.POSITIVE_INFINITY
  for (const step of [...live.steps.values()]) {
    if (step.endBy === undefined) continue
    if (rowsIn(step) || step.endBy <= now) close(step)
    else next = Math.min(next, step.endBy)
  }
  live.tick?.cancel()
  live.tick = Number.isFinite(next) ? $.clock.after(next - now, nudge) : undefined
}

/** The worker: on `session.start`'s `$`, it finds the bridge, sends what the hooks queued,
 *  and ends the steps that are due, each time something wakes it. */
async function work($: Engine): Promise<void> {
  for (;;) {
    const woken = new Promise<void>((wake) => {
      live.wake = wake
    })
    await adopt($).catch(() => undefined)
    if (live.flushDue && idle()) {
      live.flushDue = false
      flush($)
    }
    if (live.listDue && live.announced !== undefined) await list($).catch(() => undefined)
    closeDue($)
    await pump($)
    if (live.overflowed && live.queue.length === 0) {
      live.overflowed = false
      if (live.watched) restate()
    }
    if (live.queue.length === 0) await woken
  }
}


/** A response row's block, and its thinking's signature: the host reads a narration from it
 *  as the reply's words while the row waits to be written. */
type Bound = { step: Step; i: number; signature?: string }

/** The open blocks a response row is the record of: a tool call by its id, else the
 *  oldest open block of that part with no row yet. */
function bound(content: readonly unknown[]): Bound[] {
  const found: Bound[] = []
  for (const item of content) {
    const { type, id, signature } = item as { type?: unknown; id?: unknown; signature?: unknown }
    const part =
      type === 'text' ? 'text'
      : type === 'thinking' || type === 'redacted_thinking' ? 'thinking'
      : type === 'tool_use' ? 'tool'
      : undefined
    if (part === undefined) continue
    search: for (const step of live.steps.values()) {
      if (step.closed) continue
      for (const block of step.blocks.values()) {
        if (block.part !== part || step.stored.has(block.i)) continue
        if (found.some((f) => f.step === step && f.i === block.i)) continue
        if (part === 'tool' && block.call !== id) continue
        found.push(part === 'thinking' && typeof signature === 'string' ? { step, i: block.i, signature } : { step, i: block.i })
        break search
      }
    }
  }
  return found
}

function rowsIn(step: Step): boolean {
  return [...step.blocks.keys()].every((i) => step.stored.has(i))
}

async function recordedThrough($: Engine): Promise<number | undefined> {
  const path = live.transcript
  if (path === undefined) return undefined
  try {
    if (!(await $.fs.exists(path))) return 0
    const stat = await $.fs.stat(path)
    return stat.kind === 'file' ? stat.size : undefined
  } catch {
    return undefined
  }
}

function transcriptAt(path: string): void {
  live.transcript = path
  if (live.announced?.before === undefined) live.announced = undefined
  nudge()
}

async function bind($: Engine, uuid: string, blocks: Bound[]): Promise<void> {
  if (live.face === undefined) return
  const posted = recordedThrough($).then((before) => send(live.session, {
    op: 'record', uuid, before,
    blocks: blocks.map(({ step, i, signature }) => ({ turn: step.turn, step: step.step, i, ...(signature === undefined ? {} : { signature }) })),
  }))
  await within($, posted, BIND_MS)
}

function stored(blocks: { step: Step; i: number }[]): void {
  for (const { step, i } of blocks) step.stored.add(i)
  if (blocks.some(({ step }) => step.endBy !== undefined)) nudge()
}

/** A command or watch a main-loop turn started in the background, which a stopJob may name. */
function startedJob(id: string): void {
  if (live.running === undefined || live.jobs.includes(id)) return
  live.jobs.push(id)
  if (live.jobs.length > TASKS_KEPT) live.jobs.shift()
  live.unfinished.push(id)
  if (live.unfinished.length > TASKS_KEPT) live.unfinished.shift()
}

/** docs/769 P6: the jobs a task notification says ended, any status but `running`. */
function endedJobs(origin: unknown, text: string): void {
  if ((origin as { kind?: unknown } | undefined)?.kind !== 'task-notification') return
  for (const told of text.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)) {
    const id = /<task-id>([^<]+)<\/task-id>/.exec(told[1] ?? '')?.[1]
    const status = /<status>([^<]+)<\/status>/.exec(told[1] ?? '')?.[1]
    if (id !== undefined && status !== undefined && status.trim() !== 'running') {
      live.unfinished = live.unfinished.filter((job) => job !== id)
    }
  }
}

/** A main-loop tool result that names a command running on in the background, or a watch it
 *  armed (docs/587 P7: a job the console may stop). */
function resulted(content: readonly unknown[]): void {
  for (const item of content) {
    const block = item as { type?: unknown; content?: unknown }
    if (block.type !== 'tool_result') continue
    const text = typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '')
    const first = Array.isArray(block.content) ? (block.content[0] as { text?: unknown } | undefined)?.text : block.content
    const id = BACKGROUNDED.exec(text)?.[1] ?? (typeof first === 'string' ? WATCHING.exec(first)?.[1] : undefined)
    if (id !== undefined) startedJob(id)
  }
}

/** What `/v1/permission` answers: the owner's decision, `held` while they have not answered
 *  (asked again at once: a `$` call stops the hook's 10 s clock, a `$.clock` wait does not), or
 *  neither once it settled elsewhere. */
type Permitted = { decision?: PermissionRequestDecision; held?: unknown }

/** docs/539 W8: whether Claude Code holds `text` for its terminal in a session in `mode`: a peer's
 *  message whose `from-mode` is not the session's own class, or that names none to a session that
 *  bypasses (2.1.309, ac's `CcClass`). No mode said yet: it cannot tell, and Claude Code decides. */
function heldHere(text: string, mode: string | undefined): boolean {
  const open = mode === undefined ? null : /^\s*<cross-session-message\b([^>]*)>/.exec(text)
  if (open === null) return false
  const sent = /\sfrom-mode="([^"]*)"/.exec(open[1])?.[1]
  const own = mode === 'bypassPermissions' ? 'bypass' : 'prompting'
  return sent === undefined ? own === 'bypass' : sent !== own
}

/** One permission's id for its asking, never reused. */
function permissionId(): string {
  return Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('')
}

function started($: Engine, session: string, interactive: boolean): void {
  live.session = session
  live.interactive = interactive
  if (live.working) return nudge()
  live.working = true
  void work($)
}

/** A main-loop turn began, in the session the process runs now (a /clear starts another
 *  with no `session.start`). */
function turnStarted(session: string, turn: string, text: string): void {
  live.session = session
  live.running = turn
  live.turns++
  live.lookAfter = Number.NEGATIVE_INFINITY
  nudge()
  // Bound by its words, never by order alone: a turn a command or a notification opens is not
  // the act's, and the owner's answer there never reaches the room.
  const opening = live.opening
  const act = opening !== undefined && opening.text === text ? opening.act : undefined
  live.opening = undefined
  if (act !== undefined) {
    live.opened.set(turn, act)
    if (live.opened.size > ACTS_KEPT) live.opened.delete(live.opened.keys().next().value as string)
  }
  void send(live.session, { op: 'turn', turn, ...(act !== undefined && { act }) })
}

/** The most of a turn's answer a `done` carries; ac cuts it to a room post's size. */
const ANSWER_MAX = 16 * 1024

/** `answer` is said only of a turn an act opened: no other turn's words leave the session. */
async function turnDone($: Engine, turn: string, answer: string): Promise<void> {
  if (live.running === turn) live.running = undefined
  live.listDue = true
  // docs/569 D1 (b): the queue goes once the turn ends, from the worker, whose calls no turn's
  // end cancels; a stop or a send now that ends this turn sends it itself, after its own words.
  if (!live.ending.has(turn) && live.waiting.waitingCount !== 0) {
    live.flushDue = true
    nudge()
  }
  live.ending.get(turn)?.()
  for (const step of live.steps.values()) if (step.turn === turn && step.endBy !== undefined) close(step)
  const act = live.opened.get(turn)
  live.opened.delete(turn)
  const opened = act === undefined ? {} : { act, answer: answer.slice(0, ANSWER_MAX) }
  // docs/769 P6: how many of its own jobs run on as it ends; with none, the turn is a finish.
  const jobs = live.unfinished.length
  const posted = recordedThrough($).then((before) => send(live.session, { op: 'done', turn, before, jobs, ...opened }))
  await within($, posted, BIND_MS)
}

function stepBegun(turn: string, index: number): Step {
  return prose.begin(turn, index)
}

function stepEnded(step: Step): void {
  step.endBy = Date.now() + ROWS_MS
  nudge()
}

/** The prompt a row of this module's is: journaled as the owner's before it is stored, a say's as
 *  `said`, the queue's as `read` naming every line it carries (docs/569 Q3). */
async function sayingRow($: Engine, uuid: string): Promise<Saying | undefined> {
  const said = live.saying.shift()
  live.opening = said
  if (said?.batch !== undefined) {
    const entries = said.batch.map((line) => line.entry)
    await within($, send(live.session, { op: 'read', entries, uuid }), BIND_MS)
  } else if (said !== undefined) {
    await within($, send(live.session, { op: 'said', act: said.act, uuid }), BIND_MS)
  }
  return said
}

/** docs/571 W4: the live window as the engine counts it, with the `summary` breakdown's rows and
 *  auto-compaction (local estimates; it sends no request). A breakdown that fails posts without
 *  them, so ac says "unknown" for what it could not read, never a guess; with no measure to fall
 *  back on (an announce), it posts nothing. */
async function postContext($: Engine, measured?: SessionContextUsage): Promise<void> {
  let context = measured
  let breakdown: SessionContextUsage['breakdown']
  try {
    const usage = await $.session.usage({ breakdown: 'summary' })
    context = usage.context
    breakdown = usage.context.breakdown
  } catch {
    breakdown = undefined
  }
  if (context === undefined) return
  const kinds = breakdown?.categories
    .filter((row) => row.kind === 'used' && !row.isDeferred && row.tokens > 0)
    .slice(0, KINDS_MAX)
    .map((row) => ({ label: row.name, tokens: row.tokens }))
  void send(live.session, {
    op: 'context',
    ...(context.tokens !== undefined && { tokens: context.tokens }),
    window: context.window,
    ...(breakdown !== undefined && {
      auto: breakdown.isAutoCompactEnabled,
      ...(breakdown.autoCompactThreshold !== undefined && { threshold: breakdown.autoCompactThreshold }),
      kinds,
    }),
  })
}

// `claude plugin validate` warns of gating hooks without `.catch`. Claude Code (2.1.306, measured
// with a module that threw) runs on past one that throws: the prompt still ran, the row was stored.
/** A step of any loop but an aside's fork: the main loop's words seen as they are written. */
async function* chatStep(e: Frozen<TurnStepInput>, next: StreamNext<'turn.step'>) {
  const stream = next(e)
  if (e.agentId !== undefined) return yield* stream
  const step = stepBegun(e.turnId, e.index)
  try {
    for await (const chunk of stream) {
      prose.seen(step, chunk)
      yield chunk
    }
    return await stream.result
  } finally {
    stepEnded(step)
  }
}

export const register: Register = (on) => {
  // docs/643 R5 and A1 (wheel.ts): first, so outermost. While this session drives the person's terminal, its Bash
  // runs there and its own asks are the wheel's to answer; no bridge is a could-not-tell. The loader takes a hook
  // only as a literal, and follows $ only into a function declaration (2.1.314 refused `on(…, wheel.check)`).
  // R5: a hook that fails is skipped and the tool runs (index.d.ts:4079), so each carries a `.catch` that refuses
  // while the last answer said this session drives.
  const wheel = new Wheel()
  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    const own = next.origin?.plugin === $.plugin.name
    return checkedBy(wheel, verdict, own, e, (route, body) => wheelAsk($, route, body), (path) => placed($, path))
  }).catch(($, e, next) => (wheel.drove ? { decision: 'deny', reason: FAILED } : next(e)))
  // docs/845: an aside's fork runs no tool; its `.catch` refuses too, as a failed hook is skipped.
  on('tool.call', async ($, e, next) => {
    if (sides.of(e.agentId) !== undefined) return { deny: NO_TOOLS }
    const own = next.origin?.plugin === $.plugin.name
    return (await calledBy(wheel, e, own, (route, body) => wheelAsk($, route, body))) ?? next(e)
  }).catch(($, e, next) =>
    sides.of(e.agentId) !== undefined ? { deny: NO_TOOLS } : next.called || !wheel.drove ? next(e) : { deny: FAILED },
  )

  on('classic.SessionStart', async ($, e, next) => {
    transcriptAt(e.transcript_path)
    live.mode = e.permission_mode ?? live.mode
    return next(e)
  })

  // docs/582 P19: the notices ride this hook, the one every prompt reaches, this module's own
  // submits included (M-M1: its prompt.submit hook is not run for them); Claude Code keeps each
  // as the record's hook_additional_context row, the host's one proof it was told.
  on('classic.UserPromptSubmit', async ($, e, next) => {
    transcriptAt(e.transcript_path)
    live.mode = e.permission_mode ?? live.mode
    const result = await next(e)
    if (live.notices.length === 0) return result
    return { ...result, additionalContext: [...(result.additionalContext ?? []), ...live.notices] }
  })

  // docs/539 W8 (the owner's call of 2026-10-24): a peer's message Claude Code would hold for its
  // terminal is taken at once and asked of the owner, who lets it in or discards it. Deliveries
  // pass here one at a time (2.1.310, measured), so one held here would hold every later one.
  on('session.receive', { origin: 'peer' }, async ($, e, next) => {
    const at = live.face
    const s = live.session
    if (e.agentId !== undefined || at === undefined || s === undefined || !heldHere(e.text, live.mode)) return next(e)
    const heard = (await call($, at, '/v1/held', JSON.stringify({ v: V, s, mode: live.mode, text: e.text }))) as
      { taken?: unknown } | undefined
    // Not taken: Claude Code holds it at its terminal, as without ac.
    return heard?.taken === true ? { consumed: 'ac asks the owner to let it in' } : next(e)
  })

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    started($, await $.session.id(), e.isInteractive)
    // docs/739 W9: a session ac starts to read or use Claude Code's resets (Claude Code takes one
    // hooks module per plugin, measured on 2.1.322).
    void meter($)
    return result
  })

  // docs/571 W4: each measure that moved the context, so ac's meter is the engine's own.
  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    if (e.changed.includes('context')) await postContext($, e.context)
    return result
  })

  // The record holds nothing of a compaction until it commits, so without this a chat compacting reads as
  // thinking. Every trigger the person waits on: `/compact`, the threshold, a plugin's call (the owner's
  // turn-compact mod). `precompute` runs beside the person's work, as Claude Code's own status shows nothing.
  on('session.compact', async ($, e, next) => {
    if (e.agentId !== undefined || e.trigger === 'precompute') return next(e)
    const at = Date.now()
    live.compacting = at
    void send(live.session, { op: 'compacting', at })
    try {
      return await next(e)
    } finally {
      if (live.compacting === at) {
        live.compacting = undefined
        void send(live.session, { op: 'compacted' })
      }
    }
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) takenIn(await $.session.id()).started()
    const result = await next(e)
    if (e.agentId === undefined) turnStarted(await $.session.id(), e.turnId, e.text)
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) await turnDone($, e.turnId, e.answer)
    else sides.ended(e.agentId, { reason: e.reason, answer: e.answer })
    return result
  })

  // docs/845: an aside's fork. Each piece of its words goes to ac as it arrives; a step past
  // FORK_STEPS is answered here, with no request.
  on('turn.step', async function* ($, e, next) {
    const fork = sides.of(e.agentId)
    if (fork === undefined) return yield* chatStep(e, next)
    if (e.index >= FORK_STEPS) return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: null, usage: null }
    const stream = next(e)
    if (fork.words !== '') fork.wrote('\n\n')
    for await (const chunk of stream) {
      if (chunk.kind === 'text') {
        fork.wrote(chunk.text)
        void postWords($, fork, (to, out) => postNow($, to, out))
      }
      yield chunk
    }
    const result = await stream.result
    fork.usage = sideAdded(fork.usage, result.usage)
    return result
  })

  on('session.append', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    if (e.door === 'response' && e.message.type === 'assistant') {
      const blocks = bound(e.message.content)
      await bind($, e.uuid, blocks)
      const result = await next(e)
      if (result.deny === undefined) stored(blocks)
      return result
    }
    if (e.door === 'tool-result') resulted(e.message.content)
    const origin = e.origin as { kind?: unknown; name?: unknown; asUser?: unknown }
    const mine = origin?.kind === 'plugin' && origin.name === $.plugin.name
    const first = e.message.content[0] as { text?: unknown } | undefined
    const shellTurn = e.door === 'prompt' && mine && typeof first?.text === 'string' ? shells.rowOf(first.text) : undefined
    if (shellTurn !== undefined) {
      // docs/614: a `!` line's output row ends its live block as it is stored.
      await within($, send(live.session, { op: 'row', turn: shellTurn, step: 0, i: 0, uuid: e.uuid }), BIND_MS)
      return next(e)
    }
    if (e.door === 'prompt' && mine && origin.asUser === true) {
      const said = await sayingRow($, e.uuid)
      const batch = said?.batch
      if (batch === undefined) return next(e)
      // I-ONCE: the queue drops its lines only once their row is stored, so a watch that reads
      // the queue before the record never misses them in both.
      const result = await next(e)
      if (result.deny === undefined) live.waiting.stored(batch)
      else live.waiting.dropped(batch)
      postQueue()
      return result
    } else if ((e.door === 'command' || e.door === 'prompt') && mine && e.message.type === 'user' && commandRow(e.message.content)) {
      const batch = (await ranRow($, e.uuid))?.batch
      if (batch === undefined) return next(e)
      // I-ONCE, as for words: the command leaves the queue only once its row is stored.
      const result = await next(e)
      live.waiting.stored(batch)
      postQueue()
      return result
    }
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    endedJobs(e.origin, e.text)
    if (silenced(e.origin, e.text)) {
      return { drop: 'Stopped from ac' }
    }
    // docs/569 §12 M33: a line the daemon queued for the next step is screened here, as the
    // owner's own Enter, at the moment its turn reads it.
    if (
      e.origin.kind === 'composer' &&
      e.command === undefined &&
      takenIn(await $.session.id()).screen(e.text, Date.now())
    ) {
      return { drop: TAKEN_BACK }
    }
    return next(e)
  })

  on('command.describe', async ($, e, next) => {
    const result = await next(e)
    const was = described.get(e.command)
    if (was !== undefined || described.size < COMMANDS_MAX * 2) {
      described.set(e.command, {
        hint: e.immediate ? (was?.hint ?? result.argumentHint) : (result.argumentHint ?? was?.hint),
        now: was?.now === true || e.immediate,
        hidden: result.isHidden && (was?.hidden ?? true),
      })
    }
    live.listDue = true
    nudge()
    return result
  })

  // docs/587 D6: the command a stop's abort sent from the turn's foreground to the background,
  // which that stop ends. Only the tool's record says so (2.1.312: `backgroundedByTurnAbort`); the
  // receipt's words differ from a run_in_background one's only in prose.
  // docs/614: the owner's `!` line and this module's read of the folder run unasked, as Claude
  // Code's own `!` does; every other call, the model's included, is asked as before.
  on('tool.check', { tool: 'Bash' }, async ($, e, next) => {
    const command = (e.input as { command?: unknown } | undefined)?.command
    if (typeof command === 'string' && next.origin?.plugin === $.plugin.name && shells.owns(command)) {
      return { decision: 'allow', reason: 'the owner typed it' }
    }
    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const command = (e as { command?: unknown }).command
    // docs/614: a command run since the owner's last line may have moved the shell.
    const theirs = next.origin?.plugin !== $.plugin.name || typeof command !== 'string' || !shells.owns(command)
    if (theirs && shells.forget()) void send(live.session, { op: 'shellCwd', cwd: null })
    const result = await next(e)
    const ran = result.result as { backgroundTaskId?: unknown; backgroundedByTurnAbort?: unknown } | undefined
    const turn = live.running
    if (turn !== undefined && ran?.backgroundedByTurnAbort === true && typeof ran.backgroundTaskId === 'string') {
      live.aborted.push({ turn, id: ran.backgroundTaskId })
      if (live.aborted.length > TASKS_KEPT) live.aborted.shift()
    }
    return result
  })

  // docs/557 R7, docs/677 E: Claude Code's own in-process addressees are its own; every chat of
  // the owner's, room and ac agent ac carries goes to ac as PostToChat, answered here without
  // `next`, so the model reads ac's answer (2.1.316 refuses a name nobody carries after the hooks,
  // whatever a hook says once `next` passed it on). One PostToChat failed is Claude Code's own
  // SendMessage, `to` as written (the owner, 2026-11-06); one ac may have taken is never sent again.
  // Every other send is Claude Code's, `to` as written. G4: one Claude Code delivered is put on
  // ac's record, never waited on.
  on('session.send', async ($, e, next) => {
    let failed: string | undefined
    if (!(await ownAddressee($, e.to)) && (await carries($, e.to))) {
      const carried = await sendToAc($, e.to, e.text)
      if (carried.kind !== 'refused') {
        carriedSends.set(sendKey(e.agentId, e.to, e.text), { ...carried, to: e.to })
        while (carriedSends.size > CARRIED_KEPT) carriedSends.delete(carriedSends.keys().next().value as string)
        return carried.kind === 'delivered' ? { isDelivered: true } : { isDelivered: false, reason: `${carried.why}; ${MAY_HAVE}` }
      }
      failed = carried.why
    }
    const native = await next(e)
    if (native.isDelivered) reportSent($, e.to, e.text)
    if (native.isDelivered || failed === undefined) return native
    return { isDelivered: false, reason: `${failed}; SendMessage: ${native.reason ?? 'not delivered'}` }
  })

  // A send ac carried reads as ac said: delivered, with its words, or not told either way.
  on('tool.call', { tool: 'SendMessage' }, async ($, e, next) => {
    const result = await next(e)
    const { to, message, agentId } = e as { to?: unknown; message?: unknown; agentId?: string }
    if (typeof to !== 'string' || typeof message !== 'string') return result
    const key = sendKey(agentId, to, message)
    const carried = carriedSends.get(key)
    carriedSends.delete(key)
    const worded = carried === undefined || result.deny !== undefined || result.isError === true ? undefined : carriedResult(carried)
    return worded === undefined ? result : { result: worded }
  })

  on('tool.call', { tool: 'ListAgents' }, async ($, e, next) => {
    const listed = await next(e)
    const reach = await reachOf($)
    if (reach === undefined) return listed
    return { ...listed, result: { ...listed.result, listing: `${listed.result.listing}\n\n${reach}` } }
  })

  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    const id = e.tool_use_id
    const s = live.session
    if (e.agentId !== undefined || id === undefined || live.face === undefined || s === undefined) return next(e)
    // docs/620: questions.ts answers as the terminal's own dialog would.
    const post = (out: Record<string, unknown>) => send(s, out as Out)
    const here = next(e)
    const idle = await continuesInMs($)
    return (await asked.asking(post, id, e.questions, idle, here)) as Awaited<ReturnType<typeof next>>
  })

  // docs/539 W8: the owner answers a permission from ac for as long as Claude Code waits. The
  // dialog stays open beside this and its answer never ends this hook (2.1.310, measured), so
  // ac reads the record for it and says `settled`.
  on('classic.PermissionRequest', async ($, e, next) => {
    live.mode = e.permission_mode ?? live.mode
    const at = live.face
    if (at === undefined || e.tool_name === 'AskUserQuestion') return next(e)
    const id = permissionId()
    let body = JSON.stringify({ v: V, s: e.session_id, id, request: e })
    for (;;) {
      const heard = (await call($, at, '/v1/permission', body)) as Permitted | undefined
      // No answer from ac: the hook beneath, ac's older one, or the dialog decides.
      if (heard === undefined) return next(e)
      if (typeof heard.decision === 'object' && heard.decision !== null) return { decision: heard.decision }
      // Settled elsewhere: nothing beneath may ask it again.
      if (heard.held !== true) return {}
      body = JSON.stringify({ v: V, s: e.session_id, id })
    }
  })
}
