import { validServerKey } from "./tunnel-crypto.ts";

export function scanOptions(mode: unknown, account: { serverKey?: string } | null): {
  computer: boolean;
  returnTo: "/you" | "/welcome";
} {
  // A saved legacy account still needs an invite to reconnect securely.
  const paired = !!account && validServerKey(account.serverKey);
  return { computer: paired || mode === "computer", returnTo: paired ? "/you" : "/welcome" };
}
