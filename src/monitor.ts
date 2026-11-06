// Mempool monitoring: tx stages and rejection statistics. Pure functions, no network.
import type { Admission, TxResult } from './diagnose.ts'

export type Stage = 'pending' | 'admitted' | 'rejected' | 'included' | 'failed' | 'dropped'
export const FINAL_STAGES: readonly Stage[] = ['rejected', 'included', 'failed', 'dropped']

/** Maps the sidecar explorer's record to a stage (New/Pending/Submitted = admitted, OnChain/Finalized = included, ...). */
export function txStage(r: TxResult | null): Stage {
  if (!r) return 'pending'
  if (r.admission?.outcome === 'rejected') return 'rejected'
  switch (r.entry?.status) {
    case 'OnChain':
    case 'Finalized':
      return 'included'
    case 'Reverted':
      return 'failed'
    case 'Cancelled':
      return 'dropped'
    case 'New':
    case 'Pending':
    case 'Submitted':
      return 'admitted'
  }
  return r.admission?.outcome === 'included' ? 'included' : r.admission ? 'admitted' : 'pending'
}

export type AdmissionRow = Admission & { txHash: string }
export type RejectionStats = {
  total: number
  rejected: number
  /** Distinct senders among the rejected transactions. */
  senders: number
  /** Milliseconds between the oldest and newest decision in the sample. */
  spanMs: number
  /** Failing rules, most frequent first, verbatim from the sidecar. */
  topRules: [rule: string, count: number][]
}

/** "N of the last M were rejected, from K senders, over T; top rules …" from `recent()` rows. */
export function rejectionStats(rows: AdmissionRow[], top = 4): RejectionStats {
  const rejected = rows.filter((r) => r.outcome === 'rejected')
  const rules = new Map<string, number>()
  for (const r of rejected) for (const c of r.checks) if (c.verdict === 'fail') rules.set(c.rule, (rules.get(c.rule) ?? 0) + 1)
  const ats = rows.map((r) => r.at ?? 0).filter(Boolean)
  return {
    total: rows.length,
    rejected: rejected.length,
    senders: new Set(rejected.map((r) => r.sender).filter(Boolean)).size,
    spanMs: ats.length > 1 ? Math.max(...ats) - Math.min(...ats) : 0,
    topRules: [...rules].sort((a, b) => b[1] - a[1]).slice(0, top),
  }
}
