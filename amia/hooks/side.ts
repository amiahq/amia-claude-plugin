import type { EngineInterface, ModelUsage } from 'claude-code'

// docs/652 B1, docs/845: the side chat. A question is answered by a fork of this chat: a subagent
// of type `fork` (`$.agent.spawn`), which inherits the chat's context, so its request is served
// from the chat's prompt cache as `$.model.fork`'s was, and whose words reach `turn.step` as the
// model writes them, which `$.model.fork`'s never do (measured on 2.1.325, docs/845 §1). The chat's
// own loop never hears of it: no notification, and none of its words in a main-loop request
// (measured, docs/845 §1). It writes nothing to the chat (I-NO-WRITE-BACK). Every tool call it
// makes is denied, and a step past FORK_STEPS is answered here with no request, so one question
// costs at most FORK_STEPS requests. Its words are posted to ac as they arrive; its answer cost
// money, so it is kept until ac takes it, and posted again until it does. Claude Code cannot cut a
// fork short: Stop (ac's `sideStop`) shows it no more and frees the chat; it writes on, unseen,
// and its answer is not kept. Claude Code's loader follows `$` only into a function declaration.

type Engine = EngineInterface

/** Answers ac has not taken yet; past it the oldest goes. */
export const KEPT_MAX = 16
/** A thrown error's words, as far as they are carried. */
const ERROR_MAX = 512
/** ac keeps an answer whole up to this many UTF-8 bytes (`MAX_SIDE_ANSWER`), past it cut. */
export const ANSWER_MAX = 64 * 1024
/** An answer's text as one post's JSON carries it at most, under the face's 256 KiB body bound. */
export const POSTED_MAX = 192 * 1024
/** Model requests one fork may make: its answer, and one more after a denied tool call. */
export const FORK_STEPS = 2
/** Stopped forks of one chat still writing, unseen, past which it is busy. */
export const FINISHING_MAX = 2
/** The least time between two posts of a fork's words. */
export const WORDS_EVERY_MS = 50
/** What a fork's tool call is answered. */
export const NO_TOOLS = 'An aside answers in words alone, and no tool runs. Answer now from what you already know.'

/** `bytes`: the answer's whole length in UTF-8 bytes, where it was cut to fit one post. */
export type SideAnswer = { text: string; usage: ModelUsage; bytes?: number }

export type SideOut =
  | { op: 'side'; act: string; answer: SideAnswer }
  | { op: 'side'; act: string; refused: { reason: string; status?: number | null; error?: string; usage?: ModelUsage } }

/** docs/845 H-Hold: a fork's words from byte `at`, as ac holds them. */
export type SideWords = { op: 'side_writing'; act: string; at: number; text: string }

/** Posts one line to ac now: whether ac took it. */
export type PostNow = (s: string, out: SideOut | SideWords) => Promise<boolean>

/** How a fork's turn ended, as its `turn.complete` says. */
export type ForkEnd = { reason: string; answer?: string }

/** One fork answering one question. */
export class Fork {
  words = ''
  bytes = 0
  sentChars = 0
  sentBytes = 0
  posting = false
  stopped = false
  usage: ModelUsage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
  ended: Promise<ForkEnd>
  end: (how: ForkEnd) => void = () => {}

  constructor(readonly s: string, readonly act: string) {
    this.ended = new Promise((done) => {
      this.end = done
    })
  }

  /** The next piece of its words, past ANSWER_MAX dropped as ac drops them. */
  wrote(piece: string): void {
    const room = ANSWER_MAX - this.bytes
    if (room <= 0) return
    const kept = utf8(piece) <= room ? piece : upTo(piece, room)
    this.words += kept
    this.bytes += utf8(kept)
  }
}

/** The answers ac has not taken, each with its session, oldest first; the forks answering now. */
export class Kept {
  private held: { s: string; out: SideOut }[] = []
  private live = new Map<string, string>()
  private forks = new Map<string, Fork>()

  get waiting(): number {
    return this.held.length
  }

  add(s: string, out: SideOut): void {
    this.held.push({ s, out })
    while (this.held.length > KEPT_MAX) this.held.shift()
  }

  list(): { s: string; out: SideOut }[] {
    return [...this.held]
  }

  forget(out: SideOut): void {
    this.held = this.held.filter((held) => held.out !== out)
  }

  /** Whether `s` may fork `act` now: one shown fork a chat at a time (I-ONE-AT-A-TIME), whatever ac
   *  believes of an earlier ask whose `asking` never reached it, and at most FINISHING_MAX stopped
   *  ones still writing. */
  fork(s: string, act: string): boolean {
    if (this.live.has(s)) return false
    if ([...this.forks.values()].filter((fork) => fork.s === s && fork.stopped).length >= FINISHING_MAX) return false
    this.live.set(s, act)
    return true
  }

  forked(s: string, act: string): void {
    if (this.live.get(s) === act) this.live.delete(s)
  }

  /** The fork `agentId` answers `act` of `s`. */
  began(agentId: string, fork: Fork): void {
    this.forks.set(agentId, fork)
  }

  /** The fork running in `agentId`'s loop; undefined for any other loop. */
  of(agentId: string | undefined): Fork | undefined {
    return agentId === undefined ? undefined : this.forks.get(agentId)
  }

  /** `agentId`'s turn ended. */
  ended(agentId: string, how: ForkEnd): void {
    const fork = this.forks.get(agentId)
    if (fork === undefined) return
    this.forks.delete(agentId)
    fork.end(how)
  }

  /** docs/845 W-Stop: the fork answering `act` is shown no more, and its chat may be asked again. */
  stop(act: string): void {
    for (const fork of this.forks.values()) {
      if (fork.act !== act) continue
      fork.stopped = true
      this.forked(fork.s, act)
    }
  }
}

/** The act: `asking` at once, which settles it, then one fork; what it answers is kept until ac
 *  takes it. A fork that cannot start is a refusal, and the worker runs on. A chat forking already
 *  is answered `busy`, and nothing forks again. A fork stopped is answered nothing: ac filed it. */
export async function ask($: Engine, kept: Kept, s: string, act: string, body: { prompt?: unknown }, asking: () => void, post: PostNow): Promise<void> {
  asking()
  let out: SideOut = { op: 'side', act, refused: { reason: 'busy' } }
  if (kept.fork(s, act)) {
    let stopped = false
    try {
      const [answered, fork] = await answer($, kept, s, act, body.prompt)
      out = answered
      stopped = fork?.stopped === true
    } finally {
      kept.forked(s, act)
    }
    if (stopped) return
  }
  kept.add(s, out)
  if (await post(s, out)) kept.forget(out)
}

/** Every answer ac has not taken, again, oldest first: after `start`, and while ac answers. */
export async function again(kept: Kept, post: PostNow): Promise<void> {
  for (const { s, out } of kept.list()) {
    if (await post(s, out)) kept.forget(out)
  }
}

/** The question as its fork is told it: in words alone, and with no line restating it, which the
 *  fork's own guidelines ask unless its directive says otherwise. The question stays last: the
 *  fork's last user words end with its directive, and the version gate's stand-in reads its marks
 *  off that end. */
export function directive(prompt: string): string {
  return `Answer in words alone: use no tool, and do not open by restating this question.\n\n${prompt}`
}

async function answer($: Engine, kept: Kept, s: string, act: string, prompt: unknown): Promise<[SideOut, Fork | undefined]> {
  if (typeof prompt !== 'string' || prompt === '') return [{ op: 'side', act, refused: { reason: 'no-prompt' } }, undefined]
  let started: Awaited<ReturnType<Engine['agent']['spawn']>>
  try {
    started = await $.agent.spawn({ prompt: directive(prompt), subagentType: 'fork', description: 'Aside' })
  } catch (error) {
    return [{ op: 'side', act, refused: { reason: 'threw', error: String(error).slice(0, ERROR_MAX) } }, undefined]
  }
  if (!('agentId' in started) || typeof started.agentId !== 'string') {
    const deny = 'deny' in started ? String(started.deny) : 'no fork started'
    return [{ op: 'side', act, refused: { reason: 'threw', error: deny.slice(0, ERROR_MAX) } }, undefined]
  }
  const fork = new Fork(s, act)
  kept.began(started.agentId, fork)
  const how = await fork.ended
  const text = fork.words !== '' ? fork.words : (how.answer ?? '')
  if (how.reason === 'answer' && text !== '') return [{ op: 'side', act, answer: posted(text, fork.usage) }, fork]
  // `turn.complete`'s own reason, passed on whole: an agent's end carries no HTTP status to word.
  switch (how.reason) {
    case 'aborted':
    case 'error':
    case 'refusal':
      return [{ op: 'side', act, refused: { reason: how.reason, usage: fork.usage } }, fork]
    default:
      return [{ op: 'side', act, refused: { reason: 'empty-reply', usage: fork.usage } }, fork]
  }
}

/** docs/845 I-PREFIX: `fork`'s words since the last post, posted from the byte ac holds; one post
 *  at a time, at most one each WORDS_EVERY_MS, the pieces between them going together. A post ac
 *  did not take is stated again from 0. Nothing more once the fork is stopped. */
export async function postWords($: Engine, fork: Fork, post: PostNow): Promise<void> {
  if (fork.posting) return
  fork.posting = true
  try {
    while (!fork.stopped && fork.sentChars < fork.words.length) {
      const text = fork.words.slice(fork.sentChars)
      const end = fork.words.length
      const took = await post(fork.s, { op: 'side_writing', act: fork.act, at: fork.sentBytes, text })
      if (took) {
        fork.sentChars = end
        fork.sentBytes += utf8(text)
      } else {
        fork.sentChars = 0
        fork.sentBytes = 0
        return
      }
      await $.clock.sleep(WORDS_EVERY_MS)
    }
  } finally {
    fork.posting = false
  }
}

/** The usage of one more of a fork's steps, added to its own. */
export function added(usage: ModelUsage, step: ModelUsage | null): ModelUsage {
  if (step === null) return usage
  return {
    input_tokens: usage.input_tokens + step.input_tokens,
    output_tokens: usage.output_tokens + step.output_tokens,
    cache_read_input_tokens: usage.cache_read_input_tokens + step.cache_read_input_tokens,
    cache_creation_input_tokens: usage.cache_creation_input_tokens + step.cache_creation_input_tokens,
  }
}

/** An answer as one post carries it: past ac's bound, or past what a post holds once its JSON
 *  escapes are written, cut on a character, with its whole length. A post the face refused for
 *  its size would be refused again on every try, and the answer lost. */
export function posted(text: string, usage: ModelUsage): SideAnswer {
  const bytes = utf8(text)
  if (bytes <= ANSWER_MAX && utf8(JSON.stringify(text)) <= POSTED_MAX) return { text, usage }
  let kept = upTo(text, ANSWER_MAX)
  while (kept !== '' && utf8(JSON.stringify(kept)) > POSTED_MAX) kept = upTo(kept, Math.floor(utf8(kept) / 2))
  return { text: kept, usage, bytes }
}

/** `text`'s length in UTF-8 bytes. */
function utf8(text: string): number {
  let bytes = 0
  for (const ch of text) bytes += width(ch.codePointAt(0) ?? 0)
  return bytes
}

function width(point: number): number {
  return point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4
}

/** `text`'s first characters within `max` UTF-8 bytes. */
function upTo(text: string, max: number): string {
  let bytes = 0
  let end = 0
  for (const ch of text) {
    bytes += width(ch.codePointAt(0) ?? 0)
    if (bytes > max) break
    end += ch.length
  }
  return text.slice(0, end)
}
