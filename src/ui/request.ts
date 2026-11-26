// A screen's request to the worker and its common states: loading (placeholder rows), error (the error text and
// «Повторить», which runs the same request again) and ready (the answer). See ./states.tsx for how they look.
import { atom, set, type Atom } from 'orca'

export type RequestState<T> =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; data: T }

export type Resource<T> = {
  readonly state: Atom<RequestState<T>>
  /** Runs the request (again): loading, then ready or error. Only the latest run's answer is shown. */
  load(): Promise<void>
  /** Shows `data` as the answer, e.g. what the worker posted; a run still under way no longer counts. */
  resolve(data: T): void
}

/** A request the screen runs with `load()`; until the first run it is loading. */
export function resource<T>(run: () => Promise<T>): Resource<T> {
  const state = atom<RequestState<T>>({ status: 'loading' })
  let runs = 0
  return {
    state,
    async load() {
      const mine = ++runs
      set(state, { status: 'loading' })
      try {
        const data = await run()
        if (mine === runs) set(state, { status: 'ready', data })
      } catch (error) {
        if (mine === runs) set(state, { status: 'error', message: errorMessage(error) })
      }
    },
    resolve(data) {
      runs++
      set(state, { status: 'ready', data })
    },
  }
}

/** What the worker's error says (a rejected `plugin.request` carries its message), or its code. */
function errorMessage(error: unknown): string {
  if (error && typeof error === 'object') {
    const { message, code } = error as { message?: unknown; code?: unknown }
    if (typeof message === 'string' && message.trim()) return message
    if (typeof code === 'string' && code) return code
  }
  return String(error)
}
