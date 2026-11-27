// The coordinator's journal of its claims on this computer (TZ «Данные», «Состояние на компьютере»: журнал координатора),
// in the plugin's data directory beside the task's agents:
//
//   projects/<проект>/issue-<N>/claims/<отсчёт>/<запись>
//
// One small file per record — the time it was written — created once and never rewritten (Machine.createText): a record
// survives a restart of the worker, and two writes of one record are one. The records of a count:
//
// - `claimed`  — this coordinator wrote the claim (or the takeover) of this count;
// - `labelled` — `agent-queue:working` was on the task for this count: this coordinator set it, or saw it there while it
//   led the count. Without it a leader that finds no label sets it (the write after the claim failed, Ф4); with it, a
//   label that is gone was taken off by the owner, and the leader releases the count;
// - `led`      — the re-read after the claim decided that this coordinator leads the count: the point where the agents
//   of the task start;
// - `released` — this coordinator released the count (the owner took `working` off);
// - `yielded`  — this coordinator led the count and found that it does not any more (a newer count).
//
// `<проект>` is the name the agents' records use (src/agents/agents.ts): from the project's id and its host, so copies
// of one project on two hosts never share it. The directory `claims` is the coordinator's own: no other record of the
// plugin lives there.
import type { ProjectRef } from '../agents/agents'
import type { Machine } from '../platform/machine'
import { dataName, dataPath } from '../platform/paths'

export const JOURNAL_DIR = 'claims'

export const JOURNAL_RECORDS = ['claimed', 'labelled', 'led', 'released', 'yielded'] as const
export type JournalRecord = (typeof JOURNAL_RECORDS)[number]

export class ClaimJournal {
  constructor(
    private readonly machine: Pick<Machine, 'platform' | 'readText' | 'createText' | 'listEntries' | 'now'>,
    private readonly dataDir: string,
  ) {}

  has(project: ProjectRef, issue: number, count: number, record: JournalRecord): boolean {
    return this.machine.readText(this.file(project, issue, count, record)) !== null
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
