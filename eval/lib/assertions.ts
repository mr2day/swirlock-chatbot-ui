export interface AssertionResult {
  ok: boolean;
  message: string;
}

export function ok(condition: boolean, message: string): AssertionResult {
  return { ok: condition, message };
}

export function equal<T>(
  actual: T,
  expected: T,
  message: string,
): AssertionResult {
  const pass = actual === expected;
  return {
    ok: pass,
    message: pass
      ? `${message} ✓`
      : `${message} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  };
}
