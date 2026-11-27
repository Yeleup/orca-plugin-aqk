// The project's rules for tasks: the file .agent-queue.md in the project's repository (TZ «Данные»): what to read before
// a task, the project's commands, what a worktree must never do. The plugin puts it whole into the tasks it gives its
// agents (TZ Ф4: the implementer's task carries it). The connection wizard (src/connect/) writes it from its template,
// in the project's language — ./templates.ts, which the panel's form reads too; then the owner edits it, and a queue
// task never changes it. It is read, like the settings, from the project's base branch (./base-branch.ts).
import { errorMessage, type Machine } from '../platform/machine'
import { readBaseBranchFile, REMOTE, type BaseBranchCommit } from './base-branch'

export const TASK_RULES_FILE = '.agent-queue.md'

export { taskRulesTemplate, type TaskRulesTemplateInput } from './templates'

export type ReadTaskRulesResult =
  | { readonly ok: true; readonly text: string; readonly source: BaseBranchCommit }
  // The base branch has no .agent-queue.md.
  | { readonly ok: false; readonly kind: 'missing'; readonly error: string; readonly source: BaseBranchCommit }
  // git failed, or the clone lacks the branch: nothing is known about the file.
  | { readonly ok: false; readonly kind: 'unreadable'; readonly error: string }

// The committed .agent-queue.md of origin/<baseBranch> (the base branch of the project's settings), as it is.
export async function readTaskRules(machine: Machine, checkout: string, baseBranch: string): Promise<ReadTaskRulesResult> {
  try {
    const file = await readBaseBranchFile(machine, checkout, baseBranch, TASK_RULES_FILE)
    const source = { branch: file.branch, commit: file.commit }
    if (!file.found) return { ok: false, kind: 'missing', error: `${REMOTE}/${baseBranch} has no ${TASK_RULES_FILE}`, source }
    return { ok: true, text: file.text, source }
  } catch (error) {
    return { ok: false, kind: 'unreadable', error: `${TASK_RULES_FILE}: ${errorMessage(error)}` }
  }
}
