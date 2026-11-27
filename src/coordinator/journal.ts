// The coordinator's journal of its claims on this computer (TZ «Данные», «Состояние на компьютере»: журнал координатора),
// in the plugin's data directory beside the task's agents:
//
//   projects/<проект>/issue-<N>/claims/<отсчёт>/<запись>
//
// One small file per record — the time it was written — created once and never rewritten (Machine.createText): a record
// survives a restart of the worker, and two writes of one record are one. The records of a count:
//
// - `claimed`   — this coordinator wrote the claim (or the takeover) of this count;
// - `labelled`  — `agent-queue:working` was on the task for this count: this coordinator set it, or saw it there while
//   it held the count. The re-read of the claim comes REREAD_AFTER_MS after this record. Without it a leader that
//   finds no label sets it (the write after the claim failed, Ф4);
// - `confirmed` — the label was on at a check LATE_WRITE_MS or more after the claim, when no write of a former leader
//   can land any more: a label that is gone after it was taken off by a person — the owner — and the leader releases
//   the count. Before it, on a task with an earlier count, a label that is gone is set again (it may be a former
//   leader's late write); on a task without one it is the owner's at once;
// - `led`       — the claim is complete and this coordinator leads the count: the point where the agents start;
// - `releasing` — this coordinator decided to release the count because the owner took `working` off: the release is
//   written (again, if GitHub's answer was lost) until GitHub shows it;
// - `yielded`   — this coordinator led the count and found that it does not any more (a newer count);
// - `handled`   — the count it led is lost or released, and the local handling of that (the hook `lost`: the agents
//   stop, their work is saved) has finished. Until then every check runs it again.
//
// `<проект>` is the name the agents' records use (src/agents/agents.ts): from the project's id and its host, so copies
// of one project on two hosts never share it. The directory `claims` is the coordinator's own: no other record of the
// plugin lives there.
import type { ProjectRef } from '../agents/agents'
import type { Machine } from '../platform/machine'
import { dataName, dataPath } from '../platform/paths'

export const JOURNAL_DIR = 'claims'

export const JOURNAL_RECORDS = ['claimed', 'labelled', 'confirmed', 'led', 'releasing', 'yielded', 'handled'] as const
export type JournalRecord = (typeof JOURNAL_RECORDS)[number]

export class ClaimJournal {
  constructor(
    private readonly machine: Pick<Machine, 'platform' | 'readText' | 'createText' | 'listEntries' | 'now'>,
    private readonly dataDir: string,
  ) {}

  has(project: ProjectRef, issue: number, count: number, record: JournalRecord): boolean {
    return this.machine.readText(this.file(project, issue, count, record)) !== null
  }

  // When the record was written (the machine's clock), or null when there is none or it holds no time.
  time(project: ProjectRef, issue: number, count: number, record: JournalRecord): number | null {
    const text = this.machine.readText(this.file(project, issue, count, record))
    const time = text === null ? Number.NaN : Date.parse(text.trim())
    return Number.isFinite(time) ? time : null
  }

  // Writes the record once; a record already there stays as it is. Throws when the disk refuses it.
  async write(project: ProjectRef, issue: number, count: number, record: JournalRecord): Promise<void> {
    const time = new Date(this.machine.now()).toISOString()
    await this.machine.createText(this.file(project, issue, count, record), `${time}\n`)
  }

  // The counts of the task this coordinator has records of, in order.
  counts(project: ProjectRef, issue: number): number[] {
    const entries = this.machine.listEntries(dataPath(this.machine, this.dataDir, ...this.names(project, issue))) ?? []
    return entries
      .filter((entry) => entry.kind === 'directory' && /^[1-9][0-9]*$/.test(entry.name))
      .map((entry) => Number(entry.name))
      .sort((a, b) => a - b)
  }

  // The issues of the project this coordinator has records of.
  issues(project: ProjectRef): number[] {
    const names = ['projects', dataName(JSON.stringify([project.id, project.hostId]))]
    const entries = this.machine.listEntries(dataPath(this.machine, this.dataDir, ...names)) ?? []
    return entries
      .filter((entry) => entry.kind === 'directory' && /^issue-[1-9][0-9]*$/.test(entry.name))
      .map((entry) => Number(entry.name.slice('issue-'.length)))
      .filter((issue) => this.counts(project, issue).length > 0)
      .sort((a, b) => a - b)
  }

  // The file of a record.
  file(project: ProjectRef, issue: number, count: number, record: JournalRecord): string {
    if (!Number.isSafeInteger(count) || count < 1) throw new Error(`not a claim count: ${count}`)
    return dataPath(this.machine, this.dataDir, ...this.names(project, issue), String(count), record)
  }

  private names(project: ProjectRef, issue: number): string[] {
    if (!Number.isSafeInteger(issue) || issue < 1) throw new Error(`not an issue number: ${issue}`)
    return ['projects', dataName(JSON.stringify([project.id, project.hostId])), `issue-${issue}`, JOURNAL_DIR]
  }
}
