// The periodic check of the queue (TZ Ф4, the introduction): while Orca is open — the worker runs — and the coordinator
// of this computer is on (`coordinatorEnabled`), once per interval (`queueCheckInterval`, minutes, 5 by default) the
// coordinator checks the queue of every connected project (Coordinator.checkQueue). With the coordinator off a check
// does nothing: the coordinator of this computer takes and leads no task. Whether a project's queue is stopped is the
// coordinator's own question (CoordinatorOptions.queueStopped).
//
// - The plugin's settings are read at every check, so a change counts from the next one; a change of the interval
//   moves the check already planned at once: the next check comes one new interval after the last one (or after the
//   start).
// - The first check comes one interval after the start of the worker. The settings are not read at the start: the
//   worker wakes after the shortest interval (1 minute), reads them, and waits for the rest of the interval.
// - One check at a time: the next one is planned when the last one has ended.
// - A timer waits at most MAX_TIMER_MS (what a timer of Node.js can wait); a longer interval wakes and waits again.
import type { SettingsApi } from 'orca'
import { errorMessage } from '../platform/machine'
import { MIN_INTERVAL_MINUTES, readSettings, SETTING_KEYS } from '../settings'
import type { Coordinator, QueueProject } from './coordinator'

export const MINUTE_MS = 60_000
export const MAX_TIMER_MS = 2 ** 31 - 1

export type Timers = {
  set(run: () => void, ms: number): unknown
  clear(handle: unknown): void
}

// Node's timers; a pending one does not keep the worker's process alive.
export const realTimers: Timers = {
  set: (run, ms) => {
    const handle = setTimeout(run, ms)
    ;(handle as { unref?: () => void }).unref?.()
    return handle
  },
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export type QueueCheckOptions = {
  readonly settings: Pick<SettingsApi, 'get' | 'onDidChange'>
  // Null when the worker has no coordinator id (the data directory could not give one): no check runs.
  readonly coordinator: Pick<Coordinator, 'checkQueue'> | null
  // The connected projects at the moment of a check.
  readonly projects: () => Promise<readonly QueueProject[]>
  readonly now: () => number
  readonly timers?: Timers
  readonly log?: (line: string) => void
}

export type QueueCheck = {
  // Stops planning checks; a check under way ends by itself.
  stop(): void
  // The check under way, or null.
  readonly current: Promise<void> | null
  // Resolves when no check runs and no new plan after a change of the interval is pending.
  idle(): Promise<void>
}

export function startQueueCheck(options: QueueCheckOptions): QueueCheck {
  const timers = options.timers ?? realTimers
  const log = (line: string) => options.log?.(`agent-queue: queue check: ${line}`)
  let stopped = false
  let timer: unknown = null
  let current: Promise<void> | null = null
  let replanning: Promise<void> | null = null
  // The end of the last check (the start of the worker before the first one), and the interval read last; null until
  // the settings were read.
  let since = options.now()
  let interval: number | null = null

  const arm = (wait: number) => {
    if (stopped) return
    if (timer !== null) timers.clear(timer)
    timer = timers.set(wake, Math.max(0, Math.min(wait, MAX_TIMER_MS)))
  }

  const plan = async () => {
    try {
      interval = (await readSettings(options.settings)).queueCheckInterval
    } catch (error) {
      log(`the plugin's settings were not read: ${errorMessage(error)}`)
      interval ??= MIN_INTERVAL_MINUTES
    }
    return since + interval * MINUTE_MS
  }

  const wake = () => {
    timer = null
    if (stopped || current !== null) return
    current = (async () => {
      const due = await plan()
      if (options.now() < due) {
        arm(due - options.now())
        return
      }
      await check()
      since = options.now()
      const next = await plan()
      arm(next - options.now())
    })().finally(() => {
      current = null
    })
  }

  // One check; it never throws: whatever fails is in the log, and the next check is planned as ever.
  const check = async () => {
    try {
      const settings = await readSettings(options.settings)
      if (!settings.coordinator || options.coordinator === null) return
      await options.coordinator.checkQueue(await options.projects())
    } catch (error) {
      log(errorMessage(error))
    }
  }

  // A new interval moves the planned check at once; a check under way plans the next one by itself when it ends.
  const listening = options.settings.onDidChange((change) => {
    if (change.key !== SETTING_KEYS.queueCheckInterval || stopped || current !== null) return
    const replan: Promise<void> = plan()
      .then((due) => {
        if (current === null) arm(due - options.now())
      })
      .finally(() => {
        if (replanning === replan) replanning = null
      })
    replanning = replan
  })

  arm(MIN_INTERVAL_MINUTES * MINUTE_MS)
  return {
    stop() {
      stopped = true
      listening.dispose()
      if (timer !== null) timers.clear(timer)
      timer = null
    },
    get current() {
      return current
    },
    async idle() {
      while (current !== null || replanning !== null) await (current ?? replanning)
    },
  }
}
