// The plugin's worker. Orca transpiles this file when it loads it: no build step.
// A skeleton for now: the MVP's tasks give it its functions.
import type { OrcaWorkerApi } from 'orca/worker'

export default function activate(orca: OrcaWorkerApi): void {
  orca.log('agent-queue-kit: worker started')
}
