// Ask a signed-in phone to approve this device: create a device-link request,
// show its code, poll until the phone approves, then hand back the account.
// Shared by the Mac app's sign-in screen and the browser's "approve from my
// other device" step when a name is already taken.
import { useEffect, useState } from "react";
import type { DesktopWorkspace } from "./desktop";
import { pollDesktopLink, startDesktopLink, type DesktopLinkSession } from "./device-link-api";
import { saveAccountIfCurrent, ServerError, type Account } from "./server";

export type DeviceLinkApproval = {
  session: DesktopLinkSession | null;
  error: string | null;
  connection: string | null;
  completing: boolean;
  seconds: number;
  expired: boolean;
  retry: () => void;
};

export function useDeviceLinkApproval(workspace: DesktopWorkspace, device: string, onSignedIn: (account: Account) => void): DeviceLinkApproval {
  const [attempt, setAttempt] = useState(0);
  const [session, setSession] = useState<DesktopLinkSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connection, setConnection] = useState<string | null>(null);
  const [completing, setCompleting] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const { server, serverKey, discovery } = workspace;

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const clock = setInterval(() => setNow(Date.now()), 1000);
    const poll = async (current: DesktopLinkSession) => {
      if (controller.signal.aborted) return;
      if (Date.now() >= current.expiresAt) return;
      try {
        const account = await pollDesktopLink(current, controller.signal);
        if (controller.signal.aborted) return;
        setConnection(null);
        if (account) {
          setCompleting(true);
          if (!await saveAccountIfCurrent(account, () => !controller.signal.aborted)) return;
          onSignedIn(account);
          return;
        }
      } catch (e) {
        if (controller.signal.aborted) return;
        if (e instanceof ServerError && (!e.status || e.status >= 500)) {
          setConnection("Reconnecting to the server…");
        } else {
          setError(e instanceof Error ? e.message : "Couldn't finish signing in. Get a new code.");
          setCompleting(false);
          return;
        }
      }
      timer = setTimeout(() => void poll(current), Math.max(2000, current.intervalMs || 2000));
    };
    startDesktopLink({ server, serverKey, discovery }, controller.signal, device).then(current => {
      if (controller.signal.aborted) return;
      setSession(current);
      setNow(Date.now());
      timer = setTimeout(() => void poll(current), Math.max(2000, current.intervalMs || 2000));
    }).catch(e => {
      if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "Couldn't create a sign-in code. Try again.");
    });
    return () => {
      controller.abort();
      clearTimeout(timer);
      clearInterval(clock);
    };
    // onSignedIn is an event handler, not an input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server, serverKey, discovery, device, attempt]);

  const seconds = session ? Math.max(0, Math.ceil((session.expiresAt - now) / 1000)) : 0;
  const expired = !!session && seconds === 0 && !completing;
  const retry = () => { setSession(null); setError(null); setConnection(null); setCompleting(false); setAttempt(v => v + 1); };
  return { session, error, connection, completing, seconds, expired, retry };
}
