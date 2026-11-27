// The journal of operations (TZ «Данные», «Состояние на компьютере»: the operation's id, its steps and what is already
// written), in the plugin's data directory, per project: projects/<project>/operations/<operation id>/ — <project> the
// same plain name as the project's directory of the agents' records (src/agents/agents.ts). Each step is a JSON file
// of its own, created once and never rewritten (Machine.createText), so a record survives a stop of the worker or of
// Orca and is never seen half written:
//
// - intent.json — written before anything else is: the kind of the operation (`connect`), its id, the project, its
//   main checkout, the repository, the base branch, the source commit (HEAD of the checkout, equal to origin/<base>),
//   and the four paths, each with its blob id in the source commit (null: the commit lacks it) and the blob id of its
//   expected content (git's hash of the text the operation writes); the time;
// - labels.json — the plugin's labels created now and those already there;
// - files.json — the four files written into the working tree;
// - commit.json — the commit of the four files (its SHA);
// - push.json — the push: `pushed`, `rejected` with git's reason, or `unknown` (no answer in time);
// - undo.json — the local commit undone (or the written paths put back) after a failure, or why that failed;
// - failed.json — the step that failed and why.
//
// The interrupted connection (task `connect-recovery`) reads these to tell the state together with git.
import type { Machine } from '../platform/machine'
import { dataName, dataPath } from '../platform/paths'

export const OPERATIONS_DIR = 'operations'

export type JournalPath = {
  readonly path: string
  // The blob of the path in the source commit; null when the commit has no such path.
  readonly sourceBlob: string | null
  // The blob id of the content the operation writes.
  readonly expectedBlob: string
}

export type ConnectIntent = {
  readonly kind: 'connect'
  readonly operation: string
  readonly project: { readonly id: string; readonly hostId: string }
  readonly checkout: string
  readonly repository: string
  readonly baseBranch: string
  readonly sourceCommit: string
  readonly paths: readonly JournalPath[]
  readonly startedAt: string
}

export type JournalStep = 'intent' | 'labels' | 'files' | 'commit' | 'push' | 'undo' | 'failed'

export class OperationJournal {
  readonly dir: string
  private readonly names: string[]

  constructor(
    private readonly machine: Machine,
    dataDir: string,
    project: { readonly id: string; readonly hostId: string },
    readonly operation: string,
  ) {
    this.names = ['projects', dataName(JSON.stringify([project.id, project.hostId])), OPERATIONS_DIR, operation]
    this.dir = dataPath(machine, dataDir, ...this.names)
  }

  // The file of a step.
  file(step: JournalStep): string {
    return dataPath(this.machine, this.dir, `${step}.json`)
  }

  // Writes the record of `step`, with the time; throws when it cannot be written or is there already.
  async record(step: JournalStep, data: Record<string, unknown>): Promise<void> {
    const text = `${JSON.stringify({ step, operation: this.operation, at: new Date(this.machine.now()).toISOString(), ...data }, null, 2)}\n`
    if (!(await this.machine.createText(this.file(step), text))) throw new Error(`${this.file(step)} is there already`)
  }
}
