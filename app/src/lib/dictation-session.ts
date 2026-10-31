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
export function createDictationCoordinator(speech: Speech) {
  type Session = { active: boolean; state: DictationState; onText: (text: string) => void; onState: (state: DictationState) => void };
  type Run = { session: Session; native: boolean; cancelled: boolean; failed: boolean; stopping: boolean;
    done: Promise<boolean>; resolve: (ok: boolean) => void; unsubscribe?: () => void; timeout?: ReturnType<typeof setTimeout> };
  let owner: Run | undefined;
  const update = (session: Session, next: Partial<DictationState>) => {
    session.state = { ...session.state, ...next };
    if (session.active) session.onState(session.state);
  };
  const settle = (run: Run, ok: boolean) => {
    if (owner !== run) return;
    owner = undefined;
    clearTimeout(run.timeout);
    run.unsubscribe?.();
    update(run.session, { listening: false, partial: '' });
    run.resolve(ok && !run.cancelled && run.session.active);
  };
  const expire = (run: Run) => {
    clearTimeout(run.timeout);
    run.timeout = setTimeout(() => {
      if (owner !== run) return;
      run.failed = true;
      update(run.session, { error: "Dictation didn't finish. Review your draft and try again." });
      try { speech.abort(); } catch { /* The session is released below. */ }
      settle(run, false);
    }, 8000);
  };
  return {
    createSession(onText: Session['onText'], onState: Session['onState']) {
      const session: Session = { active: false, state: { listening: false, partial: '', error: '' }, onText, onState };
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
      return {
        setActive(active: boolean) {
          session.active = active;
          if (!active) cancel();
          else onState(session.state);
        },
        cancel,
        async start(language: string) {
          if (!session.active || owner?.session === session) return;
          if (owner) { update(session, { error: 'Dictation is finishing. Try again.' }); return; }
          let resolve!: Run['resolve'];
          const done = new Promise<boolean>(yes => { resolve = yes; });
          const run: Run = { session, native: false, cancelled: false, failed: false, stopping: false, done, resolve };
          owner = run;
          update(session, { listening: true, partial: '', error: '' });
          try {
            const permission = await speech.permission();
            if (owner !== run || !session.active || run.cancelled) return;
            if (!permission?.granted) {
              update(session, { error: messages['not-allowed'] });
              settle(run, false); return;
            }
            if (run.stopping) { settle(run, true); return; }
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
                run.failed = true;
                update(session, { partial: '', error: ['aborted', 'no-speech', 'speech-timeout'].includes(event.error)
                  ? '' : messages[event.error] ?? "Couldn't hear that. Try again" });
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
        finish(): Promise<boolean> {
          const run = owner;
          if (!run || run.session !== session) return Promise.resolve(session.active);
          if (run.cancelled) return Promise.resolve(false);
          if (!run.stopping) {
            run.stopping = true;
            expire(run);
            if (run.native) {
              try { speech.stop(); }
              catch { run.failed = true; try { speech.abort(); } catch {} settle(run, false); }
            }
          }
          return run.done;
        },
      };
    },
  };
}
