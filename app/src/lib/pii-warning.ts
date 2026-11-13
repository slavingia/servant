// The server warns before personal information is saved in a chat (server/pii-gate.mjs): a 409 with the code
// pii_warning and a plain sentence. The person can send anyway; that sends the same message again with
// confirmPii. Warning only, never a block.
export const PII_WARNING = "pii_warning";

/** Thrown when the person looks at the warning and chooses not to send. Callers keep the draft and say nothing more. */
export const PII_DECLINED = "Not sent";
export class PiiDeclined extends Error {
  constructor() { super(PII_DECLINED); }
}

// By shape, not instanceof, so this stays plain TypeScript that tests run without the app's runtime.
export const isPiiWarning = (e: unknown): e is Error & { code: string } => e instanceof Error && (e as { code?: unknown }).code === PII_WARNING;

/** What the person chose in the warning: not to send (false), to send anyway (true), or to send anyway and say the warning was
 * wrong ("reported"; the server queues it for the owner to review, and only when the owner has switched reporting on). */
export type PiiChoice = boolean | "reported";

/** The two flags the server reads for a choice. A report always implies sending anyway. */
export function piiFlags(choice: PiiChoice): { confirmPii?: true; reportFalseAlarm?: true } {
  if (choice === "reported") return { confirmPii: true, reportFalseAlarm: true };
  return choice ? { confirmPii: true } : {};
}

/** Runs a send; if the server warns, asks the person and, on yes, runs it again with confirmPii (and reportFalseAlarm if they
 * said the warning was wrong). `reportable` comes from the server only when it can take a report. */
export async function withPiiConfirm<T>(ask: (message: string, options?: { reportable?: boolean }) => Promise<PiiChoice>, run: (confirmPii: PiiChoice) => Promise<T>): Promise<T> {
  try {
    return await run(false);
  } catch (e) {
    if (!isPiiWarning(e)) throw e;
    const details = (e as { details?: { reportable?: unknown } }).details;
    const choice = await ask(e.message, { reportable: details?.reportable === true });
    if (!choice) throw new PiiDeclined();
    return run(choice);
  }
}
