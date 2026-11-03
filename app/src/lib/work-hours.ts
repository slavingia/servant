import { useEffect, useState } from "react";
import { api } from "./server";
import { useSession } from "./session";

// During work hours the server returns a reminder to use Microsoft Teams for
// official business. Posting stays open; the composer shows the reminder up
// front so nobody types a message first and learns about it afterwards.
// Shared across composers and refreshed every few minutes.
type Notice = { message: string } | null;
let cached: { key: string; at: number; notice: Notice } | null = null;
const listeners = new Set<(n: Notice) => void>();
const REFRESH_MS = 5 * 60_000;

export function useWorkHoursNotice(): string | null {
  const { account } = useSession();
  const key = account ? `${account.serverUrl}|${account.user.id}` : "";
  const [notice, setNotice] = useState<Notice>(cached?.key === key ? cached.notice : null);
  useEffect(() => {
    if (!account) return;
    let alive = true;
    const listen = (n: Notice) => { if (alive) setNotice(n); };
    listeners.add(listen);
    const load = () => {
      if (cached?.key === key && Date.now() - cached.at < REFRESH_MS) return listen(cached.notice);
      api.workHours(account).then(n => {
        cached = { key, at: Date.now(), notice: n };
        for (const l of listeners) l(n);
      }).catch(() => undefined); // An older server has no reminder; say nothing.
    };
    load();
    const timer = setInterval(load, 60_000);
    return () => { alive = false; listeners.delete(listen); clearInterval(timer); };
  }, [account, key]);
  return notice?.message ?? null;
}
