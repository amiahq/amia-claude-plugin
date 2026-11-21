import type { EngineInterface } from 'claude-code'

// docs/739 W9 (rev 5; the owner's Q10, 2026-11-13: "let go with both (a) + (b)"): Claude Code's own
// limit resets, read and used under the sign-in Claude Code lends this session as a handle
// (`$.session.authorize`, M19), whose token this module never reads, saying it is Claude Code's
// CLI as Claude Code itself does (M20: `x-app: cli` and its User-Agent; without them Anthropic
// answers `ineligible_reason: "surface"`). Only a session ac starts for it asks: one whose env
// names AC_METER_SOCKET, where this posts what it read and nothing else. It claims only where the
// env also names AC_METER_CLAIM, the id of an act the person confirmed (D14), and only after ac
// heard that it is about to.
//
// What it posts never carries a grant's id or label, nor `event_props` (one names the plan): the
// owner's order on published ids and plan names holds by construction, so a capture of a post is
// a redacted golden as it stands.

type Engine = EngineInterface

const API = 'https://api.anthropic.com'
const BETA = 'oauth-2025-04-20'
/** Claude Code's own forms (2.1.322): a claim with another grant or request id is refused there. */
const GRANT = /^[a-z0-9_-]{1,40}$/
const ACT = /^[0-9a-f]{32}$/
const ORG = /^[0-9A-Fa-f-]{1,64}$/
const VERSION = /^\d+\.\d+\.\d+$/
/** A server time as Claude Code reads one. */
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/

/** One grant as W9 counts it. */
export type Grant = { resets_left: number; usable_now: boolean; paused: boolean; ends_at: string | null }
/** What a read posts: `cedar_ember`'s eligibility and grants, and whether `juniper_tide` is ready
 *  (asked only at the 5-hour limit; `null` when not asked or not offered). */
export type Read = { eligible: boolean; grants: Grant[]; juniper_available: boolean | null }

type Lent = { auth: string; headers: Record<string, string> }
type Said = { status: number; body: unknown }

/** The sign-in Claude Code lends, and Claude Code's own two headers; a string says why not. */
async function lend($: Engine): Promise<Lent | string> {
  const lent = (await $.session.authorize()) as { kind?: unknown; handle?: unknown } | null | undefined
  if (lent?.kind !== 'bearer' || typeof lent.handle !== 'string') return 'Claude Code lent this session no sign-in'
  const said = (await $.session.version()) as { version?: unknown } | undefined
  const version = typeof said?.version === 'string' && VERSION.test(said.version) ? said.version : undefined
  if (version === undefined) return 'Claude Code did not say its version'
  return {
    auth: lent.handle,
    headers: { 'anthropic-beta': BETA, 'x-app': 'cli', 'user-agent': `claude-cli/${version} (external, cli)` },
  }
}

async function ask($: Engine, lent: Lent, path: string, post?: Record<string, unknown>): Promise<Said> {
  const answer = (await $.http.fetch(
    `${API}${path}`,
    post === undefined
      ? { auth: lent.auth, headers: lent.headers }
      : {
          method: 'POST',
          auth: lent.auth,
          headers: { ...lent.headers, 'content-type': 'application/json' },
          body: JSON.stringify(post),
        },
  )) as { status: number; text: string }
  let body: unknown
  try {
    body = JSON.parse(answer.text)
  } catch {
    body = undefined
  }
  return { status: answer.status, body }
}

function grantOf(g: unknown): Grant | undefined {
  if (typeof g !== 'object' || g === null) return undefined
  const { resets_left, usable_now, paused, ends_at } = g as Record<string, unknown>
  if (typeof resets_left !== 'number' || !Number.isInteger(resets_left) || resets_left < 0) return undefined
  if (typeof usable_now !== 'boolean' || typeof paused !== 'boolean') return undefined
  return { resets_left, usable_now, paused, ends_at: typeof ends_at === 'string' && ISO.test(ends_at) ? ends_at : null }
}

/** A grant W9 counts: usable now, not paused, a reset left. */
const counted = (g: Grant): boolean => g.usable_now && !g.paused && g.resets_left > 0

/** Both programs' status as Claude Code reads them (M18): `cedar_ember` always, `juniper_tide`
 *  only at the 5-hour limit, where alone it is offered. `next` is `cedar_ember`'s pick, for a
 *  claim alone; it never leaves this module. */
export async function read($: Engine, lent: Lent): Promise<{ read: Read; next: string | undefined } | string> {
  const first = await ask($, lent, '/api/oauth/usage?cedar_ember=1&skip_spend=1')
  if (first.status !== 200) return `Anthropic answered HTTP ${first.status}`
  const body = first.body as Record<string, unknown> | undefined
  const cedar = body?.cedar_ember as Record<string, unknown> | null | undefined
  if (typeof cedar !== 'object' || cedar === null) return 'Anthropic’s answer carried no cedar_ember'
  const grants = Array.isArray(cedar.grants) ? cedar.grants.map(grantOf) : []
  if (grants.some((g) => g === undefined)) return 'a grant came in a shape ac does not read'
  const fiveHour = (body?.five_hour as { utilization?: unknown } | undefined)?.utilization
  let juniper: boolean | null = null
  if (typeof fiveHour === 'number' && fiveHour >= 100) {
    const wall = await ask($, lent, '/api/oauth/usage?at_wall=1&skip_spend=1')
    const tide = (wall.body as Record<string, unknown> | undefined)?.juniper_tide as { available?: unknown } | null | undefined
    juniper = wall.status === 200 && typeof tide === 'object' && tide !== null ? tide.available === true : null
  }
  const next = typeof cedar.next_grant_id === 'string' && GRANT.test(cedar.next_grant_id) ? cedar.next_grant_id : undefined
  return { read: { eligible: cedar.eligible === true, grants: grants as Grant[], juniper_available: juniper }, next }
}

/** D15: `cedar_ember`'s next grant while one is counted, else `juniper_tide` while it is ready. */
export function pick(read: Read, next: string | undefined, act: string): Record<string, unknown> | undefined {
  if (read.eligible && next !== undefined && read.grants.some(counted)) {
    return { program: 'cedar_ember', grant_id: next, request_id: act }
  }
  if (read.juniper_available === true) return { program: 'juniper_tide' }
  return undefined
}

async function post($: Engine, at: string, said: Record<string, unknown>): Promise<boolean> {
  try {
    const answer = (await $.http.fetch('http://ac/v1/meter', {
      method: 'POST',
      socketPath: at,
      body: JSON.stringify({ v: 1, ...said }),
    })) as { status: number }
    return answer.status === 200
  } catch {
    return false
  }
}

/** The read, then the claim where one is asked: each said to ac at `at`. */
export async function meter($: Engine): Promise<void> {
  const at = await $.env.get('AC_METER_SOCKET')
  if (at === undefined || at === '') return
  const act = await $.env.get('AC_METER_CLAIM')
  const org = await $.env.get('AC_METER_ORG')
  let lent: Lent | string
  let got: Awaited<ReturnType<typeof read>>
  try {
    lent = await lend($)
    if (typeof lent === 'string') {
      await post($, at, { failed: lent })
      return
    }
    got = await read($, lent)
  } catch (error) {
    await post($, at, { failed: `the read failed: ${String(error).slice(0, 200)}` })
    return
  }
  if (typeof got === 'string') {
    await post($, at, { failed: got })
    return
  }
  if (act === undefined || act === '') {
    await post($, at, { read: got.read })
    return
  }
  if (!ACT.test(act) || org === undefined || !ORG.test(org)) {
    await post($, at, { failed: 'ac asked a claim with no act id or organization Claude Code takes' })
    return
  }
  const body = pick(got.read, got.next, act)
  if (body === undefined) {
    await post($, at, { read: got.read, claim: { none: true } })
    return
  }
  // ac hears of the claim before it is sent: a claim ac never heard of is never made.
  if (!(await post($, at, { read: got.read, claiming: body.program }))) return
  let claimed: Said
  try {
    claimed = await ask($, lent, `/api/organizations/${org}/reset_rate_limits`, body)
  } catch (error) {
    await post($, at, { claim: { program: body.program, failed: String(error).slice(0, 200) } })
    return
  }
  const answered = (claimed.body ?? {}) as Record<string, unknown>
  await post($, at, {
    claim: {
      program: body.program,
      status: claimed.status,
      result: typeof answered.result === 'string' ? answered.result : null,
      cooldown_until: typeof answered.cooldown_until === 'string' ? answered.cooldown_until : null,
    },
  })
}

