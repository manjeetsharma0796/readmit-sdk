// Generic frame-transaction drafts: build, sign with any signer, patch, encode and decode. No network here.
import { profile as tracerProfile } from '@forshtat/hegota-support/profiles/ethrex-eip8141-tracer'
import { decodeTx, encodeTx, newTx, secp256k1Placeholder, sigHash, txHash, type FrameTx } from '@forshtat/hegota-support/tx'
import { concat, numberToHex, parseSignature, toHex, type Address, type Hex } from 'viem'
import { sign } from 'viem/accounts'
import type { Frame, Patch } from './diagnose.ts'

export type Profile = typeof tracerProfile
export const DEFAULT_PROFILE: Profile = tracerProfile

/** Frame modes and approval scopes of EIP-8141 (profile `frameModes`; flags bits 0-1). */
export const MODE = { DEFAULT: 0, VERIFY: 1, SENDER: 2 } as const
export const SCOPE = { NONE: 0, PAYMENT: 1, EXECUTION: 2, BOTH: 3 } as const

export type FrameSpec = {
  mode: number
  /** `null` = the sender itself. */
  target: Address | null
  gas: bigint
  stateGas: bigint
  value: bigint
  data: Hex
  /** Low bits: approval scope (SCOPE.*). */
  flags?: number
}
/** An unsigned, editable transaction: change any field, then sign again. */
export type Draft = { sender: Address; nonce: bigint; frames: FrameSpec[]; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }

type FrameInit = { target?: Address | null; gas: bigint; stateGas?: bigint; value?: bigint; data?: Hex }
/** A VERIFY frame that approves `scope` (SCOPE.EXECUTION for the sender's own check, SCOPE.PAYMENT for a paymaster). */
export const verifyFrame = (scope: number, f: FrameInit): FrameSpec => ({ mode: MODE.VERIFY, flags: scope, target: f.target ?? null, gas: f.gas, stateGas: f.stateGas ?? 0n, value: f.value ?? 0n, data: f.data ?? '0x' })
/** A SENDER frame: a call made as the sender (`target` = the contract to call). */
export const senderFrame = (f: FrameInit & { target: Address }): FrameSpec => ({ mode: MODE.SENDER, flags: 0, target: f.target, gas: f.gas, stateGas: f.stateGas ?? 0n, value: f.value ?? 0n, data: f.data ?? '0x' })

/** The chain's overhead on top of the frame limits (intrinsic + signature). Measured ~16,750 on ethrex; kept with slack. */
export const OVERHEAD = 50_000n
/** Upper bound of what the chain may charge, in wei: every frame limit plus overhead, at maxFeePerGas. */
export const maxCostBound = (d: Pick<Draft, 'frames' | 'maxFeePerGas'>) => (d.frames.reduce((s, f) => s + f.gas + f.stateGas, 0n) + OVERHEAD) * d.maxFeePerGas

/**
 * Who signs. One of:
 * - a secp256k1 private key (`0x…`, 32 bytes);
 * - a viem `LocalAccount` (anything with `sign({ hash })`, e.g. `privateKeyToAccount(...)`);
 * - `{ signHash }` for any other scheme (PQ, multisig): return the signature bytes your VERIFY code expects.
 */
export type Signer = Hex | { sign: (args: { hash: Hex }) => Promise<Hex> } | { signHash: (hash: Hex) => Promise<Hex> }

export function toFrameTx(d: Draft, chainId: number | bigint, profile: Profile = DEFAULT_PROFILE): FrameTx {
  return newTx({
    chainId,
    sender: d.sender,
    nonceSeq: d.nonce,
    fees: { maxFeePerGas: d.maxFeePerGas, maxPriorityFeePerGas: d.maxPriorityFeePerGas },
    signatures: [secp256k1Placeholder(profile)],
    frames: d.frames.map((f) => ({ mode: f.mode, flags: f.flags ?? 0, target: f.target, limits: { execution: f.gas, state: f.stateGas }, value: f.value, data: f.data })),
  })
}

/** The hash the sender's VERIFY code checks. Every frame is covered, so any change to a draft needs a new signature. */
export const signingHash = (d: Draft, chainId: number | bigint, profile: Profile = DEFAULT_PROFILE): Hex => sigHash(profile, toFrameTx(d, chainId, profile))

/** Signs a draft and returns the raw transaction bytes, ready for `simulate` or `send`. */
export async function signDraft(d: Draft, signer: Signer, chainId: number | bigint, profile: Profile = DEFAULT_PROFILE): Promise<Hex> {
  const tx = toFrameTx(d, chainId, profile)
  const hash = sigHash(profile, tx)
  let packed: Hex
  if (typeof signer === 'object' && 'signHash' in signer) packed = await signer.signHash(hash)
  else {
    const s = typeof signer === 'string' ? await sign({ hash, privateKey: signer }) : parseSignature(await signer.sign({ hash }))
    const parity = s.yParity ?? Number(s.v) - 27
    packed = concat([numberToHex(parity, { size: 1 }), s.r, s.s])
  }
  return encodeTx(profile, { ...tx, signatures: tx.signatures.map((e, i) => (i === 0 ? { ...e, signature: packed } : e)) })
}

/** The transaction hash of signed raw bytes (the hash `send` returns and the explorer shows). */
export const rawTxHash = (raw: Hex, profile: Profile = DEFAULT_PROFILE): Hex => txHash(profile, decodeTx(profile, raw))

/** Raw bytes back to an editable draft (for display, or to patch and re-sign). */
export function decodeDraft(raw: Hex, profile: Profile = DEFAULT_PROFILE): Draft {
  const t = decodeTx(profile, raw)
  return {
    sender: t.sender,
    nonce: t.nonceSeq,
    maxFeePerGas: t.fees.maxFeePerGas,
    maxPriorityFeePerGas: t.fees.maxPriorityFeePerGas,
    frames: t.frames.map((f) => ({ mode: f.mode, flags: f.flags, target: f.target, gas: f.limits.execution, stateGas: f.limits.state, value: f.value, data: f.data })),
  }
}

/** A draft's frames in the shape `diagnose` / `diagnoseDraft` read (hex quantities, like the explorer API). */
export const draftFrames = (d: Draft): Frame[] =>
  d.frames.map((f) => ({ mode: f.mode, flags: f.flags ?? 0, target: f.target, limits: { execution: toHex(f.gas), state: toHex(f.stateGas) }, value: toHex(f.value), data: f.data }))

/**
 * Applies a finding's patch. `gas` patches are generic. A `requote` patch needs your paymaster's pricing:
 * pass `requote` (the ERC-20 paymaster recipe provides one). Sign again afterwards.
 */
export async function applyPatch(d: Draft, p: Patch, opts: { requote?: (d: Draft) => Promise<Draft> } = {}): Promise<Draft> {
  if (p.kind === 'gas') return { ...d, frames: d.frames.map((f, i) => (i === p.frame ? { ...f, gas: BigInt(p.gas) } : f)) }
  if (!opts.requote) throw new Error('This fix re-quotes the paymaster fee: pass { requote } for your paymaster')
  return opts.requote(d)
}
