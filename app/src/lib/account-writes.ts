type Storage = { read: () => Promise<string | null>; write: (value: string) => Promise<void>; remove: () => Promise<void> };

// Account writes share one queue so cancellation cannot undo a later pairing or
// sign-out. In particular, a Keychain IPC write may finish after its screen exits.
export function createAccountWrites(storage: Storage) {
  let tail: Promise<unknown> = Promise.resolve();
  const queue = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(operation);
    tail = result.catch(() => undefined);
    return result;
  };
  return {
    save(value: string, current?: () => boolean): Promise<boolean> {
      return queue(async () => {
        if (current && !current()) return false;
        const previous = current ? await storage.read() : null;
        if (current && !current()) return false;
        await storage.write(value);
        if (current && !current()) {
          if (previous === null) await storage.remove();
          else await storage.write(previous);
          return false;
        }
        return true;
      });
    },
    clear: () => queue(storage.remove),
  };
}
