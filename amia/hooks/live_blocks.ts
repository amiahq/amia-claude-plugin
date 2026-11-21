import type { TurnStepChunk } from 'claude-code'

export type Out = { op: string } & Record<string, unknown>
/** `full`: it stopped growing at a bound; the rest arrives with its row. */
type Block = { i: number; part: 'text' | 'thinking' | 'tool'; call: string; name: string; text: string; bytes: number; full: boolean }
export type Step = {
  turn: string
  step: number
  blocks: Map<number, Block>
  /** Blocks past BLOCKS_MAX: shown by their rows alone. */
  unshown: Set<number>
  stored: Set<number>
  endBy: number | undefined
  closed: boolean
}

/** Every part, as Claude Code caps its own streaming preview (2.1.310: 1e6 characters, past
 *  which it stops growing; a tool input it never draws until the block stops). */
const PART_MAX = 1024 * 1024
const NAME_MAX = 16 * 1024
const TOTAL_MAX = 2 * 1024 * 1024
/** The most blocks one response measured is 32 (228,715 responses, 2026-10-24). */
const BLOCKS_MAX = 64
const PIECE_MAX = 16 * 1024
const encoder = new TextEncoder()
const decoder = new TextDecoder()

const width = (char: string): number => {
  const point = char.codePointAt(0) as number
  return point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4
}

export function bytesOf(text: string, stopAfter = Number.POSITIVE_INFINITY): number {
  let bytes = 0
  for (const char of text) {
    bytes += width(char)
    if (bytes > stopAfter) break
  }
  return bytes
}

/** UTF-8 turns a lone surrogate into U+FFFD before the offset is advertised. */
function wellFormed(text: string): string {
  return /[\uD800-\uDFFF]/.test(text) ? decoder.decode(encoder.encode(text)) : text
}

export function* pieces(text: string): Generator<{ text: string; bytes: number }> {
  let start = 0
  let at = 0
  let bytes = 0
  for (const char of text) {
    const next = width(char)
    if (bytes + next > PIECE_MAX) {
      yield { text: text.slice(start, at), bytes }
      start = at
      bytes = 0
    }
    bytes += next
    at += char.length
  }
  yield { text: text.slice(start), bytes }
}

/** The longest prefix of `text` whose UTF-8 is at most `max` bytes, and its bytes. */
function within(text: string, max: number): { text: string; bytes: number } {
  let bytes = 0
  let at = 0
  for (const char of text) {
    const next = width(char)
    if (bytes + next > max) break
    bytes += next
    at += char.length
  }
  return { text: text.slice(0, at), bytes }
}

export class LiveBlocks {
  readonly steps = new Map<string, Step>()
  private post: (out: Out) => void

  constructor(post: (out: Out) => void) { this.post = post }

  begin(turn: string, index: number): Step {
    const step: Step = { turn, step: index, blocks: new Map(), unshown: new Set(), stored: new Set(), endBy: undefined, closed: false }
    this.post({ op: 'begin', turn, step: index })
    return step
  }

  close(step: Step): void {
    this.steps.delete(`${step.turn}/${step.step}`)
    step.blocks.clear()
  }

  private block(step: Step, i: number, part: Block['part'], call = '', name = ''): Block | undefined {
    if (step.closed || step.unshown.has(i)) return undefined
    const old = step.blocks.get(i)
    if (old !== undefined) return old.part === part ? old : undefined
    const count = [...this.steps.values()].reduce((n, step) => n + step.blocks.size, 0)
    if (count >= BLOCKS_MAX || bytesOf(call, NAME_MAX) > NAME_MAX || bytesOf(name, NAME_MAX) > NAME_MAX) {
      step.unshown.add(i)
      return undefined
    }
    const block: Block = { i, part, call, name, text: '', bytes: 0, full: false }
    step.blocks.set(i, block)
    this.steps.set(`${step.turn}/${step.step}`, step)
    return block
  }

  private append(step: Step, block: Block, raw: string): void {
    if (raw === '' || block.full) return
    const retained = [...this.steps.values()].reduce((n, step) =>
      n + [...step.blocks.values()].reduce((n, block) => n + block.bytes, 0), 0)
    const fit = within(raw, Math.min(PART_MAX - block.bytes, TOTAL_MAX - retained))
    block.full = fit.text.length < raw.length
    if (fit.bytes === 0) return
    const text = wellFormed(fit.text)
    let at = block.bytes
    block.text += text
    block.bytes += fit.bytes
    for (const piece of pieces(text)) {
      const address = { turn: step.turn, step: step.step, i: block.i, at }
      this.post(block.part === 'tool'
        ? { op: 'input', ...address, json: piece.text }
        : { op: 'piece', ...address, part: block.part, text: piece.text })
      at += piece.bytes
    }
  }

  seen(step: Step, chunk: TurnStepChunk): void {
    if (step.closed) return
    switch (chunk.kind) {
      case 'text':
      case 'thinking': {
        const block = this.block(step, chunk.index, chunk.kind)
        if (block !== undefined) this.append(step, block, chunk.text)
        return
      }
      case 'tool': {
        if (step.blocks.has(chunk.index)) return
        const block = this.block(step, chunk.index, 'tool', chunk.id, chunk.name)
        if (block !== undefined) this.post({ op: 'tool', turn: step.turn, step: step.step, i: chunk.index, call: chunk.id, name: chunk.name })
        return
      }
      case 'input': {
        const block = step.blocks.get(chunk.index)
        if (block?.part === 'tool') this.append(step, block, chunk.json)
        return
      }
    }
  }

  restate(): void {
    for (const step of this.steps.values()) {
      if (step.closed) continue
      this.post({ op: 'begin', turn: step.turn, step: step.step })
      for (const block of step.blocks.values()) {
        if (step.stored.has(block.i)) continue
        const address = { turn: step.turn, step: step.step, i: block.i }
        if (block.part === 'tool') this.post({ op: 'tool', ...address, call: block.call, name: block.name })
        let at = 0
        for (const piece of pieces(block.text)) {
          this.post(block.part === 'tool'
            ? { op: 'input', ...address, at, json: piece.text }
            : { op: 'piece', ...address, part: block.part, at, text: piece.text })
          at += piece.bytes
        }
      }
    }
  }
}
