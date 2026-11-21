// docs/643 R5 and A1: while this session drives the person's terminal (the wheel they handed it), its Bash runs
// there, through ac's gate, and its own asks are answered by the wheel's autonomy. ac answers who drives; an answer
// that could not be had leaves the last one standing, so a session that drove never runs a command in its own shell,
// and a run ac was sent whose answer was lost runs nowhere: it may have run in the terminal.
import type { EngineInterface } from 'claude-code'

/** What `/v1/run` and `/v1/wait` answer (docs/643 §2, E's routes). */
export type Ran =
  | { wheel: 'not_driving' }
  | { wheel: 'could_not_tell'; why: string }
  | { wheel: 'answered'; text: string }
  | { wheel: 'running'; n: number; text: string }

export type Autonomy = 'ask' | 'auto' | 'bypass'

/** A wheel this session holds: how freely it goes, and the folder its terminal was opened in (null: Home). */
export type Seat = { autonomy: Autonomy; folder: string | null }

/** What `/v1/wheel` answers. */
export type Look =
  | { wheel: 'not_driving' }
  | { wheel: 'could_not_tell'; why: string }
  | { wheel: 'driving'; seats: Seat[] }

/**
 * Posts `body` to one of the bridge's routes for this session: its answer, or could-not-tell when nothing was sent (no
 * face to ask, or a face that refused the ask). Undefined only when the ask was sent and no answer came back, so it
 * may have run.
 */
export type Post = (route: string, body: Record<string, unknown>) => Promise<unknown>

/** Where `path` lands, `..` and links resolved; undefined when it cannot be placed. */
export type Place = (path: string) => Promise<string | undefined>

export type Checked = 'next' | { decision: 'allow' | 'deny'; reason: string }
export type Called = 'next' | { text: string } | { deny: string }

/** Claude Code's Bash without a `timeout` (its tool's own words: "default 120000, max 600000"). */
export const BASH_DEFAULT_MS = 120_000

export const UNREACHED = 'the terminal you were handed could not be reached, so this was not run'
export const UNTOLD =
  "ac's answer to this was lost, so it did not run here: whether it ran in a terminal handed to you cannot be told"
export const HANDED =
  'you were handed a terminal as this was about to run in your own shell, so it did not run: run it again to run it there'
export const FAILED = "ac's plugin failed while you drive the terminal you were handed, so this did not run here"
const COULD_NOT_TELL: Ran = { wheel: 'could_not_tell', why: 'its answer was none that ac writes' }
const BYPASS = 'you were handed the terminal under Bypass'
const INSIDE = "an edit inside the folder of the terminal you were handed, under Auto"
const OUTSIDE =
  'under Auto, the terminal you were handed lets only its commands and edits inside its folder run unasked'

/** The tools that edit a file, and the field naming it. */
const EDITS: Readonly<Record<string, string>> = { Edit: 'file_path', Write: 'file_path', NotebookEdit: 'notebook_path' }
const AUTONOMIES: readonly Autonomy[] = ['ask', 'auto', 'bypass']

export class Wheel {
  /** The last answer said this session drives: an answer that could not be had then refuses. */
  drove = false

  /**
   * A tool's check: the wheel's word while this session drives, else the check beneath (`next`). It runs inside the
   * call's `next(e)` (§10's order), so a foreground Bash that reaches it is already bound for the session's own shell.
   */
  async check(tool: string, input: unknown, post: Post, place: Place): Promise<Checked> {
    const heard = look(await post('/v1/wheel', {}))
    if (heard === undefined || heard.wheel === 'could_not_tell') {
      return this.drove ? { decision: 'deny', reason: UNREACHED } : 'next'
    }
    if (heard.wheel === 'not_driving') {
      this.drove = false
      return 'next'
    }
    this.drove = true
    const fields = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {}
    if (tool === 'Bash' && fields.run_in_background !== true) return { decision: 'deny', reason: HANDED }
    const least = AUTONOMIES.find((autonomy) => heard.seats.some((seat) => seat.autonomy === autonomy)) ?? 'ask'
    if (least === 'ask') return 'next'
    if (least === 'bypass') return { decision: 'allow', reason: BYPASS }
    const field = EDITS[tool]
    const path = field === undefined ? undefined : fields[field]
    if (typeof path === 'string' && (await inside(path, heard.seats, place))) {
      return { decision: 'allow', reason: INSIDE }
    }
    return { decision: 'deny', reason: OUTSIDE }
  }

  /** Bash's call: in the terminal while this session drives, waited on until `timeoutMs`; else `next`. */
  async call(command: string, timeoutMs: number, post: Post, now: () => number = Date.now): Promise<Called> {
    const until = now() + timeoutMs
    const sent = await post('/v1/run', { command, timeout_ms: timeoutMs })
    // Sent and never answered (the face's own 500 says so): it may have run there, so never here, whatever the last
    // answer was. This session's first run is the one that learns whether it drives.
    if (sent === undefined) return { deny: UNTOLD }
    // From here a run was sent: a throw is refused, never left to the engine, which runs the tool past a failed hook.
    try {
      // Anything else that is no answer ac writes reads as the host's could-not-tell, which sent nothing (F-WIRE).
      const first = ran(sent) ?? COULD_NOT_TELL
      if (first.wheel === 'could_not_tell') return this.drove ? { deny: UNREACHED } : 'next'
      if (first.wheel === 'not_driving') {
        this.drove = false
        return 'next'
      }
      this.drove = true
      let heard: Extract<Ran, { text: string }> = first
      while (heard.wheel === 'running' && now() < until) {
        const later = ran(await post('/v1/wait', { n: heard.n }))
        if (later === undefined || (later.wheel !== 'answered' && later.wheel !== 'running')) {
          // It ran in the terminal: never again here, and its end is the terminal's to tell.
          const why =
            later === undefined
              ? 'the terminal could not be reached'
              : later.wheel === 'could_not_tell'
                ? later.why
                : "the wheel is no longer this session's"
          return { text: `${heard.text}\nIts end could not be read: ${why}.` }
        }
        heard = later
      }
      return { text: heard.text }
    } catch {
      return { deny: UNTOLD }
    }
  }
}

/**
 * tool.check's word once core's `verdict` is in. bridge.ts registers the check first, so outermost, and asks core
 * first: only an ask stalls a run (A1), so core's allow and deny stand and cost the host nothing. `own`, a call of this
 * module's own (the owner's `!` line, its read of the folder), is the owner's, never the session's.
 */
export async function checkedBy<V extends { decision?: unknown }>(
  wheel: Wheel,
  verdict: V,
  own: boolean,
  e: { tool: string; input: unknown },
  post: Post,
  place: Place,
): Promise<V | Exclude<Checked, 'next'>> {
  if (verdict.decision !== 'ask' || own) return verdict
  const checked = await wheel.check(e.tool, e.input, post, place)
  return checked === 'next' ? verdict : checked
}

/** Bash's result while this session drives, in Bash's own shape; undefined leaves the call to the hook beneath. */
export type Answered = { result: { stdout: string; stderr: string; interrupted: boolean } } | { deny: string }

/** tool.call's answer: a Bash run in the terminal. A background Bash, any other tool and `own` calls pass. */
export async function calledBy(wheel: Wheel, e: unknown, own: boolean, post: Post): Promise<Answered | undefined> {
  const args = e as { tool?: unknown; command?: unknown; timeout?: unknown; run_in_background?: unknown }
  if (args.tool !== 'Bash' || own) return undefined
  if (typeof args.command !== 'string' || args.run_in_background === true) return undefined
  const timeout = typeof args.timeout === 'number' && args.timeout > 0 ? args.timeout : BASH_DEFAULT_MS
  const called = await wheel.call(args.command, timeout, post)
  if (called === 'next') return undefined
  if ('deny' in called) return { deny: called.deny }
  return { result: { stdout: called.text, stderr: '', interrupted: false } }
}

/** At most this many names of a path may not exist yet: a deeper one is placed nowhere. */
const MISSING_KEPT = 64

/**
 * Where `spelled` lands (§2): the realpath of its nearest existing parent, then the names not there yet, each a plain
 * name, so `..` or `.` among them places it nowhere. What exists but leads nowhere (a dangling link) is placed nowhere.
 * A function declaration taking `$`, the only kind Claude Code's loader lets a hook hand `$` to.
 */
export async function placed($: EngineInterface, spelled: string): Promise<string | undefined> {
  const missing: string[] = []
  let at = spelled.replace(/\/+$/, '')
  const leaf = at.slice(at.lastIndexOf('/') + 1)
  if (leaf === '' || leaf === '.' || leaf === '..') return undefined
  while (missing.length <= MISSING_KEPT) {
    const found = await $.fs.stat(at === '' ? '/' : at, { resolve: true }).catch(() => undefined)
    if (found !== undefined) {
      if (found.realPath === undefined) return undefined
      return missing.length === 0 ? found.realPath : `${found.realPath.replace(/\/+$/, '')}/${missing.reverse().join('/')}`
    }
    if (at === '' || at === '.') return undefined
    const cut = at.lastIndexOf('/')
    const name = at.slice(cut + 1)
    if (name === '' || name === '.' || name === '..') return undefined
    missing.push(name)
    at = cut < 0 ? '.' : at.slice(0, cut).replace(/\/+$/, '')
  }
  return undefined
}

async function inside(path: string, seats: readonly Seat[], place: Place): Promise<boolean> {
  const real = await place(path)
  if (real === undefined) return false
  for (const seat of seats) {
    if (seat.autonomy === 'ask' || seat.folder === null) continue
    const root = await place(seat.folder)
    if (root !== undefined && real.startsWith(`${root.replace(/\/+$/, '')}/`)) return true
  }
  return false
}

/** A `/v1/run` or `/v1/wait` answer, or undefined when it is none of them. */
export function ran(heard: unknown): Ran | undefined {
  if (typeof heard !== 'object' || heard === null) return undefined
  const h = heard as Record<string, unknown>
  switch (h.wheel) {
    case 'not_driving':
      return { wheel: 'not_driving' }
    case 'could_not_tell':
      return typeof h.why === 'string' ? { wheel: 'could_not_tell', why: h.why } : undefined
    case 'answered':
      return typeof h.text === 'string' ? { wheel: 'answered', text: h.text } : undefined
    case 'running':
      return Number.isInteger(h.n) && typeof h.text === 'string'
        ? { wheel: 'running', n: h.n as number, text: h.text }
        : undefined
    default:
      return undefined
  }
}

/** A `/v1/wheel` answer, or undefined when it is none. A driving answer names at least one seat. */
export function look(heard: unknown): Look | undefined {
  if (typeof heard !== 'object' || heard === null) return undefined
  const h = heard as Record<string, unknown>
  switch (h.wheel) {
    case 'not_driving':
      return { wheel: 'not_driving' }
    case 'could_not_tell':
      return typeof h.why === 'string' ? { wheel: 'could_not_tell', why: h.why } : undefined
    case 'driving': {
      if (!Array.isArray(h.seats) || h.seats.length === 0) return undefined
      const seats: Seat[] = []
      for (const seat of h.seats as unknown[]) {
        const s = typeof seat === 'object' && seat !== null ? (seat as Record<string, unknown>) : {}
        const autonomy = AUTONOMIES.find((a) => a === s.autonomy)
        if (autonomy === undefined || (s.folder !== null && typeof s.folder !== 'string')) return undefined
        seats.push({ autonomy, folder: s.folder as string | null })
      }
      return { wheel: 'driving', seats }
    }
    default:
      return undefined
  }
}
