// @readmit/sdk: build, dry-run, diagnose, fix, send and watch EIP-8141 frame transactions on an ERC-8421 alt mempool.
export { createReadmit, ALT_MEMPOOL_DEVNET, nextPollDelay, BACKOFF_AFTER_MS, type Readmit, type ReadmitConfig, type Transport, type NodeName, type WatchOptions } from './client.ts'
export {
  MODE, SCOPE, OVERHEAD, DEFAULT_PROFILE, verifyFrame, senderFrame, maxCostBound, toFrameTx, signingHash, signDraft, rawTxHash, decodeDraft, draftFrames, applyPatch, nonceSlot, checkNonceKeys,
  type Draft, type FrameSpec, type Signer, type Profile,
} from './frames.ts'
export { txStage, rejectionStats, FINAL_STAGES, type Stage, type AdmissionRow, type RejectionStats } from './monitor.ts'
export { ReadmitError, RpcError, DryRunFailed, TxNotIncluded, WaitTimeout } from './errors.ts'
export { lookupSelectors } from './selectors.ts'
export { frameActions } from './viem.ts'
// The diagnosis engine is shared with the Readmit app (pure, no network).
export {
  diagnose, diagnoseDraft, sharedReads, FINDING_CODES, errorString, role, isVerify,
  type Diagnosis, type Finding, type FindingCode, type Patch, type Verdict, type Tone, type Frame, type Simulation, type TxResult, type Receipt, type TraceFrame,
} from './diagnose.ts'
// The purpose-first API: connect() → why / prepare / check / send / follow / mempool.
export { connect, payWithEth, payWithToken, DEVNET_CONTRACTS, type ReadmitConnection, type Report, type Problem, type SendResult, type SendStep, type GasPayment, type Call, type PreparedTx } from './easy.ts'
