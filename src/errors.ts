// Typed errors. Every SDK failure is a ReadmitError with a stable `code`, so callers can branch without parsing text.
import type { Diagnosis } from './diagnose.ts'
import type { Stage } from './monitor.ts'

export class ReadmitError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = new.target.name
    this.code = code
  }
}

/** A JSON-RPC call failed: the node was unreachable, answered with HTTP != 200, or returned an `error`. */
export class RpcError extends ReadmitError {
  readonly url: string
  readonly method: string
  readonly rpcCode?: number
  constructor(url: string, method: string, message: string, rpcCode?: number) {
    super(rpcCode != null ? `RPC_${rpcCode}` : 'RPC_UNREACHABLE', `${method} at ${url}: ${message}`)
    this.url = url
    this.method = method
    this.rpcCode = rpcCode
  }
}

/** The dry run found a problem, so nothing was sent. `diagnosis.findings[0]` says what and how to fix it. */
export class DryRunFailed extends ReadmitError {
  readonly diagnosis: Diagnosis
  constructor(diagnosis: Diagnosis) {
    const top = diagnosis.findings[0]
    super('DRY_RUN_FAILED', top ? `${top.title}. ${top.fix ?? top.why}` : 'The dry run failed')
    this.diagnosis = diagnosis
  }
}

/** The transaction reached a final stage other than `included`: rejected by the mempool, reverted on chain, or dropped. */
export class TxNotIncluded extends ReadmitError {
  readonly hash: string
  readonly stage: Stage
  readonly diagnosis: Diagnosis | null
  constructor(hash: string, stage: Stage, diagnosis: Diagnosis | null) {
    const top = diagnosis?.findings[0]
    super(`TX_${stage.toUpperCase()}`, `${hash} was ${stage}${top ? `: ${top.title}` : ''}`)
    this.hash = hash
    this.stage = stage
    this.diagnosis = diagnosis
  }
}

/** `waitForInclusion` gave up before the transaction reached a final stage. */
export class WaitTimeout extends ReadmitError {
  readonly hash: string
  readonly lastStage: Stage | null
  constructor(hash: string, lastStage: Stage | null, ms: number) {
    super('WAIT_TIMEOUT', `${hash} was still ${lastStage ?? 'unknown'} after ${Math.round(ms / 1000)} s`)
    this.hash = hash
    this.lastStage = lastStage
  }
}
