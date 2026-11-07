// Journey 3: "Send it and make sure it lands."
// check → fix what the check found → send → wait for inclusion. One call; you read `status`.
// This one sends a REAL transaction on the devnet, so it needs your devnet key and asks first.
//
//   READMIT_KEY=0x… node examples/3-send-and-make-sure-it-lands.ts
// Your key needs tUSD (or devnet ETH: run `npm run try -- --send` once, it mints 100 tUSD for you).
import { createInterface } from 'node:readline/promises'
import { privateKeyToAccount } from 'viem/accounts'
import { encodeFunctionData, parseAbi } from 'viem'
import { connect, payWithToken } from '../src/index.ts' // in your project: from '@readmit/sdk'

const key = process.env.READMIT_KEY as `0x${string}`
if (!key) throw new Error('Set READMIT_KEY to your devnet key (make one: npm run try -- --new-key)')
const readmit = connect('devnet')
const me = privateKeyToAccount(key).address

const transfer = encodeFunctionData({ abi: parseAbi(['function transfer(address,uint256)']), functionName: 'transfer', args: ['0x000000000000000000000000000000000000dEaD', 1_000_000n] })
// 16,000 gas is deliberately too little for this transfer (~18,500): watch send() notice and fix it.
const tx = await readmit.prepare({ from: me, calls: [{ to: readmit.contracts.tUSD, data: transfer, gas: 16_000n }], payGas: payWithToken() })

const rl = createInterface({ input: process.stdin, output: process.stdout })
if (!/^y/i.test(await rl.question(`Send 1 tUSD from ${me}, gas paid in tUSD? [y/N] `))) process.exit(0)
rl.close()

const result = await readmit.send(tx, key, { onStep: (step, detail) => console.log(`  … ${step}${detail ? `: ${detail}` : ''}`) })

console.log(`\nStatus:  ${result.status}`)
console.log(`Hash:    ${result.hash ?? '(not sent)'}`)
console.log(`Fixes:   ${result.fixes.join('; ') || 'none needed'}`)
console.log(`Summary: ${result.summary}`)
for (const p of result.problems) console.log(`  [${p.code}] ${p.why}`)
