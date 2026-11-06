// Synced from the Readmit app (github.com/manjeetsharma0796/readmit, src/diagnose.ts at 916375d).
// Fix diagnosis bugs in both places until the app depends on this package.
// Pure diagnosis engine: sidecar admission report + ethrex receipt -> findings and three verdicts.
// No network here, so it can be checked offline (see diagnose.check.ts).
import { keccak256, type Hex } from 'viem'

export type Frame = {
  mode: number
  flags: number
  target: string | null
  limits: { execution: string; state: string }
  value: string
  data: string
}
export type Check = { rule: string; verdict: 'pass' | 'fail' | 'skipped'; detail?: string; frameIndex?: number; entity?: string }
export type Admission = { outcome: string; checks: Check[]; frames?: Frame[]; frameStatuses?: string[]; errorCode?: number; at?: number; sender?: string; nonce?: string }
export type TxResult = { hash: string; entry: null | { status: string; payer?: string; sender?: string; revertReason?: string; tx: { frames: Frame[] } }; admission: Admission | null; events?: unknown[] }
export type FrameReceipt = { status: string; gasUsed: string; stateGasUsed: string; logs: unknown[] }
export type Receipt = { status: string; gasUsed: string; effectiveGasPrice: string; blockNumber: string; payer?: string; frameReceipts: FrameReceipt[] }

export type Tone = 'pass' | 'fail' | 'warn' | 'info'
/** A fix the app can apply by itself (Fix & send): set one frame's gas limit, or re-quote the tUSD fee from the pool. */
export type Patch = { kind: 'gas'; frame: number; gas: number } | { kind: 'requote' }
/** Stable ids for findings. Titles are prose and may be reworded; codes are never renamed (new ones may be added). */
export const FINDING_CODES = [
  'FRAME_OUT_OF_GAS', 'FRAME_REVERTED', 'FRAME_SKIPPED', 'VALIDATION_GAS_OVERDECLARED',
  'VALIDATION_GAS_OVER_CAP', 'VALIDATION_STATE_GAS_OVER_CAP', 'VALIDATION_OUT_OF_GAS', 'VALIDATION_REVERTED', 'BAD_SIGNATURE',
  'UNSTAKED_STORAGE_READ', 'BANNED_OPCODE', 'PAYER_CANNOT_COVER', 'NONCE_MISMATCH', 'REPLACEMENT_FEE_TOO_LOW', 'ALREADY_KNOWN', 'UNKNOWN_RULE',
  'PAYMASTER_UNDERPAID', 'PAYMASTER_SENDER_LACKS_TOKEN', 'PAYMASTER_FEE_FRAME_INVALID',
  'SHARED_STATE_READ', 'PAYER_CHARGED_ON_FAILURE', 'READY', 'NOTHING_TO_FIX',
] as const
export type FindingCode = (typeof FINDING_CODES)[number]
export type Finding = { code: FindingCode; tone: Tone; frame?: number; title: string; why: string; fix?: string; selector?: string; patch?: Patch }
export type Verdict = { tone: Tone; headline: string; sub: string }
export type Diagnosis = { frames: Frame[]; findings: Finding[]; mempool: Verdict; chain: Verdict; spec: Verdict }

// Numbers from the sidecar's own error text and the ERC-8421 draft budget rule.
const SIDECAR_VERIFY_CAP = 100_000
const ERC8421_STAKED_CAP = 1_000_000
// A failed frame that used at least this share of its limit is treated as out of gas; below it, a logic revert.
const OOG_SHARE = 0.98
// BadSignature(): the default ECDSA VERIFY code's revert when the signature doesn't recover to the sender.
const BAD_SIGNATURE = '0x5cd5d233'

export const n = (hex?: string | null) => (hex ? Number(BigInt(hex)) : 0)
export const fmt = (x: number) => x.toLocaleString('en-US')
const roundUp = (x: number, step = 1000) => Math.ceil(x / step) * step

export function role(f: Frame): string {
  if (f.mode === 1) {
    const exec = (f.flags & 2) !== 0
    const pay = (f.flags & 1) !== 0
    if (exec && pay) return 'Approves execution and payment'
    if (exec) return 'Approves execution'
    if (pay) return 'Approves payment'
    return 'Verification'
  }
  if (f.mode === 2) return 'User operation'
  return 'Default call'
}
export const isVerify = (f: Frame) => f.mode === 1

/** Decodes Solidity's Error(string) revert data (selector 0x08c379a0). Returns null for anything else. */
export function errorString(data?: string | null): string | null {
  if (!data || !data.startsWith('0x08c379a0') || data.length < 10 + 128) return null
  const len = parseInt(data.slice(10 + 64, 10 + 128), 16)
  const hex = data.slice(10 + 128, 10 + 128 + len * 2)
  try { return decodeURIComponent(hex.replace(/../g, '%$&')) } catch { return null }
}

/** Our V4PricedPaymaster's require() messages, in plain words, with the fix the app can apply. */
function paymasterReason(reason: string, i: number, w: boolean): Pick<Finding, 'code' | 'title' | 'why' | 'fix' | 'patch'> | null {
  if (reason === 'underpaid')
    return {
      code: 'PAYMASTER_UNDERPAID',
      title: "The tUSD fee is below the paymaster's price",
      why: `The paymaster prices gas from the Uniswap v4 pool while it validates. The fee in frame ${i + 1} is lower than its quote right now, usually because the pool price moved after the transaction was signed.`,
      fix: 'Re-quote the fee from the pool and re-sign. Fix & send does this for you.',
      patch: { kind: 'requote' },
    }
  if (reason === 'sender lacks TOKEN')
    return { code: 'PAYMASTER_SENDER_LACKS_TOKEN', title: "The sender doesn't hold enough tUSD for the fee", why: `The paymaster checks the sender's tUSD balance before it agrees to pay, and the fee is more than the sender ${w ? 'has' : 'had'}.`, fix: 'Top up the sender with tUSD, or send a smaller amount.' }
  if (/^(next frame not SENDER|next frame not TOKEN|not transfer\(\)|not to paymaster)$/.test(reason))
    return { code: 'PAYMASTER_FEE_FRAME_INVALID', title: "The paymaster's fee frame is missing or wrong", why: `The paymaster only pays if the frame right after it (frame ${i + 1}) is a SENDER frame calling tUSD.transfer(paymaster, fee). It said: "${reason}".`, fix: `Put tUSD.transfer(paymaster, fee) directly after frame ${i}.` }
  return null
}

type ExecResult = { status: string; gasUsed: string }

/** Per-frame execution findings. 'did' reads a receipt (it happened); 'would' reads a dry run (it will happen if sent). */
function execFindings(frames: Frame[], results: ExecResult[], tense: 'did' | 'would'): Finding[] {
  const out: Finding[] = []
  const w = tense === 'would'
  const firstFailed = results.findIndex((r) => r.status === '0x0')
  results.forEach((fr, i) => {
    const f = frames[i]
    if (!f) return
    const used = n(fr.gasUsed)
    const limit = n(f.limits.execution)
    const pct = limit > 0 ? ((used / limit) * 100).toFixed(1) : '?'
    const selector = f.data.length >= 10 ? f.data.slice(0, 10) : undefined
    if (fr.status === '0x0') {
      const oog = limit > 0 && used / limit >= OOG_SHARE
      const newLimit = fmt(roundUp(used * 1.25))
      out.push({
        code: oog ? 'FRAME_OUT_OF_GAS' : 'FRAME_REVERTED',
        tone: 'fail',
        frame: i,
        title: oog ? `Frame ${i} ${w ? 'would run' : 'ran'} out of gas` : `Frame ${i} ${w ? 'would revert' : 'reverted'} (not a gas problem)`,
        why: oog
          ? `${w ? 'In the dry run it' : 'It'} used ${fmt(used)} of its ${fmt(limit)} gas limit (${pct}%), so it ${w ? 'would hit' : 'almost certainly hit'} the limit.`
          : `${w ? 'In the dry run it' : 'It'} stopped after ${fmt(used)} of its ${fmt(limit)} gas limit (${pct}%), so it ${w ? "doesn't" : 'did not'} run out. The call itself ${w ? 'reverts' : 'reverted'}, and raising gas won't help.`,
        fix: oog
          ? w ? `Raise frame ${i}'s gas limit to about ${newLimit} before sending.` : `Re-sign with frame ${i}'s gas limit raised to about ${newLimit}.`
          : `Check the call below and the contract state it depends on (balances, allowances, the arguments).${w ? '' : ' Simulate it to see the revert reason.'}`,
        selector,
        patch: oog ? { kind: 'gas', frame: i, gas: roundUp(used * 1.25) } : undefined,
      })
    } else if (fr.status === '0x2') {
      out.push({
        code: 'FRAME_SKIPPED',
        tone: 'warn',
        frame: i,
        title: `Frame ${i} ${w ? 'would be' : 'was'} skipped`,
        why: `It ${w ? "wouldn't run" : 'never ran'}, because ${firstFailed >= 0 ? `frame ${firstFailed}` : 'another frame'} in the same atomic batch ${w ? 'fails' : 'failed'}, so the whole batch ${w ? 'is' : 'was'} rolled back.`,
        fix: firstFailed >= 0 ? `Fix frame ${firstFailed} first. This frame runs again once it succeeds.` : undefined,
        selector,
      })
    } else if (isVerify(f) && limit > SIDECAR_VERIFY_CAP && used < SIDECAR_VERIFY_CAP) {
      out.push({
        code: 'VALIDATION_GAS_OVERDECLARED',
        tone: 'warn',
        frame: i,
        title: `Frame ${i} declares far more gas than it uses`,
        why: `It declares ${fmt(limit)} but ${w ? 'uses' : 'used'} ${fmt(used)}. Declared limits count against the ${fmt(SIDECAR_VERIFY_CAP)} validation cap.`,
        fix: `${w ? 'Set' : 'Re-sign with'} a limit near ${fmt(roundUp(used * 1.25))} to stay under the cap.`,
      })
    }
  })
  return out
}

/** The response of ethrex_simulateFrameTransaction (shape from the sidecar's own types, ethrexFrameTx.ts). */
export type Simulation = {
  canonicalMempoolValid: boolean
  canonicalMempoolViolation: string | null
  prefixShape: string | null
  payer: string | null
  maxCost: string
  gasUsed: string | null
  frames: { gasUsed: string; succeeded: boolean }[] | null
  executionStatus: 'success' | 'reverted' | null
  executionError: string | null
  failedFrameIndex?: number
  haltReason?: string
  haltDetail?: string
  revertData?: string
  account?: string
  balance?: string
  required?: string
  erc7562Trace?: TraceFrame[] | null
}

/** One frame of `ethrex_simulateFrameTransaction`'s `erc7562Trace` (with `{ trace: true }`): a call tree per frame. */
export type TraceCall = {
  type: string
  from: string
  to: string
  accessedSlots?: { reads?: Record<string, string[]>; writes?: Record<string, number> }
  keccak?: string[]
  calls?: TraceCall[]
}
export type TraceFrame = { frameIndex: number; root: TraceCall }

const SLOT_MASK = (1n << 256n) - 1n
/** ERC-7562 association: slot = keccak(A || x) + n with n < 128, where A is the sender (left-padded to 32 bytes). */
function senderSlots(sender: string, preimages: string[]): Set<bigint> {
  const pad = sender.toLowerCase().replace(/^0x/, '').padStart(64, '0')
  const bases = preimages.filter((p) => p.toLowerCase().slice(2, 66) === pad).map((p) => BigInt(keccak256(p as Hex)))
  return new Set(bases.flatMap((b) => Array.from({ length: 128 }, (_, n) => (b + BigInt(n)) & SLOT_MASK)))
}

/**
 * Storage a VERIFY frame read that anyone else can change before inclusion: reads of a contract that is not the sender,
 * not the frame's own target, and not a sender-associated slot (e.g. the sender's token balance). Calls with no reads
 * (the hegota-support helper contracts) are ignored. Returns one entry per VERIFY frame that has such reads.
 */
export function sharedReads(frames: Frame[], trace: TraceFrame[], sender: string): { frame: number; contracts: string[] }[] {
  const me = sender.toLowerCase()
  const out: { frame: number; contracts: string[] }[] = []
  for (const t of trace) {
    const f = frames[t.frameIndex]
    if (!f || !isVerify(f)) continue
    const target = (f.target ?? sender).toLowerCase()
    const calls: TraceCall[] = []
    const walk = (c: TraceCall) => { calls.push(c); c.calls?.forEach(walk) }
    walk(t.root)
    const mine = senderSlots(sender, calls.flatMap((c) => c.keccak ?? []))
    const hit = new Set<string>()
    for (const c of calls) {
      const to = c.to.toLowerCase()
      if (to === me || to === target) continue
      const slots = Object.keys(c.accessedSlots?.reads ?? {})
      if (slots.some((k) => !mine.has(BigInt(k)))) hit.add(to)
    }
    if (hit.size) out.push({ frame: t.frameIndex, contracts: [...hit] })
  }
  return out
}

/**
 * Dry-run diagnosis: what would happen if this tx were sent now. Nothing is broadcast.
 * Pass `opts.sender` (and a simulation run with `{ trace: true }`, or `opts.trace`) to also flag VERIFY frames that read
 * shared, mutable storage such as a Uniswap v4 pool's slot0 (fragility: a swap can invalidate the tx before inclusion).
 */
export function diagnoseDraft(frames: Frame[], sim: Simulation, opts?: { sender: string; trace?: TraceFrame[] | null }): Diagnosis {
  const findings: Finding[] = []
  const eth = (hex?: string) => (Number(BigInt(hex ?? '0x0')) / 1e18).toFixed(6)
  const halted = !sim.frames
  if (halted && (sim.haltReason === 'insufficient_funds' || /cannot cover/.test(sim.haltDetail ?? ''))) {
    const who = sim.account ?? sim.payer
    findings.push({
      code: 'PAYER_CANNOT_COVER',
      tone: 'fail',
      title: "The payer can't cover the maximum cost",
      why: `The payer${who ? ` ${who.slice(0, 6)}…${who.slice(-4)}` : ''} has ${eth(sim.balance)} ETH, but the transaction could cost up to ${eth(sim.required ?? sim.maxCost)} ETH.`,
      fix: `Fund the payer with at least ${eth(sim.required ?? sim.maxCost)} ETH, or lower the gas limits or maxFeePerGas.`,
    })
  } else if (halted && errorString(sim.revertData) && sim.failedFrameIndex != null && paymasterReason(errorString(sim.revertData)!, sim.failedFrameIndex, true)) {
    const i = sim.failedFrameIndex
    findings.push({ tone: 'fail', frame: i, ...paymasterReason(errorString(sim.revertData)!, i, true)! })
  } else if (halted) {
    const i = sim.failedFrameIndex
    const reason = errorString(sim.revertData)
    findings.push({
      code: sim.revertData?.startsWith(BAD_SIGNATURE) ? 'BAD_SIGNATURE' : 'VALIDATION_REVERTED',
      tone: 'fail',
      frame: i,
      title: i != null ? `Frame ${i} would reject the transaction during validation` : 'The transaction would be rejected',
      why: reason ? `It reverted with "${reason}".` : sim.haltDetail ?? sim.executionError ?? sim.canonicalMempoolViolation ?? 'The simulator gave no detail.',
      fix: 'Check what this frame requires: the signature, the payment frame that must follow it, or the balances it reads.',
      selector: sim.revertData && sim.revertData.length >= 10 ? sim.revertData.slice(0, 10) : undefined,
    })
  } else {
    findings.push(...execFindings(frames, sim.frames!.map((f) => ({ status: f.succeeded ? '0x1' : '0x0', gasUsed: f.gasUsed })), 'would'))
    if (sim.executionStatus === 'reverted') {
      findings.push({
        code: 'PAYER_CHARGED_ON_FAILURE',
        tone: 'warn',
        title: 'If you send it now, the payer is still charged',
        why: `Validation passes, so the mempool would admit it, and the payer would pay for the failed execution, up to ${eth(sim.maxCost)} ETH.`,
        fix: 'Apply the fix above and run the dry run again.',
      })
    }
  }
  if (!findings.some((f) => f.tone === 'fail' || f.tone === 'warn')) {
    findings.push({ code: 'READY', tone: 'pass', title: 'Ready to send', why: 'The dry run passed: validation approves it and every frame succeeds.' })
  }
  const trace = opts?.trace ?? sim.erc7562Trace
  if (opts?.sender && trace) {
    for (const r of sharedReads(frames, trace, opts.sender)) {
      const who = r.contracts.map((c) => `${c.slice(0, 6)}…${c.slice(-4)}`).join(', ')
      findings.push({
        code: 'SHARED_STATE_READ',
        tone: 'warn',
        frame: r.frame,
        title: 'This tx depends on the pool price; a swap can invalidate it before inclusion',
        why: `VERIFY frame ${r.frame} reads storage of ${who}, which other transactions can change. If it moves before inclusion, validation can fail.`,
        fix: 'Send it soon after the dry run. If it is rejected as underpaid, re-quote and send again.',
      })
    }
  }
  const failed = sim.frames?.map((f, i) => (f.succeeded ? -1 : i)).filter((i) => i >= 0) ?? []
  const mempool: Verdict = sim.canonicalMempoolValid
    ? { tone: 'pass', headline: 'Public mempool would accept it', sub: `Validation shape: ${sim.prefixShape ?? 'unknown'}` }
    : { tone: 'info', headline: 'Public mempool would refuse it', sub: `${sim.canonicalMempoolViolation ?? 'No reason given'}. The alt mempool can still admit it.` }
  const chain: Verdict = halted
    ? { tone: 'fail', headline: "Wouldn't run", sub: sim.haltDetail ?? sim.executionError ?? 'Validation failed' }
    : sim.executionStatus === 'success'
      ? { tone: 'pass', headline: 'Would succeed', sub: `All ${sim.frames!.length} frames succeed in the dry run` }
      : { tone: 'fail', headline: 'Would fail', sub: `Frame ${failed.join(', ')} fails in the dry run` }
  const spec: Verdict = { tone: 'info', headline: 'Not checked', sub: 'Dry run: the spec check runs on the admission report after sending' }
  const order: Record<Tone, number> = { fail: 0, warn: 1, info: 2, pass: 3 }
  findings.sort((a, b) => order[a.tone] - order[b.tone])
  return { frames, findings, mempool, chain, spec }
}

export function diagnose(tx: TxResult, receipt: Receipt | null): Diagnosis {
  const adm = tx.admission
  const frames: Frame[] = tx.entry?.tx.frames ?? adm?.frames ?? []
  const findings: Finding[] = []
  const fails = (adm?.checks ?? []).filter((c) => c.verdict === 'fail')

  let spec: Verdict = { tone: 'info', headline: 'No conflict found', sub: 'Partial check: budget and validation rules only' }

  // Every number below is read from the sidecar's own detail text, never assumed, so a config change shows up as-is.
  const severity: Record<Tone, number> = { fail: 0, warn: 1, info: 2, pass: 3 }
  let specFromRule = false
  for (const c of fails) {
    const before = spec
    const d = c.detail ?? ''
    const ruleNote = ` Sidecar rule: ${c.rule}.`
    // Two wordings of the same cap, from different sidecar versions.
    const budgetOld = d.match(/gas sum (\d+) \+ signature-verification cost (\d+) = (\d+) exceeds MAX_VERIFY_GAS (\d+)/)
    const budgetNew = d.match(/prefix gas budget exceeded: (\d+) > (\d+) \(MAX_VERIFY_GAS\)/)
    const stateCap = d.match(/state gas sum (\d+) exceeds MAX_VERIFY_STATE_GAS (\d+)/)
    const payer = d.match(/the payer (0x[0-9a-fA-F]{40}) has (\d+) wei, the transaction's maximum cost is (\d+) wei/)
    const vOog = d.match(/validation frame (\d+): ran out of gas(?: \(the frame's gas limit (\d+) cannot cover its entry charge of (\d+) gas\))?/)
    const vrev = d.match(/validation frame (\d+): reverted(?: with data (0x[0-9a-fA-F]*))?/)
    const storage = d.match(/unstaked (\w+) accessed (\S+) slot (0x[0-9a-fA-F]+)/)
    const opcode = d.match(/(\w+) uses banned opcode: (\w+)/)
    const nonce = d.match(/Nonce mismatch: expected (\d+), got (\d+)/)
    if (budgetOld || budgetNew) {
      const total = Number(budgetOld ? budgetOld[3] : budgetNew![1])
      const cap = Number(budgetOld ? budgetOld[4] : budgetNew![2])
      const parts = budgetOld ? `${fmt(Number(budgetOld[1]))} gas plus ${fmt(Number(budgetOld[2]))} for the signature, ` : ''
      findings.push({
        code: 'VALIDATION_GAS_OVER_CAP',
        tone: 'fail',
        title: 'Validation gas is over the mempool cap',
        why: `The verification frames declare ${parts}${fmt(total)} in total. This sidecar caps validation at ${fmt(cap)} for every account, staked or not.${ruleNote}`,
        fix: `Lower the verification frames' gas limits so their total is under ${fmt(cap)}. Simulate first to see what they really use. Staking does not raise this sidecar's cap. If validation truly needs more (for example a post-quantum signature), this sidecar can't admit it today.`,
      })
      spec =
        total <= ERC8421_STAKED_CAP
          ? { tone: 'warn', headline: 'Admissible if staked', sub: `The spec says staked entities may use up to ${fmt(ERC8421_STAKED_CAP)}. This sidecar doesn't apply that yet.` }
          : { tone: 'fail', headline: 'Also rejected', sub: `Over the ${fmt(ERC8421_STAKED_CAP)} staked budget` }
    } else if (stateCap) {
      findings.push({
        code: 'VALIDATION_STATE_GAS_OVER_CAP',
        tone: 'fail',
        title: 'Validation state gas is over the mempool cap',
        why: `The verification frames declare ${fmt(Number(stateCap[1]))} state gas in total, over this sidecar's cap of ${fmt(Number(stateCap[2]))}.${ruleNote}`,
        fix: `Lower the state gas limits of the verification frames to ${fmt(Number(stateCap[2]))} or less in total. Validation rarely needs state gas, so 0 often works.`,
      })
    } else if (payer) {
      const cost = Number(payer[3]) / 1e18
      findings.push({
        code: 'PAYER_CANNOT_COVER',
        tone: 'fail',
        title: "The payer can't cover the maximum cost",
        why: `The payer ${payer[1].slice(0, 6)}…${payer[1].slice(-4)} has ${(Number(payer[2]) / 1e18).toFixed(6)} ETH, but the transaction could cost up to ${cost.toFixed(6)} ETH (all gas limits × maxFeePerGas).${ruleNote}`,
        fix: `Fund the payer with at least ${cost.toFixed(6)} ETH, or lower the gas limits or maxFeePerGas so the maximum cost fits its balance.`,
      })
      spec = { tone: 'info', headline: 'Same rule', sub: 'The spec also requires the payer to cover the maximum cost' }
    } else if (vOog) {
      const i = Number(vOog[1])
      findings.push({
        code: 'VALIDATION_OUT_OF_GAS',
        tone: 'fail',
        frame: i,
        title: `Frame ${i} ran out of gas during validation`,
        why: vOog[3]
          ? `Its gas limit of ${fmt(Number(vOog[2]))} doesn't even cover the ${fmt(Number(vOog[3]))} gas charged to enter the frame.${ruleNote}`
          : `The verification code used up its whole gas limit before approving.${ruleNote}`,
        fix: vOog[3]
          ? `Raise frame ${i}'s gas limit above ${fmt(Number(vOog[3]))}, plus what its code needs. Keep all verification frames under the mempool cap together.`
          : `Raise frame ${i}'s gas limit. Simulate first to see what it uses, and keep all verification frames under the mempool cap together.`,
      })
    } else if (vrev && errorString(vrev[2]) && paymasterReason(errorString(vrev[2])!, Number(vrev[1]), false)) {
      const i = Number(vrev[1])
      findings.push({ tone: 'fail', frame: i, ...paymasterReason(errorString(vrev[2])!, i, false)!, why: paymasterReason(errorString(vrev[2])!, i, false)!.why + ruleNote })
    } else if (vrev) {
      const i = Number(vrev[1])
      findings.push({
        code: vrev[2]?.startsWith(BAD_SIGNATURE) ? 'BAD_SIGNATURE' : 'VALIDATION_REVERTED',
        tone: 'fail',
        frame: i,
        title: `Frame ${i} rejected the transaction during validation`,
        why: `This frame's verification code (${frames[i] ? role(frames[i]).toLowerCase() : 'verification'}) reverted, so the account or paymaster refused to approve the transaction.${ruleNote}`,
        fix: vrev[2] && vrev[2].length >= 10
          ? 'Check the error above. A signature error usually means the transaction was signed over the wrong hash or with the wrong key.'
          : 'It reverted without an error message. Check what this frame requires: the signature, the payment frame that must follow it, or the balances it reads.',
        selector: vrev[2] && vrev[2].length >= 10 ? vrev[2].slice(0, 10) : undefined,
      })
      spec = { tone: 'fail', headline: 'Also invalid', sub: 'A revert in validation is invalid under ERC-8421 too' }
    } else if (storage) {
      const [, who, what, slot] = storage
      findings.push({
        code: 'UNSTAKED_STORAGE_READ',
        tone: 'fail',
        frame: c.frameIndex,
        title: `The ${who} read storage it isn't allowed to read unstaked`,
        why: `During validation the ${who} read ${what === who ? 'its own storage' : `${what.slice(0, 6)}…${what.slice(-4)}`} at slot ${slot.slice(0, 10)}…. Unstaked entities may only read storage tied to the sender, because other storage can change and invalidate many pending transactions at once.${ruleNote}`,
        fix: `Stake the ${who} in the alt mempool's staking registry (more than 0.01 ETH, for example 0.012, with an unstake delay), or stop reading that storage during validation.`,
      })
      spec = { tone: 'info', headline: 'Same rule', sub: 'The spec also requires stake for this access' }
    } else if (opcode) {
      const [, who, op] = opcode
      findings.push({
        code: 'BANNED_OPCODE',
        tone: 'fail',
        frame: c.frameIndex,
        title: `The ${who} uses ${op}, which validation can't use`,
        why: `${op} returns a value that can change between validation and inclusion, so the mempool can't trust the result of the check.${ruleNote}`,
        fix: `Remove ${op} from the ${who}'s validation code. Read it in an execution frame instead, if you need it.`,
      })
      spec = { tone: 'fail', headline: 'Also invalid', sub: 'The spec bans the same opcodes in validation' }
    } else if (nonce) {
      findings.push({
        code: 'NONCE_MISMATCH',
        tone: 'fail',
        title: 'Wrong nonce',
        why: `The account's next nonce is ${nonce[1]}, but the transaction uses ${nonce[2]}.${ruleNote}`,
        fix: `Re-sign with nonce ${nonce[1]}.`,
      })
      spec = { tone: 'info', headline: 'Not a spec conflict', sub: 'Nonces must be in order everywhere' }
    } else if (/cannot be replaced: fee too low/.test(d)) {
      findings.push({
        code: 'REPLACEMENT_FEE_TOO_LOW',
        tone: 'fail',
        title: 'A transaction with this nonce is already pending',
        why: `The mempool already holds a transaction from this sender with the same nonce, and this one does not pay enough more to replace it.${ruleNote}`,
        fix: 'Raise both maxFeePerGas and maxPriorityFeePerGas above the pending transaction (bump by at least 10%), or send it with the next nonce or a new nonce key.',
      })
      spec = { tone: 'info', headline: 'Not a validity rule', sub: 'Replacement pricing is mempool policy, not part of the transaction rules' }
    } else if (/already known/.test(d)) {
      findings.push({ code: 'ALREADY_KNOWN', tone: 'info', title: 'Already in the mempool', why: `This exact transaction was already submitted, so nothing new happened.${ruleNote}` })
    } else {
      // Unknown rule: show the sidecar's words as they are rather than guessing.
      findings.push({ code: 'UNKNOWN_RULE', tone: 'fail', frame: c.frameIndex, title: `Rule "${c.rule}" failed`, why: d || 'The sidecar gave no detail for this rule.' })
      spec = { tone: 'info', headline: 'Not checked', sub: `Readmit has no spec mapping for "${c.rule}" yet` }
    }
    // Several failed rules: keep the most severe spec verdict, not just the last one.
    if (specFromRule && severity[before.tone] < severity[spec.tone]) spec = before
    specFromRule = true
  }

  // Execution results from the chain.
  if (receipt) {
    const price = n(receipt.effectiveGasPrice)
    findings.push(...execFindings(frames, receipt.frameReceipts, 'did'))
    if (receipt.status === '0x0') {
      const paid = (n(receipt.gasUsed) * price) / 1e18
      const payer = receipt.payer ?? tx.entry?.payer
      const passed = adm && adm.outcome !== 'rejected'
      findings.push({
        code: 'PAYER_CHARGED_ON_FAILURE',
        tone: 'warn',
        title: passed ? 'Admitted, but it still failed, and the payer was charged' : 'It failed on chain, and the payer was still charged',
        why: `${passed ? 'Every admission rule passed, yet execution failed on chain. ' : ''}The payer${payer ? ` ${payer.slice(0, 6)}…${payer.slice(-4)}` : ''} paid ${paid.toFixed(6)} ETH for ${fmt(n(receipt.gasUsed))} gas.`,
        fix: 'Simulate the full transaction, not just validation, before sending.',
      })
    }
  }

  if (!findings.some((f) => f.tone === 'fail' || f.tone === 'warn')) {
    findings.push({ code: 'NOTHING_TO_FIX', tone: 'pass', title: 'Nothing to fix', why: receipt ? 'Admitted and included, and every frame succeeded.' : 'Every admission rule passed.' })
  }

  const outcome = adm?.outcome ?? tx.entry?.status ?? 'unknown'
  const mempool: Verdict = !adm
    ? tx.entry
      ? { tone: 'info', headline: 'No admission report', sub: 'This node saw the tx, but keeps reports in memory, so a restart cleared it' }
      : { tone: 'info', headline: 'Not seen', sub: 'This node has no admission record' }
    : outcome === 'rejected'
      ? { tone: 'fail', headline: 'Rejected', sub: fails.map((c) => c.rule).join(', ') || `error ${adm.errorCode}` }
      : outcome === 'included' || outcome === 'accepted'
        ? { tone: 'pass', headline: outcome === 'included' ? 'Admitted and included' : 'Admitted, pending', sub: `${(adm.checks ?? []).filter((c) => c.verdict === 'pass').length} checks passed` }
        : { tone: 'warn', headline: outcome[0].toUpperCase() + outcome.slice(1), sub: 'Left the mempool without being included' }

  const failedFrames = receipt?.frameReceipts.map((f, i) => (f.status === '0x0' ? i : -1)).filter((i) => i >= 0) ?? []
  const chain: Verdict = !receipt
    ? { tone: 'info', headline: 'Not on chain', sub: adm?.outcome === 'rejected' ? 'Never reached a block' : 'No receipt yet' }
    : receipt.status === '0x1'
      ? { tone: 'pass', headline: 'Executed', sub: `Block ${fmt(n(receipt.blockNumber))}, all ${receipt.frameReceipts.length} frames succeeded` }
      : { tone: 'fail', headline: 'Executed with a failure', sub: `Block ${fmt(n(receipt.blockNumber))}, frame ${failedFrames.join(', ')} failed` }

  const order: Record<Tone, number> = { fail: 0, warn: 1, info: 2, pass: 3 }
  findings.sort((a, b) => order[a.tone] - order[b.tone])
  return { frames, findings, mempool, chain, spec }
}
