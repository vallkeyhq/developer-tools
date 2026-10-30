export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
}
export function errorCode(error: unknown): string | undefined {
  if (!isRecord(error)) return undefined;
  const cause = error.cause;
  return isRecord(cause) && typeof cause.code === 'string' ? cause.code : undefined;
}
export function hasStatus(error: unknown): error is Error & { status: number } {
  return error instanceof Error && 'status' in error && typeof error.status === 'number';
}
