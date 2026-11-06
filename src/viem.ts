// viem integration: `publicClient.extend(frameActions({ miner }))` adds frame-tx actions that use the client's own
// transport for ethrex and your sidecar URLs for the alt mempool.
import type { Client } from 'viem'
import { createReadmit, type ReadmitConfig } from './client.ts'
import type { Draft, Signer } from './frames.ts'

export function frameActions(sidecars: Omit<ReadmitConfig, 'ethrex' | 'chainId'> & { chainId?: number }) {
  return (client: Client) => {
    const chainId = sidecars.chainId ?? client.chain?.id
    if (chainId == null) throw new Error('frameActions: the client has no chain; pass chainId')
    const r = createReadmit({ ...sidecars, chainId, ethrex: (method, params) => client.request({ method, params } as any) as Promise<any> })
    return {
      readmit: r,
      buildFrameTransaction: r.buildFrameTx,
      simulateFrameTransaction: (raw: `0x${string}`, opts?: { trace?: boolean }) => r.simulate(raw, opts),
      dryRunFrameTransaction: (draft: Draft, signer: Signer) => r.dryRun(draft, signer),
      sendFrameTransaction: (raw: `0x${string}`) => r.send(raw),
      sendFrameDraft: (draft: Draft, signer: Signer) => r.sendDraft(draft, signer),
      waitForFrameTransaction: (hash: `0x${string}`) => r.waitForInclusion(hash),
      explainFrameTransaction: (hash: `0x${string}`) => r.explain(hash),
    }
  }
}
