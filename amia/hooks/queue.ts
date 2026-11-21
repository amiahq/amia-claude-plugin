import { bytesOf } from './live_blocks.ts'
import { POST_MAX } from './posts.ts'

// docs/569 Q1: the owner's words said while a turn or a command runs, and every command the
// session lists. This module is the queue's one writer (I-ONE-WRITER): a line waits here until it
// goes as the owner's own next prompt or command, is taken back, or is refused in words. Never as
// hook context: the model reads that as a hook's claim, not the owner's words (docs/569 M10,
// measured on haiku).

/** One waiting line, as the bridge posts it: its act's id, its words, when it was said. */
export type Line = { entry: string; text: string; at_ms: number }
/** A slash command the session lists, run as the owner typed it (`$.command.run`). */
export type Command = { command: string; args: string }
/** docs/614: a `!` line, run in the session's shell with its output to `out`. */
export type Shell = { line: string; out: string }
/** A line as the queue holds it: a command's words are its `/command args` and a `!` line's its
 *  `! line`, and each runs alone. */
export type Held = Line & { run?: Command; shell?: Shell }

/** The queue is posted whole on every change, so its lines fit one post with room to spare. */
export const QUEUE_BYTES = POST_MAX / 2
/** The lines one queue holds, as the host shows them (`bridge/queue.rs` MAX_QUEUED). */
export const QUEUE_LINES = 64
/** Entries remembered as read, so a late withdraw is told why it cannot be taken back. */
const READ_KEPT = 256

export type Withdrawal = { text: string } | { why: string }

export class Queue {
  private waiting: Held[] = []
  /** Lines gone to Claude Code, a prompt or a command each batch, oldest first, listed until
   *  its row is stored. */
  private entering: Held[][] = []
  private read: string[] = []

  /** Every line not yet in the record, oldest first: what a watch is shown, as the host's
   *  `QueuedLine` takes it (no field past these three). */
  lines(): Line[] {
    return [...this.entering.flat(), ...this.waiting].map(({ entry, text, at_ms }) => ({ entry, text, at_ms }))
  }

  /** Lines that have not gone to Claude Code yet. */
  get waitingCount(): number {
    return this.waiting.length
  }

  /** Nothing is waiting and nothing is on its way into the record. */
  get empty(): boolean {
    return this.waiting.length === 0 && this.entering.length === 0
  }

  /** A line was queued here: it waits, is entering, or was read. */
  get touched(): boolean {
    return !this.empty || this.read.length !== 0
  }

  /** Queues `line`; why it was refused, in words, when the queue cannot hold it. */
  add(line: Held): string | undefined {
    const held = this.lines()
    if (held.some((queued) => queued.entry === line.entry)) return undefined
    if (held.length >= QUEUE_LINES || bytesOf(JSON.stringify([...held, line])) > QUEUE_BYTES) {
      return 'the queue is full: send it now or wait for the turn to end, then say it again'
    }
    this.waiting.push(line)
    return undefined
  }

  /** Takes `entry` back while it waits; once it went to Claude Code it cannot be. */
  withdraw(entry: string): Withdrawal {
    const at = this.waiting.findIndex((line) => line.entry === entry)
    if (at !== -1) return { text: this.waiting.splice(at, 1)[0].text }
    if (this.entering.some((batch) => batch.some((line) => line.entry === entry)) || this.read.includes(entry)) {
      return { why: 'Claude Code already has it, so it cannot be taken back' }
    }
    return { why: 'no line of that id is waiting' }
  }

  /** The lines that go next, now on their way, in the order said: a command alone (one
   *  `$.command.run` runs one), else every line of words up to the next command, as one
   *  prompt. None when nothing waits. */
  take(): Held[] | undefined {
    const first = this.waiting[0]
    if (first === undefined) return undefined
    const alone = (line: Held): boolean => line.run !== undefined || line.shell !== undefined
    const command = this.waiting.findIndex(alone)
    const end = alone(first) ? 1 : command === -1 ? this.waiting.length : command
    const batch = this.waiting.splice(0, end)
    this.entering.push(batch)
    return batch
  }

  /** `batch`'s row is stored: its lines leave, read. */
  stored(batch: Held[]): void {
    this.entering = this.entering.filter((entering) => entering !== batch)
    for (const line of batch) this.read.push(line.entry)
    if (this.read.length > READ_KEPT) this.read.splice(0, this.read.length - READ_KEPT)
  }

  /** `batch` never went in: its lines wait again, ahead of any said since. */
  dropped(batch: Held[]): void {
    if (!this.entering.includes(batch)) return
    this.entering = this.entering.filter((entering) => entering !== batch)
    this.waiting = [...batch, ...this.waiting]
  }
}

/** The words of `batch` as the one prompt Claude Code's own dequeue opens a turn with. */
export function prompt(batch: readonly Line[]): string {
  return batch.map((line) => line.text).join('\n')
}

/** `/command args` as the owner typed it: the host reads a line's command back from these words
 *  (`typed::typed`), and an edit puts them back in the owner's line. */
export function typed({ command, args }: Command): string {
  return args === '' ? `/${command}` : `/${command} ${args}`
}
