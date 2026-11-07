// Journey 4: "What is the mempool rejecting right now?"
//
//   node examples/4-watch-the-mempool.ts
import { connect } from '../src/index.ts' // in your project: from '@readmit/sdk'

const readmit = connect('devnet')
const m = await readmit.mempool({ last: 200 })

console.log(m.summary)
console.log('\nTop reasons:')
for (const r of m.topReasons) console.log(`  ${String(r.count).padStart(4)}× ${r.rule}`)
console.log('\nLatest rejections:')
for (const t of m.rejections.slice(0, 8)) console.log(`  ${t.hash}  ${t.reason?.slice(0, 90) ?? ''}`)
console.log('\nAsk why any of them failed:  node examples/1-why-did-it-fail.ts <hash>')
