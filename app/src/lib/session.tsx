import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { clearAccount, loadAccount, api, type Account } from "./server";

type Session = {
  ready: boolean;
  loadError: string | null;
  retryLoad: () => void;
  account: Account | null;
  setAccount: (a: Account | null) => void;
  signOut: () => Promise<void>;
};

const Ctx = createContext<Session | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [account, setAccount] = useState<Account | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    loadAccount().then((a) => {
      if (!active) return;
      setAccount(a);
      setReady(true);
    }).catch(() => {
      if (!active) return;
      setLoadError("Couldn't read your saved account. Unlock your device and try again.");
      setReady(true);
    });
    return () => { active = false; };
  }, [loadAttempt]);

  const retryLoad = useCallback(() => {
    setReady(false);
    setLoadError(null);
    setLoadAttempt(value => value + 1);
  }, []);

  const signOut = useCallback(async () => {
    if (account) await api.signOut(account);
    await clearAccount();
    setAccount(null);
  }, [account]);

  const value = useMemo(() => ({ ready, loadError, retryLoad, account, setAccount, signOut }), [ready, loadError, retryLoad, account, signOut]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession() {
  const s = useContext(Ctx);
  if (!s) throw new Error("useSession outside SessionProvider");
  return s;
}
