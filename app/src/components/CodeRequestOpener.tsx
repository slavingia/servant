import { useEffect, useRef } from "react";
import { AppState } from "react-native";
import { router, usePathname } from "expo-router";
import { api } from "../lib/server";
import { useSession } from "../lib/session";
import { useLiveActions } from "../lib/live";
import { codeRequestAt, codeRequestToOpen } from "../lib/code-request-open";

// When an automation of yours asks for a one-time code (docs/code-requests.md) and Servant is already open, the
// Enter code screen comes up by itself, with its box ready to type in: no need to find the alert first. It comes up
// for a new request (live event), and for one still waiting when the app comes back to the front. The Mac app also
// brings its window forward. Each request comes up once; closing the screen leaves it to the alert.
export function CodeRequestOpener() {
  const { account } = useSession();
  const { subscribe } = useLiveActions();
  const pathname = usePathname();
  const path = useRef(pathname);
  const shown = useRef(new Set<string>());
  useEffect(() => {
    path.current = pathname;
    const here = codeRequestAt(pathname);
    if (here) shown.current.add(here);
  }, [pathname]);
  useEffect(() => {
    if (!account) return;
    let live = true;
    const open = (id: string) => {
      if (!live || shown.current.has(id) || codeRequestAt(path.current) === id) return;
      shown.current.add(id);
      if (typeof window !== "undefined") void window.servantDesktop?.focus?.().catch(() => false);
      router.push({ pathname: "/code/[id]", params: { id } });
    };
    const check = () => api.codeRequests(account).then(r => { const id = codeRequestToOpen(r.requests, shown.current, Date.now()); if (id) open(id); }, () => {});
    const unsubscribe = subscribe(e => {
      if (e.event === "code.requested") void check();
      else if (e.event === "ready") void check();
    });
    const state = AppState.addEventListener("change", s => { if (s === "active") void check(); });
    return () => { live = false; unsubscribe(); state.remove(); };
  }, [account, subscribe]);
  return null;
}
