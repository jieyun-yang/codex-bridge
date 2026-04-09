export function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export function errorResponse(message: string) {
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: message }],
  };
}

export function textResponse(text: string) {
  return {
    content: [{ type: "text" as const, text }],
  };
}

export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    ),
  ]);
}
