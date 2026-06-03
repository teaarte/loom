// Public barrel for `@loomfsm/daemon` — the long-lived supervisor over the
// headless `drive()` loop. It is the SECOND consumer of `@loomfsm/driver`'s
// `drive()` (after `loom run`), wrapping it in a process that drives one
// task to terminal while surviving human gates (park + wake), transient
// failures (retry + backoff), and process death (recover from the store on
// restart), and that owns the worktree lifecycle (commit-to-branch + GC).
//
// No daemon-specific kernel API: everything here is a transport + scheduler
// over `drive()` + existing kernel/driver primitives, bundle- and
// domain-blind (the daemon-leak gate enforces it).

export {
  superviseToTerminal,
  superviseWatch,
  detectStaleness,
  DEFAULT_RATE_LIMIT_WAIT_MS,
  DEFAULT_WATCH_ERROR_PARK_AFTER,
  type SuperviseOptions,
  type SupervisionResult,
  type ExecutorBuildContext,
  type StatusUpdater,
} from "./supervisor.js";

export {
  DEFAULT_RETRY_POLICY,
  defaultClassifier,
  backoffDelayMs,
  type RetryPolicy,
  type ErrorClassifier,
  type ErrorDisposition,
} from "./retry.js";

export { waitForWake, type WakeOptions, type WakeResult } from "./wake.js";

export {
  commitToBranchMergeBack,
  commitToBranchMergeBackFromClone,
  removeWorktree,
  removeClone,
  sweepOrphanWorktree,
  sweepOrphanClone,
  type MergeBackResult,
} from "./worktree-lifecycle.js";

export {
  createFileLogger,
  createMemoryLogger,
  nullLogger,
  type DaemonLogger,
  type LogEvent,
  type LogLevel,
  type FileLoggerOptions,
} from "./logger.js";

export {
  nullNotifier,
  createMemoryNotifier,
  webhookNotifier,
  multiNotifier,
  filterEvents,
  withProjectId,
  DEFAULT_NOTIFY_EVENTS,
  DEFAULT_NOTIFY_TIMEOUT_MS,
  type Notifier,
  type NotifyEvent,
  type NotifyEventName,
  type FetchLike,
  type WebhookNotifierOptions,
} from "./notify.js";

export {
  slackNotifier,
  telegramNotifier,
  scriptNotifier,
  formatEventText,
  type SlackNotifierOptions,
  type TelegramNotifierOptions,
  type ScriptNotifierOptions,
} from "./notify-channels.js";

export {
  acquireLock,
  readStatus,
  writeStatus,
  clearStatus,
  signalStop,
  isAlive,
  daemonDir,
  statusFilePath,
  DaemonError,
  type DaemonHandle,
  type DaemonStatus,
  type DaemonPhase,
  type StopResult,
  type AcquireOptions,
} from "./process-control.js";

export { systemClock, isoFrom, type Clock } from "./clock.js";
