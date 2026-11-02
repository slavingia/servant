export type DeviceLink = { id: string; serverKey: string };
const ID = /^[A-Za-z0-9_-]{43}$/;
const KEY = /^(02|03)[0-9a-f]{64}$/;

export function deviceLinkFromParams(id: unknown, key: unknown): DeviceLink | null {
  return typeof id === "string" && ID.test(id) && typeof key === "string" && KEY.test(key)
    ? { id, serverKey: key }
    : null;
}

export function parseDeviceLink(input: string): DeviceLink | null {
  try {
    const url = new URL(input.trim());
    if (url.protocol !== "servant:" || url.hostname !== "link-device" || url.pathname || url.hash || url.username || url.password || url.port) return null;
    if ([...url.searchParams.keys()].some(key => key !== "id" && key !== "key")) return null;
    if (url.searchParams.getAll("id").length !== 1 || url.searchParams.getAll("key").length !== 1) return null;
    return deviceLinkFromParams(url.searchParams.get("id"), url.searchParams.get("key"));
  } catch {
    return null;
  }
}

export function deviceLinkUrl(link: DeviceLink): string {
  if (!deviceLinkFromParams(link.id, link.serverKey)) throw new Error("Invalid computer sign-in code");
  return `servant://link-device?${new URLSearchParams({ id: link.id, key: link.serverKey })}`;
}

export function deviceLinkMatchesAccount(link: DeviceLink, account: { serverKey?: string } | null): boolean {
  return !!account && KEY.test(account.serverKey ?? "") && link.serverKey === account.serverKey;
}
