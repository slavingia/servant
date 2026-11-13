// Expiry follows each saved server credential; an inactive server never locks the active one.
import { useSyncExternalStore } from "react";
import { createSessionExpiryStore } from "./session-expiry-state";
const store = createSessionExpiryStore();
export const selectSessionAccount = store.select;
export const noteSessionExpired = store.noteExpired;
export const clearSessionExpired = store.clear;
export const noteSessionInfo = store.noteInfo;
export const checkSessionOnResume = store.checkResume;
export const resetSessionExpiry = store.reset;
export const sessionExpiredNow = () => store.snapshot().expired;
export const sessionInfoNow = () => store.snapshot().info;
export function useSessionExpiry() {
  return useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
}
