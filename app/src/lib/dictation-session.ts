export type DictationState = { listening: boolean; partial: string; error: string };
export type DictationEvent =
  | { type: 'start' | 'end' }
  | { type: 'result'; isFinal: boolean; text: string }
  | { type: 'error'; error: string };

type Speech = {
  permission: () => Promise<{ granted: boolean } | null>;
  start: (language: string) => void | Promise<void>;
  stop: () => void;
  abort: () => void;
  subscribe: (listener: (event: DictationEvent) => void) => () => void;
};
const messages: Record<string, string> = {
  'not-allowed': 'Allow the microphone in Settings to dictate',
  'service-not-allowed': 'Turn on speech recognition in Settings to dictate',
  'language-not-supported': "Dictation isn't available in this language",
  network: 'Dictation needs a connection right now',
};

// Recognition is one native service, even when several navigation screens keep
// their composers mounted. Only its owning session may receive words or stop it.
export function createDictationCoordinator(speech: Speech, { permissionMayBackgroundApp = false } = {}) {
  type Session = { active: boolean; foreground: boolean; state: DictationState; onText: (text: string) => void; onState: (state: DictationState) => void };
  type Run = { session: Session; native: boolean; permissionPending: boolean; permissionBackgroundAt?: number; cancelled: boolean; failed: boolean; stopping: boolean;
    done: Promise<boolean>; resolve: (ok: boolean) => void; unsubscribe?: () => void; timeout?: ReturnType<typeof setTimeout>; grace?: ReturnType<typeof setTimeout>;
    resume?: (foreground: boolean) => void; resumeTimeout?: ReturnType<typeof setTimeout> };
  let owner: Run | undefined;
  const update = (session: Session, next: Partial<DictationState>) => {
    session.state = { ...session.state, ...next };
    if (session.active) session.onState(session.state);
  };
  const settle = (run: Run, ok: boolean) => {
    if (owner !== run) return;
    owner = undefined;
    clearTimeout(run.timeout);
    clearTimeout(run.grace);
    clearTimeout(run.resumeTimeout);
    run.resume?.(false);
    run.unsubscribe?.();
    update(run.session, { listening: false, partial: '' });
    run.resolve(ok && !run.cancelled && run.session.active && run.session.foreground);
  };
  const expire = (run: Run) => {
    clearTimeout(run.timeout);
    run.timeout = setTimeout(() => {
      if (owner !== run) return;
      // A send that already went out with the words heard so far needs no warning.
      if (!run.cancelled) {
        run.failed = true;
        update(run.session, { error: "Dictation didn't finish. Review your draft and try again." });
      }
      try { speech.abort(); } catch { /* The session is released below. */ }
      settle(run, false);
    }, 8000);
  };
  return {
    createSession(onText: Session['onText'], onState: Session['onState']) {
      const session: Session = { active: false, foreground: true, state: { listening: false, partial: '', error: '' }, onText, onState };
      const cancel = () => {
        const run = owner;
        if (!run || run.session !== session) return;
        run.cancelled = true;
        run.resolve(false);
        update(session, { listening: false, partial: '' });
        if (!run.native) { settle(run, false); return; }
        // Keep ownership until end so an old recognizer's final event cannot be
        // mistaken for a new conversation's dictation.
        if (!run.timeout) expire(run);
        try { speech.abort(); } catch { settle(run, false); }
      };
      const permissionExpired = (run: Run) => run.permissionBackgroundAt !== undefined && Date.now() - run.permissionBackgroundAt > 60_000;
      const retryPermission = () => {
        update(session, { error: 'Dictation did not start. Tap the microphone to try again.' });
        cancel();
      };
      return {
        setActive(active: boolean) {
          session.active = active;
          if (!active) cancel();
          else onState(session.state);
        },
        setForeground(foreground: boolean) {
          if (session.foreground === foreground) return;
          session.foreground = foreground;
          const run = owner?.session === session ? owner : undefined;
          // Android's permission Activity backgrounds the app. Keep only that
          // pending decision, not a recording, and never resume a stale request.
          if (!foreground) {
            if (run && permissionMayBackgroundApp && run.permissionPending) run.permissionBackgroundAt ??= Date.now();
            else cancel();
          } else if (run && !run.native && permissionExpired(run)) retryPermission();
          else {
            if (session.active) onState(session.state);
            run?.resume?.(true);
          }
        },
        cancel,
        async start(language: string) {
          if (!session.active || !session.foreground || owner?.session === session) return;
          if (owner) { update(session, { error: 'Dictation is finishing. Try again.' }); return; }
          let resolve!: Run['resolve'];
          const done = new Promise<boolean>(yes => { resolve = yes; });
          const run: Run = { session, native: false, permissionPending: true, cancelled: false, failed: false, stopping: false, done, resolve };
          owner = run;
          update(session, { listening: true, partial: '', error: '' });
          try {
            const permission = await speech.permission();
            run.permissionPending = false;
            if (owner !== run || !session.active || run.cancelled) return;
            if (!permission?.granted) {
              update(session, { error: messages['not-allowed'] });
              settle(run, false); return;
            }
            if (run.stopping) { settle(run, true); return; }
            if (permissionExpired(run)) { retryPermission(); return; }
            if (!session.foreground) {
              // The permission result can precede Android's foreground event.
              // Allow that handoff for one second, then require a fresh tap.
              const resumed = await new Promise<boolean>(resolve => {
                run.resume = resolve;
                run.resumeTimeout = setTimeout(() => resolve(false), 1000);
              });
              clearTimeout(run.resumeTimeout);
              run.resume = undefined;
              if (owner !== run || !session.active || run.cancelled) return;
              if (!resumed || !session.foreground || permissionExpired(run)) { retryPermission(); return; }
            }
            if (run.stopping) { settle(run, true); return; }
            run.permissionBackgroundAt = undefined;
            run.unsubscribe = speech.subscribe(event => {
              if (owner !== run) return;
              if (event.type === 'end') { settle(run, !run.failed); return; }
              if (run.cancelled) return;
              if (event.type === 'result') {
                if (event.isFinal) {
                  update(session, { partial: '' });
                  if (event.text.trim()) session.onText(event.text);
                } else update(session, { partial: event.text });
              } else if (event.type === 'error') {
                // iOS reports no-speech or aborted when it's stopped after the
                // words already arrived. That's an ordinary end, not a failure
                // that should swallow the Send tap.
                if (['aborted', 'no-speech', 'speech-timeout'].includes(event.error)) { update(session, { partial: '' }); return; }
                run.failed = true;
                update(session, { partial: '', error: messages[event.error] ?? "Couldn't hear that. Try again" });
              }
            });
            run.native = true;
            await speech.start(language);
          } catch {
            if (owner !== run) return;
            run.failed = true;
            update(session, { error: "Couldn't start dictation. Try again" });
            try { if (run.native) speech.abort(); } catch { /* Preserve the original start failure. */ }
            settle(run, false);
          }
        },
        // Sending while listening: wait briefly for the recognizer's final words,
        // then send what was heard (including the live partial) and drop the
        // recognizer's tail, so the composer never sits on a spinner.
        finish(graceMs = 0): Promise<boolean> {
          const run = owner;
          if (!run || run.session !== session) return Promise.resolve(session.active && session.foreground);
          // A recognizer still draining after an earlier send (or a cancel) has
          // nothing left for this draft, so a typed follow-up sends right away.
          if (run.cancelled) return Promise.resolve(session.active && session.foreground);
          if (!run.stopping) {
            run.stopping = true;
            if (run.resume) { settle(run, true); return run.done; }
            expire(run);
            if (run.native) {
              try { speech.stop(); }
              catch { run.failed = true; try { speech.abort(); } catch {} settle(run, false); }
            }
          }
          // Also when the mic button already asked it to stop: iOS may never
          // end, and Send must not sit out the long timeout (a second tap).
          if (run.native && graceMs > 0 && owner === run && !run.grace) {
            run.grace = setTimeout(() => {
              if (owner !== run || run.cancelled || run.failed) return;
              const heard = session.state.partial.trim();
              if (heard) session.onText(heard);
              run.cancelled = true;
              run.resolve(true);
              update(session, { listening: false, partial: '' });
              // Ownership stays until end so late words can't land in the next draft.
              try { speech.abort(); } catch { settle(run, false); }
            }, graceMs);
          }
          return run.done;
        },
      };
    },
  };
}
