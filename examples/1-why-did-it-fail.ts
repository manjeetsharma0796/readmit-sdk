// Journey 1: "Why did my transaction fail?"
// Works for anyone's transaction, including ones the mempool rejected (those never reach a block explorer).
//
//   node examples/1-why-did-it-fail.ts                 a live rejection from the devnet right now
//   node examples/1-why-did-it-fail.ts 0x…             your own hash
import { connect } from '../src/index.ts' // in your project: from '@readmit/sdk'

const readmit = connect('devnet')

// No hash given? Take the newest rejection the devnet saw.
const hash = (process.argv[2] ?? (await readmit.mempool()).rejections[0]?.hash) as `0x${string}`
if (!hash) throw new Error('Pass a transaction hash')

const report = await readmit.why(hash)

console.log(`Transaction ${hash}`)
console.log(`Status:  ${report.status} (seen by the ${report.seenBy} node)`)
console.log(`Summary: ${report.summary}\n`)

for (const p of report.problems) {
  console.log(`✗ [${p.code}]${p.frame != null ? ` frame ${p.frame}` : ''}: ${p.message}`)
  console.log(`    why: ${p.why}`)
  if (p.fix) console.log(`    fix: ${p.fix}${p.autoFixable ? '  (readmit.send can apply this for you)' : ''}`)
}
for (const w of report.warnings) console.log(`! [${w.code}] ${w.message}`)
if (report.ok) console.log('✓ Nothing blocks this transaction.')
