// A message the server refused outright (a token typed into chat, too long, over a limit) has a reason the person
// needs to read before they try again. A failure to reach the server is different: it clears itself once the
// conversation is in step again.
/** Whether this error is the server saying no to the message itself, rather than a connection that failed. */
export function refusedByServer(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" && status >= 400 && status < 500;
}
