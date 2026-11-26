// The commands of the plugin's GitHub Actions workflow (.github/workflows/plugin.yml) on macOS, Windows and Linux. Node
// only, no packages.
//
//   node scripts/ci.mjs orca-version        the minimum Orca version of engines.orca in orca-plugin.json (x.y.z)
//   node scripts/ci.mjs install-orca <dir>  Orca's CLI of exactly that version into <dir>, from the Orca release's
//                                           package for this system; its path goes to $GITHUB_ENV as ORCA_CLI_COMMAND
//   node scripts/ci.mjs hook <name>         runs hook <name> of orca.yaml the way Orca runs it (Windows: a .cmd file)
//
// The CLI runs as Orca's own launcher runs it: the Electron of the Orca package in Node mode (ELECTRON_RUN_AS_NODE=1)
// with the CLI's entry point resources/app.asar.unpacked/out/cli/index.js. The download goes through curl and the
// unpacking through the system's tool for the package (dpkg-deb, ditto, 7z): all of them come with GitHub's runners.
import { appendFileSync, chmodSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { orcaYamlScripts, runOrcaHook } from './orca-hooks.mjs'
import { spawnCommand } from './tools.mjs'

const pluginRoot = fileURLToPath(new URL('..', import.meta.url))

// Orca's releases: https://github.com/stablyai/orca/releases, tag `v<version>`.
export const ORCA_RELEASES = 'https://github.com/stablyai/orca/releases/download'

// The minimum Orca version of a manifest: engines.orca is a minimum `>=x.y.z` (the only form Orca supports there), and
// the CI tests on exactly that version. Anything else throws.
export function minimumOrcaVersion(manifest) {
  const range = manifest?.engines?.orca
  const match = typeof range === 'string' ? /^>=((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/.exec(range) : null
  if (!match) throw new Error(`engines.orca ${JSON.stringify(range)} в orca-plugin.json: не минимум >=x.y.z`)
  return match[1]
}

// The Orca package of a release for a system: its asset, the tool that unpacks it, and where the Electron executable
// lies relative to the package's `resources` directory (Orca's own CLI launcher looks for it there too).
const PACKAGES = {
  'linux-x64': { asset: (v) => `orca-ide_${v}_amd64.deb`, unpack: 'dpkg-deb', electron: ['../orca-ide', '../orca', '../Orca'] },
  'linux-arm64': { asset: (v) => `orca-ide_${v}_arm64.deb`, unpack: 'dpkg-deb', electron: ['../orca-ide', '../orca', '../Orca'] },
  'darwin-arm64': { asset: (v) => `Orca-${v}-arm64-mac.zip`, unpack: 'ditto', electron: ['../MacOS/Orca'] },
  'darwin-x64': { asset: (v) => `Orca-${v}-mac.zip`, unpack: 'ditto', electron: ['../MacOS/Orca'] },
  'win32-x64': { asset: () => 'orca-windows-setup.exe', unpack: '7z', electron: ['../Orca.exe', '../orca-ide.exe'] },
}

// The release package of Orca `version` for `platform`/`arch`: { version, asset, url, unpack, electron }.
export function orcaPackage(version, platform = process.platform, arch = process.arch) {
  const known = PACKAGES[`${platform}-${arch}`]
  if (!known) {
    throw new Error(`нет пакета Orca для ${platform}-${arch}; есть для ${Object.keys(PACKAGES).join(', ')}`)
  }
  const asset = known.asset(version)
  return { version, asset, url: `${ORCA_RELEASES}/v${version}/${asset}`, unpack: known.unpack, electron: known.electron }
}

// The command that unpacks `file` into `dir` with `tool`.
export function unpackCommand(tool, file, dir) {
  if (tool === 'dpkg-deb') return ['dpkg-deb', ['-x', file, dir]]
  if (tool === 'ditto') return ['ditto', ['-x', '-k', file, dir]]
  if (tool === '7z') return ['7z', ['x', '-y', `-o${dir}`, file]]
  throw new Error(`unknown unpack tool ${tool}`)
}

// The CLI's entry point inside a package's `resources` directory.
const CLI_ENTRY = ['app.asar.unpacked', 'out', 'cli', 'index.js']

// The CLI launcher for this system: Orca's CLI name (orca-ide on Linux, orca on macOS, orca.cmd on Windows) and the
// text that starts the CLI's entry point under the package's Electron in Node mode, with NODE_OPTIONS moved aside as
// Orca's own launcher does.
export function cliLauncher(electron, cli, platform = process.platform) {
  if (platform === 'win32') {
    return {
      name: 'orca.cmd',
      text: [
        '@echo off',
        'setlocal',
        'set "ORCA_NODE_OPTIONS=%NODE_OPTIONS%"',
        'set "NODE_OPTIONS="',
        'set "ELECTRON_RUN_AS_NODE=1"',
        `"${electron}" "${cli}" %*`,
        'exit /b %errorlevel%',
        '',
      ].join('\r\n'),
    }
  }
  const quote = (text) => `'${text.replaceAll("'", "'\\''")}'`
  return {
    name: platform === 'linux' ? 'orca-ide' : 'orca',
    text: [
      '#!/bin/sh',
      `# Orca's CLI from the Orca package: its Electron in Node mode runs the CLI's entry point.`,
      'ORCA_NODE_OPTIONS="${NODE_OPTIONS-}"',
      'export ORCA_NODE_OPTIONS',
      'unset NODE_OPTIONS',
      `ELECTRON_RUN_AS_NODE=1 exec ${quote(electron)} ${quote(cli)} "$@"`,
      '',
    ].join('\n'),
  }
}

// Installs Orca's CLI of the manifest's minimum version into `dir`: downloads the release package for this system,
// unpacks it, writes the launcher, checks that the CLI reports exactly that version. Returns { version, url, launcher }.
export function installOrca(dir, { manifest, env = process.env, log = console.log } = {}) {
  const version = minimumOrcaVersion(manifest)
  const pkg = orcaPackage(version)
  const root = resolve(dir)
  const downloads = join(root, 'download')
  const unpacked = join(root, 'package')
  mkdirSync(downloads, { recursive: true })
  mkdirSync(unpacked, { recursive: true })

  log(`CLI Orca ${version} (engines.orca ${manifest.engines.orca}): ${pkg.url}`)
  const file = join(downloads, pkg.asset)
  step('curl', ['-fsSL', '--retry', '3', '-o', file, pkg.url], env)
  const resources = unpack(pkg.unpack, file, unpacked, env)
  const electron = pkg.electron.map((path) => resolve(resources, path)).find(isFile)
  if (!electron) {
    throw new Error(`в пакете ${pkg.asset} нет Electron рядом с ${resources} (искали ${pkg.electron.join(', ')})`)
  }

  const launcher = cliLauncher(electron, join(resources, ...CLI_ENTRY))
  const bin = join(root, 'bin')
  mkdirSync(bin, { recursive: true })
  const launcherPath = join(bin, launcher.name)
  writeFileSync(launcherPath, launcher.text, 'utf8')
  if (process.platform !== 'win32') chmodSync(launcherPath, 0o755)

  const reported = spawnCommand(launcherPath, ['--version'], { env, encoding: 'utf8' })
  const shown = (reported.stdout ?? '').trim()
  if (reported.status !== 0 || shown !== version) {
    throw new Error(`CLI Orca из ${pkg.asset} сообщает версию «${shown}» (код ${reported.status}), а нужна ${version}:\n` +
      `${reported.stderr ?? ''}${reported.error?.message ?? ''}`)
  }
  log(`CLI Orca ${shown}: ${launcherPath}`)
  return { version, url: pkg.url, launcher: launcherPath }
}

// Unpacks `file` into `dir` and returns the package's `resources` directory (the one with the CLI's entry point). An
// installer that holds its app as an inner archive (Orca's setup.exe for Windows: $PLUGINSDIR/app-64.7z) is unpacked
// in turn.
function unpack(tool, file, dir, env) {
  step(...unpackCommand(tool, file, dir), env)
  let resources = findResources(dir)
  if (!resources && tool === '7z') {
    for (const [index, inner] of findFiles(dir, (name) => name.endsWith('.7z')).entries()) {
      step(...unpackCommand(tool, inner, join(dir, `inner-${index}`)), env)
    }
    resources = findResources(dir)
  }
  if (!resources) throw new Error(`в пакете ${file} нет ${CLI_ENTRY.join('/')}`)
  return resources
}

function step(command, args, env) {
  const result = spawnCommand(command, args, { env, stdio: 'inherit' })
  if (result.error) throw new Error(`${command} не запустился: ${result.error.message}`)
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')}: код ${result.status}`)
}

// The first directory under `dir` (breadth first) that holds the CLI's entry point; packed apps and modules are not
// searched.
function findResources(dir) {
  let level = [dir]
  for (let depth = 0; depth < 8 && level.length > 0; depth++) {
    const next = []
    for (const current of level) {
      if (isFile(join(current, ...CLI_ENTRY))) return current
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        if (entry.isDirectory() && !['node_modules', 'app.asar.unpacked'].includes(entry.name)) {
          next.push(join(current, entry.name))
        }
      }
    }
    level = next
  }
  return null
}

function findFiles(dir, wanted) {
  const found = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...findFiles(path, wanted))
    else if (entry.isFile() && wanted(entry.name)) found.push(path)
  }
  return found.sort()
}

function isFile(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function readManifest() {
  return JSON.parse(readFileSync(join(pluginRoot, 'orca-plugin.json'), 'utf8'))
}

function main([command, ...args]) {
  if (command === 'orca-version' && args.length === 0) {
    console.log(minimumOrcaVersion(readManifest()))
    return 0
  }
  if (command === 'install-orca' && args.length === 1) {
    const { launcher } = installOrca(args[0], { manifest: readManifest() })
    if (process.env.GITHUB_ENV) {
      appendFileSync(process.env.GITHUB_ENV, `ORCA_CLI_COMMAND=${launcher}\n`, 'utf8')
      console.log(`ORCA_CLI_COMMAND=${launcher} — в $GITHUB_ENV для следующих шагов`)
    } else {
      console.log(`ORCA_CLI_COMMAND=${launcher}`)
    }
    return 0
  }
  if (command === 'hook' && args.length === 1) {
    const [name] = args
    const scripts = orcaYamlScripts(readFileSync(join(pluginRoot, 'orca.yaml'), 'utf8'))
    if (!Object.hasOwn(scripts, name)) {
      throw new Error(`в orca.yaml нет скрипта ${name}; есть: ${Object.keys(scripts).join(', ')}`)
    }
    const result = runOrcaHook(name, scripts[name], pluginRoot, { stdio: 'inherit' }, (runner) => {
      console.log(`orca.yaml ${name}, как его запускает Orca: ${runner.program} ${runner.args.join(' ')}`)
      console.log(`--- ${runner.file}\n${runner.text.replaceAll('\r\n', '\n')}---`)
    })
    if (result.error) throw new Error(`${name}: ${result.error.message}`)
    console.log(`orca.yaml ${name}: код ${result.status}`)
    return result.status ?? 1
  }
  console.error('usage: node scripts/ci.mjs orca-version | install-orca <dir> | hook <name>')
  return 2
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (error) {
    console.error(`scripts/ci.mjs: ${error.message}`)
    process.exitCode = 1
  }
}

