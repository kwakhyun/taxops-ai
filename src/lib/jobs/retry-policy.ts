export type FailureStatus = "RETRYING" | "DEAD";

export function failureDisposition(input: {
  attempts: number;
  maxAttempts: number;
  permanent: boolean;
  jitter?: number;
}): { status: FailureStatus; delaySeconds: number } {
  const status =
    input.permanent || input.attempts >= input.maxAttempts
      ? "DEAD"
      : "RETRYING";
  const jitter = input.jitter ?? Math.floor(Math.random() * 3);
  return {
    status,
    delaySeconds: Math.min(300, 2 ** input.attempts + jitter),
  };
}
