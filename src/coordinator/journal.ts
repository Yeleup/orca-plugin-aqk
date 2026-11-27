// The coordinator's journal of its claims on this computer (TZ «Данные», «Состояние на компьютере»: журнал координатора),
// in the plugin's data directory — by GitHub repository, since a claim is a fact of the coordinator and the repository,
// not of an Orca project (two connected copies of one repository share it):
//
//   repositories/<репозиторий>/issue-<N>/claims/<отсчёт>/<запись>
//
// `<репозиторий>` is dataName (src/platform/paths.ts) of `host/owner/name` in lower case — the key of the task's queue
// too. The agents' records stay with the Orca project (`projects/<проект>/…`, src/agents/agents.ts).
//
// One small file per record, created once and never rewritten (Machine.createText): a record survives a restart of the
// worker, and two writes of one record are one. The records of a count:
//
// - `profile-<k>` — written right before the POST of a claim attempt: how the claim goes on — who completes and leads it
//   after a failure or a restart (`queue`: the check of the queue; `caller`: the code that claimed it, when it asks
//   again) and the labels of its stage (JSON). A new attempt takes the next number unless its profile is the last one's;
//   the profile of the count is the file with the highest number;
// - `claimed`   — this coordinator wrote the claim (or the takeover) of this count;
// - `labelled`  — `agent-queue:working` was on the task for this count: this coordinator set it, or saw it there while
//   it held the count. The re-read of the claim comes REREAD_AFTER_MS after this record. Without it a leader that
//   finds no label sets it (the write after the claim failed, Ф4); with it, a label that is gone is decided by
//   removalOrigin (claims.ts) — the owner's removal or a late write of a former leader;
// - `led`       — the claim is complete and this coordinator leads the count through one Orca project: the record keeps
//   that project (its id and host). Only the completion that created it starts the agents, and only that project leads
//   the count on this computer;
// - `releasing` — this coordinator decided to release the count because the owner took `working` off: the release is
//   written (again, if GitHub's answer was lost or refused) before anything else of the count, until GitHub shows it;
// - `yielded`   — this coordinator led the count and found that it does not any more (a newer count);
// - `handled`   — the count it led is lost or released, and the local handling of that (the hook `lost`: the agents
//   stop, their work is saved) has finished — or none is needed: it ended the count itself by a block or a deferral.
//   Until then every check runs it again.
import type { ProjectRef } from '../agents/agents'
import type { Repository } from '../github/gh'
import type { Machine } from '../platform/machine'
import { dataName, dataPath } from '../platform/paths'

export const JOURNAL_DIR = 'claims'
export const REPOSITORIES_DIR = 'repositories'

export const JOURNAL_RECORDS = ['claimed', 'labelled', 'led', 'releasing', 'yielded', 'handled'] as const
export type JournalRecord = (typeof JOURNAL_RECORDS)[number]

// How a claim goes on (the record `profile-<k>`): who completes and leads it, and the labels of its stage.
export type ClaimProfile = {
  readonly recovery: 'queue' | 'caller'
  readonly on: readonly string[]
  readonly off: readonly string[]
}

// Who leads a count on this computer by the record `led`: the Orca project that completed its claim; `unreadable` — a
// record from which no project can be read (the count is nobody's).
export type LedBy = ProjectRef | 'unreadable'

const PROFILE = /^profile-([1-9][0-9]*)$/

export class ClaimJournal {
  constructor(
    private readonly machine: Pick<Machine, 'platform' | 'readText' | 'createText' | 'listEntries' | 'now'>,
    private readonly dataDir: string,
  ) {}

  has(repository: Repository, issue: number, count: number, record: JournalRecord): boolean {
    return this.machine.readText(this.file(repository, issue, count, record)) !== null
  }

  // When the record was written (the machine's clock), or null when there is none or it holds no time.
  time(repository: Repository, issue: number, count: number, record: JournalRecord): number | null {
    const text = this.machine.readText(this.file(repository, issue, count, record))
    const time = text === null ? Number.NaN : Date.parse(text.trim())
    return Number.isFinite(time) ? time : null
  }

  // Writes the record once; a record already there stays as it is. True when this call created it. Throws when the
  // disk refuses it.
  async write(repository: Repository, issue: number, count: number, record: JournalRecord): Promise<boolean> {
    const time = new Date(this.machine.now()).toISOString()
    return this.machine.createText(this.file(repository, issue, count, record), `${time}\n`)
  }

  // Writes `led` once with the project that completed the claim. True when this call created it. Throws when the disk
  // refuses it.
  async writeLed(repository: Repository, issue: number, count: number, project: ProjectRef): Promise<boolean> {
    const at = new Date(this.machine.now()).toISOString()
    const text = JSON.stringify({ at, project: { id: project.id, hostId: project.hostId } })
    return this.machine.createText(this.file(repository, issue, count, 'led'), `${text}\n`)
  }

  // The project of the record `led`, `unreadable` when it holds none, null when there is no record.
  ledBy(repository: Repository, issue: number, count: number): LedBy | null {
    const text = this.machine.readText(this.file(repository, issue, count, 'led'))
    if (text === null) return null
    try {
      const project = (JSON.parse(text) as { project?: Record<string, unknown> }).project
      if (project && typeof project.id === 'string' && typeof project.hostId === 'string') {
        return { id: project.id, hostId: project.hostId }
      }
    } catch {
      // Not JSON: no project to read.
    }
    return 'unreadable'
  }

  // The profile of a claim attempt, written right before its POST: a new file `profile-<k>` with the next number, unless
  // the last one holds the same profile. A number taken meanwhile (the file is there already) is read again: the last
  // profile is compared once more and the attempt takes the next number, until the last file is this attempt's
  // profile. Throws when the disk refuses it.
  async writeProfile(repository: Repository, issue: number, count: number, profile: ClaimProfile): Promise<void> {
    const text = JSON.stringify({ recovery: profile.recovery, on: [...profile.on], off: [...profile.off] })
    for (;;) {
      const last = this.profileNumbers(repository, issue, count).at(-1)
      if (last !== undefined && this.machine.readText(this.profileFile(repository, issue, count, last))?.trim() === text) {
        return
      }
      if (await this.machine.createText(this.profileFile(repository, issue, count, (last ?? 0) + 1), `${text}\n`)) return
    }
  }

  // The profile of the count — of its last claim attempt —, or null when there is none (or it cannot be read).
  profile(repository: Repository, issue: number, count: number): ClaimProfile | null {
    const last = this.profileNumbers(repository, issue, count).at(-1)
    if (last === undefined) return null
    const text = this.machine.readText(this.profileFile(repository, issue, count, last))
    if (text === null) return null
    try {
      const value = JSON.parse(text) as Record<string, unknown>
      const list = (field: unknown) => (Array.isArray(field) && field.every((one) => typeof one === 'string') ? field : null)
      const on = list(value.on)
      const off = list(value.off)
      if ((value.recovery !== 'queue' && value.recovery !== 'caller') || on === null || off === null) return null
      return { recovery: value.recovery, on, off }
    } catch {
      return null
    }
  }

  // The counts of the task this coordinator has records of, in order.
  counts(repository: Repository, issue: number): number[] {
    const entries = this.machine.listEntries(dataPath(this.machine, this.dataDir, ...this.names(repository, issue))) ?? []
    return entries
      .filter((entry) => entry.kind === 'directory' && /^[1-9][0-9]*$/.test(entry.name))
      .map((entry) => Number(entry.name))
      .sort((a, b) => a - b)
  }

  // The issues of the repository this coordinator has records of.
  issues(repository: Repository): number[] {
    const dir = dataPath(this.machine, this.dataDir, REPOSITORIES_DIR, repositoryName(repository))
    return (this.machine.listEntries(dir) ?? [])
      .filter((entry) => entry.kind === 'directory' && /^issue-[1-9][0-9]*$/.test(entry.name))
      .map((entry) => Number(entry.name.slice('issue-'.length)))
      .filter((issue) => this.counts(repository, issue).length > 0)
      .sort((a, b) => a - b)
  }

  // The file of a record.
  file(repository: Repository, issue: number, count: number, record: JournalRecord): string {
    return dataPath(this.machine, this.dataDir, ...this.names(repository, issue), countName(count), record)
  }

  private profileFile(repository: Repository, issue: number, count: number, number: number): string {
    return dataPath(this.machine, this.dataDir, ...this.names(repository, issue), countName(count), `profile-${number}`)
  }

  private profileNumbers(repository: Repository, issue: number, count: number): number[] {
    const dir = dataPath(this.machine, this.dataDir, ...this.names(repository, issue), countName(count))
    return (this.machine.listEntries(dir) ?? [])
      .map((entry) => (entry.kind === 'file' ? PROFILE.exec(entry.name)?.[1] : undefined))
      .filter((number): number is string => number !== undefined)
      .map(Number)
      .sort((a, b) => a - b)
  }

  private names(repository: Repository, issue: number): string[] {
    if (!Number.isSafeInteger(issue) || issue < 1) throw new Error(`not an issue number: ${issue}`)
    return [REPOSITORIES_DIR, repositoryName(repository), `issue-${issue}`, JOURNAL_DIR]
  }
}

// The name of a repository's directory: dataName of `host/owner/name` in lower case.
export function repositoryName(repository: Repository): string {
  return dataName(`${repository.host}/${repository.owner}/${repository.name}`.toLowerCase())
}

function countName(count: number): string {
  if (!Number.isSafeInteger(count) || count < 1) throw new Error(`not a claim count: ${count}`)
  return String(count)
}
