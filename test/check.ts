// Self-check for @readmit/sdk. Offline cases always run; `--live` adds read-only calls to the public devnet. Nothing is ever sent.
// Run: npm test   (or: node test/check.ts --live)
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createPublicClient, encodeErrorResult, http, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { JsonRpcProvider, Wallet } from 'ethers'
import { ethersSigner, ethersTransport } from '../src/ethers.ts'
import { erc20Paymaster, transferData } from '../recipes/erc20Paymaster.ts'
import {
  ALT_MEMPOOL_DEVNET, DryRunFailed, FINDING_CODES, diagnoseDraft, RpcError, SCOPE, TxNotIncluded, WaitTimeout, applyPatch, createReadmit, decodeDraft, diagnose, frameActions,
  rawTxHash, rejectionStats, senderFrame, signDraft, signingHash, txStage, verifyFrame, type Draft,
} from '../src/index.ts'
import { connect, payWithEth } from '../src/index.ts'

const load = (n: string) => JSON.parse(readFileSync(new URL(`./fixtures/${n}.json`, import.meta.url), 'utf8'))
const key = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as Hex // well-known local test key
const me = privateKeyToAccount(key).address
const A = { token: '0x1111111111111111111111111111111111111111', paymaster: '0x2222222222222222222222222222222222222222' } as const
const to = '0x3333333333333333333333333333333333333333'
let cases = 0
const ok = () => cases++

// 1. Generic builder + every signer kind. GOLDEN is the hash of the same draft signed by the Readmit app's own engine
//    (the code behind every live proof tx), so a match means byte-identical encoding and signing.
const draft: Draft = {
  sender: me, nonce: 7n, maxFeePerGas: 4_000_000_000n, maxPriorityFeePerGas: 2_000_000_000n,
  frames: [
    verifyFrame(SCOPE.EXECUTION, { gas: 10_000n }),
    verifyFrame(SCOPE.PAYMENT, { target: A.paymaster, gas: 70_000n }),
    senderFrame({ target: A.token, gas: 60_000n, stateGas: 100_000n, data: transferData(A.paymaster, 3_300_000n) }),
    senderFrame({ target: A.token, gas: 60_000n, stateGas: 100_000n, data: transferData(to, 5n) }),
  ],
}
const GOLDEN = '0x18b0c7182a0d0fd3b5b284ae28f7a77a0dc0b1d1f2a00b446daa10fc0a1e744d'
const byKey = await signDraft(draft, key, 1337)
assert.equal(rawTxHash(byKey), GOLDEN, 'same bytes as the Readmit app engine'); ok()
assert.equal(await signDraft(draft, privateKeyToAccount(key), 1337), byKey, 'viem LocalAccount signer'); ok()
const custom = await signDraft(draft, { signHash: async (h) => (h === signingHash(draft, 1337) ? '0xabcdef' : '0x00') }, 1337)
assert.match(custom, /abcdef/, 'custom signHash signer gets the signing hash and its bytes are used as is'); ok()
assert.notEqual(await signDraft(draft, key, 1), byKey, 'chain id is part of what is signed'); ok()
assert.equal(await signDraft(draft, ethersSigner(new Wallet(key)), 1337), byKey, 'ethers Wallet signer'); ok()
assert.equal(await signDraft(draft, ethersSigner(new Wallet(key).signingKey), 1337), byKey, 'ethers SigningKey signer'); ok()
const back = decodeDraft(byKey)
assert.deepEqual([back.sender.toLowerCase(), back.nonce, back.frames.length], [me.toLowerCase(), 7n, 4]); ok()
assert.match(rawTxHash(byKey), /^0x[0-9a-f]{64}$/); ok()

// 2. Patches: gas is generic; requote needs the paymaster's pricing.
const patched = await applyPatch(draft, { kind: 'gas', frame: 3, gas: 90_000 })
assert.deepEqual(patched.frames.map((f) => f.gas), [10_000n, 70_000n, 60_000n, 90_000n]); ok()
await assert.rejects(applyPatch(draft, { kind: 'requote' }), /pass \{ requote \}/); ok()
const rq = await applyPatch(draft, { kind: 'requote' }, { requote: async (d) => ({ ...d, nonce: 99n }) })
assert.equal(rq.nonce, 99n); ok()

// 3. Monitoring.
assert.equal(txStage(null), 'pending'); ok()
assert.equal(txStage(load('paid-in-tusd').tx), 'included'); ok()
assert.equal(txStage(load('bad-signature').tx), 'rejected'); ok()
const rows = [
  { txHash: '0x1', outcome: 'rejected', sender: '0xa', at: 1_000, checks: [{ rule: 'simulation', verdict: 'fail' as const }] },
  { txHash: '0x2', outcome: 'rejected', sender: '0xa', at: 2_000, checks: [{ rule: 'simulation', verdict: 'fail' as const }, { rule: 'OP-011', verdict: 'fail' as const }] },
  { txHash: '0x3', outcome: 'admitted', sender: '0xb', at: 61_000, checks: [{ rule: 'simulation', verdict: 'pass' as const }] },
]
assert.deepEqual(rejectionStats(rows), { total: 3, rejected: 2, senders: 1, spanMs: 60_000, topRules: [['simulation', 2], ['OP-011', 1]] }); ok()

// 3b. Stable finding codes: every code in FINDING_CODES is produced by a real fixture or a sidecar/simulator message
//     in the exact wording the regexes in diagnose.ts read. Callers branch on `code`, never on `title`.
{
  const seen = new Set<string>()
  const codes = (findings: { code: string }[]) => { findings.forEach((f) => seen.add(f.code)); return findings.map((f) => f.code) }
  const paid = load('paid-in-tusd')
  const frames = paid.tx.admission.frames
  const errData = (msg: string) => encodeErrorResult({ abi: [{ type: 'error', name: 'Error', inputs: [{ type: 'string', name: 'm' }] }], errorName: 'Error', args: [msg] })
  // Fixtures recorded on the devnet.
  assert.deepEqual(codes(diagnose(paid.tx, paid.receipt).findings), ['NOTHING_TO_FIX']); ok()
  assert.equal(codes(diagnose(load('bad-signature').tx, null).findings)[0], 'BAD_SIGNATURE'); ok()
  const oog = load('reverted-out-of-gas')
  assert.deepEqual(codes(diagnose(oog.tx, oog.receipt).findings).slice(0, 2), ['FRAME_OUT_OF_GAS', 'PAYER_CHARGED_ON_FAILURE']); ok()
  // Admission reports: one failed check each.
  const rejected = (detail: string) => diagnose({ ...paid.tx, entry: null, admission: { ...paid.tx.admission, outcome: 'rejected', checks: [{ rule: 'simulation', verdict: 'fail', frameIndex: 1, detail }] } }, null).findings[0]
  const admission: [string, string][] = [
    ['prefix gas budget exceeded: 120000 > 100000 (MAX_VERIFY_GAS)', 'VALIDATION_GAS_OVER_CAP'],
    ['gas sum 90000 + signature-verification cost 20000 = 110000 exceeds MAX_VERIFY_GAS 100000', 'VALIDATION_GAS_OVER_CAP'],
    ['state gas sum 5000 exceeds MAX_VERIFY_STATE_GAS 0', 'VALIDATION_STATE_GAS_OVER_CAP'],
    [`the payer ${me} has 1 wei, the transaction's maximum cost is 2 wei`, 'PAYER_CANNOT_COVER'],
    ['validation frame 0: ran out of gas', 'VALIDATION_OUT_OF_GAS'],
    ['validation frame 0: reverted', 'VALIDATION_REVERTED'],
    [`validation frame 1: reverted with data ${errData('underpaid')}`, 'PAYMASTER_UNDERPAID'],
    [`validation frame 1: reverted with data ${errData('sender lacks TOKEN')}`, 'PAYMASTER_SENDER_LACKS_TOKEN'],
    [`validation frame 1: reverted with data ${errData('not to paymaster')}`, 'PAYMASTER_FEE_FRAME_INVALID'],
    [`unstaked paymaster accessed ${A.token} slot 0x01`, 'UNSTAKED_STORAGE_READ'],
    ['paymaster uses banned opcode: TIMESTAMP', 'BANNED_OPCODE'],
    ['Nonce mismatch: expected 3, got 2', 'NONCE_MISMATCH'],
    ['replacement transaction cannot be replaced: fee too low', 'REPLACEMENT_FEE_TOO_LOW'],
    ['already known', 'ALREADY_KNOWN'],
    ['some rule this engine has never seen', 'UNKNOWN_RULE'],
  ]
  for (const [detail, code] of admission) { assert.equal(rejected(detail).code, code, detail); seen.add(code); ok() }
  // Receipts: a skipped frame, and a VERIFY frame that declares more than the 100k cap but uses less.
  const rcpt = (st: string[]) => ({ ...paid.receipt, frameReceipts: paid.receipt.frameReceipts.map((r: any, i: number) => ({ ...r, status: st[i] })) })
  assert.ok(codes(diagnose(paid.tx, rcpt(['0x1', '0x1', '0x0', '0x2'])).findings).includes('FRAME_SKIPPED')); ok()
  const big = frames.map((f: any, i: number) => (i === 1 ? { ...f, limits: { ...f.limits, execution: '0x30d40' } } : f))
  assert.ok(codes(diagnose({ ...paid.tx, entry: null, admission: { ...paid.tx.admission, frames: big } }, paid.receipt).findings).includes('VALIDATION_GAS_OVERDECLARED')); ok()
  // Dry runs.
  const sim = (over: object): any => ({ canonicalMempoolValid: true, canonicalMempoolViolation: null, prefixShape: null, payer: null, maxCost: '0x1', gasUsed: null, frames: null, executionStatus: null, executionError: null, ...over })
  const ran = (ok: boolean[]) => sim({ frames: ok.map((s) => ({ gasUsed: '0x100', succeeded: s })), executionStatus: ok.every(Boolean) ? 'success' : 'reverted' })
  assert.deepEqual(codes(diagnoseDraft(frames, ran([true, true, true, true])).findings), ['READY']); ok()
  assert.deepEqual(codes(diagnoseDraft(frames, ran([true, true, true, false])).findings), ['FRAME_REVERTED', 'PAYER_CHARGED_ON_FAILURE']); ok()
  assert.equal(codes(diagnoseDraft(frames, sim({ haltReason: 'insufficient_funds', balance: '0x0' })).findings)[0], 'PAYER_CANNOT_COVER'); ok()
  assert.equal(codes(diagnoseDraft(frames, sim({ failedFrameIndex: 0, revertData: '0x5cd5d233' })).findings)[0], 'BAD_SIGNATURE'); ok()
  assert.equal(codes(diagnoseDraft(frames, sim({ failedFrameIndex: 1, revertData: errData('underpaid') })).findings)[0], 'PAYMASTER_UNDERPAID'); ok()
  assert.equal(codes(diagnoseDraft(frames, sim({ failedFrameIndex: 0, revertData: '0x' })).findings)[0], 'VALIDATION_REVERTED'); ok()
  // A VERIFY frame that reads a pool's storage (shared state) is fragile.
  const pool = '0x4444444444444444444444444444444444444444'
  const trace = [{ frameIndex: 1, root: { type: 'CALL', from: paid.tx.admission.sender, to: frames[1].target, calls: [{ type: 'STATICCALL', from: frames[1].target, to: pool, accessedSlots: { reads: { '0x0': ['0x1'] } } }] } }]
  assert.ok(codes(diagnoseDraft(frames, ran([true, true, true, true]), { sender: paid.tx.admission.sender, trace }).findings).includes('SHARED_STATE_READ')); ok()
  assert.deepEqual(FINDING_CODES.filter((c) => !seen.has(c)), [], 'every code is produced by some case'); ok()
}

// 4. Client against a scripted fake node: explain, waitForInclusion, sendDraft's fix loop, typed errors.
const oog = load('reverted-out-of-gas')
function fake(script: Record<string, (params: any[]) => any>) {
  const calls: string[] = []
  const t = async (m: string, p: unknown[]) => { calls.push(m); if (!script[m]) throw new Error(`unscripted ${m}`); return script[m](p as any[]) }
  return { t, calls }
}
{
  const node = fake({ skandha_explorer_getTransaction: () => oog.tx })
  const eth = fake({ eth_getTransactionReceipt: () => oog.receipt })
  const r = createReadmit({ ethrex: eth.t, miner: node.t, chainId: 1337 })
  const dx = await r.explain(oog.hash)
  assert.equal(dx.findings[0].code, diagnose(oog.tx, oog.receipt).findings[0].code)
  assert.deepEqual(dx.findings[0].patch, { kind: 'gas', frame: 4, gas: 38_000 }); ok()
}
{
  // explain falls back to the other node when the first never saw the hash
  const r = createReadmit({ ethrex: fake({ eth_getTransactionReceipt: () => oog.receipt }).t, miner: fake({ skandha_explorer_getTransaction: () => null }).t, gateway: fake({ skandha_explorer_getTransaction: () => oog.tx }).t, chainId: 1337 })
  assert.equal((await r.explain(oog.hash)).node, 'gateway'); ok()
}
{
  // admitted → included resolves with the receipt
  let n = 0
  const states = [{ entry: { status: 'Pending' }, admission: { outcome: 'admitted', checks: [] } }, load('paid-in-tusd').tx]
  const r = createReadmit({ ethrex: fake({ eth_getTransactionReceipt: () => load('paid-in-tusd').receipt }).t, miner: fake({ skandha_explorer_getTransaction: () => states[Math.min(n++, 1)] }).t, chainId: 1337 })
  const seen: string[] = []
  r.watch('0x01', (s) => seen.push(s), { intervalMs: 5 })
  const receipt = await r.waitForInclusion('0x01', { intervalMs: 5, timeoutMs: 5_000 })
  assert.equal(receipt.status, '0x1'); ok()
}
{
  // rejected → TxNotIncluded carrying the diagnosis
  const bad = load('bad-signature')
  const r = createReadmit({ ethrex: fake({ eth_getTransactionReceipt: () => null }).t, miner: fake({ skandha_explorer_getTransaction: () => bad.tx }).t, chainId: 1337 })
  const e = await r.waitForInclusion(bad.hash, { intervalMs: 5 }).catch((x) => x)
  assert.ok(e instanceof TxNotIncluded && e.code === 'TX_REJECTED' && e.diagnosis?.findings[0].tone === 'fail', String(e)); ok()
}
{
  // never final → WaitTimeout
  const r = createReadmit({ ethrex: fake({}).t, miner: fake({ skandha_explorer_getTransaction: () => null }).t, chainId: 1337 })
  const e = await r.waitForInclusion('0x02', { intervalMs: 5, timeoutMs: 60 }).catch((x) => x)
  assert.ok(e instanceof WaitTimeout && e.code === 'WAIT_TIMEOUT'); ok()
}
{
  // sendDraft: dry run says frame 3 would run out of gas → patch → dry run passes → send the patched bytes
  const sims = [
    { frames: [[100, true], [52_848, true], [28_461, true], [16_000, false]], status: 'reverted' },
    { frames: [[100, true], [52_848, true], [28_461, true], [18_461, true]], status: 'success' },
  ]
  let i = 0
  let sentRaw: Hex | undefined
  const sim = () => {
    const s = sims[i++]
    return { canonicalMempoolValid: false, canonicalMempoolViolation: 'StorageReadNonSender', prefixShape: 'SponsoredVerify', payer: A.paymaster, maxCost: '0x1', gasUsed: '0x0', executionStatus: s.status, executionError: null, frames: s.frames.map(([g, okk]) => ({ gasUsed: '0x' + Number(g).toString(16), succeeded: okk })) }
  }
  const eth = fake({ ethrex_simulateFrameTransaction: sim })
  const miner = fake({ eth_sendFrameTransaction: (p) => { sentRaw = p[0]; return '0xfeed' } })
  const r = createReadmit({ ethrex: eth.t, miner: miner.t, chainId: 1337 })
  const tight = { ...draft, frames: draft.frames.map((f, k) => (k === 3 ? { ...f, gas: 16_000n } : f)) }
  const res = await r.sendDraft(tight, key)
  assert.equal(res.hash, '0xfeed')
  assert.equal(res.draft.frames[3].gas, 20_000n) // used 16,000 of 16,000 → × 1.25, rounded up to 1,000
  assert.ok(sentRaw, 'sent in the sidecar wire format')
  assert.equal(decodeDraft(res.raw).frames[3].gas, 20_000n, 'the sent bytes carry the fixed limit')
  assert.deepEqual(eth.calls, ['ethrex_simulateFrameTransaction', 'ethrex_simulateFrameTransaction']); ok()
}
{
  // sendDraft refuses to broadcast when the problem has no automatic fix
  const r = createReadmit({
    ethrex: fake({ ethrex_simulateFrameTransaction: () => ({ canonicalMempoolValid: false, canonicalMempoolViolation: null, prefixShape: null, payer: null, maxCost: '0x1', gasUsed: null, frames: null, executionStatus: null, executionError: null, haltReason: 'insufficient_funds', balance: '0x0', required: '0x10' }) }).t,
    miner: fake({}).t, chainId: 1337,
  })
  const e = await r.sendDraft(draft, key).catch((x) => x)
  assert.ok(e instanceof DryRunFailed && e.code === 'DRY_RUN_FAILED' && /can't cover/.test(e.message), String(e)); ok()
}
{
  const r = createReadmit({ ethrex: 'http://127.0.0.1:9', miner: 'http://127.0.0.1:9', chainId: 1337 })
  const e = await r.getReceipt('0x03').catch((x) => x)
  assert.ok(e instanceof RpcError && e.code === 'RPC_UNREACHABLE' && e.method === 'eth_getTransactionReceipt'); ok()
}

// 5. The purpose-first API (connect): why / prepare / check / send / mempool, against scripted nodes.
{
  const c = connect({ ethrex: fake({ eth_getTransactionReceipt: () => oog.receipt }).t, miner: fake({ skandha_explorer_getTransaction: () => oog.tx }).t, chainId: 1337 })
  const rep = await c.why(oog.hash)
  assert.equal(rep.ok, false)
  assert.equal(rep.problems[0].code, 'FRAME_OUT_OF_GAS')
  assert.equal(rep.problems[0].frame, 4)
  assert.equal(rep.problems[0].autoFixable, true)
  assert.match(rep.summary, /38,000/); ok()
}
{
  // send(): check says frame 1 would run out of gas → fix → check passes → send → included, with the fix recorded
  const sims = [
    { frames: [[100, true], [16_000, false]], status: 'reverted' },
    { frames: [[100, true], [18_461, true]], status: 'success' },
  ]
  let i = 0
  const sim = () => { const x = sims[i++]; return { canonicalMempoolValid: true, canonicalMempoolViolation: null, prefixShape: 'SelfVerify', payer: me, maxCost: '0x1', gasUsed: '0x0', executionStatus: x.status, executionError: null, frames: x.frames.map(([g, k]) => ({ gasUsed: '0x' + Number(g).toString(16), succeeded: k })) } }
  const included = { ...load('paid-in-tusd').tx }
  const steps: string[] = []
  const c = connect({
    ethrex: fake({ ethrex_simulateFrameTransaction: sim, eth_getTransactionCount: () => '0x3', eth_gasPrice: () => '0x1', eth_getTransactionReceipt: () => load('paid-in-tusd').receipt }).t,
    miner: fake({ eth_sendFrameTransaction: () => '0xbeef', skandha_explorer_getTransaction: () => included }).t,
    chainId: 1337,
  })
  const tx = await c.prepare({ from: me, calls: [{ to: A.token, data: transferData(to, 1n), gas: 16_000n }], payGas: payWithEth() })
  assert.equal(tx.draft.nonce, 3n)
  assert.deepEqual(tx.draft.frames.map((f) => f.mode), [1, 2]) // the sender's own VERIFY, then the call
  const res = await c.send(tx, key, { onStep: (s) => steps.push(s) })
  assert.equal(res.status, 'included')
  assert.equal(res.hash, '0xbeef')
  assert.deepEqual(res.fixes, ['frame 1 gas 16,000 → 20,000'])
  assert.equal(res.tx.draft.frames[1].gas, 20_000n)
  assert.deepEqual(steps, ['checking', 'fixing', 'checking', 'sending', 'waiting', 'done']); ok()
}
{
  // send(): a problem with no automatic fix → status 'blocked', nothing sent
  let sent = false
  const c = connect({
    ethrex: fake({ eth_getTransactionCount: () => '0x0', eth_gasPrice: () => '0x1', ethrex_simulateFrameTransaction: () => ({ canonicalMempoolValid: false, canonicalMempoolViolation: null, prefixShape: null, payer: null, maxCost: '0x1', gasUsed: null, frames: null, executionStatus: null, executionError: null, haltReason: 'insufficient_funds', balance: '0x0', required: '0x10' }) }).t,
    miner: fake({ eth_sendFrameTransaction: () => { sent = true; return '0x1' } }).t,
    chainId: 1337,
  })
  const res = await c.send(await c.prepare({ from: me, calls: [{ to: A.token }] }), key)
  assert.equal(res.status, 'blocked')
  assert.equal(res.problems[0].code, 'PAYER_CANNOT_COVER')
  assert.equal(sent, false); ok()
}
{
  // mempool(): summary, reasons, and a rejections list to feed into why()
  const c = connect({ ethrex: fake({}).t, miner: fake({ skandha_explorer_listAdmissions: () => ({ items: [
    { txHash: '0xa1', outcome: 'rejected', sender: '0xs', at: 1, checks: [{ rule: 'prefix', verdict: 'fail', detail: 'prefix gas budget exceeded' }] },
    { txHash: '0xa2', outcome: 'included', sender: '0xt', at: 120_001, checks: [] },
  ] }) }).t, chainId: 1337 })
  const m = await c.mempool()
  assert.equal(m.summary, '1 of the last 2 transactions were rejected, from 1 sender, over 2 min.')
  assert.deepEqual(m.topReasons, [{ rule: 'prefix', count: 1 }])
  assert.deepEqual(m.rejections, [{ hash: '0xa1', outcome: 'rejected', reason: 'prefix gas budget exceeded' }]); ok()
}
console.log(`sdk: ${cases} offline cases OK`)

// 5. Live, read-only (public devnet). Nothing is sent.
if (process.argv.includes('--live')) {
  const dep = JSON.parse(readFileSync(new URL('./fixtures/devnet-1337.json', import.meta.url), 'utf8'))
  const r = createReadmit(ALT_MEMPOOL_DEVNET)
  const gold = '0x3fd93ca4a082d636d08fc27a8afd65b6449dda7aff6609736e8f080064724b9c'
  const dx = await r.explain(gold)
  console.log('live explain:', dx.node, '|', dx.mempool.headline, '|', dx.chain.headline, '|', dx.findings[0].title)
  const st = await r.stats(200)
  console.log(`live stats: ${st.rejected} of the last ${st.total} rejected, ${st.senders} senders, top ${st.topRules.map(([k, v]) => `${k}×${v}`).join(', ')}`)
  const pm = erc20Paymaster(r, { token: dep.tUSD, paymaster: dep.paymaster })
  const d = await pm.transfer(dep.demoWallet, to, 1_000_000n)
  console.log(`live build: nonce ${d.nonce}, maxFee ${d.maxFeePerGas}, fee frame quoted ${d.frames[2].data.slice(-16)}`)
  const run = await r.dryRun(d, key) // wrong key for the demo wallet on purpose: the node must refuse the signature
  console.log('live dry run (wrong key, expected to fail):', run.ok, '|', run.diagnosis.findings[0].title, '|', run.simulation.canonicalMempoolViolation)
  const viemClient = createPublicClient({ transport: http(ALT_MEMPOOL_DEVNET.ethrex) }).extend(frameActions({ miner: ALT_MEMPOOL_DEVNET.miner, gateway: ALT_MEMPOOL_DEVNET.gateway, chainId: 1337 }))
  console.log('live viem extend:', (await viemClient.explainFrameTransaction(gold)).chain.headline)
  const viaEthers = createReadmit({ ...ALT_MEMPOOL_DEVNET, ethrex: ethersTransport(new JsonRpcProvider(ALT_MEMPOOL_DEVNET.ethrex as string, 1337, { staticNetwork: true })) })
  console.log('live ethers transport:', (await viaEthers.explain(gold)).chain.headline)
}
