// createReadmit(config): one object with every network-facing feature, bound to your endpoints and chain.
import { toWire } from '@forshtat/hegota-support/rpc'
import { decodeTx, encodeTx, type FrameTx } from '@forshtat/hegota-support/tx'
import { toHex, type Address, type Hex } from 'viem'
import { diagnose, diagnoseDraft, type Diagnosis, type Receipt, type Simulation, type TxResult } from './diagnose.ts'
import { DryRunFailed, RpcError, TxNotIncluded, WaitTimeout } from './errors.ts'
import { DEFAULT_PROFILE, MODE, applyPatch, checkNonceKeys, draftFrames, nonceSlot, signDraft, type Draft, type FrameSpec, type Profile, type Signer } from './frames.ts'
import { FINAL_STAGES, rejectionStats, txStage, type AdmissionRow, type Stage } from './monitor.ts'

/** A JSON-RPC transport: a URL, or your own function (e.g. a viem client's `request`). */
export type Transport = string | ((method: string, params: unknown[]) => Promise<any>)
export type NodeName = 'gateway' | 'miner'

export type ReadmitConfig = {
  /** ethrex execution RPC: reads, dry runs, receipts, nonce and fees. */
  ethrex: Transport
  /** Alt-mempool sidecars (ERC-8421). At least one. */
  gateway?: Transport
  miner?: Transport
  chainId: number
  /** Where `send`, `watch` and `explain` go first. Defaults to `miner` if set, else `gateway`. */
  defaultNode?: NodeName
  /** Codec profile (hegota-support). Defaults to `ethrex-eip8141-tracer`. */
  profile?: Profile
  /** Floor for maxFeePerGas when the devnet's gas price is near zero. Default 2 gwei. */
  minMaxFeePerGas?: bigint
}

/** The public EF alt-mempool devnet (Mumbai, Nov 2026). */
export const ALT_MEMPOOL_DEVNET = {
  ethrex: 'https://altmempool.forshtat.com',
  gateway: 'https://altmempoolgateway.forshtat.com/rpc',
  miner: 'https://altmempool.forshtat.com/rpc',
  chainId: 1337,
} as const satisfies ReadmitConfig

export type WatchOptions = {
  node?: NodeName
  /** Poll every this many ms for the first 30 s (default 2000), then back off. */
  intervalMs?: number
  /** Longest gap between polls once backing off (default 8000, never below `intervalMs`). */
  maxIntervalMs?: number
  timeoutMs?: number
  /** Abort to stop polling: `watch` stops quietly, `waitForInclusion` rejects with an AbortError. */
  signal?: AbortSignal
}

/** After this long at the base interval, polling backs off. */
export const BACKOFF_AFTER_MS = 30_000
/** The next poll gap: the base interval for the first 30 s, then doubling up to `maxMs`. Pure, so it can be tested. */
export const nextPollDelay = (current: number, elapsedMs: number, baseMs: number, maxMs = 8000): number =>
  elapsedMs < BACKOFF_AFTER_MS ? baseMs : Math.min(Math.max(maxMs, baseMs), current * 2)

const abortError = (signal: AbortSignal): Error =>
  signal.reason instanceof Error ? signal.reason : Object.assign(new Error('The wait was aborted'), { name: 'AbortError' })

export function createReadmit(config: ReadmitConfig) {
  const profile = config.profile ?? DEFAULT_PROFILE
  const nodes: Partial<Record<NodeName, Transport>> = { gateway: config.gateway, miner: config.miner }
  const defaultNode: NodeName = config.defaultNode ?? (config.miner ? 'miner' : 'gateway')
  if (!nodes[defaultNode]) throw new Error('createReadmit: set `miner` or `gateway`')
  const otherNode = (n: NodeName): NodeName | null => { const o = n === 'miner' ? 'gateway' : 'miner'; return nodes[o] ? o : null }

  async function call<T>(t: Transport, method: string, params: unknown[] = []): Promise<T> {
    if (typeof t === 'function') return t(method, params)
    let res: Response
    try {
      res = await fetch(t, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
    } catch (e) {
      throw new RpcError(t, method, (e as Error).message)
    }
    if (!res.ok) throw new RpcError(t, method, `HTTP ${res.status}`)
    const json = await res.json()
    if (json.error) throw new RpcError(t, method, json.error.message, json.error.code)
    return json.result as T
  }
  const node = (n: NodeName = defaultNode) => {
    const t = nodes[n]
    if (!t) throw new Error(`No ${n} endpoint configured`)
    return t
  }
  const eth = <T>(method: string, params: unknown[] = []) => call<T>(config.ethrex, method, params)

  // --- Node access -------------------------------------------------------------------------------------------
  /** The sidecar's record: mempool status plus the admission report (every rule it ran). null if it never saw the hash. */
  const getTx = (hash: Hex, n?: NodeName) => call<TxResult | null>(node(n), 'skandha_explorer_getTransaction', [hash])
  /** The ethrex receipt with per-frame status and gas. null until included. */
  const getReceipt = (hash: Hex) => eth<Receipt | null>('eth_getTransactionReceipt', [hash])
  /** Dry run on ethrex: nothing is broadcast. `trace` adds the ERC-7562 access trace (needed for the fragility check). */
  const simulate = (raw: Hex, opts: { trace?: boolean; block?: string } = {}) =>
    eth<Simulation>('ethrex_simulateFrameTransaction', [raw, opts.block ?? 'latest', { trace: opts.trace ?? false }])
  /** Broadcasts signed bytes to a sidecar (`eth_sendFrameTransaction`). Returns the tx hash. */
  const send = (raw: Hex, n?: NodeName) => call<Hex>(node(n), 'eth_sendFrameTransaction', [toWire(decodeTx(profile, raw))])

  /** Fetch + diagnose in one call. Tries the default node, then the other one. Throws if neither node knows the hash. */
  async function explain(hash: Hex, n: NodeName = defaultNode): Promise<Diagnosis & { node: NodeName }> {
    for (const which of [n, otherNode(n)].filter(Boolean) as NodeName[]) {
      const tx = await getTx(hash, which)
      if (tx) return { ...diagnose(tx, await getReceipt(hash)), node: which }
    }
    throw new Error(`No configured node has a record of ${hash} (sidecars keep history in memory)`)
  }

  // --- Tracking ----------------------------------------------------------------------------------------------
  const stage = async (hash: Hex, n?: NodeName): Promise<Stage> => txStage(await getTx(hash, n))

  /** Calls `onUpdate` on every stage change until a final stage or the timeout. Returns a stop function. */
  function watch(hash: Hex, onUpdate: (s: Stage) => void, opts: WatchOptions = {}): () => void {
    const { node: n, intervalMs = 2000, maxIntervalMs = 8000, timeoutMs = 120_000, signal } = opts
    let last: Stage | null = null
    let stopped = false
    let delay = intervalMs
    let timer: ReturnType<typeof setTimeout> | undefined
    const started = Date.now()
    const stop = () => { stopped = true; clearTimeout(timer); signal?.removeEventListener('abort', stop) }
    const tick = async () => {
      if (stopped) return
      const s = await stage(hash, n).catch(() => last ?? 'pending')
      if (stopped) return // aborted while the request was in flight
      if (s !== last) onUpdate((last = s))
      if (FINAL_STAGES.includes(s) || Date.now() - started > timeoutMs) return stop()
      delay = nextPollDelay(delay, Date.now() - started, intervalMs, maxIntervalMs)
      timer = setTimeout(tick, delay)
    }
    if (signal?.aborted) return () => {}
    signal?.addEventListener('abort', stop, { once: true })
    void tick()
    return stop
  }

  /** Resolves with the receipt once included. Rejects with TxNotIncluded (rejected / failed / dropped, with a diagnosis) or WaitTimeout. */
  function waitForInclusion(hash: Hex, opts: WatchOptions = {}): Promise<Receipt> {
    const timeoutMs = opts.timeoutMs ?? 120_000
    const { signal } = opts
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(abortError(signal))
      let last: Stage | null = null
      const onAbort = () => { clearTimeout(timer); stop(); reject(abortError(signal!)) }
      const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); stop(); reject(new WaitTimeout(hash, last, timeoutMs)) }, timeoutMs)
      signal?.addEventListener('abort', onAbort, { once: true })
      const stop = watch(hash, async (s) => {
        last = s
        if (!FINAL_STAGES.includes(s)) return
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        try {
          if (s === 'included') {
            // The sidecar can report OnChain a moment before ethrex serves the receipt.
            for (let i = 0; i < 10; i++) {
              const r = await getReceipt(hash)
              if (r) return resolve(r)
              if (signal?.aborted) return reject(abortError(signal))
              await new Promise((ok) => setTimeout(ok, 1000))
            }
            return reject(new WaitTimeout(hash, s, timeoutMs))
          }
          const tx = await getTx(hash, opts.node)
          reject(new TxNotIncluded(hash, s, tx ? diagnose(tx, await getReceipt(hash)) : null))
        } catch (e) {
          reject(e)
        }
      }, { ...opts, signal: undefined, timeoutMs: timeoutMs + 1000 })
    })
  }

  // --- Monitoring --------------------------------------------------------------------------------------------
  /** The sidecar's latest admission decisions (newest first). */
  const recent = async (limit = 60, n?: NodeName): Promise<AdmissionRow[]> =>
    (await call<{ items: AdmissionRow[] }>(node(n), 'skandha_explorer_listAdmissions', [{ limit }])).items
  /** `recent()` summarised: how many were rejected, by how many senders, and the top rules. */
  const stats = async (limit = 200, n?: NodeName) => rejectionStats(await recent(limit, n))

  // --- Building and sending ----------------------------------------------------------------------------------
  /** Fills nonce and fees from the node. Pass any frames (see verifyFrame / senderFrame). */
  /**
   * The sequence the next tx on these keys must use. NONCE_MANAGER has no getter (every call to it reverts), so this
   * reads the storage slot directly. An unused key reads 0. Keys of one tx share one sequence, so they must agree.
   */
  async function keyedNonce(sender: Address, keys: bigint[]): Promise<bigint> {
    const manager = profile.predeploys.NONCE_MANAGER
    if (!manager) throw new Error('This profile has no NONCE_MANAGER predeploy, so keyed nonces are not available')
    const seqs = await Promise.all(keys.map((k) => eth<string>('eth_getStorageAt', [manager, nonceSlot(sender, k), 'latest']).then(BigInt)))
    if (seqs.some((s) => s !== seqs[0])) throw new Error(`nonceKeys are at different sequences (${seqs.join(', ')}); a tx uses one shared sequence, so pick keys that are in step`)
    return seqs[0] ?? 0n
  }

  async function buildFrameTx(p: { sender: Address; frames: FrameSpec[]; nonce?: bigint; nonceKeys?: bigint[]; recentRootReferences?: Draft['recentRootReferences']; maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint }): Promise<Draft> {
    const keyed = p.nonceKeys && !(p.nonceKeys.length === 1 && p.nonceKeys[0] === 0n)
    if (p.nonceKeys) checkNonceKeys(p.nonceKeys)
    const [nonce, gasPrice] = await Promise.all([
      p.nonce ?? (keyed ? keyedNonce(p.sender, p.nonceKeys!) : eth<string>('eth_getTransactionCount', [p.sender, 'pending']).then(BigInt)),
      p.maxFeePerGas ? Promise.resolve(0n) : eth<string>('eth_gasPrice').then(BigInt),
    ])
    const floor = config.minMaxFeePerGas ?? 2_000_000_000n
    const maxFeePerGas = p.maxFeePerGas ?? (gasPrice * 2n > floor ? gasPrice * 2n : floor)
    return {
      sender: p.sender, nonce, frames: p.frames, maxFeePerGas, maxPriorityFeePerGas: p.maxPriorityFeePerGas ?? maxFeePerGas / 2n,
      ...(p.nonceKeys ? { nonceKeys: p.nonceKeys } : {}), ...(p.recentRootReferences ? { recentRootReferences: p.recentRootReferences } : {}),
    }
  }
  const sign = (d: Draft, signer: Signer) => signDraft(d, signer, config.chainId, profile)

  /** Sign → simulate (with trace) → diagnose. Nothing is broadcast. `ok` is false if any finding is a failure. */
  async function dryRun(d: Draft, signer: Signer) {
    const raw = await sign(d, signer)
    const simulation = await simulate(raw, { trace: true })
    const diagnosis = diagnoseDraft(draftFrames(d), simulation, { sender: d.sender })
    return { raw, simulation, diagnosis, ok: !diagnosis.findings.some((f) => f.tone === 'fail') }
  }

  /**
   * Sets each frame's gas limit from a real simulation, so you don't guess. SENDER frames are first simulated with a
   * generous limit (`probeGas`, default 500k); every frame then gets `used × 1.25` rounded up to 1,000 (the fix rule).
   * VERIFY frames together are kept within the sidecar's 100,000 budget (a warning says when that bites). Signing covers
   * the limits, so it signs, simulates and re-signs. Pass `requote` for a paymaster whose fee depends on the limits.
   * Nothing is broadcast. `ok` is false if the confirming simulation still fails (the warnings say why).
   */
  async function estimate(d: Draft, signer: Signer, opts: { probeGas?: bigint; verifyBudget?: bigint; requote?: (d: Draft) => Promise<Draft> } = {}) {
    const probeGas = opts.probeGas ?? 500_000n
    const budget = opts.verifyBudget ?? 100_000n
    const warnings: string[] = []
    const probe: Draft = { ...d, frames: d.frames.map((f) => (f.mode === MODE.SENDER && f.gas < probeGas ? { ...f, gas: probeGas } : f)) }
    const first = await simulate(await sign(probe, signer))
    if (!first.frames) throw new Error(`estimate: the node could not run the transaction (${first.executionError ?? first.canonicalMempoolViolation ?? 'no frame data'}); fix that first (run dryRun for a diagnosis)`)
    const usedAt = (i: number) => BigInt(first.frames![i]?.gasUsed ?? '0x0')
    const want = probe.frames.map((_, i) => {
      const g = ((usedAt(i) * 125n + 99n) / 100n + 999n) / 1000n * 1000n
      return g === 0n ? 1000n : g
    })
    // VERIFY frames share one budget. If 1.25x on each would exceed it, keep what each used and share the spare room
    // in proportion to the headroom each one asked for (rounded down to 1,000, so the sum stays inside).
    const vi = probe.frames.flatMap((f, i) => (f.mode === MODE.VERIFY ? [i] : []))
    const wantSum = vi.reduce((s, i) => s + want[i]!, 0n)
    const usedSum = vi.reduce((s, i) => s + usedAt(i), 0n)
    const gas = [...want]
    if (wantSum > budget) {
      if (usedSum >= budget) {
        vi.forEach((i) => { gas[i] = usedAt(i) })
        warnings.push(`the VERIFY frames use ${usedSum} gas, at or over the ${budget} validation budget, so there is no headroom to add and the sidecar may reject this`)
      } else {
        const spare = budget - usedSum
        const asked = wantSum - usedSum
        vi.forEach((i) => { gas[i] = usedAt(i) + ((want[i]! - usedAt(i)) * spare / asked) / 1000n * 1000n })
        warnings.push(`VERIFY limits were trimmed to share the ${budget} validation budget, so they have less than the usual 25% headroom`)
      }
    }
    const frames = probe.frames.map((f, i) => ({ ...f, gas: gas[i]! }))
    let draft: Draft = { ...d, frames }
    if (opts.requote) draft = await opts.requote(draft)
    const simulation = await simulate(await sign(draft, signer))
    const failed = (simulation.frames ?? []).findIndex((f) => !f.succeeded)
    if (!simulation.frames) warnings.push(`the confirming simulation did not run: ${simulation.executionError ?? 'no frame data'}`)
    else if (failed >= 0) warnings.push(`frame ${failed} still fails with the new limits; run dryRun for a diagnosis`)
    return { draft, simulation, warnings, ok: !!simulation.frames && failed < 0 }
  }

  /**
   * Dry run, apply the suggested fix if there is one and run again (up to `maxFixes` times), then send.
   * Throws DryRunFailed when a problem remains that has no automatic fix. Returns the hash and the final draft.
   */
  async function sendDraft(d: Draft, signer: Signer, opts: { node?: NodeName; maxFixes?: number; requote?: (d: Draft) => Promise<Draft> } = {}) {
    let draft = d
    for (let i = 0; ; i++) {
      const run = await dryRun(draft, signer)
      if (run.ok) return { hash: await send(run.raw, opts.node), draft, diagnosis: run.diagnosis, raw: run.raw }
      const patch = run.diagnosis.findings.find((f) => f.tone === 'fail' && f.patch)?.patch
      if (!patch || i >= (opts.maxFixes ?? 2) || (patch.kind === 'requote' && !opts.requote)) throw new DryRunFailed(run.diagnosis)
      draft = await applyPatch(draft, patch, { requote: opts.requote })
    }
  }

  /** Why an on-chain failure reverted: replays it on its parent block. null once ethrex has pruned that state (~128 blocks). */
  async function replay(hash: Hex): Promise<Simulation | null> {
    const t = await eth<any>('eth_getTransactionByHash', [hash])
    if (!t?.blockNumber) return null
    const B = (x: string) => BigInt(x)
    const tx: FrameTx = {
      chainId: B(t.chainId), nonceKeys: t.nonceKeys.map(B), nonceSeq: B(t.nonceSeq), sender: t.sender,
      frames: t.frames.map((f: any) => ({ mode: Number(f.mode), flags: Number(f.flags), target: f.to, limits: { execution: B(f.gasLimit), state: B(f.stateLimit) }, value: B(f.value), data: f.data })),
      signatures: t.signatures.map((s: any) => ({ scheme: Number(s.scheme), signer: s.signer ?? '0x', msg: s.msg, signature: s.signature })),
      fees: { maxPriorityFeePerGas: B(t.maxPriorityFeePerGas), maxFeePerGas: B(t.maxFeePerGas), maxFeePerBlobGas: B(t.maxFeePerBlobGas ?? '0x0') },
      blobVersionedHashes: t.blobVersionedHashes ?? [], recentRootReferences: t.recentRootReferences ?? [],
    }
    try {
      return await simulate(encodeTx(profile, tx), { block: toHex(Number(t.blockNumber) - 1) })
    } catch (e) {
      if (/state root missing/.test(String(e))) return null
      throw e
    }
  }

  return {
    config: { ...config, profile, defaultNode },
    /** Raw JSON-RPC to ethrex, for anything not wrapped here. */
    request: eth,
    getTx, getReceipt, simulate, send, explain,
    stage, watch, waitForInclusion,
    recent, stats,
    buildFrameTx, keyedNonce, sign, estimate, dryRun, sendDraft, replay,
  }
}
export type Readmit = ReturnType<typeof createReadmit>
