// Closing the tour, by finishing or by skipping, saves "seen" on the server, so it is once for the person and
// not once for each phone and computer they sign in on, and so people who were here before the tour are never
// interrupted by it (the server marks only someone who joins from now on: server/tour.mjs).
//
// The app also remembers at once, on the saved account and for this run, so the tour does not come back while
// the server is being told. If the server could not be told (offline, or the app closed first), the saved
// account keeps `tourClosed`: the tour stays closed on this device and the server is told the next time the app
// runs, until its own answer says the tour is no longer due (lib/session-profile.ts).
import { accountId, api, saveAccount, type Account } from "./server";

const dismissed = new Set<string>();
const told = new Set<string>();
const key = (account: Account) => `${accountId(account)}:${account.token}`;

/** Whether this run of the app has already closed the tour for this account. */
export const tourDismissed = (account: Account) => dismissed.has(key(account)) || account.tourClosed === true;

export function markTourSeen(account: Account) {
  dismissed.add(key(account));
  told.add(key(account));
  if (account.tourDue) void saveAccount({ ...account, tourDue: false, tourClosed: true }).catch(() => {});
  void api.tourSeen(account).catch(() => { told.delete(key(account)); });
}

/** Tells the server again about a tour this device closed earlier, once per run. */
export function retryTourSeen(account: Account) {
  if (!account.tourClosed || told.has(key(account))) return;
  told.add(key(account));
  void api.tourSeen(account).catch(() => {});
}
