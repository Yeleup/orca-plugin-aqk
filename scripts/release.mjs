// The release of the plugin: the entry for the Orca plugin catalog of a release commit.
//
//   node scripts/release.mjs [<commit>]      (default HEAD; a tag such as v0.1.0 or any commit of this repository)
//
// Clones this repository into a temporary directory, checks the release commit out there and runs Orca's CLI
// `plugin release-entry` on that clone: the entry describes exactly that commit (the files of the commit, its manifest's
// version), and the working checkout is never changed — no checkout, no files, no refs. The entry goes to stdout as JSON
// (the `releases` element to put first in orca-catalog.json — the owner adds the plugin to the catalog), the rest to
// stderr. Orca's CLI: ORCA_CLI_COMMAND, otherwise orca-ide on Linux and orca on macOS and Windows (scripts/tools.mjs);
// never a bare `orca` on Linux. Node only, no packages.
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isScreenReader, orcaCliCommand, spawnCommand } from './tools.mjs'

const pluginRoot = fileURLToPath(new URL('..', import.meta.url))

function git(args, cwd) {
  const result = spawnCommand('git', args, { cwd, encoding: 'utf8' })
  if (result.error) throw new Error(`git не запустился: ${result.error.message}`)
  return result
}

function gitOk(args, cwd, what) {
  const result = git(args, cwd)
  if (result.status !== 0) throw new Error(`${what}: git ${args.join(' ')} — код ${result.status}\n${result.stderr}`)
  return result.stdout.trim()
}

// The catalog entry of `rev` (a commit of the repository of `root`): { sha, entry, result }.
export function releaseEntry(rev = 'HEAD', { root = pluginRoot, cli = orcaCliCommand(), log = console.error } = {}) {
  if (isScreenReader(cli)) {
    throw new Error("CLI Orca «orca» без пути на Linux — экранный диктор GNOME, а не CLI Orca: задайте ORCA_CLI_COMMAND " +
      '(orca-ide или полный путь CLI)')
  }
  const toplevel = gitOk(['rev-parse', '--show-toplevel'], root, 'папка плагина не в репозитории git')
  const found = git(['rev-parse', '--verify', '--quiet', '--end-of-options', `${rev}^{commit}`], root)
  if (found.status !== 0) throw new Error(`релизный коммит «${rev}» не найден в ${toplevel}`)
  const sha = found.stdout.trim()

  const temp = mkdtempSync(join(tmpdir(), 'orca-plugin-aqk-release-'))
  try {
    const clone = join(temp, 'repo')
    gitOk(['clone', '--quiet', '--no-checkout', toplevel, clone], temp, 'временный клон')
    gitOk(['-c', 'advice.detachedHead=false', 'checkout', '--quiet', '--detach', sha], clone, 'релизный коммит в клоне')
    const pluginDir = join(clone, relative(resolve(toplevel), resolve(root)))
    log(`Релизный коммит ${sha} (${rev}) во временном клоне ${clone}: ${cli} plugin release-entry`)

    const answer = spawnCommand(cli, ['plugin', 'release-entry', pluginDir, '--json'], { cwd: clone, encoding: 'utf8' })
    if (answer.error) throw new Error(`CLI Orca ${cli} не запустился: ${answer.error.message}`)
    let json = null
    try {
      json = JSON.parse(answer.stdout)
    } catch {
      // Not JSON: the error below shows the whole answer.
    }
    if (answer.status !== 0 || json?.ok !== true || typeof json?.result?.entry !== 'object') {
      throw new Error(`plugin release-entry: код ${answer.status}\n${answer.stdout}${answer.stderr}`)
    }
    const { entry } = json.result
    if (entry.commit !== sha) {
      throw new Error(`plugin release-entry описал коммит ${entry.commit}, а релизный — ${sha}`)
    }
    const manifest = JSON.parse(readFileSync(join(pluginDir, 'orca-plugin.json'), 'utf8'))
    if (entry.version !== manifest.version) {
      throw new Error(`в записи версия ${entry.version}, а в манифесте релизного коммита — ${manifest.version}`)
    }
    return { sha, entry, result: json.result }
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}

function main(args) {
  if (args.length > 1 || args[0]?.startsWith('-')) {
    console.error('usage: node scripts/release.mjs [<commit>]')
    return 2
  }
  const { sha, entry, result } = releaseEntry(args[0] ?? 'HEAD')
  console.log(JSON.stringify(entry, null, 2))
  console.error(`Запись каталога Orca: ${entry.name} ${entry.version}, коммит ${sha}. Рабочий чекаут не менялся.`)
  if (result.source) console.error(`source плагина в каталоге: ${JSON.stringify(result.source)}`)
  console.error('В каталог Orca её вносит владелец: первой в "releases" плагина в orca-catalog.json.')
  return 0
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (error) {
    console.error(`scripts/release.mjs: ${error.message}`)
    process.exitCode = 1
  }
}
