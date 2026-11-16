import { useEffect, useState } from "react";

/**
 * The time, looked at again every so often: for words that change by the minute ("about 17 min left"), never a
 * stopwatch. With `every` null nothing ticks, so a row with nothing running is not drawn again. When it starts
 * ticking it looks once straight away, because the time it holds may have stood still for a while.
 */
export function useNow(every: number | null) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!every) return;
    const look = () => setNow(Date.now());
    const first = setTimeout(look, 0);
    const timer = setInterval(look, every);
    return () => { clearTimeout(first); clearInterval(timer); };
  }, [every]);
  return now;
}
