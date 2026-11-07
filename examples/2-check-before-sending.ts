// Journey 2: "Will my transaction get in?"
// Describe what you want to do, then dry-run it on the node. Nothing is broadcast.
//
//   node examples/2-check-before-sending.ts
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import { encodeFunctionData, parseAbi } from 'viem'
import { connect, payWithEth, payWithToken } from '../src/index.ts' // in your project: from '@readmit/sdk'

const readmit = connect('devnet')
const key = (process.env.READMIT_KEY ?? generatePrivateKey()) as `0x${string}` // a fresh, empty key unless you pass yours
const me = privateKeyToAccount(key).address

// What we want to do: send 1 tUSD to 0x…dEaD.
const transfer = encodeFunctionData({ abi: parseAbi(['function transfer(address,uint256)']), functionName: 'transfer', args: ['0x000000000000000000000000000000000000dEaD', 1_000_000n] })
const calls = [{ to: readmit.contracts.tUSD, data: transfer }]

for (const [label, payGas] of [['gas paid in ETH', payWithEth()], ['gas paid in tUSD (paymaster)', payWithToken()]] as const) {
  const tx = await readmit.prepare({ from: me, calls, payGas })
  const report = await readmit.check(tx, key)
  console.log(`\n${label}: ${report.ok ? '✓ would get in' : '✗ would not get in'}`)
  console.log(`  ${report.summary}`)
  for (const p of report.problems) console.log(`  [${p.code}] ${p.why}`)
}
console.log(`\n(${me} ${process.env.READMIT_KEY ? 'is your key' : 'is a fresh empty account, so both checks should say what is missing'})`)
