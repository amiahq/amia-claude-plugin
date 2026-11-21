import { bytesOf } from './live_blocks.ts'

export const POST_MAX = 256 * 1024
const ENTRIES_MAX = 4096
const BYTES_MAX = 16 * 1024 * 1024
type Queued = { s: string; line: string; bytes: number; recoverable: boolean; sent: () => void }
const RECOVERABLE = new Set(['begin', 'piece', 'input', 'tool'])

export class Posts {
  private waiting: Queued[] = []
  private retainedBytes = 0
  private retainedEntries = 0

  get bytes(): number { return this.retainedBytes }
  get length(): number { return this.retainedEntries }

  push(s: string, line: string, op: string, sent: () => void): { queued: boolean; dropped: boolean } {
    const bytes = bytesOf(line)
    if (bytes > POST_MAX) return { queued: false, dropped: true }
    const recoverable = RECOVERABLE.has(op)
    let dropped = false
    const full = () => this.retainedEntries >= ENTRIES_MAX || this.retainedBytes + bytes + 1 > BYTES_MAX
    while (full() && !recoverable) {
      const at = this.waiting.findIndex(queued => queued.recoverable)
      if (at < 0) break
      this.finish(this.waiting.splice(at, 1))
      dropped = true
    }
    if (full()) return { queued: false, dropped: true }
    this.waiting.push({ s, line, bytes, recoverable, sent })
    this.retainedBytes += bytes + 1
    this.retainedEntries++
    return { queued: true, dropped }
  }

  take(): Queued[] {
    const first = this.waiting[0]
    if (first === undefined) return []
    let n = 1
    let bytes = first.bytes
    for (let next = this.waiting[n]; next !== undefined; next = this.waiting[++n]) {
      if (next.s !== first.s || bytes + 1 + next.bytes > POST_MAX) break
      bytes += 1 + next.bytes
    }
    return this.waiting.splice(0, n)
  }

  finish(batch: Queued[]): void {
    for (const queued of batch) {
      this.retainedBytes -= queued.bytes + 1
      this.retainedEntries--
    }
    for (const queued of batch) queued.sent()
  }

  clear(): void {
    this.finish(this.waiting.splice(0))
  }
}
