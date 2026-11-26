// Types of the Node.js built-in modules the plugin uses. The worker is a `trusted-worker`: its own Node.js process, so
// it imports Node's modules; Node's typings (@types/node) are not installed (the plugin adds no packages), and
// tsconfig.json has only Orca's. So this file declares the exports the plugin and its tests use, and only those, with
// Node's own signatures (narrowed where the plugin always passes the same option, e.g. the 'utf8' encoding; a Buffer
// is typed as the Uint8Array it extends).

declare module 'node:path' {
  export interface PlatformPath {
    readonly sep: '\\' | '/'
    readonly delimiter: ';' | ':'
    normalize(path: string): string
    join(...paths: string[]): string
    resolve(...paths: string[]): string
    isAbsolute(path: string): boolean
    dirname(path: string): string
    basename(path: string, suffix?: string): string
    extname(path: string): string
  }
  export const posix: PlatformPath
  export const win32: PlatformPath
  export const sep: '\\' | '/'
  export function join(...paths: string[]): string
  export function dirname(path: string): string
  export function basename(path: string, suffix?: string): string
}

declare module 'node:fs' {
  export interface Stats {
    isFile(): boolean
    isDirectory(): boolean
    readonly ino: number
    readonly mtimeMs: number
  }
  export const constants: { readonly F_OK: number; readonly X_OK: number }
  export function statSync(path: string): Stats
  export function accessSync(path: string, mode?: number): void
  export function existsSync(path: string): boolean
  export function mkdirSync(path: string, options?: { recursive?: boolean }): string | undefined
  export function mkdtempSync(prefix: string): string
  export function readFileSync(path: string, encoding: 'utf8'): string
  export function readFileSync(path: string): Uint8Array
  // An entry of a directory as the directory has it: a symbolic link (or a Windows junction) is a link, not followed.
  export interface Dirent {
    readonly name: string
    isFile(): boolean
    isDirectory(): boolean
    isSymbolicLink(): boolean
  }
  export function readdirSync(path: string): string[]
  export function readdirSync(path: string, options: { withFileTypes: true }): Dirent[]
  export function symlinkSync(target: string, path: string, type?: 'dir' | 'file' | 'junction'): void
  export function writeFileSync(
    path: string,
    data: string | Uint8Array,
    options?: { encoding?: 'utf8'; flag?: string; mode?: number },
  ): void
  export function linkSync(existingPath: string, newPath: string): void
  export function openSync(path: string, flags: 'w' | 'a'): number
  export function writeSync(fd: number, data: Uint8Array, offset?: number, length?: number): number
  export function closeSync(fd: number): void
  export function unlinkSync(path: string): void
  export function chmodSync(path: string, mode: number): void
  export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void
}

declare module 'node:os' {
  export function homedir(): string
  export function hostname(): string
  export function tmpdir(): string
  export function userInfo(): { readonly username: string; readonly homedir: string }
}

declare module 'node:crypto' {
  export interface Hash {
    update(data: string, encoding: 'utf8'): Hash
    digest(encoding: 'hex'): string
  }
  export function randomUUID(): string
  export function createHash(algorithm: 'sha256'): Hash
}

declare module 'node:process' {
  export const platform: string
  export const env: Record<string, string | undefined>
  export const execPath: string
  export const pid: number
  export function cwd(): string
  export function kill(pid: number, signal?: 'SIGKILL' | 'SIGTERM' | 0): true
}

declare module 'node:child_process' {
  export interface SpawnOptions {
    cwd?: string
    env?: Record<string, string | undefined>
    stdio?: ['ignore' | 'pipe', 'ignore' | 'pipe', 'ignore' | 'pipe'] | 'ignore'
    detached?: boolean
    windowsHide?: boolean
    windowsVerbatimArguments?: boolean
  }
  // A child's stdout or stderr without an encoding: its chunks are Buffers.
  export interface ReadableBytes {
    on(event: 'data', listener: (chunk: Uint8Array) => void): this
    destroy(): this
  }
  // A child's stdin: a string is written as UTF-8.
  export interface WritableText {
    end(data: string): this
    on(event: 'error', listener: (error: Error) => void): this
  }
  export interface ChildProcess {
    readonly pid?: number
    readonly stdin: WritableText | null
    readonly stdout: ReadableBytes | null
    readonly stderr: ReadableBytes | null
    kill(signal?: 'SIGTERM' | 'SIGKILL'): boolean
    unref(): void
    on(event: 'spawn', listener: () => void): this
    on(event: 'error', listener: (error: Error & { code?: string }) => void): this
    on(event: 'exit' | 'close', listener: (code: number | null, signal: string | null) => void): this
  }
  export function spawn(command: string, args: readonly string[], options?: SpawnOptions): ChildProcess
}
