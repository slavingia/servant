import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { clearAccount, loadAccount, api, type Account } from "./hub";

type Session = {
  ready: boolean;
  account: Account | null;
  setAccount: (a: Account | null) => void;
  signOut: () => Promise<void>;
};

const Ctx = createContext<Session | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [account, setAccount] = useState<Account | null>(null);

  useEffect(() => {
    loadAccount().then((a) => {
      setAccount(a);
      setReady(true);
    });
  }, []);

  const signOut = useCallback(async () => {
    if (account) await api.signOut(account);
    await clearAccount();
    setAccount(null);
  }, [account]);

  const value = useMemo(() => ({ ready, account, setAccount, signOut }), [ready, account, signOut]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession() {
  const s = useContext(Ctx);
  if (!s) throw new Error("useSession outside SessionProvider");
  return s;
}
