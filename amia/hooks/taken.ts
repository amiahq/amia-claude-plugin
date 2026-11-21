// docs/569 §12 Q4‴: a line said for the running turn's next step, taken back. Claude Code's daemon
// queues it (`reply nextTurn`) unscreened, and `prompt.submit` screens it at the moment the turn
// reads it (M33, measured on 2.1.316), so a take-back armed before that moment drops it there and
// the turn never reads it. The hook sees such a line as the owner's own Enter (`composer`) and
// with no id, so a line is known by its words, and Claude Code screens its lines oldest first.

/** Screenings remembered, so a take-back can tell whether its line was already read. */
const SCREENED_KEPT = 64
/** Take-backs armed at once, as many lines as a chat's queue shows (`queue.ts` QUEUE_LINES). */
const ARMED_MAX = 64
/** Main turns a take-back outlives. Claude Code reads every waiting next-step line at its turn's
 *  next step or as the next turn's prompt, so one still armed when a second turn starts was taken
 *  out of Claude Code's queue some other way, and must not drop a later line of the same words. */
const TURNS_KEPT = 2
/** The host stamps a line as it sends it and this module stamps a screening, on one machine; this
 *  much clock step between the two still reads as "maybe read". */
const SKEW_MS = 2_000
/** Lines dropped as taken back, remembered so a take asked again (its answer lost on the way, the
 *  host answering Unknown) is answered as the first was and never arms a second drop. */
const DROPPED_KEPT = 64

export const TAKEN_BACK = 'taken back from ac'
export const READ = 'Claude Code has read this line, so it cannot be taken back'
export const UNTOLD = 'ac could not tell whether Claude Code has read this line, so it was not taken back'
export const FULL = 'this chat has as many lines being taken back as ac shows'

export class NextTaken {
  /** Words screened as the owner's and let through, oldest first. */
  private screened: { text: string; at: number }[] = []
  /** Nothing screened before this is known: the module's load, or the newest screening forgotten. */
  private knownSince: number
  private armed: { entry: string; text: string; turn: number }[] = []
  private dropped: string[] = []
  private turns = 0

  constructor(now: number) {
    this.knownSince = now
  }

  /** The owner takes back the host's line `entry` of `text`, sent to Claude Code at `sentAt` (ms):
   *  armed (or armed already, or dropped already), or why not. */
  take(entry: string, text: string, sentAt: number): string | undefined {
    if (this.dropped.includes(entry) || this.armed.some((taken) => taken.entry === entry)) return undefined
    const words = text.trim()
    const since = sentAt - SKEW_MS
    if (since < this.knownSince) return UNTOLD
    const seen = this.screened.filter((screened) => screened.at >= since && screened.text === words)
    if (seen.some((screened) => screened.at >= sentAt)) return READ
    if (seen.length > 0) return UNTOLD
    if (this.armed.length >= ARMED_MAX) return FULL
    this.armed.push({ entry, text: words, turn: this.turns })
    return undefined
  }

  /** Claude Code screens `text` as the owner's own Enter at `now`: whether it is a line taken
   *  back, to be dropped. */
  screen(text: string, now: number): boolean {
    const words = text.trim()
    const armed = this.armed.findIndex((taken) => taken.text === words)
    if (armed !== -1) {
      this.dropped.push(this.armed.splice(armed, 1)[0].entry)
      if (this.dropped.length > DROPPED_KEPT) this.dropped.shift()
      return true
    }
    this.screened.push({ text: words, at: now })
    const forgotten = this.screened.length > SCREENED_KEPT ? this.screened.shift() : undefined
    if (forgotten !== undefined) this.knownSince = Math.max(this.knownSince, forgotten.at + 1)
    return false
  }

  /** The session's main loop began a turn. */
  started(): void {
    this.turns++
    this.armed = this.armed.filter((taken) => this.turns - taken.turn < TURNS_KEPT)
  }
}
