import { useEffect, useState } from "react";

/** "4:07" or "1:02:09": how long the call has been going. */
export function callDuration(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000)), m = Math.floor(s / 60), h = Math.floor(m / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m % 60).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** The running call time, ticking every second, or "" before the call starts. */
export function useCallClock(startedAt: number | undefined) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!startedAt) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [startedAt]);
  return startedAt ? callDuration(now - startedAt) : "";
}
