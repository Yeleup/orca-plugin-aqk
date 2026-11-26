// Reading an unknown thrown value: Node's error code (ENOENT, EEXIST …) and a message.
export function errorCode(error: unknown): string | null {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : null
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
