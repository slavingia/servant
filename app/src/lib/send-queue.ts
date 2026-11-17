// Someone who types "ok" Enter "thanks" Enter on a slow connection sends the second message while the first
// is still on its way. The composer used to refuse it: the box kept the words, Send showed a spinner, and
// pressing Enter again did nothing until the first answer came back.
//
// Now the box is free the moment a message leaves (Messaging.tsx, `freeOnSend`), each message is shown in the
// conversation at once (outbox.ts), and this sends them to the server one at a time, in the order they were
// written, so two messages a moment apart can never arrive the other way round.

export function createSendQueue() {
  let last: Promise<unknown> = Promise.resolve();
  return {
    /** Runs `send` when every send before it has been answered or has failed, and resolves or rejects with its result. */
    inTurn<T>(send: () => Promise<T>): Promise<T> {
      const mine = last.then(send, send);
      last = mine.catch(() => {});
      return mine;
    },
  };
}
export type SendQueue = ReturnType<typeof createSendQueue>;

/**
 * A message that could not be sent goes back in the box. Whatever has been typed since stays: the words that
 * failed go under it, in the order they were sent, and are not added twice.
 */
export function backInBox(current: string, failed: string): string {
  if (!failed) return current;
  if (!current.trim()) return failed;
  return current.split("\n").includes(failed) || current === failed ? current : `${current}\n${failed}`;
}
