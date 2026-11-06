# readmit-sdk: open tasks

This is the to-do list for anyone picking up the SDK. Each task stands on its own: why it matters, where to change things, how to approach it, the gotchas we already hit, and how to know it's done. Read **Context** once, then take a task.

## How to work on a task

1. **Pull, then pick** the first `todo` in priority order whose `depends` are `done`.
2. **Claim it.** Set `status: doing`, `owner: <you>`, `started: <date>`. Commit `S07: claim` and push before you write code, so two people don't build the same thing.
3. **Work only in the files the task lists.** If you must touch more, say why in the task's `log`.
4. **Finish.** Run `npm run typecheck && npm test`. Paste the evidence into `log`: one line of command output, a tx hash, or a test name. Then set `status: done`, commit `S07: done` and push.
5. **New work you discover** goes in a new task at the end. Don't silently grow the one you're on.

**Rules:**
- **Tests never send transactions.** `npm run test:live` is read-only.
- **Never commit keys.** The README examples use placeholders.
- **New diagnosis cases come from real devnet data.** Record the sidecar's `skandha_explorer_getTransaction` result and the ethrex receipt into `test/fixtures/<name>.json` (shape: `{ name, hash, node, tx, receipt }`). Don't hand-write fixtures.
- No AI co-author lines in commit messages.

---

## Context

### What exists (v0.1.0)

| File | What it does |
|---|---|
| `src/client.ts` | `createReadmit(config)`: node access (`getTx`, `getReceipt`, `simulate`, `send`), `explain`, `watch` / `waitForInclusion`, `recent` / `stats`, `buildFrameTx`, `sign`, `dryRun`, `sendDraft` (dry run → apply patch → dry run → send), `replay` |
| `src/frames.ts` | `Draft` / `FrameSpec`, `verifyFrame` / `senderFrame`, `MODE` / `SCOPE`, `signDraft` (key, viem account, or `{ signHash }`), `signingHash`, `decodeDraft`, `rawTxHash`, `draftFrames`, `applyPatch`, `maxCostBound` |
| `src/diagnose.ts` | Pure diagnosis engine: `diagnose`, `diagnoseDraft`, `sharedReads`, `errorString`, `role`. **This is a synced copy** of the Readmit app's `src/diagnose.ts` (see S03). |
| `src/monitor.ts` | `txStage`, `rejectionStats` |
| `src/viem.ts` | `frameActions` for `client.extend` |
| `src/errors.ts` | `ReadmitError` → `RpcError`, `DryRunFailed`, `TxNotIncluded`, `WaitTimeout` |
| `recipes/erc20Paymaster.ts` | Gas paid in an ERC-20 through a paymaster with `quote(uint256)` |
| `test/check.ts` | 21 offline cases plus `--live` read-only cases. Signing is checked against a golden hash produced by the Readmit app's engine. |

### The system we talk to

- **Chain:** the EF alt-mempool devnet, chain id 1337, built on ethrex with EIP-8141. **EIP-8141 isn't on mainnet** until the Hegotá fork.
- **Endpoints:** in `ALT_MEMPOOL_DEVNET` in `src/client.ts`.
  - ethrex: `https://altmempool.forshtat.com`
  - gateway sidecar: `https://altmempoolgateway.forshtat.com/rpc`
  - miner sidecar: `https://altmempool.forshtat.com/rpc`
- **Faucet and funding:** https://docs.altmempool.wtf/guides/devnet/
- **Explorer:** https://explorer.altmempool.wtf/
- **ethrex methods we use:**
  - `ethrex_simulateFrameTransaction(raw, block, { trace })`, which returns per-frame gas and success, `payer`, `maxCost`, `canonicalMempoolValid`, and with `trace` the `erc7562Trace`;
  - `eth_getTransactionReceipt`, which includes per-frame `frameReceipts`;
  - `eth_getTransactionByHash`, `eth_getTransactionCount`, `eth_gasPrice`.
- **Sidecar methods** (a Skandha fork):
  - `eth_sendFrameTransaction(wireTx)`: it takes the **wire object** from `toWire(decodeTx(...))`, not raw bytes;
  - `skandha_explorer_getTransaction(hash)`: the entry plus the admission report;
  - `skandha_explorer_listAdmissions({ limit })`.
  - API notes: https://github.com/forshtat/mempool-workshop-sidecar/blob/master/docs/sidecar_explorer.md
- **Encoding:** `@forshtat/hegota-support` (profile `ethrex-eip8141-tracer`) does all of it.
  - Frame modes: DEFAULT 0, VERIFY 1, SENDER 2.
  - Approve scopes: NONE 0, PAYMENT 1, EXECUTION 2, both 3.
  - Flag bit `ATOMIC_BATCH` 0x4.
  - Signature schemes: ARBITRARY 0, SECP256K1 1, P256 2.

### Devnet behaviour we learned the hard way

- **The gateway runs in manual bundling.** A tx sent only there is admitted but sits until someone triggers a bundle. Send to the **miner** (the default).
- **One tx in flight per sender.** Send the next one only after the previous is included.
- **The miner can drop an admitted tx** after relaying it several times. `txStage` reports this as `dropped`. It's relay behaviour, not a validation failure.
- **ethrex keeps state for ~128 blocks** (~13 minutes), so `replay` returns null after that.
- **Validation budget.** The sidecar's `MAX_VERIFY_GAS` is 100,000 across the VERIFY (prefix) frames: [validationPrefix.ts](https://github.com/forshtat/mempool-workshop-sidecar/blob/master/packages/executor/src/services/UserOpValidation/utils/validationPrefix.ts). Its rejection message changed wording mid-event, and `diagnose.ts` parses both.
- **Reading non-sender storage in VERIFY needs a staked entity.** It's rejected as unstaked storage otherwise. The staking registry is keyed by `msg.sender`, so a paymaster must call `addStake` itself.
- **Wording quirks:** the sidecar's `COD-010` actually means "address has no code". Rolled-back frames in an atomic batch still show "Succeeded".
- **Reading:** [EIP-8141](https://eips.ethereum.org/EIPS/eip-8141) and the [ERC-8421 draft](https://raw.githubusercontent.com/forshtat/ERCs/refs/heads/pr-clean/ERCS/erc-8421.md). The Readmit repo's `docs/RESEARCH.md` has a cited summary with a claims table.

---

## Tasks (priority order)

### S01 · Continuous integration
- status: done
- owner: manjeet (Claude Code)
- started: 2026-11-07 04:59 IST
- priority: P0
- depends: none
- touches: `.github/workflows/ci.yml` (new)
- why: Nothing stops a broken commit today. Every later task needs a safety net.
- how:
  - On push and on PR: Node 24, `npm ci`, `npm run typecheck`, `npm test`, `npm run build`.
  - Add a second job, `live`, that runs `npm run test:live` only on `workflow_dispatch`. It depends on the public devnet, which can be down or reset, so it must not block merges.
- done when: a PR shows the green check; a deliberately broken assertion turns it red.
- log: `.github/workflows/ci.yml` runs on push to main and on PRs: Node 24, `npm ci`, typecheck, `npm test`, build. The `live` job runs `npm run test:live` only on workflow_dispatch, so it never blocks merges. First run 42312296810 on 3157b17: test=success, live=skipped. Red path checked locally in a clean clone: a real failing `assert.equal(1, 2)` makes `node test/check.ts` exit 1 with an AssertionError, which fails the job. `npm ci` from the committed lockfile works.

### S02 · Publish to npm
- status: todo
- owner:
- priority: P0
- depends: S01
- touches: `package.json`, `README.md` (install line), `.github/workflows/release.yml` (optional)
- why: `npm install github:…` works (the `prepare` script builds `dist/`), but it's slow, and judges and users expect `npm i @readmit/sdk`.
- how:
  - Check that the `@readmit` npm scope is free, or create the org. Otherwise rename, e.g. `readmit-sdk`.
  - `npm pack --dry-run`: the tarball should hold only `dist/`, `README.md`, `LICENSE` and `package.json`.
  - `prepublishOnly` already builds and tests.
  - Publish `0.1.0`, then change the README install line to `npm i @readmit/sdk viem`.
  - Optional: publish on a git tag with an `NPM_TOKEN` secret, plus `--provenance`.
- gotchas:
  - `viem` is a **peer** dependency.
  - `@forshtat/hegota-support` is pinned at `0.0.1`. Bump it only with a re-run of the golden signing test.
- done when: in an empty folder, `npm i @readmit/sdk viem` followed by the README quick-start step 1 prints "Admitted and included".
- log:

### S03 · Make the Readmit app use the SDK (remove the duplicated diagnose.ts)
- status: todo
- owner:
- priority: P1
- depends: S02 (or a git dependency until then)
- touches: the **Readmit app repo** (github.com/manjeetsharma0796/readmit): `package.json`, `src/rpc.ts`, `src/engine/frames.ts`, `src/diagnose.ts`, and the `src/ui/*` imports. In this repo, delete the provenance header in `src/diagnose.ts` once the app depends on the package.
- why: `src/diagnose.ts` exists in both repos, so every diagnosis fix must be made twice. It was synced at app commit `916375d`.
- how:
  - In the app, build the client once:
    ```ts
    createReadmit({ ethrex: ENDPOINTS.ethrex, gateway: ENDPOINTS.gateway, miner: ENDPOINTS.miner, chainId: 1337 })
    ```
    `ENDPOINTS` already merges the user's saved endpoints from localStorage (app ticket T50).
  - Swap each app function for its SDK equivalent:
    - `getTx`, `getReceipt`, `simulate`, `sendFrameTx` → `r.send`;
    - `watchTx` → `r.watch`;
    - `recent` → `r.recent`;
    - `replay` → `r.replay`.
  - Express `buildSendTx` / `buildFaucetTx` through `recipes/erc20Paymaster`: `pm.transfer`, and `pm.build` with a mint call.
  - Then delete the app's own copies.
- gotchas:
  - The app's `txStage` and the SDK's are identical; keep one.
  - The app's `rpc.ts` returns `AdmissionRow` with a `node` field, and the SDK rows don't have it. Add it in the app when merging gateway and miner lists.
  - Re-run the app's `npm run check` and do one approved live send on the static build before merging.
- done when: the app has no `src/diagnose.ts`; `npm run check` and `npm run build` pass; one live Fix & send works from the deployed app.
- log:

### S04 · Stable finding codes
- status: todo
- owner:
- priority: P1
- depends: none
- touches: `src/diagnose.ts`, `src/errors.ts` (re-export the type), `test/check.ts`, `README.md`
- why: Today the only way to tell findings apart is the English `title`, which breaks callers whenever we reword it. (That already happened once: the fragility title lost a trailing period.)
- how:
  - Add `code` to `Finding`:
    - `FRAME_OUT_OF_GAS`, `FRAME_REVERTED`;
    - `VALIDATION_GAS_OVER_CAP`, `VALIDATION_OUT_OF_GAS`;
    - `UNSTAKED_STORAGE_READ`, `BANNED_OPCODE`;
    - `PAYER_CANNOT_COVER`, `NONCE_MISMATCH`, `REPLACEMENT_FEE_TOO_LOW`;
    - `PAYMASTER_UNDERPAID`, `BAD_SIGNATURE`;
    - `SHARED_STATE_READ`, `PAYER_CHARGED_ON_FAILURE`;
    - `READY`, `NOTHING_TO_FIX`.
  - Assign one wherever a finding is pushed.
  - Add a table to the README.
  - Tests should assert on codes, not titles.
- done when: every finding the 21 cases produce has a code, and the README lists all codes.
- log:

### S05 · Gas estimation for drafts
- status: todo
- owner:
- priority: P1
- depends: none
- touches: `src/client.ts` (`r.estimate(draft, signer)`), `src/frames.ts`, `test/check.ts`
- why: Today you have to guess limits and let the fix loop correct them. A real `estimate` is the DX people expect from viem.
- how:
  1. Simulate with generous limits. Use the frame's own limit, or 500k for SENDER frames.
  2. Read `frames[i].gasUsed`.
  3. Set each limit to `ceil(used × 1.25 / 1000) × 1000`, the same rule as the fix finding.
  4. Re-simulate once to confirm.
- gotchas:
  - **The VERIFY frames together must stay ≤ 100,000** (sidecar `MAX_VERIFY_GAS`). If 1.25× would exceed it, cap at the remaining budget and return a warning.
  - The simulation needs a valid signature, so the signer is required. Signing covers the limits, so re-sign after changing them.
  - A paymaster's fee depends on `maxCostBound`, so re-quote after shrinking limits. Use the recipe's `requote` when one is passed.
- done when: an offline test with a scripted simulate shows the limits rewritten and the VERIFY sum ≤ 100k; `test:live` estimates the recipe transfer (it will fail on the signature with a dummy key, so assert only the first simulate call's shape).
- log:

### S06 · Keyed nonces (EIP-8250) and recent-root references in drafts
- status: todo
- owner:
- priority: P1
- depends: none
- touches: `src/frames.ts` (`Draft`, `toFrameTx`, `decodeDraft`), `src/client.ts` (`buildFrameTx`), `test/check.ts`
- why: `Draft` only carries `nonce` (the sequence). `toFrameTx` lets hegota-support default `nonceKeys` to `[0n]`, and `decodeDraft` drops `nonceKeys` and `recentRootReferences`. The devnet runs keyed nonces and recent roots, so parallel txs from one sender (different keys) are impossible today, and decode → re-sign silently loses data.
- how:
  - Add optional `nonceKeys?: bigint[]` and `recentRootReferences?` to `Draft`.
  - Pass them through `newTx` and back out in `decodeDraft`.
  - In `buildFrameTx`, if a key ≠ 0 is given, read that key's sequence from the NONCE_MANAGER predeploy `0x…8250`. Check the call shape against EIP-8250 and the sidecar source.
- done when: decode → encode round-trips byte-identically for a tx with nonce key 5 and one recent-root reference; the golden hash for key 0 is unchanged.
- log:

### S07 · Multiple signatures and P256
- status: todo
- owner:
- priority: P2
- depends: S06
- touches: `src/frames.ts` (`Draft.signatures`, `signDraft`), `test/check.ts`, `README.md`
- why: `toFrameTx` always builds exactly one `secp256k1Placeholder`, which blocks two cases:
  - a co-signing paymaster or a multisig, which needs several signature entries;
  - a P256 / passkey wallet: the profile has `P256 = 2`, but we only emit SECP256K1.
- how:
  - Let a draft declare signature entries: `{ scheme, signer? }[]`.
  - Let `signDraft` take one signer per entry (`Signer[]`).
  - For P256, require `{ signHash }` and set `scheme: 2`.
  - The signing hash is the same for every entry: `sigHash` over the tx without signatures. Check that in hegota-support's `codec.js`.
- done when: a test builds a 2-entry tx (secp256k1 + arbitrary), signs both, and decodes them back.
- log:

### S08 · DEFAULT-mode frames (deploy, post-op) and a deploy-on-first-use recipe
- status: todo
- owner:
- priority: P2
- depends: none
- touches: `src/frames.ts` (`defaultFrame`), `recipes/deployAccount.ts` (new), `src/diagnose.ts` (`role` already labels deploy / post_op; check it), `README.md`
- why: Accounts that don't exist yet need a DEFAULT deploy frame first. A paymaster that refreshes its price needs a DEFAULT post-op frame, because VERIFY is a STATICCALL and can't write. That's the safer alternative to reading Uniswap `slot0` during validation.
- done when: `defaultFrame({ target, gas, data })` exists; the recipe builds deploy + VERIFY + SENDER; offline tests decode the right modes; a dry run on the devnet with a fresh key and the workshop wallet factory passes. Ask the human before any real send.
- log:

### S09 · ethers v6 adapter
- status: doing
- owner: manjeet (Claude Code)
- started: 2026-11-07 04:59 IST
- priority: P2
- depends: none
- touches: `src/ethers.ts` (new; `ethers` as an **optional** peer dependency), `package.json` exports `./ethers`, `README.md`
- why: Half the ecosystem uses ethers. Today ethers users must hand-write the transport and signer.
- how:
  - `fromEthers(provider, wallet?)` returns:
    - `ethrex: (m, p) => provider.send(m, p)`;
    - a signer `{ signHash: async (h) => packed(wallet.signingKey.sign(h)) }`, where packed is `yParity || r || s`, 65 bytes, the same layout `signDraft` produces.
  - Test it against the golden hash.
- done when: an ethers-built signer reproduces the golden hash in `test/check.ts`.
- log:

### S10 · Pluggable paymaster interface, plus a second recipe
- status: todo
- owner:
- priority: P2
- depends: S04
- touches: `src/paymaster.ts` (new interface), `recipes/erc20Paymaster.ts`, `recipes/sponsor.ts` (new), `src/client.ts` (`sendDraft` takes `paymaster?` instead of a bare `requote`)
- why:
  - `applyPatch`'s requote assumes "the fee frame is the frame right after the paymaster VERIFY", which is our paymaster's layout.
  - A sponsoring paymaster (no fee frame) or a daily-quota paymaster would need different frames and different fixes.
- how:
  - Define `interface PaymasterAdapter { frames(calls, ctx): FrameSpec[]; requote?(d): Promise<Draft>; explain?(revertReason): Finding | null }`.
  - Port the ERC-20 recipe to it.
  - Add a sponsor recipe: a paymaster VERIFY that approves PAYMENT, with no fee transfer.
- done when: `sendDraft(draft, signer, { paymaster: pm })` works with both recipes in offline tests.
- log:

### S11 · Full ERC-8421 rule set in the spec verdict
- status: todo
- owner:
- priority: P2
- depends: S04
- touches: `src/diagnose.ts`, `test/fixtures/` (new recorded cases), `test/check.ts`, `README.md` (Limits)
- why: The ERC-8421 verdict only checks the validation budget and validation reverts.
- how:
  - Go through the ERC-8421 draft rule by rule: opcode bans, storage access by entity, staking thresholds, reputation (THROTTLED / BANNED), and LIFECYCLE revalidation.
  - Map each rule to the sidecar's rule ids, from `packages/executor/src/services/UserOpValidation/validators/frameTx.ts` in the sidecar repo.
  - Implement them one rule at a time, each with a recorded fixture.
- gotchas: `diagnose.ts` compares the prefix total with `ERC8421_STAKED_CAP = 1_000_000`, but the 1M is **per entity**, not per transaction. Fix that while you're here.
- done when: each implemented rule has a fixture case and a code (S04); README "Limits" lists what's still not covered.
- log:

### S12 · Cancellation and back-off for watching
- status: todo
- owner:
- priority: P3
- depends: none
- touches: `src/client.ts` (`watch`, `waitForInclusion`), `test/check.ts`
- why: Polling is fixed at 2 s with no way to cancel `waitForInclusion`. UIs need to abort when a component unmounts.
- how: Accept `signal?: AbortSignal` and reject with an `AbortError`. Use exponential back-off from 1 s up to 8 s. Keep the 2-s default for the first 30 s, which is what the demo relied on.
- done when: offline tests cover abort and a back-off schedule.
- log:

### S13 · Browser bundle smoke test
- status: todo
- owner:
- priority: P3
- depends: S01
- touches: `test/browser/` (new, a tiny Vite page), CI
- why: The Readmit app runs this code in the browser, but the SDK itself is only tested in Node.
- how: Build a minimal Vite page that imports `@readmit/sdk`, calls `r.explain(goldenHash)` against the devnet, and prints the headline. Run it in CI with Playwright on `workflow_dispatch`.
- done when: the page prints "Admitted and included" headless.
- log:

### S14 · Anon-RPC transport example
- status: todo
- owner:
- priority: P3
- depends: none
- touches: `examples/anon-rpc.ts` (new), `README.md`
- why: Every RPC call reveals the user's IP to the node; this matters for CROPS privacy. A transport is just `(method, params) => Promise`, so routing reads through Anon-RPC needs no SDK change.
- how: Follow https://ethereum.github.io/anon-rpc/wallets/ with `@anon-rpc/browser-harness`. Keep `send` on the sidecar directly unless Anon-RPC supports `eth_sendFrameTransaction`, and say so.
- done when: the example explains the golden hash through Anon-RPC.
- log:

### S15 · API reference site
- status: todo
- owner:
- priority: P3
- depends: S02
- touches: `typedoc.json` (new), `.github/workflows/docs.yml`, the JSDoc comments in `src/`
- why: The README tables are hand-maintained and will drift.
- how: Generate TypeDoc from the existing JSDoc and publish it to GitHub Pages. Link it from the README.
- done when: the Pages site lists every export from `src/index.ts`.
- log:

### S16 · Hegotá readiness: profile and chain presets
- status: todo
- owner:
- priority: P3
- depends: S06
- touches: `src/client.ts` (presets), `README.md`
- why: Once EIP-8141 ships, the devnet profile and endpoints change. hegota-support already ships a second profile, `ethrex-hegota-devnet`.
- how: Add presets next to `ALT_MEMPOOL_DEVNET` with the right `profile`. Run the golden test per profile; it needs a golden hash per profile.
- done when: `createReadmit({ ...HEGOTA_DEVNET })` passes `test:live` against that network.
- log:
