// The purpose-first API. Four jobs, one call each, plain results:
//
//   const readmit = connect('devnet')
//   await readmit.why(hash)                       1. Why did this transaction fail?
//   await readmit.check(tx, signer)               2. Will this transaction get in? (dry run, nothing sent)
//   await readmit.send(tx, signer)                3. Send it and make sure it lands (check → fix → send → wait)
//   await readmit.mempool()                       4. What is the mempool rejecting right now?
//
// `tx` comes from `readmit.prepare({ from, calls, payGas })`, so callers never touch frames. Everything below is
// built on the lower-level client (`readmit.advanced`), which stays available for full control.
import type { Address, Hex } from 'viem'
import { createReadmit, ALT_MEMPOOL_DEVNET, type Readmit, type ReadmitConfig } from './client.ts'
import { applyPatch, senderFrame, verifyFrame, SCOPE, type Draft, type Signer } from './frames.ts'
import { TxNotIncluded, WaitTimeout } from './errors.ts'
import type { Diagnosis, Finding, FindingCode, Verdict } from './diagnose.ts'
import type { Stage } from './monitor.ts'
import { erc20Paymaster } from '../recipes/erc20Paymaster.ts'
import { lookupSelectors } from './selectors.ts'

/** Contracts Readmit deployed on the public devnet: tUSD and a staked paymaster that takes gas in tUSD. */
export const DEVNET_CONTRACTS = {
  tUSD: '0xFa85eaee2c9abF09Ec7c305692979C0Ab91D0024',
  tUSDDecimals: 6,
  paymaster: '0xc9ca898B92fA53635959021239E190Cf22c1F1d9',
} as const satisfies Record<string, Address | number>

// ---------------------------------------------------------------------------------------------------------------
// Results: the same small shape for every job.

/** One thing that is wrong (or worth knowing), in plain words. */
export type Problem = {
  /** Stable id: branch on this, not on `message`. */
  code: FindingCode
  /** Which frame, if the problem is in one. */
  frame?: number
  /** One line: what happened. */
  message: string
  /** Why it happened, with the numbers. */
  why: string
  /** What to change, if we know. */
  fix?: string
  /** `send` can fix this by itself (a gas limit, or a re-quoted fee). */
  autoFixable: boolean
  /** The custom error the contract reverted with, when there is one. `name` comes from the Sourcify signature database (null if unknown). */
  error?: { selector: Hex; name: string | null }
}

export type Report = {
  /** Nothing blocks this transaction. */
  ok: boolean
  /** One sentence for a human. */
  summary: string
  /** Blocking problems, worst first. */
  problems: Problem[]
  /** Non-blocking: worth knowing (e.g. depends on a pool price). */
  warnings: Problem[]
  /** The three views: the mempool node, the chain, and the ERC-8421 spec. */
  verdicts: { mempool: Verdict; chain: Verdict; spec: Verdict }
  /** The full diagnosis, for UIs that want every detail. */
  details: Diagnosis
}

export type SendResult = Report & {
  /** Where it ended. `blocked` = the check found a problem with no automatic fix, so nothing was sent. */
  status: 'included' | 'rejected' | 'failed' | 'dropped' | 'timeout' | 'blocked'
  hash?: Hex
  /** What `send` changed before sending, e.g. "frame 3 gas 16,000 → 20,000". */
  fixes: string[]
  /** The transaction that was finally sent (after fixes). */
  tx: PreparedTx
}

export type SendStep = 'checking' | 'fixing' | 'sending' | 'waiting' | 'done'

/** How the transaction pays for gas. */
export type GasPayment = { kind: 'eth' } | { kind: 'token'; token: Address; paymaster: Address }
/** The sender pays gas in ETH. */
export const payWithEth = (): GasPayment => ({ kind: 'eth' })
/** A paymaster pays the ETH and takes `token` from the sender. Default: Readmit's tUSD paymaster on the devnet. */
export const payWithToken = (p: { token: Address; paymaster: Address } = { token: DEVNET_CONTRACTS.tUSD, paymaster: DEVNET_CONTRACTS.paymaster }): GasPayment => ({ kind: 'token', ...p })

export type Call = { to: Address; data?: Hex; value?: bigint; /** Gas limit for this call. Default 60,000; `send` raises it if the check says it's too low. */ gas?: bigint }
/** A transaction ready to check or send. Plain data: safe to log, store or edit. */
export type PreparedTx = { draft: Draft; payGas: GasPayment }

// ---------------------------------------------------------------------------------------------------------------

const toProblem = (f: Finding): Problem => ({ code: f.code, frame: f.frame, message: f.title, why: f.why, fix: f.fix, autoFixable: !!f.patch, ...(f.selector ? { error: { selector: f.selector as Hex, name: null } } : {}) })

/** Names custom-error selectors (e.g. 0x84a4bbd6 → BadWitness()) via Sourcify. Best effort: unknown stays null. */
async function nameErrors<T extends Report>(r: T): Promise<T> {
  const all = [...r.problems, ...r.warnings].filter((p) => p.error)
  if (!all.length) return r
  const names = await lookupSelectors(all.map((p) => p.error!.selector)).catch(() => new Map<string, string | null>())
  for (const p of all) {
    const name = names.get(p.error!.selector) ?? null
    p.error = { ...p.error!, name }
    if (name) {
      p.why = `${p.why} The contract's error: ${name} (${p.error.selector}).`
      if (p.fix && p.code === 'VALIDATION_REVERTED') p.fix = `Meet the condition behind ${name} in the account or paymaster code. If it's a signature or witness check, re-sign over the right hash with the right key.`
    }
  }
  if (!r.ok && r.problems[0]) r.summary = `${r.problems[0].message}${r.problems[0].error?.name ? `: ${r.problems[0].error.name}` : ''}.${r.problems[0].fix ? ` ${r.problems[0].fix}` : ''}`
  return r
}

function report(dx: Diagnosis): Report {
  const problems = dx.findings.filter((f) => f.tone === 'fail').map(toProblem)
  const warnings = dx.findings.filter((f) => f.tone === 'warn').map(toProblem)
  const ok = problems.length === 0
  const summary = ok
    ? warnings.length ? `OK, with ${warnings.length} warning${warnings.length > 1 ? 's' : ''}: ${warnings[0].message}` : dx.findings[0]?.title ?? 'OK'
    : `${problems[0].message}.${problems[0].fix ? ` ${problems[0].fix}` : ''}`
  return { ok, summary, problems, warnings, verdicts: { mempool: dx.mempool, chain: dx.chain, spec: dx.spec }, details: dx }
}

/**
 * Connect to a network. `'devnet'` is the public EF alt-mempool devnet (chain 1337); or pass your own endpoints:
 * `connect({ ethrex, miner, gateway, chainId })`.
 */
export function connect(network: 'devnet' | ReadmitConfig = 'devnet') {
  const advanced: Readmit = createReadmit(network === 'devnet' ? ALT_MEMPOOL_DEVNET : network)
  const paymasters = new Map<string, ReturnType<typeof erc20Paymaster>>()
  const pmFor = (g: GasPayment) => {
    if (g.kind !== 'token') return null
    const k = `${g.token}:${g.paymaster}`.toLowerCase()
    if (!paymasters.has(k)) paymasters.set(k, erc20Paymaster(advanced, { token: g.token, paymaster: g.paymaster }))
    return paymasters.get(k)!
  }

  /** 1. Why did this transaction fail? Works for anyone's hash, including rejected ones no block explorer has. */
  async function why(hash: Hex): Promise<Report & { status: Stage; seenBy: 'gateway' | 'miner' }> {
    const dx = await advanced.explain(hash)
    const status = await advanced.stage(hash, dx.node)
    return nameErrors({ ...report(dx), status, seenBy: dx.node })
  }

  /** Describe what you want to do; this builds the frames, reads nonce and fees, and quotes the fee if a token pays. */
  async function prepare(p: { from: Address; calls: Call[]; payGas?: GasPayment }): Promise<PreparedTx> {
    const payGas = p.payGas ?? payWithEth()
    if (!p.calls.length) throw new Error('prepare: give at least one call')
    const calls = p.calls.map((c) => senderFrame({ target: c.to, data: c.data, value: c.value, gas: c.gas ?? 60_000n, stateGas: 100_000n }))
    const pm = pmFor(payGas)
    const draft = pm
      ? await pm.build(p.from, calls)
      : await advanced.buildFrameTx({ sender: p.from, frames: [verifyFrame(SCOPE.BOTH, { gas: 10_000n }), ...calls] })
    return { draft, payGas }
  }

  /** 2. Will this transaction get in? Signs and dry-runs it on the node. Nothing is broadcast. */
  async function check(tx: PreparedTx, signer: Signer): Promise<Report> {
    return nameErrors(report((await advanced.dryRun(tx.draft, signer)).diagnosis))
  }

  /**
   * 3. Send it and make sure it lands: check → apply the suggested fix (up to 3 times) → send → wait for inclusion.
   * Never throws for a transaction outcome: read `status`. Throws only for configuration or network errors.
   */
  async function send(tx: PreparedTx, signer: Signer, opts: { onStep?: (step: SendStep, detail?: string) => void; timeoutMs?: number } = {}): Promise<SendResult> {
    const step = opts.onStep ?? (() => {})
    const pm = pmFor(tx.payGas)
    const fixes: string[] = []
    let draft = tx.draft
    for (let i = 0; ; i++) {
      step('checking')
      const run = await advanced.dryRun(draft, signer)
      const rep = report(run.diagnosis)
      if (rep.ok) {
        step('sending')
        const hash = await advanced.send(run.raw)
        step('waiting', hash)
        const done = { ...rep, hash, fixes, tx: { draft, payGas: tx.payGas } }
        try {
          await advanced.waitForInclusion(hash, { timeoutMs: opts.timeoutMs ?? 120_000 })
          step('done', 'included')
          // Report on the real outcome: an included tx can still have a failed frame (and the payer was charged).
          const landed = report(await advanced.explain(hash))
          return { ...done, ...landed, status: landed.ok ? 'included' : 'failed' }
        } catch (e) {
          if (e instanceof TxNotIncluded) { step('done', e.stage); return { ...done, ...(e.diagnosis ? report(e.diagnosis) : {}), hash, fixes, tx: done.tx, ok: false, status: e.stage as SendResult['status'] } }
          if (e instanceof WaitTimeout) { step('done', 'timeout'); return { ...done, ok: false, summary: `Sent, but not included within ${Math.round((opts.timeoutMs ?? 120_000) / 1000)} s. Follow it with readmit.follow(hash).`, status: 'timeout' } }
          throw e
        }
      }
      const f = run.diagnosis.findings.find((x) => x.tone === 'fail' && x.patch)
      const fixable = f?.patch && (f.patch.kind === 'gas' || pm)
      if (!f || !fixable || i >= 3) return { ...rep, status: 'blocked', fixes, tx: { draft, payGas: tx.payGas } }
      const before = draft
      draft = await applyPatch(draft, f.patch!, { requote: pm?.requote })
      const note = f.patch!.kind === 'gas' ? `frame ${f.patch!.frame} gas ${before.frames[f.patch!.frame].gas.toLocaleString()} → ${draft.frames[f.patch!.frame].gas.toLocaleString()}` : 'fee re-quoted at the current price'
      fixes.push(note)
      step('fixing', note)
    }
  }

  /** Follow a sent transaction: calls back on every status change. Returns a function that stops following. */
  const follow = (hash: Hex, onStatus: (s: Stage) => void) => advanced.watch(hash, onStatus)

  /** 4. What is the mempool rejecting right now? Share rejected, senders, top reasons, and the latest decisions. */
  async function mempool(opts: { last?: number; node?: 'gateway' | 'miner' } = {}) {
    const rows = await advanced.recent(opts.last ?? 200, opts.node)
    const { rejectionStats } = await import('./monitor.ts')
    const s = rejectionStats(rows)
    const row = (r: (typeof rows)[number]) => ({ hash: r.txHash as Hex, outcome: r.outcome, reason: r.checks.find((c) => c.verdict === 'fail')?.detail ?? r.checks.find((c) => c.verdict === 'fail')?.rule ?? null })
    return {
      summary: `${s.rejected} of the last ${s.total} transactions were rejected, from ${s.senders} sender${s.senders === 1 ? '' : 's'}, over ${Math.max(1, Math.round(s.spanMs / 60_000))} min.`,
      rejected: s.rejected,
      total: s.total,
      senders: s.senders,
      topReasons: s.topRules.map(([rule, count]) => ({ rule, count })),
      /** The newest 20 decisions of any kind. */
      latest: rows.slice(0, 20).map(row),
      /** The newest 20 rejections: pass any `hash` to `why()`. */
      rejections: rows.filter((r) => r.outcome === 'rejected').slice(0, 20).map(row),
    }
  }

  return { why, prepare, check, send, follow, mempool, contracts: DEVNET_CONTRACTS, advanced }
}
export type ReadmitConnection = ReturnType<typeof connect>
