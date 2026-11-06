# @readmit/sdk

**Build, dry-run, diagnose, fix, send and watch EIP-8141 frame transactions on an ERC-8421 alternative mempool.**

This is the engine behind **[Readmit](https://github.com/manjeetsharma0796/readmit)** ([live app](https://readmit-kohl.vercel.app)), the debugger and admission simulator for frame transactions, packaged for your own code. It's TypeScript on [viem](https://viem.sh) and [`@forshtat/hegota-support`](https://github.com/forshtat/hegota-support), with no backend and no API keys.

## Why

EIP-8141 lets an account's own code decide what is valid. The public mempool accepts only simple frame transactions; the ERC-8421 alternative mempool takes the rest under ERC-7562-style rules. When a transaction fails there, you usually get one of:

- **a rejection**, which never reaches a block, so no block explorer has it;
- **a rule name and a hex blob** from the sidecar;
- **an admitted transaction that still fails on chain**, with the payer charged anyway.

This SDK turns those into **which frame, why, and the number to change**. It also checks a transaction *before* you send it, applies the fix, and follows it to inclusion.

## Quick start

Requires **Node 23.6+**, which runs the TypeScript sources directly. It isn't on npm yet, so install it from GitHub:

```bash
npm install github:manjeetsharma0796/readmit-sdk viem
```

**1. Explain any transaction by hash.** It works on anyone's transaction, including rejected ones.

```ts
import { createReadmit, ALT_MEMPOOL_DEVNET } from '@readmit/sdk'

const r = createReadmit(ALT_MEMPOOL_DEVNET)
const dx = await r.explain('0x3fd93ca4a082d636d08fc27a8afd65b6449dda7aff6609736e8f080064724b9c')

dx.mempool.headline // "Admitted and included"
dx.chain.headline   // "Executed"
dx.findings[0]      // { tone, frame?, title, why, fix?, patch? }, worst first
```

**2. Build, dry-run, fix and send your own.**

```ts
import { createReadmit, ALT_MEMPOOL_DEVNET, verifyFrame, senderFrame, SCOPE, TxNotIncluded } from '@readmit/sdk'

const r = createReadmit(ALT_MEMPOOL_DEVNET)
const draft = await r.buildFrameTx({                                // nonce and fees come from the node
  sender,
  frames: [
    verifyFrame(SCOPE.BOTH, { gas: 10_000n }),                       // the sender checks its signature and pays
    senderFrame({ target: token, gas: 60_000n, data: calldata }),    // a call made as the sender
  ],
})

// Dry run. If it finds a fixable problem (e.g. "frame 1 would run out of gas"), it applies the fix,
// dry-runs again, and only then sends. Throws DryRunFailed if a problem has no automatic fix.
const { hash } = await r.sendDraft(draft, privateKey)

try {
  const receipt = await r.waitForInclusion(hash)
} catch (e) {
  if (e instanceof TxNotIncluded) console.log(e.stage, e.diagnosis?.findings[0]) // rejected / failed / dropped, and why
}
```

**3. Already on viem?**

```ts
import { createPublicClient, http } from 'viem'
import { frameActions, ALT_MEMPOOL_DEVNET } from '@readmit/sdk'

const client = createPublicClient({ transport: http(ALT_MEMPOOL_DEVNET.ethrex) })
  .extend(frameActions({ miner: ALT_MEMPOOL_DEVNET.miner, gateway: ALT_MEMPOOL_DEVNET.gateway, chainId: 1337 }))

await client.explainFrameTransaction(hash)
await client.sendFrameDraft(draft, account) // the account can be a viem LocalAccount
```

## What it does

| | Feature | API |
|---|---|---|
| 🔍 | **Explains failures.** 3 verdicts (mempool, chain, ERC-8421) plus plain-language findings. It covers 10+ rejection classes using the sidecar's own rule names: the 100k validation cap (both message formats), unstaked storage reads, banned opcodes, payer can't cover, nonce, replacement fee, paymaster `underpaid`. It tells **out-of-gas apart from a logic revert** ("raising gas won't help"). | `r.explain(hash)`, `diagnose(tx, receipt)` |
| 🧪 | **Admission simulator.** Dry run on ethrex before anything is broadcast; "frame 3 would run out of gas" before anyone pays. | `r.dryRun(draft, signer)`, `r.simulate(raw)`, `diagnoseDraft(...)` |
| 🔧 | **Machine-readable fixes.** Every finding that has a fix carries a `patch`, e.g. `{ kind: 'gas', frame: 3, gas: 20000 }` (used × 1.25, rounded up to 1,000). Apply it, re-sign, resend. | `applyPatch(draft, patch)`, `r.sendDraft(...)` |
| ⚠️ | **Fragility check.** Warns when a VERIFY frame reads storage someone else can change, like a Uniswap pool's `slot0`, so a swap can invalidate your pending transaction. | `sharedReads(...)`, inside `diagnoseDraft` |
| 🏗️ | **Generic builder.** Any frames, any sender, nonce and fees filled from the node. | `r.buildFrameTx(...)`, `verifyFrame`, `senderFrame`, `MODE`, `SCOPE` |
| ✍️ | **Pluggable signing.** A private key, a viem `LocalAccount`, or `{ signHash }` for any other scheme (post-quantum, multisig). The chain ID is a parameter. | `r.sign(...)`, `signDraft(...)`, `signingHash(...)` |
| 📤 | **Send to the alt mempool** in the sidecar's wire format. | `r.send(raw, node?)` |
| 📡 | **Tracking.** pending → admitted → included, or rejected / failed / **dropped** (admitted but never mined, which only happens on an alt mempool). | `r.watch(hash, cb)`, `r.waitForInclusion(hash)` |
| 📊 | **Mempool monitoring.** The node's latest admission decisions: how many were rejected, by how many senders, and the top rules. | `r.recent()`, `r.stats()`, `rejectionStats(rows)` |
| 🧯 | **Revert reasons.** Replays a fresh on-chain failure on its parent block. | `r.replay(hash)` |
| 🔤 | **Decoders.** `Error(string)` / `Panic` / custom-error selectors, frame roles, 4-byte names. | `errorString`, `role`, `lookupSelectors` |
| 🧩 | **Typed errors** with stable `code`s. | `RpcError`, `DryRunFailed`, `TxNotIncluded`, `WaitTimeout` |

## Configuration

```ts
createReadmit({
  ethrex: 'https://…',            // execution RPC: reads, dry runs, receipts, nonce and fees
  miner: 'https://…/rpc',         // alt-mempool sidecar(s); at least one
  gateway: 'https://…/rpc',
  chainId: 1337,
  defaultNode: 'miner',           // where send / watch / explain go first
  profile,                        // hegota-support codec profile; default ethrex-eip8141-tracer
  minMaxFeePerGas: 2_000_000_000n // floor for devnets whose gas price is near zero
})
```

Every endpoint is a URL or your own transport, `(method, params) => Promise<result>`. Use that to add auth, retries, a proxy or Anon-RPC. `ALT_MEMPOOL_DEVNET` holds the public EF devnet's endpoints (chain 1337).

## Recipe: pay gas in an ERC-20

`@readmit/sdk/recipes/erc20Paymaster` builds the paymaster frames (sender VERIFY, paymaster VERIFY, fee transfer, then your calls) for a paymaster that prices gas with `quote(uint256 weiCost)`. Readmit's staked `V4PricedPaymaster` is one: it prices gas from a Uniswap v4 pool. Its `requote` plugs into the fix loop when the price moves and the paymaster answers `underpaid`.

```ts
import { erc20Paymaster } from '@readmit/sdk/recipes/erc20Paymaster'

const pm = erc20Paymaster(r, { token: tUSD, paymaster })
const draft = await pm.transfer(wallet, to, 1_000_000n)  // gas paid in tUSD; the wallet can hold 0 ETH
const { hash } = await r.sendDraft(draft, key, { requote: pm.requote })
```

The deployed addresses on chain 1337 are in [`test/fixtures/devnet-1337.json`](test/fixtures/devnet-1337.json).

## Errors

| Class | `code` | When | Carries |
|---|---|---|---|
| `RpcError` | `RPC_UNREACHABLE`, `RPC_<n>` | network failure, HTTP error, or a JSON-RPC `error` | `url`, `method`, `rpcCode` |
| `DryRunFailed` | `DRY_RUN_FAILED` | `sendDraft` found a problem with no automatic fix, so nothing was sent | `diagnosis` |
| `TxNotIncluded` | `TX_REJECTED`, `TX_FAILED`, `TX_DROPPED` | `waitForInclusion` reached a final stage other than included | `stage`, `diagnosis` |
| `WaitTimeout` | `WAIT_TIMEOUT` | no final stage before the timeout | `lastStage` |

All of them extend `ReadmitError`.

## How we know it works

```bash
npm test          # 21 offline cases, no network
npm run test:live # plus read-only calls to the public devnet; never sends
```

- **Byte-identical to the app.** Signing a reference draft gives the same transaction hash as the Readmit app's engine, which produced every live proof transaction in the [Readmit README](https://github.com/manjeetsharma0796/readmit#proof-live-on-chain-1337).
- **Real devnet data.** The diagnosis cases are recorded admission reports and receipts from chain 1337 (`test/fixtures/`).
- **The fix loop, end to end against a scripted node.** A dry run reports "frame 3 would run out of gas, 16,000 of 16,000". The SDK patches the limit to 20,000, the dry run passes, and the fixed bytes are sent.
- **Errors.** Rejected → `TxNotIncluded` with its diagnosis; never final → `WaitTimeout`; unreachable node → `RpcError`.
- **Live, read-only.** It explains the golden tx, reads rejection stats, builds a tUSD-paid transfer with a live quote, confirms the node refuses a wrong signature in the dry run, and checks the viem `extend` path.

## Limits

- **Devnet software.** EIP-8141 isn't on mainnet until Hegotá. The diagnosis knows *this* sidecar's rule names and message formats, and other ERC-8421 implementations may word them differently.
- **Partial spec check.** The ERC-8421 verdict covers the validation budget and validation reverts only.
- **`replay` window.** ethrex keeps state for about 128 blocks (~13 minutes on the devnet).
- **Not on npm yet, and no ethers adapter.** ethers users can pass a transport function and a `{ signHash }` signer.
- **The diagnosis engine is shared.** `src/diagnose.ts` is synced from the Readmit app. Fix bugs in both places until the app depends on this package.

## Contributing

```bash
git clone https://github.com/manjeetsharma0796/readmit-sdk && cd readmit-sdk
npm install
npm run typecheck && npm test
```

- **New rejection class:** record the real admission report and receipt into `test/fixtures/`, add the case to `test/check.ts`, then teach `src/diagnose.ts`.
- **Never send** from tests. `test:live` is read-only by design.

| Path | What |
|---|---|
| `src/client.ts` | `createReadmit`: node access, explain, tracking, monitoring, build / dry run / send, replay |
| `src/frames.ts` | Drafts, frame helpers, signing, encode / decode, `applyPatch` |
| `src/diagnose.ts` | The diagnosis engine (pure, no network) |
| `src/monitor.ts` | Stages and rejection stats |
| `src/viem.ts` | `frameActions` for `client.extend` |
| `src/errors.ts`, `src/selectors.ts` | Typed errors; 4-byte lookup |
| `recipes/erc20Paymaster.ts` | Gas paid in an ERC-20 through a `quote()` paymaster |

## Related

- **[Readmit](https://github.com/manjeetsharma0796/readmit)**: the app built on this engine. Paste a hash, see which frame failed and why, then Fix & send. [Live](https://readmit-kohl.vercel.app).
- [EIP-8141: Frame Transaction](https://eips.ethereum.org/EIPS/eip-8141) · [Alt mempool docs](https://docs.altmempool.wtf/) · [Devnet explorer](https://explorer.altmempool.wtf/) · [Workshop sidecar](https://github.com/forshtat/mempool-workshop-sidecar)

Built at ETHGlobal Mumbai 2026 for the EF alt-mempool developer-tooling track. MIT licensed.
