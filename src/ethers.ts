// ethers v6 integration: `createReadmit({ ethrex: ethersTransport(provider), ... })` and `ethersSigner(wallet)`.
// Structural types only, so ethers is an optional peer and never imported at runtime.
import { concat, numberToHex, type Hex } from 'viem'
import type { Transport } from './client.ts'
import type { Signer } from './frames.ts'

/** Anything with ethers' `send(method, params)`: `JsonRpcProvider`, `BrowserProvider`, `WebSocketProvider`. */
export type EthersProvider = { send: (method: string, params: any[]) => Promise<any> }
/** An ethers `SigningKey`. */
export type EthersSigningKey = { sign: (digest: string) => { yParity: 0 | 1; r: string; s: string } }

/** Routes Readmit's JSON-RPC calls through an ethers provider (for `ethrex`, `miner` or `gateway`). */
export const ethersTransport = (provider: EthersProvider): Transport => (method, params) => provider.send(method, params ?? [])

/**
 * Signs the frame tx's signing hash with an ethers `Wallet` (or its `SigningKey`). It signs the raw hash: no EIP-191
 * prefix, which is what the default ECDSA VERIFY code checks. `wallet.signMessage` would add the prefix and fail.
 */
export function ethersSigner(wallet: { signingKey: EthersSigningKey } | EthersSigningKey): Signer {
  const key = 'signingKey' in wallet ? wallet.signingKey : wallet
  return {
    signHash: async (hash) => {
      const s = key.sign(hash)
      return concat([numberToHex(s.yParity, { size: 1 }), s.r as Hex, s.s as Hex])
    },
  }
}
