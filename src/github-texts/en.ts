// The English catalog of the texts the plugin writes to GitHub (Ф15): progress, block and final comments, PR bodies and
// the texts of the «MVP» issue, for a project whose language (`language` in .agent-queue.json) is `en`. The task of
// each function adds its own texts here and in ./ru.ts, under the same keys. `{name}` marks a value the writer puts in.
export const en = {
  // The last line of a task's PR body (TZ «Данные», «PR задачи»): GitHub closes the issue when the PR is merged. GitHub
  // knows only its English keywords, so the Russian catalog keeps this line as it is.
  'pr.closes': 'Closes #{issue}',
  // The block of the «MVP» issue when the project's settings have no MVP acceptance stand (TZ Ф13, К13.6).
  'mvp.standMissing': 'Add the MVP acceptance stand to the project settings',

  // The title of the connection commit (Ф1, point 4); the operation's id follows in its own line.
  'connect.commitTitle': 'Agent Queue: connect the project to the queue',

  // The entry rule: the block the connection writes between the plugin's markers in CLAUDE.md and AGENTS.md of the
  // project (TZ Ф3, «Данные»). `{repository}` — the project's repository as `gh --repo` takes it.
  'entryRule.title': 'Agent Queue: the task queue of this project',
  'entryRule.who':
    'This rule is only for entry sessions: agents in the main checkout of this project. An agent in the worktree of a queue task (implementer, reviewer) does not follow it: it does the task it was given.',
  'entryRule.queue':
    'A change of the code of this project (a feature, a bug fix, a refactoring, a migration, a change of the interface) is made by the Agent Queue, not by the session:',
  'entryRule.questions': 'Settle every open question with the user first: the queue takes the task without asking you.',
  'entryRule.create': 'Put the task into the queue: an issue of the repository {repository} with the label `agent-queue`:',
  'entryRule.command': 'gh issue create --repo {repository} --label agent-queue --title "<short title>" --body-file <file with the text>',
  'entryRule.format':
    'Keep apart in the text of the task: «User request» (quoted word for word), «User decisions» and «Session proposals».',
  'entryRule.depends':
    'A task that needs the code of another open task gets the line «Depends on #N» (or «Зависит от #N») as a line of its own: the queue takes it once #N is closed.',
  'entryRule.data':
    'The task never holds data from production or real conversations: names, phone numbers, addresses, ids of real customers, keys and tokens.',
  'entryRule.answer': 'Answer the user with the link to the task.',
  'entryRule.self': 'When the user says «do it yourself» or «without the queue», the session makes the change itself.',
  'entryRule.settings':
    'The settings of the queue — `.agent-queue.json` and `.agent-queue.md` — are changed only by the owner, never by a queue task or a session.',
} as const satisfies Record<string, string>

export type GithubTextKey = keyof typeof en
