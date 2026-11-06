import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { clearAccount, loadAccount, saveAccount, api, type Account } from "./server";

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
      // The server decides who this device is. After two accounts are merged the id saved
      // at sign-in is stale, so "You" and the profile photo would point at the old person.
      if (a?.serverKey) void api.me(a).then((me: { user?: { id?: string; name?: string; role?: Account["user"]["role"] } }) => {
        const u = me?.user;
        if (!active || !u?.id || (u.id === a.user.id && u.name === a.user.name && u.role === a.user.role)) return;
        const fixed = { ...a, user: { ...a.user, id: u.id, name: u.name ?? a.user.name, role: u.role ?? a.user.role } };
        setAccount(fixed);
        void saveAccount(fixed);
      }).catch(() => { /* offline: keep the saved identity */ });
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
