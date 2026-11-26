// The hooks of orca.yaml (`setup`, `archive`) run the way Orca 1.4.273 runs them: Orca writes the script into a runner
// file and runs it in the worktree — on macOS and Linux a bash script with `set -e`, on Windows a .cmd file that calls
// each line and stops at the first one that fails. The CI (scripts/ci.mjs hook) and the tests use this code, so both run
// the lines of orca.yaml itself, never a copy of them. Node only, no packages.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The scripts of orca.yaml (`scripts:` — each one a block scalar `name: |` or a one-line plain value), by name. A
// comment line, at any indent, and a comment after a key belong to no script, as in YAML.
export function orcaYamlScripts(text) {
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((line) => /^scripts:\s*(#.*)?$/.test(line))
  if (start < 0) throw new Error('orca.yaml has no scripts:')
  const scripts = {}
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]
    if (/^\s*(#.*)?$/.test(line)) continue
    if (/^\S/.test(line)) break
    const key = /^(\s+)([A-Za-z][\w-]*):(?:\s+(.*))?$/.exec(line)
    if (!key) continue
    const [, indent, name] = key
    const value = (key[3] ?? '').replace(/(^|\s+)#.*$/, '').trim()
    if (!/^\|[-+]?$/.test(value)) {
      scripts[name] = value
      continue
    }
    const body = []
    while (i + 1 < lines.length && (lines[i + 1].trim() === '' || lines[i + 1].search(/\S/) > indent.length)) {
      body.push(lines[++i])
    }
    while (body.length > 0 && body[body.length - 1].trim() === '') body.pop()
    const contentIndent = Math.min(...body.filter((l) => l.trim() !== '').map((l) => l.search(/\S/)))
    scripts[name] = body.map((l) => l.slice(contentIndent)).join('\n') + (value === '|-' ? '' : '\n')
  }
  return scripts
}

// The runner file Orca 1.4.273 writes for a hook of orca.yaml: on macOS and Linux a bash script with `set -e`, on Windows
// a .cmd file that calls each line and stops at the first one that fails.
export function orcaHookRunner(script, platform = process.platform) {
  if (platform !== 'win32') return `#!/usr/bin/env bash\nset -e\n${script}\n`
  let runner = '@echo off\r\nsetlocal EnableExtensions DisableDelayedExpansion\r\n'
  for (const line of script.split('\n').map((l) => l.replace(/\r$/, '').trim())) {
    if (line.startsWith('#!')) throw new Error('Orca does not run a hook with a #! line through cmd.exe')
    runner += line ? `call ${line}\r\nif errorlevel 1 exit /b %errorlevel%\r\n` : '\r\n'
  }
  return runner
}

// How Orca runs hook `name` on `platform`: the runner file it writes in `runnerDir` (`setup-runner.cmd` on Windows,
// `setup-runner.sh` elsewhere), its text, and the program that runs it — bash on macOS and Linux; on Windows cmd.exe
// (`comspec`) runs the .cmd itself.
export function orcaHookInvocation(name, script, runnerDir, platform = process.platform, comspec = 'cmd.exe') {
  const windows = platform === 'win32'
  const file = join(runnerDir, `${name}-runner.${windows ? 'cmd' : 'sh'}`)
  return {
    file,
    text: orcaHookRunner(script, platform),
    // cmd.exe /s strips the outer quotes and runs the quoted path: a path with blanks stays one command.
    program: windows ? comspec : 'bash',
    args: windows ? ['/d', '/s', '/c', `""${file}""`] : [file],
    windowsVerbatimArguments: windows,
  }
}

// Runs hook `name` (its `script` from orca.yaml) in `cwd` the way Orca does on this system; returns spawnSync's result.
// `onRunner(invocation)` sees the runner file before it runs. `options` go to spawnSync (env, stdio, encoding …).
export function runOrcaHook(name, script, cwd, options = {}, onRunner = () => {}) {
  const env = options.env ?? process.env
  const runnerDir = mkdtempSync(join(tmpdir(), `orca-hook-${name}-`))
  try {
    const invocation = orcaHookInvocation(name, script, runnerDir, process.platform, comspecOf(env))
    writeFileSync(invocation.file, invocation.text, 'utf8')
    onRunner(invocation)
    return spawnSync(invocation.program, invocation.args, {
      ...options,
      cwd,
      env,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    })
  } finally {
    rmSync(runnerDir, { recursive: true, force: true })
  }
}

// cmd.exe of this Windows: ComSpec (its name has no case there), otherwise cmd.exe on PATH.
function comspecOf(env) {
  const key = Object.keys(env).find((name) => name.toUpperCase() === 'COMSPEC')
  return (key && env[key]) || process.env.ComSpec || 'cmd.exe'
}
