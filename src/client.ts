// createReadmit(config): one object with every network-facing feature, bound to your endpoints and chain.
import { toWire } from '@forshtat/hegota-support/rpc'
import { decodeTx, encodeTx, type FrameTx } from '@forshtat/hegota-support/tx'
import { toHex, type Address, type Hex } from 'viem'
import { diagnose, diagnoseDraft, type Diagnosis, type Receipt, type Simulation, type TxResult } from './diagnose.ts'
import { DryRunFailed, RpcError, TxNotIncluded, WaitTimeout } from './errors.ts'
import { DEFAULT_PROFILE, applyPatch, draftFrames, signDraft, type Draft, type FrameSpec, type Profile, type Signer } from './frames.ts'
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

export type WatchOptions = { node?: NodeName; intervalMs?: number; timeoutMs?: number }

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
    const { node: n, intervalMs = 2000, timeoutMs = 120_000 } = opts
    let last: Stage | null = null
    let stopped = false
    const started = Date.now()
    const tick = async () => {
      if (stopped) return
      const s = await stage(hash, n).catch(() => last ?? 'pending')
      if (s !== last) onUpdate((last = s))
      if (FINAL_STAGES.includes(s) || Date.now() - started > timeoutMs) stopped = true
      else setTimeout(tick, intervalMs)
    }
    void tick()
    return () => { stopped = true }
  }

  /** Resolves with the receipt once included. Rejects with TxNotIncluded (rejected / failed / dropped, with a diagnosis) or WaitTimeout. */
  function waitForInclusion(hash: Hex, opts: WatchOptions = {}): Promise<Receipt> {
    const timeoutMs = opts.timeoutMs ?? 120_000
    return new Promise((resolve, reject) => {
      let last: Stage | null = null
      const timer = setTimeout(() => { stop(); reject(new WaitTimeout(hash, last, timeoutMs)) }, timeoutMs)
      const stop = watch(hash, async (s) => {
        last = s
        if (!FINAL_STAGES.includes(s)) return
        clearTimeout(timer)
        try {
          if (s === 'included') {
            // The sidecar can report OnChain a moment before ethrex serves the receipt.
            for (let i = 0; i < 10; i++) { const r = await getReceipt(hash); if (r) return resolve(r); await new Promise((ok) => setTimeout(ok, 1000)) }
            return reject(new WaitTimeout(hash, s, timeoutMs))
          }
          const tx = await getTx(hash, opts.node)
          reject(new TxNotIncluded(hash, s, tx ? diagnose(tx, await getReceipt(hash)) : null))
        } catch (e) {
          reject(e)
        }
      }, { ...opts, timeoutMs: timeoutMs + 1000 })
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
  async function buildFrameTx(p: { sender: Address; frames: FrameSpec[]; nonce?: bigint; maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint }): Promise<Draft> {
    const [nonce, gasPrice] = await Promise.all([
      p.nonce ?? eth<string>('eth_getTransactionCount', [p.sender, 'pending']).then(BigInt),
      p.maxFeePerGas ? Promise.resolve(0n) : eth<string>('eth_gasPrice').then(BigInt),
    ])
    const floor = config.minMaxFeePerGas ?? 2_000_000_000n
    const maxFeePerGas = p.maxFeePerGas ?? (gasPrice * 2n > floor ? gasPrice * 2n : floor)
    return { sender: p.sender, nonce, frames: p.frames, maxFeePerGas, maxPriorityFeePerGas: p.maxPriorityFeePerGas ?? maxFeePerGas / 2n }
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
    buildFrameTx, sign, dryRun, sendDraft, replay,
  }
}
export type Readmit = ReturnType<typeof createReadmit>
