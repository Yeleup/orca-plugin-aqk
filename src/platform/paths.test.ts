// The data directory and the paths of worktree files by the rules of each system (Ф14, К14.1), on fake systems: the
// worker started on a fake Windows or macOS writes the coordinator id where that system keeps per-user data, and every
// path keeps to the separator of that system.
import { assert, mountWorker, test } from 'orca/testing'
import { startWorker } from '../worker'
import { fakeMachine, type FakeMachine } from '../testing/fake-machine'
import { dataDirectory, dataPath, nativePath, worktreeFile } from './paths'

// The worker started on `machine`: its log and the files it created.
async function startOn(machine: FakeMachine) {
  const worker = await mountWorker({ default: (orca) => startWorker(orca, machine) })
  await worker.deactivate()
  return { logs: worker.logs, created: [...machine.files.keys()] }
}

test('К14.1: подделка Windows (win32) — каталог данных в %LOCALAPPDATA%, пути worktree и файлов только с обратной косой чертой', async () => {
  const machine = fakeMachine({
    platform: 'win32',
    homedir: 'C:\\Users\\Avery',
    // Windows has no case in variable names: Orca may pass it as LocalAppData.
    env: { LocalAppData: 'C:\\Users\\Avery\\AppData\\Local', Path: 'C:\\Windows\\System32' },
  })
  const dataDir = 'C:\\Users\\Avery\\AppData\\Local\\orca-agent-queue'
  assert.equal(dataDirectory(machine), dataDir)

  const { logs, created } = await startOn(machine)
  assert.deepEqual(created, [`${dataDir}\\coordinator-id`])
  assert.match(logs[0] ?? '', /^agent-queue: worker started, coordinator [0-9a-f-]{36}$/)

  assert.equal(dataPath(machine, dataDir, 'runs', 'issue-7', 'test.log'), `${dataDir}\\runs\\issue-7\\test.log`)
  // git prints a worktree on Windows with forward slashes, Orca with backslashes: the same path either way.
  const fromGit = 'C:/Users/Avery/orca/workspaces/demo-shop/issue-7'
  const fromOrca = 'C:\\Users\\Avery\\orca\\workspaces\\demo-shop\\issue-7'
  assert.equal(nativePath(machine, fromGit), fromOrca)
  assert.equal(nativePath(machine, `${fromOrca}\\`), fromOrca)
  for (const root of [fromGit, fromOrca]) {
    assert.equal(worktreeFile(machine, root, 'src/app/main.ts'), `${fromOrca}\\src\\app\\main.ts`)
  }
  for (const path of [dataDir, ...created, worktreeFile(machine, fromGit, 'docs/notes/plan.md')]) {
    assert.ok(!path.includes('/'), `a / in a Windows path: ${path}`)
  }
})

test('К14.1: подделка Windows без LOCALAPPDATA — каталог данных в <домашний каталог>\\AppData\\Local', () => {
  const machine = fakeMachine({ platform: 'win32', homedir: 'C:\\Users\\Avery', env: { LOCALAPPDATA: 'relative\\dir' } })
  assert.equal(dataDirectory(machine), 'C:\\Users\\Avery\\AppData\\Local\\orca-agent-queue')
})

test('К14.1: подделка macOS (darwin) — каталог данных в ~/Library/Application Support, пути worktree и файлов только с /', async () => {
  // XDG variables are Linux's rule, not macOS's.
  const machine = fakeMachine({ platform: 'darwin', homedir: '/Users/avery', env: { XDG_DATA_HOME: '/Users/avery/.xdg' } })
  const dataDir = '/Users/avery/Library/Application Support/orca-agent-queue'
  assert.equal(dataDirectory(machine), dataDir)

  const { created } = await startOn(machine)
  assert.deepEqual(created, [`${dataDir}/coordinator-id`])

  assert.equal(dataPath(machine, dataDir, 'runs', 'issue-7', 'test.log'), `${dataDir}/runs/issue-7/test.log`)
  const root = '/Users/avery/orca/workspaces/demo-shop/issue-7'
  assert.equal(nativePath(machine, `${root}/`), root)
  assert.equal(worktreeFile(machine, root, 'src/app/main.ts'), `${root}/src/app/main.ts`)
  for (const path of [dataDir, ...created, worktreeFile(machine, root, 'docs/notes/plan.md')]) {
    assert.ok(!path.includes('\\'), `a \\ in a macOS path: ${path}`)
  }
})

test('каталог данных на Linux: $XDG_DATA_HOME, без него или с относительным — ~/.local/share', () => {
  const linux = (env: Record<string, string>) => fakeMachine({ platform: 'linux', homedir: '/home/avery', env })
  assert.equal(dataDirectory(linux({ XDG_DATA_HOME: '/data/avery' })), '/data/avery/orca-agent-queue')
  assert.equal(dataDirectory(linux({})), '/home/avery/.local/share/orca-agent-queue')
  assert.equal(dataDirectory(linux({ XDG_DATA_HOME: 'relative/share' })), '/home/avery/.local/share/orca-agent-queue')
})

test('пути: имя в каталоге данных и путь в worktree не выходят за их пределы', () => {
  for (const platform of ['linux', 'darwin', 'win32'] as const) {
    const machine = fakeMachine({ platform })
    const dataDir = dataDirectory(machine)
    for (const name of ['..', '', 'a/b', 'a\\b']) {
      assert.throws(() => dataPath(machine, dataDir, name), /not a plain name/)
    }
    const root = platform === 'win32' ? 'C:\\work\\demo' : '/work/demo'
    for (const repoPath of ['../outside.txt', 'src/../../outside.txt', '/etc/hosts', 'src//main.ts']) {
      assert.throws(() => worktreeFile(machine, root, repoPath), /not a path inside the repository/)
    }
    assert.throws(() => worktreeFile(machine, 'relative/worktree', 'src/main.ts'), /must be absolute/)
  }
})
