import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { router } from "expo-router";
import { AppState, Platform } from "react-native";
import { accountId, activateAccount, loadAccounts, removeAccount, saveAccount, subscribeAccounts, supportsMultipleServers, api, type Account, type Accounts } from "./server";
import { setPendingOrder } from "./channel-sort-store";
import { clearDrafts, migrateDrafts } from "./drafts";
import { clearScreenCaches } from "./screen-cache";
import { resetEmailNudge } from "./email-nudge";
import { ALL_FEATURES, FeaturesContext, landingHref, normalizeFeatures, withDeepWork } from "./features.ts";
import { deepWorkFromServer } from "./deep-work.ts";
import { reconcileAccountProfile, type ServerProfile } from "./session-profile.ts";
import { ThemeProvider } from "./theme";
import { NO_SURVEY_ACCESS, surveyPermissionsFromServer, type SurveyPermissions } from "./survey-permissions.ts";
import { noteSessionInfo, resetSessionExpiry, selectSessionAccount } from "./session-expiry";

type Session = {
  ready: boolean;
  surveyPermissions: SurveyPermissions;
  loadError: string | null;
  retryLoad: () => void;
  accounts: Account[];
  account: Account | null;
  supportsMultipleServers: boolean;
  setAccount: (a: Account | null) => void;
  updateAccount: (a: Account) => Promise<void>;
  switchAccount: (id: string) => Promise<void>;
  signOut: (id?: string) => Promise<void>;
  deepWork: boolean;
  setDeepWork: (on: boolean) => Promise<void>;
  learnDeepWork: (on: boolean) => void;
};
const Ctx = createContext<Session | null>(null);
const landingFor = (a: Account) => landingHref(withDeepWork(normalizeFeatures(a.features), !!a.deepWork));
const draftScope = (a: Account) => `${accountId(a)}:${a.user.id}`;

export function SessionProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [surveyAccess, setSurveyAccess] = useState<{ identity: string; permissions: SurveyPermissions } | null>(null);
  const [saved, setSaved] = useState<Accounts>({ accounts: [], activeId: null });
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const deepWorkBusy = useRef(new Map<string, number>());
  const savedRef = useRef(saved);
  const account = saved.accounts.find(a => accountId(a) === saved.activeId) ?? null;

  useEffect(() => {
    let active = true;
    let observed = 0;
    const apply = (value: Accounts) => {
      if (!active) return;
      const previous = savedRef.current.accounts.find(a => accountId(a) === savedRef.current.activeId);
      const selected = value.accounts.find(a => accountId(a) === value.activeId);
      const credentialChanged = previous?.token !== selected?.token || previous?.user.id !== selected?.user.id || savedRef.current.activeId !== value.activeId;
      if (credentialChanged) {
        setPendingOrder(null);
        void resetEmailNudge();
        // What screens kept in memory belongs to the account that was signed in.
        clearScreenCaches();
      }
      selectSessionAccount(selected ? `${accountId(selected)}:${selected.token}` : null);
      savedRef.current = value;
      setSaved(value);
    };
    const unsubscribe = subscribeAccounts(value => { observed++; apply(value); });
    loadAccounts().then(async value => {
      const version = observed;
      // Unscoped drafts from the single-server app belong to that first account.
      if (value.accounts[0]) await migrateDrafts(draftScope(value.accounts[0]));
      if (!active) return;
      // Another tab may have changed the accounts while drafts were loading.
      if (observed === version) apply(value);
      setReady(true);
    }).catch(error => {
      if (!active) return;
      setLoadError(error instanceof Error && error.message.startsWith("This browser cannot safely save") ? error.message : "Couldn't read your saved servers. Unlock your device and try again.");
      setReady(true);
    });
    return () => { active = false; unsubscribe(); };
  }, [loadAttempt]);

  const retryLoad = useCallback(() => { setReady(false); setLoadError(null); setLoadAttempt(value => value + 1); }, []);
  const updateAccount = useCallback((a: Account) => saveAccount(a), []);
  const setAccount = useCallback((a: Account | null) => {
    if (a) void saveAccount(a).catch(() => { /* Background refreshes retain the last saved value when storage is unavailable. */ });
  }, []);
  const patchAccount = useCallback((source: Account, change: (a: Account) => Account) => {
    const current = savedRef.current.accounts.find(a => accountId(a) === accountId(source) && a.token === source.token);
    return current ? saveAccount(change(current)) : Promise.resolve();
  }, []);

  const identity = account ? `${accountId(account)}:${account.token}` : "";
  useEffect(() => {
    if (!account?.serverKey) return;
    let current = true;
    let revision = 0;
    const refresh = () => {
      const source = savedRef.current.accounts.find(a => accountId(a) === savedRef.current.activeId);
      if (!source || `${accountId(source)}:${source.token}` !== identity) return;
      const run = ++revision;
      void api.me(source).then((me: ServerProfile) => {
        const selected = savedRef.current.accounts.find(a => accountId(a) === savedRef.current.activeId);
        if (!current || run !== revision || !selected || `${accountId(selected)}:${selected.token}` !== identity || selected.user.id !== source.user.id) return;
        noteSessionInfo(me.session, identity);
        const permissions = surveyPermissionsFromServer(me.surveyPermissions);
        setSurveyAccess(previous => previous?.identity === identity && previous.permissions.canView === permissions.canView && previous.permissions.canManage === permissions.canManage ? previous : { identity, permissions });
        return patchAccount(source, latest => reconcileAccountProfile(latest, me, !!deepWorkBusy.current.get(identity)));
      }).catch(() => { /* Offline: keep saved settings and retry on foreground or browser reconnection. */ });
    };
    refresh();
    const foreground = AppState.addEventListener("change", state => { if (state === "active") refresh(); });
    if (Platform.OS === "web") window.addEventListener("online", refresh);
    return () => {
      current = false;
      foreground.remove();
      if (Platform.OS === "web") window.removeEventListener("online", refresh);
    };
    // Reconcile per credential and on resume/reconnect, not after every profile refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity]);

  const switchAccount = useCallback(async (id: string) => {
    const current = savedRef.current;
    if (id === current.activeId) return;
    const next = current.accounts.find(a => accountId(a) === id);
    if (!next) throw new Error("This server is no longer signed in");
    // Reset the route before its account-scoped UI remounts.
    router.replace(landingFor(next));
    await activateAccount(id);
  }, []);
  const signOut = useCallback(async (id?: string) => {
    const leaving = id ? savedRef.current.accounts.find(a => accountId(a) === id) : account;
    if (!leaving) return;
    await api.signOut(leaving);
    await removeAccount(accountId(leaving), leaving.token);
    await clearDrafts(draftScope(leaving));
    resetSessionExpiry(`${accountId(leaving)}:${leaving.token}`);
    const current = savedRef.current;
    if (account && accountId(leaving) === accountId(account)) {
      const next = current.accounts.find(a => accountId(a) === current.activeId);
      router.replace(next ? landingFor(next) : "/welcome");
    }
  }, [account]);

  const setDeepWork = useCallback(async (on: boolean) => {
    if (!account || !!account.deepWork === on) return;
    const before = !!account.deepWork;
    deepWorkBusy.current.set(identity, (deepWorkBusy.current.get(identity) ?? 0) + 1);
    try {
      await patchAccount(account, a => ({ ...a, deepWork: on }));
      const answer = await api.setDeepWork(account, on);
      await patchAccount(account, a => ({ ...a, deepWork: deepWorkFromServer(answer.deepWork) }));
    } catch (error) {
      await patchAccount(account, a => ({ ...a, deepWork: before }));
      throw error;
    } finally { deepWorkBusy.current.set(identity, Math.max(0, (deepWorkBusy.current.get(identity) ?? 1) - 1)); }
  }, [account, identity, patchAccount]);
  const learnDeepWork = useCallback((on: boolean) => {
    if (!account || deepWorkBusy.current.get(identity)) return;
    void patchAccount(account, a => !!a.deepWork === on ? a : { ...a, deepWork: on }).catch(() => {});
  }, [account, identity, patchAccount]);

  const deepWork = !!account?.deepWork;
  const surveyPermissions = surveyAccess?.identity === identity ? surveyAccess.permissions : NO_SURVEY_ACCESS;
  const value = useMemo(() => ({ surveyPermissions, ready, loadError, retryLoad, accounts: saved.accounts, account, supportsMultipleServers, setAccount, updateAccount, switchAccount, signOut, deepWork, setDeepWork, learnDeepWork }), [surveyPermissions, ready, loadError, retryLoad, saved.accounts, account, setAccount, updateAccount, switchAccount, signOut, deepWork, setDeepWork, learnDeepWork]);
  const features = useMemo(() => withDeepWork(account?.features ? normalizeFeatures(account.features) : ALL_FEATURES, deepWork), [account, deepWork]);
  return <Ctx.Provider value={value}><FeaturesContext.Provider value={features}><ThemeProvider primaryColor={account?.theme?.primaryColor}>{children}</ThemeProvider></FeaturesContext.Provider></Ctx.Provider>;
}

export function useSession() {
  const session = useContext(Ctx);
  if (!session) throw new Error("useSession outside SessionProvider");
  return session;
}
