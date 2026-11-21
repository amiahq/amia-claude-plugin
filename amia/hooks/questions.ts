import type { EngineInterface } from 'claude-code'

// docs/620: a session's AskUserQuestion, asked of the owner from ac while Claude Code's own dialog
// asks at the terminal; the first to answer is the call's. ac's answer returns what that dialog
// would have made Claude Code record (2.1.312, read from the binary): `SZ`'s result for Submit
// answers, `cancelAndAbort`'s words around `zpt`'s for Chat about this, and its rejection for Esc.

type Engine = EngineInterface

/** One post to ac for this session. */
export type Post = (out: Record<string, unknown>) => Promise<void>

export type Option = { label: string; description?: string; preview?: string }
export type Question = { question: string; header?: string; multiSelect?: boolean; options?: Option[] }
/** One answer of ac's `answers` act. */
export type Answer = { question: string; picks?: string[]; typed?: string; notes?: string }
export type End = 'submit' | 'chat' | 'decline'
/** What a `tool.call` hook answers: the tool's result, or a refusal the model reads. */
export type Ending = { result: Record<string, unknown> } | { deny: string }

/** Claude Code's rejection (`Ty`). */
export const ESC_WORDS =
  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed."
/** A rejection with the person's feedback (`_I`). */
export const FEEDBACK_PREFIX =
  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). To tell you how to proceed, the user said:\n"
/** `zpt`'s feedback, before its questions. */
export const CLARIFY = `The user wants to clarify these questions.
    This means they may have additional information, context or questions for you.
    Take their response into account and then reformulate the questions if appropriate.
    Start by asking them what they would like to clarify.

    Questions asked:
`

/** `askUserQuestionTimeout`'s values (`tpt`); any other, or none, never continues. */
const IDLE: Record<string, number> = { '60s': 60_000, '5m': 300_000, '10m': 600_000 }

/** Each part JSON-quoted when it holds ", " or `"`, joined ", " (`LLt`). */
export function joined(parts: string[]): string {
  return parts.map((part) => (part.includes(', ') || part.includes('"') ? JSON.stringify(part) : part)).join(', ')
}

/** Claude Code takes notes, and no typed words, beside a single-select's previews (`Ypt`). */
function previewed(question: Question): boolean {
  return question.multiSelect !== true && (question.options ?? []).some((option) => option.preview !== undefined)
}

/** `answer` as the dialog could give it for `question`; `undefined`, it could not. */
function fits(question: Question, answer: Answer): boolean {
  const labels = (question.options ?? []).map((option) => option.label)
  const picks = answer.picks ?? []
  if (!picks.every((pick) => typeof pick === 'string' && labels.includes(pick))) return false
  if (new Set(picks).size !== picks.length) return false
  const typed = answer.typed
  const notes = answer.notes
  if (typed !== undefined && (typeof typed !== 'string' || typed.trim() === '')) return false
  if (notes !== undefined && (typeof notes !== 'string' || notes.trim() === '')) return false
  if (question.multiSelect !== true && (picks.length > 1 || (picks.length === 1 && typed !== undefined))) return false
  if (previewed(question) ? typed !== undefined : notes !== undefined) return false
  return true
}

/** One answer's words, as the dialog writes them (`Tr`); `undefined`, none. */
function words(question: Question, answer: Answer): string | undefined {
  const picks = answer.picks ?? []
  if (question.multiSelect === true) {
    const parts = [...picks, ...(answer.typed === undefined ? [] : [answer.typed])]
    return parts.length === 0 ? undefined : joined(parts)
  }
  return answer.typed ?? picks[0]
}

/** What ac's answers end `questions` with, or `undefined` when one does not fit its question and
 *  the terminal's dialog decides. */
export function ending(questions: Question[], end: End, answers: Answer[]): Ending | undefined {
  if (end === 'decline') return { deny: ESC_WORDS }
  const by = new Map<string, Answer>()
  for (const answer of answers) {
    const question = questions.find((asked) => asked.question === answer?.question)
    if (question === undefined || by.has(answer.question) || !fits(question, answer)) return undefined
    by.set(answer.question, answer)
  }
  if (end === 'chat') {
    const asked = questions.map((question) => {
      const answer = by.get(question.question)
      const said = answer === undefined ? undefined : words(question, answer)
      const lines = [`- "${question.question}"`, said === undefined ? '  (No answer provided)' : `  Answer: ${said}`]
      const notes = previewed(question) ? answer?.notes?.trim() : undefined
      if (notes) lines.push(`  User notes: ${notes}`)
      return lines.join('\n')
    })
    return { deny: `${FEEDBACK_PREFIX}${CLARIFY}${asked.join('\n')}` }
  }
  const said: Record<string, string> = {}
  const annotations: Record<string, { preview?: string; notes?: string }> = {}
  for (const question of questions) {
    const answer = by.get(question.question)
    if (answer === undefined) continue
    const one = words(question, answer)
    if (one !== undefined) said[question.question] = one
    // `SZ`: the picked option's preview and the notes, only beside a single-select's previews.
    if (!previewed(question)) continue
    const preview = (question.options ?? []).find((option) => option.label === answer.picks?.[0])?.preview
    const notes = answer.notes?.trim()
    if (preview || notes) annotations[question.question] = { ...(preview ? { preview } : {}), ...(notes ? { notes } : {}) }
  }
  return { result: { questions, answers: said, annotations } }
}

/** When the terminal answers with what it has, from now: `askUserQuestionTimeout`. */
export async function continuesInMs($: Engine): Promise<number | null> {
  const read = Promise.resolve().then(() => $.settings.read({}))
  const settings = (await read.catch(() => ({}))) as { askUserQuestionTimeout?: unknown }
  const after = settings.askUserQuestionTimeout
  return typeof after === 'string' && after in IDLE ? IDLE[after] : null
}

type Pending = { questions: Question[]; continuesInMs: number | null; ended: (ending: Ending) => void }

/** The questions asked of ac, by call, until one is answered. */
export class Asked {
  calls = new Map<string, Pending>()

  /** ac's `answers` act: the call it names ends as ac's answers say, when they fit. */
  answered(act: unknown): void {
    const { call, end, answers } = (act ?? {}) as { call?: unknown; end?: unknown; answers?: unknown }
    if (typeof call !== 'string' || (end !== 'submit' && end !== 'chat' && end !== 'decline') || !Array.isArray(answers)) return
    const pending = this.calls.get(call)
    if (pending === undefined) return
    const ended = ending(pending.questions, end, answers as Answer[])
    if (ended !== undefined) pending.ended(ended)
  }

  /** ac's older `answer` act, a label by question, from an ac before docs/620. */
  answeredBefore(act: unknown): void {
    const { call, answers } = (act ?? {}) as { call?: unknown; answers?: unknown }
    if (typeof call !== 'string' || typeof answers !== 'object' || answers === null) return
    const picked = Object.entries(answers)
    const pending = this.calls.get(call)
    if (pending === undefined || !picked.every(([, label]) => typeof label === 'string')) return
    pending.ended({ result: { questions: pending.questions, answers: Object.fromEntries(picked) } })
  }

  /** Each call still asked, said again to an ac that just came. */
  announce(post: Post): void {
    for (const [call, pending] of this.calls) {
      void post({ op: 'question', call, questions: pending.questions, continuesInMs: pending.continuesInMs })
    }
  }

  /** Asks ac beside the terminal's dialog (`here`): the first to answer is the call's. `idle` is
   *  the hook's own `continuesInMs($)`: Claude Code's loader refuses a module that hands `$` to a
   *  method (2.1.311 to 2.1.314: "$ itself is passed as an argument"), and every session then
   *  goes unbridged. */
  async asking<T>(post: Post, call: string, questions: Question[], idle: number | null, here: Promise<T>): Promise<T | Ending> {
    const fromOwner = new Promise<Ending>((ended) => this.calls.set(call, { questions, continuesInMs: idle, ended }))
    void post({ op: 'question', call, questions, continuesInMs: idle })
    try {
      const first = await Promise.race([here.then((result) => ({ here: result })), fromOwner.then((owner) => ({ owner }))])
      if ('here' in first) {
        void post({ op: 'settled', call })
        return first.here
      }
      return first.owner
    } catch (error) {
      void post({ op: 'settled', call })
      throw error
    } finally {
      this.calls.delete(call)
    }
  }
}

export const asked = new Asked()
