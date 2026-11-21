import type { EngineInterface } from 'claude-code'

// docs/614: a `!` line the owner sends from ac, run in the session's shell as Claude Code's own `!`
// runs it (2.1.312 `processBashCommand`, read from the binary): Claude Code's Bash, unasked and
// unsandboxed, its two record rows, then the model's turn. A plugin streams no tool's progress, and
// Claude Code's process held a line's pieces up to 2.6 s while its Bash ran (§1), so the line's
// output is written to `out`, a file ac made and follows, and handed back to Claude Code as the
// line ends: Claude Code's result is the result of the line unwrapped.

type Engine = EngineInterface

/** One post to ac for this session. */
export type Post = (out: Record<string, unknown>) => Promise<void>

/** Claude Code's own rows: the caveat it records before a run the model does not answer, and an
 *  interrupted run's ending (2.1.312). */
const CAVEAT =
  "<local-command-caveat>The command below was run directly in Claude Code, not sent to you as a request, and its output goes straight to the user. It's recorded here as context for later messages.</local-command-caveat>"
const INTERRUPTED = '[Request interrupted by user]'

/** A word for the shell, quoted whole. */
export function q(word: string): string {
  return `'${word.replaceAll("'", `'\\''`)}'`
}

/** The line as Claude Code's Bash runs it: its shell's pid beside `out` while it runs (ac's Stop
 *  ends its group; removed first as the shell exits, so a Stop after it reads none), its
 *  output to `out` as written, and on exit all of it handed back to Claude Code, unless ac ended
 *  it. On the line's own first line, so an error names the line number it would unwrapped
 *  (measured: `(eval):1:`). */
export function wrapped(line: string, out: string): string {
  const dir = out.slice(0, out.lastIndexOf('/'))
  const back = `rm -f -- ${q(`${dir}/pid`)}; exec >&9 2>&9; [ -e ${q(`${dir}/stop`)} ] || cat -- ${q(out)}`
  return `echo $$ >| ${q(`${dir}/pid`)}; exec 9>&1 >>${q(out)} 2>&1; trap ${q(back)} EXIT; ${line}`
}

/** Escaped as Claude Code escapes a `!` row's output (`docs/539` W6 measured `-&gt;`). */
export function escaped(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

/** What `$.tool.call` answers for Bash (2.1.312, measured): a result, or an error's words. */
export type BashAnswer = { result?: unknown; text?: string; isError?: boolean; deny?: string }

/** The output row Claude Code's `!` records for `answer`. Its stdout is the tool's own words for
 *  it less its notes (an empty run's `(Bash completed with no output)`, a large one's
 *  `<persisted-output>`, unescaped as Claude Code leaves it); its stderr, those notes (the cwd's
 *  reset). A failed run's words lead with `Exit code N`, which its row does not carry. */
export function outputRow(answer: BashAnswer): string {
  const text = answer.text ?? ''
  const ran = answer.result as { stdout?: unknown; stderr?: unknown } | undefined
  let stdout: string
  let stderr = ''
  if (answer.isError === true || typeof ran !== 'object' || ran === null) {
    stdout = escaped(text.replace(/^Exit code -?\d+\n?/, ''))
  } else {
    stderr = typeof ran.stderr === 'string' ? ran.stderr : ''
    const words = stderr !== '' && text.endsWith(stderr.trimStart()) ? text.slice(0, text.length - stderr.trimStart().length).replace(/\n$/, '') : text
    stdout = words.startsWith('<persisted-output>') ? words : escaped(words)
  }
  return `<bash-stdout>${stdout}</bash-stdout><bash-stderr>${escaped(stderr)}</bash-stderr>`
}

/** What this module knows of the session's shell between lines. */
export class Shells {
  /** Bash commands this module raised and not yet ended: its `tool.check` allows exactly these. */
  private own = new Set<string>()
  /** Output rows submitted as the owner's prompt, by their words: the block each binds. */
  private submitted = new Map<string, string>()
  /** The folder is known: posted as a line ended, and no other Bash call ran since. */
  known = false

  raise(command: string): void {
    this.own.add(command)
  }

  end(command: string): void {
    this.own.delete(command)
  }

  /** The owner's line, or this module's read of the folder: never the model's own call. */
  owns(command: string): boolean {
    return this.own.has(command)
  }

  awaitRow(text: string, turn: string): void {
    this.submitted.set(text, turn)
  }

  /** The block a prompt row with `text` is the output of, once. */
  rowOf(text: string): string | undefined {
    const turn = this.submitted.get(text)
    if (turn !== undefined) this.submitted.delete(text)
    return turn
  }

  /** Another Bash call ran: where the next line runs is no longer known. Whether to say so. */
  forget(): boolean {
    if (!this.known) return false
    this.known = false
    return true
  }
}

export const shells = new Shells()

async function bash($: Engine, command: string): Promise<BashAnswer> {
  shells.raise(command)
  try {
    return (await $.tool.call({ tool: 'Bash', command, dangerouslyDisableSandbox: true } as never)) as BashAnswer
  } catch (error) {
    return { isError: true, text: String(error) }
  } finally {
    shells.end(command)
  }
}

async function note($: Engine, text: string): Promise<string | undefined> {
  const stored = await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
  return 'uuid' in stored && typeof stored.uuid === 'string' ? stored.uuid : undefined
}

/** Why ac ended the line, as it wrote beside `out`: `stopped`, `capped`, or none. */
async function endedBy($: Engine, out: string): Promise<string | undefined> {
  const stop = `${out.slice(0, out.lastIndexOf('/'))}/stop`
  const read = await $.process.run(['/bin/cat', stop]).catch(() => undefined)
  return read?.exitCode === 0 ? read.stdout.trim() : undefined
}

/** Where Claude Code's Bash runs next, as its own `pwd -P` says after its own folder rules. */
async function folder($: Engine, post: Post): Promise<void> {
  const said = await bash($, 'pwd -P')
  const ran = said.result as { stdout?: unknown } | undefined
  const cwd = said.isError !== true && typeof ran?.stdout === 'string' && ran.stdout.startsWith('/') ? ran.stdout.trim() : null
  shells.known = cwd !== null
  await post({ op: 'shellCwd', cwd })
}

/** docs/614: runs `line` for act `act`, its output to `out`. Said once its `<bash-input>` row is
 *  stored; the output row binds the line's block (`shell-<act>`), or the block ends when ac
 *  stopped it, as an esc at Claude Code's terminal does: no output, no turn. */
export async function runShell($: Engine, post: Post, act: string, line: string, out: string): Promise<void> {
  const turn = `shell-${act}`
  const input = await note($, `<bash-input>${line}</bash-input>`).catch(() => undefined)
  if (input === undefined) {
    await post({ op: 'failed', act, why: 'Claude Code did not record the line' })
    return
  }
  await post({ op: 'said', act, uuid: input })
  const answer = await bash($, wrapped(line, out))
  const why = await endedBy($, out)
  // Before any turn the output opens: the read is one more Bash call of this module's.
  await folder($, post)
  if (why === 'stopped' || answer.deny !== undefined) {
    await note($, CAVEAT).catch(() => undefined)
    await note($, answer.deny === undefined ? INTERRUPTED : `<bash-stderr>${escaped(answer.deny)}</bash-stderr>`).catch(() => undefined)
    await post({ op: 'end', turn, step: 0, rows: [] })
    return
  }
  let row = outputRow(answer)
  if (why === 'capped') row = row.replace('<bash-stderr>', '<bash-stderr>Command killed: output file exceeded 5GB')
  const settings = (await $.settings.read({}).catch(() => ({}))) as { respondToBashCommands?: unknown }
  if (settings.respondToBashCommands !== false) {
    shells.awaitRow(row, turn)
    const entered = await $.prompt.submit({ text: row, asUser: true }).catch((error: unknown) => ({ drop: String(error) }))
    if (entered.drop !== undefined) {
      shells.rowOf(row)
      await bound(post, turn, await note($, row).catch(() => undefined))
    }
  } else {
    await note($, CAVEAT).catch(() => undefined)
    await bound(post, turn, await note($, row).catch(() => undefined))
  }
}

/** The output row binds the line's block; with no row stored the block ends, so ac lets the file
 *  go either way. */
async function bound(post: Post, turn: string, uuid: string | undefined): Promise<void> {
  await post(uuid === undefined ? { op: 'end', turn, step: 0, rows: [] } : { op: 'row', turn, step: 0, i: 0, uuid })
}
