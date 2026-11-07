// Manual walkthrough of every SDK feature against the live EF alt-mempool devnet (chain 1337).
//
//   npm run try                              read-only: 17 steps, nothing is sent, no key needed
//   npm run try -- --hash 0x…                also explain this transaction (anyone's: paste from the explorer or Readmit)
//   npm run try -- --new-key                 print a fresh devnet key + address to fund (then use --send)
//   READMIT_KEY=0x… npm run try -- --send    real sends with your devnet key: asks before each one (--yes to skip)
//
// Each step prints PASS / FAIL with what to look at. Exit code 1 if any step failed.
import { createInterface } from 'node:readline/promises'
import { readFileSync } from 'node:fs'
import { createPublicClient, encodeFunctionData, formatUnits, http, type Address, type Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount, sign } from 'viem/accounts'
import {
  ALT_MEMPOOL_DEVNET, FINDING_CODES, RpcError, SCOPE, TxNotIncluded, WaitTimeout, applyPatch, createReadmit, decodeDraft, errorString,
  frameActions, lookupSelectors, maxCostBound, rawTxHash, role, senderFrame, signDraft, signingHash, verifyFrame, type Diagnosis, type Draft,
} from '../src/index.ts'
import { ethersSigner, ethersTransport } from '../src/ethers.ts'
import { erc20Paymaster, transferData } from '../recipes/erc20Paymaster.ts'

const args = process.argv.slice(2)
const flag = (f: string) => args.includes(f)
const opt = (f: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined }
const dep = JSON.parse(readFileSync(new URL('../test/fixtures/devnet-1337.json', import.meta.url), 'utf8'))
const GOLDEN = '0x3fd93ca4a082d636d08fc27a8afd65b6449dda7aff6609736e8f080064724b9c' as Hex
const DEAD = '0x000000000000000000000000000000000000dEaD' as Address
const EXPLORER = (h: string) => `https://explorer.altmempool.wtf/tx/${h}?node=${encodeURIComponent(ALT_MEMPOOL_DEVNET.miner)}`

const B = '\x1b[1m', D = '\x1b[2m', G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', X = '\x1b[0m'
let step = 0, failed = 0
async function check(title: string, fn: () => Promise<string | string[]>) {
  step++
  process.stdout.write(`\n${B}${String(step).padStart(2)}. ${title}${X}\n`)
  try {
    const out = await fn()
    for (const l of [out].flat()) console.log(`    ${l}`)
    console.log(`    ${G}PASS${X}`)
  } catch (e) {
    failed++
    console.log(`    ${R}FAIL${X} ${(e as Error).message}`)
  }
}
const must = (cond: unknown, msg: string) => { if (!cond) throw new Error(msg) }
const show = (dx: Diagnosis) => [
  `mempool: ${dx.mempool.headline}  |  chain: ${dx.chain.headline}  |  ERC-8421: ${dx.spec.headline}`,
  ...dx.findings.map((f) => `${f.tone === 'fail' ? R : f.tone === 'warn' ? Y : G}[${f.code}]${X} ${f.title}${f.fix ? `${D} → ${f.fix}${X}` : ''}${f.patch ? `${D}  patch ${JSON.stringify(f.patch)}${X}` : ''}`),
]

if (flag('--new-key')) {
  const k = generatePrivateKey()
  console.log(`New devnet key (test only, never use for real funds):\n  READMIT_KEY=${k}\n  address     ${privateKeyToAccount(k).address}`)
  console.log('Fund the address with a little devnet ETH (https://docs.altmempool.wtf/guides/devnet/), then run:\n  READMIT_KEY=<key> npm run try -- --send')
  process.exit(0)
}

if (flag('--send') && !process.env.READMIT_KEY) {
  console.log('--send needs READMIT_KEY (a devnet key). Make one with: npm run try -- --new-key')
  process.exit(1)
}

const r = createReadmit(ALT_MEMPOOL_DEVNET)
const pm = erc20Paymaster(r, { token: dep.tUSD, paymaster: dep.paymaster })
const probeKey = generatePrivateKey() // throwaway, holds nothing: used to show real diagnoses of an unfunded account
const probe = privateKeyToAccount(probeKey).address
console.log(`${B}@readmit/sdk manual test${X} · ethrex ${ALT_MEMPOOL_DEVNET.ethrex} · miner ${ALT_MEMPOOL_DEVNET.miner} · chain ${ALT_MEMPOOL_DEVNET.chainId}`)
console.log(`${D}Read-only unless --send. Throwaway probe account ${probe} (no funds).${X}`)

let rows: Awaited<ReturnType<typeof r.recent>> = []

// --- Config & node access --------------------------------------------------------------------------------------
await check('Config + node access (createReadmit, request)', async () => {
  const [chain, block] = await Promise.all([r.request<string>('eth_chainId'), r.request<string>('eth_blockNumber')])
  must(Number(chain) === 1337, `chain id ${Number(chain)}, expected 1337`)
  const code = await r.request<string>('eth_getCode', [dep.paymaster, 'latest'])
  must(code.length > 2, 'our paymaster has no code: the devnet was reset, redeploy (Readmit contracts/)')
  return [`chain ${Number(chain)}, block ${Number(block).toLocaleString()}`, `paymaster ${dep.paymaster} deployed (${(code.length - 2) / 2} bytes)`]
})

// --- Explain ------------------------------------------------------------------------------------------------------
await check('Explain a sent tx by hash (explain → getTx + getReceipt + diagnose)', async () => {
  const dx = await r.explain(GOLDEN)
  must(dx.chain.headline === 'Executed', `chain says ${dx.chain.headline}`)
  return [`golden tx ${GOLDEN.slice(0, 12)}… (gas paid in tUSD, 0 ETH sender), seen by ${dx.node}`, ...show(dx), `${D}${EXPLORER(GOLDEN)}${X}`]
})

const userHash = opt('--hash') as Hex | undefined
if (userHash) await check(`Explain your hash ${userHash.slice(0, 12)}…`, async () => { const dx = await r.explain(userHash); return [`seen by ${dx.node}`, ...show(dx)] })

// --- Monitoring ---------------------------------------------------------------------------------------------------
await check('Mempool monitoring (recent, stats)', async () => {
  rows = await r.recent(200)
  const s = await r.stats(200)
  must(rows.length > 0, 'the sidecar returned no admissions')
  const mins = Math.round(s.spanMs / 60_000)
  return [`${s.rejected} of the last ${s.total} decisions were rejections, from ${s.senders} senders, over ${mins} min`, `top rules: ${s.topRules.map(([k, v]) => `${k} ×${v}`).join(', ') || 'none'}`]
})

const rejected = rows.find((x) => x.outcome === 'rejected')
await check("Explain a live rejection from someone else (no block explorer has these)", async () => {
  must(rejected, 'no rejection in the last 200 decisions (quiet devnet): skip')
  const dx = await r.explain(rejected!.txHash as Hex)
  must(dx.findings.every((f) => FINDING_CODES.includes(f.code)), 'a finding has no stable code')
  return [`${rejected!.txHash}`, ...show(dx)]
})

// --- Tracking -----------------------------------------------------------------------------------------------------
await check('Tracking (txStage, watch, waitForInclusion)', async () => {
  const stage = await r.stage(GOLDEN)
  const seen: string[] = []
  await new Promise<void>((done) => { const stop = r.watch(GOLDEN, (s) => { seen.push(s); stop(); done() }, { intervalMs: 500 }) })
  const receipt = await r.waitForInclusion(GOLDEN, { timeoutMs: 20_000 })
  must(stage === 'included' && receipt.status === '0x1', `stage ${stage}, receipt ${receipt.status}`)
  return [`stage ${stage}; watch reported ${seen.join(' → ')}; receipt block ${Number(receipt.blockNumber).toLocaleString()}, ${receipt.frameReceipts.length} frame receipts`]
})

await check('Typed errors (TxNotIncluded, WaitTimeout, RpcError)', async () => {
  const out: string[] = []
  if (rejected) {
    const e = await r.waitForInclusion(rejected.txHash as Hex, { timeoutMs: 20_000 }).catch((x) => x)
    must(e instanceof TxNotIncluded, `expected TxNotIncluded, got ${e}`)
    out.push(`rejected hash → ${e.name} ${e.code}: ${e.diagnosis?.findings[0]?.code}`)
  }
  const t = await r.waitForInclusion(`0x${'ab'.repeat(32)}`, { timeoutMs: 3_000, intervalMs: 500 }).catch((x) => x)
  must(t instanceof WaitTimeout, `expected WaitTimeout, got ${t}`)
  out.push(`unknown hash → ${t.name} ${t.code}`)
  const bad = createReadmit({ ethrex: 'http://127.0.0.1:9', miner: 'http://127.0.0.1:9', chainId: 1337 })
  const x = await bad.getReceipt(GOLDEN).catch((e) => e)
  must(x instanceof RpcError, `expected RpcError, got ${x}`)
  out.push(`dead node → ${x.name} ${x.code} (${x.method})`)
  return out
})

// --- Building & signing -------------------------------------------------------------------------------------------
let generic: Draft | undefined
await check('Generic frame builder (buildFrameTx, verifyFrame, senderFrame)', async () => {
  generic = await r.buildFrameTx({
    sender: probe,
    frames: [
      verifyFrame(SCOPE.BOTH, { gas: 10_000n }), // the sender checks its own signature and pays its own gas
      senderFrame({ target: dep.tUSD, gas: 60_000n, stateGas: 100_000n, data: transferData(DEAD, 1n) }),
    ],
  })
  return [`nonce ${generic.nonce} (from the node), maxFeePerGas ${generic.maxFeePerGas}, ${generic.frames.length} frames: ${generic.frames.map((f) => role({ mode: f.mode, flags: f.flags ?? 0 } as any)).join(' · ')}`, `worst-case cost ${formatUnits(maxCostBound(generic), 18)} ETH (maxCostBound)`]
})

await check('Pluggable signers give identical bytes (key, viem account, custom signHash, ethers-shaped)', async () => {
  const d = generic!
  const byKey = await r.sign(d, probeKey)
  const byAccount = await r.sign(d, privateKeyToAccount(probeKey))
  const byCustom = await r.sign(d, { signHash: async (h) => { const s = await sign({ hash: h, privateKey: probeKey }); return `0x${s.yParity ? '01' : '00'}${s.r.slice(2)}${s.s.slice(2)}` as Hex } })
  const ethersLike = { signingKey: { sign: (digest: string) => { throw new Error(`sync ${digest}`) } } } // shape check only
  must(typeof ethersSigner(ethersLike) === 'object', 'ethersSigner shape')
  must(byKey === byAccount && byKey === byCustom, 'signers disagree')
  const back = decodeDraft(byKey)
  must(back.sender.toLowerCase() === probe.toLowerCase(), 'decode lost the sender')
  return [`tx hash ${rawTxHash(byKey)}`, `signing hash ${signingHash(d, 1337)}`, `decodeDraft round-trip OK; chain id 1 gives a different tx: ${(await signDraft(d, probeKey, 1)) !== byKey}`]
})

// --- Admission simulator ------------------------------------------------------------------------------------------
await check('Admission simulator: self-paid tx from an account with 0 ETH (dryRun → diagnoseDraft)', async () => {
  const run = await r.dryRun(generic!, probeKey)
  must(!run.ok, 'expected the dry run to fail: the probe has no ETH')
  return ['nothing broadcast; the node simulated it', ...show(run.diagnosis)]
})

let pmDraft: Draft | undefined
await check('ERC-20 paymaster recipe: gas paid in tUSD, live Uniswap v4 quote', async () => {
  pmDraft = await pm.transfer(probe, DEAD, 1_000_000n)
  const fee = await pm.quote(maxCostBound(pmDraft))
  return [`4 frames: ${pmDraft.frames.map((f) => role({ mode: f.mode, flags: f.flags ?? 0 } as any)).join(' · ')}`, `fee quoted live: ${formatUnits(fee, 6)} tUSD for up to ${formatUnits(maxCostBound(pmDraft), 18)} ETH of gas`]
})

await check('Admission simulator + fragility check on the paymaster tx (trace, sharedReads)', async () => {
  const run = await r.dryRun(pmDraft!, probeKey)
  return ['the probe holds 0 tUSD, so the paymaster refuses before it reads the pool price. With a funded sender (--send, step B) the same dry run also shows the SHARED_STATE_READ warning', ...show(run.diagnosis), `${D}canonical mempool: ${run.simulation.canonicalMempoolValid ? 'accepts' : `refuses (${run.simulation.canonicalMempoolViolation})`}${X}`]
})

await check('Fixes are data (applyPatch: gas patch, requote patch)', async () => {
  const tight = { ...pmDraft!, frames: pmDraft!.frames.map((f, i) => (i === 3 ? { ...f, gas: 16_000n } : f)) }
  const fixed = await applyPatch(tight, { kind: 'gas', frame: 3, gas: 20_000 })
  const re = await applyPatch(tight, { kind: 'requote' }, { requote: pm.requote })
  must(fixed.frames[3].gas === 20_000n, 'gas patch not applied')
  return [`gas patch: frame 3 limit ${tight.frames[3].gas} → ${fixed.frames[3].gas}`, `requote patch: fee ${formatUnits(BigInt('0x' + tight.frames[2].data.slice(-64)), 6)} → ${formatUnits(BigInt('0x' + re.frames[2].data.slice(-64)), 6)} tUSD (re-priced live for the new, lower gas limits)`]
})

await check('Fix loop stops before broadcasting (sendDraft with a send-blocking node)', async () => {
  const guarded = createReadmit({ ...ALT_MEMPOOL_DEVNET, miner: async (m, p) => { if (m === 'eth_sendFrameTransaction') throw new Error('blocked by the manual test'); return fetch(ALT_MEMPOOL_DEVNET.miner, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: m, params: p }) }).then((x) => x.json()).then((j) => j.result) } })
  const e = await guarded.sendDraft(pmDraft!, probeKey).catch((x) => x)
  must(e?.code === 'DRY_RUN_FAILED', `expected DryRunFailed, got ${e}`)
  return [`${e.name} ${e.code}: "${e.message}"`, 'the problem has no automatic fix (needs tUSD), so sendDraft refused to broadcast']
})

// --- Revert reasons & decoders --------------------------------------------------------------------------------------
await check('Revert reason replay (replay)', async () => {
  const sim = await r.replay(GOLDEN)
  return [sim === null ? 'golden tx is older than ~128 blocks: replay correctly returns null (ethrex pruned that state)' : `replayed: ${sim.executionStatus}, failed frame ${sim.failedFrameIndex ?? 'none'}`]
})

await check('Decoders (errorString, role, lookupSelectors)', async () => {
  const underpaid = '0x08c379a000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000009756e6465727061696400000000000000000000000000000000000000000000000' as Hex
  const sel = encodeFunctionData({ abi: [{ type: 'function', name: 'transfer', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] }], functionName: 'transfer', args: [DEAD, 1n] }).slice(0, 10)
  const names = await lookupSelectors([sel])
  must(errorString(underpaid) === 'underpaid', 'errorString')
  return [`errorString → "${errorString(underpaid)}"`, `role(VERIFY, payment) → "${role({ mode: 1, flags: 1 } as any)}"`, `lookupSelectors(${sel}) → ${names.get(sel) ?? 'unknown (Sourcify unreachable?)'}`]
})

// --- Integrations ---------------------------------------------------------------------------------------------------
await check('viem integration (publicClient.extend(frameActions))', async () => {
  const c = createPublicClient({ transport: http(ALT_MEMPOOL_DEVNET.ethrex) }).extend(frameActions({ miner: ALT_MEMPOOL_DEVNET.miner, gateway: ALT_MEMPOOL_DEVNET.gateway, chainId: 1337 }))
  const dx = await c.explainFrameTransaction(GOLDEN)
  return [`client.explainFrameTransaction → ${dx.chain.headline}`]
})

await check('ethers integration (ethersTransport with an ethers-style provider)', async () => {
  const provider = { send: (method: string, params: any[]) => fetch(ALT_MEMPOOL_DEVNET.ethrex, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }).then((x) => x.json()).then((j) => j.result) }
  const viaEthers = createReadmit({ ...ALT_MEMPOOL_DEVNET, ethrex: ethersTransport(provider) })
  const receipt = await viaEthers.getReceipt(GOLDEN)
  return [`receipt via an ethers-shaped provider: block ${Number(receipt!.blockNumber).toLocaleString()}`, `${D}with real ethers: ethersTransport(new JsonRpcProvider(url)), ethersSigner(new Wallet(key))${X}`]
})

// --- Optional: real sends ---------------------------------------------------------------------------------------------
if (flag('--send')) {
  const key = process.env.READMIT_KEY as Hex | undefined
  if (!key) { console.log(`\n${R}--send needs READMIT_KEY (a devnet key). Make one with: npm run try -- --new-key${X}`); process.exit(1) }
  const me = privateKeyToAccount(key).address
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const ask = async (q: string) => flag('--yes') || /^y/i.test(await rl.question(`    ${Y}${q} [y/N] ${X}`))
  const balances = async () => {
    const [eth, raw] = await Promise.all([
      r.request<string>('eth_getBalance', [me, 'latest']).then(BigInt),
      r.request<Hex>('eth_call', [{ to: dep.tUSD, data: `0x70a08231${me.slice(2).toLowerCase().padStart(64, '0')}` }, 'latest']).then(BigInt),
    ])
    return { eth, tusd: raw }
  }
  const follow = async (hash: Hex) => {
    console.log(`    sent ${hash}\n    ${D}${EXPLORER(hash)}${X}`)
    try {
      const rc = await r.waitForInclusion(hash, { timeoutMs: 120_000 })
      return `included in block ${Number(rc.blockNumber).toLocaleString()}, status ${rc.status}`
    } catch (e) {
      if (e instanceof TxNotIncluded) return `${e.code}: ${e.diagnosis?.findings[0]?.title ?? ''}`
      throw e
    }
  }

  await check(`Send A: mint 100 tUSD to yourself, gas paid in ETH (${me})`, async () => {
    const b = await balances()
    if (b.tusd >= 10_000_000n) return `you already hold ${formatUnits(b.tusd, 6)} tUSD: skipped`
    must(b.eth > 0n, `${me} has 0 ETH and 0 tUSD: fund it with devnet ETH first (https://docs.altmempool.wtf/guides/devnet/)`)
    const mint = encodeFunctionData({ abi: [{ type: 'function', name: 'mint', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [] }], functionName: 'mint', args: [me, 100_000_000n] })
    const d = await r.buildFrameTx({ sender: me, frames: [verifyFrame(SCOPE.BOTH, { gas: 10_000n }), senderFrame({ target: dep.tUSD, gas: 60_000n, stateGas: 100_000n, data: mint })] })
    if (!(await ask('Send the mint tx now?'))) return 'skipped by you'
    const { hash } = await r.sendDraft(d, key)
    return [await follow(hash), `tUSD now ${formatUnits((await balances()).tusd, 6)}`]
  })

  await check('Send B: 1 tUSD with gas paid in tUSD, deliberately too little gas → dry run catches it → auto-fix → send', async () => {
    const d = await pm.transfer(me, DEAD, 1_000_000n)
    const tight = { ...d, frames: d.frames.map((f, i) => (i === 3 ? { ...f, gas: 16_000n } : f)) } // the transfer needs ~18.5k
    const pre = await r.dryRun(tight, key)
    console.log(...show(pre.diagnosis).map((l) => `    ${l}\n`))
    if (!(await ask('Let sendDraft fix it and send?'))) return 'skipped by you'
    const res = await r.sendDraft(tight, key, { requote: pm.requote })
    return [`fixed frame 3 gas: 16000 → ${res.draft.frames[3].gas}`, await follow(res.hash), `explain it: npm run try -- --hash ${res.hash}`]
  })
  rl.close()
}

console.log(`\n${failed ? R : G}${B}${step - failed} of ${step} steps passed${X}${failed ? `  (${failed} failed)` : ''}`)
process.exit(failed ? 1 : 0)
