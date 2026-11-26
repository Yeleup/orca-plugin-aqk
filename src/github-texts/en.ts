// The English catalog of the texts the plugin writes to GitHub (Ф15): progress, block and final comments, PR bodies and
// the texts of the «MVP» issue, for a project whose language (`language` in .agent-queue.json) is `en`. The task of
// each function adds its own texts here and in ./ru.ts, under the same keys. `{name}` marks a value the writer puts in.
export const en = {
  // The last line of a task's PR body (TZ «Данные», «PR задачи»): GitHub closes the issue when the PR is merged. GitHub
  // knows only its English keywords, so the Russian catalog keeps this line as it is.
  'pr.closes': 'Closes #{issue}',
  // The block of the «MVP» issue when the project's settings have no MVP acceptance stand (TZ Ф13, К13.6).
  'mvp.standMissing': 'Add the MVP acceptance stand to the project settings',
} as const satisfies Record<string, string>

export type GithubTextKey = keyof typeof en
