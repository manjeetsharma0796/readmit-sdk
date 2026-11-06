// Recipe: pay gas in an ERC-20 through a paymaster that prices it with `quote(uint256 weiCost)`, like Readmit's
// V4PricedPaymaster (Uniswap v4 slot0 + margin). Frames: sender VERIFY, paymaster VERIFY, fee transfer, your calls.
import { decodeFunctionResult, encodeFunctionData, type Address, type Hex } from 'viem'
import type { Readmit } from '../src/client.ts'
import { maxCostBound, senderFrame, verifyFrame, SCOPE, type Draft, type FrameSpec } from '../src/frames.ts'

const ERC20 = [{ type: 'function', name: 'transfer', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] }] as const
const QUOTE = [{ type: 'function', name: 'quote', stateMutability: 'view', inputs: [{ name: 'weiCost', type: 'uint256' }], outputs: [{ type: 'uint256' }] }] as const
export const transferData = (to: Address, amount: bigint) => encodeFunctionData({ abi: ERC20, functionName: 'transfer', args: [to, amount] })

/** Gas limits measured on chain 1337 (wallet VERIFY 100, paymaster VERIFY 52,848, transfers ~28k). Dry run refines them. */
export const GAS = { walletVerify: 10_000n, paymasterVerify: 70_000n, call: 60_000n, callState: 100_000n }

export function erc20Paymaster(r: Readmit, p: { token: Address; paymaster: Address }) {
  const quote = async (weiCost: bigint) =>
    decodeFunctionResult({ abi: QUOTE, functionName: 'quote', data: await r.request<Hex>('eth_call', [{ to: p.paymaster, data: encodeFunctionData({ abi: QUOTE, functionName: 'quote', args: [weiCost] }) }, 'latest']) })
  const frames = (calls: FrameSpec[], fee: bigint): FrameSpec[] => [
    verifyFrame(SCOPE.EXECUTION, { gas: GAS.walletVerify }),
    verifyFrame(SCOPE.PAYMENT, { target: p.paymaster, gas: GAS.paymasterVerify }),
    senderFrame({ target: p.token, gas: GAS.call, stateGas: GAS.callState, data: transferData(p.paymaster, fee) }), // must follow the paymaster frame
    ...calls,
  ]
  /** Re-reads the price and rewrites the fee frame (the frame right after the paymaster's VERIFY). Pass to applyPatch / sendDraft. */
  const requote = async (d: Draft): Promise<Draft> => {
    const i = d.frames.findIndex((f) => f.mode === 1 && f.target?.toLowerCase() === p.paymaster.toLowerCase())
    if (i < 0 || !d.frames[i + 1]) throw new Error('No paymaster fee frame in this draft')
    const fee = await quote(maxCostBound(d))
    return { ...d, frames: d.frames.map((f, k) => (k === i + 1 ? { ...f, data: transferData(p.paymaster, fee) } : f)) }
  }
  /** A draft whose gas is paid in `token`: your `calls` after the three paymaster frames, fee quoted live. */
  async function build(sender: Address, calls: FrameSpec[]): Promise<Draft> {
    return requote(await r.buildFrameTx({ sender, frames: frames(calls, 0n) }))
  }
  /** Convenience: send `amount` of the token to `to`, gas paid in the token. */
  const transfer = (sender: Address, to: Address, amount: bigint) =>
    build(sender, [senderFrame({ target: p.token, gas: GAS.call, stateGas: GAS.callState, data: transferData(to, amount) })])
  return { quote, requote, build, transfer }
}
