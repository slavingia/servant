import { discover, request, ServerError, type Account } from "./server";
import { secureFetch } from "./secure-fetch";
import type { DesktopWorkspace } from "./desktop";
import { deviceLinkFromParams, deviceLinkMatchesAccount, type DeviceLink } from "./device-link";

export type DesktopLinkSession = {
  id: string;
  secret: string;
  code: string;
  expiresAt: number;
  intervalMs: number;
  workspace: DesktopWorkspace;
};
export type DeviceLinkPreview = { id: string; device: string; agent?: boolean; code: string; expiresAt: number; status: "pending" | "approved" };

async function withDeadline<T>(operation: (signal: AbortSignal) => Promise<T>, parent?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  if (parent?.aborted) controller.abort();
  parent?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(cancel, 20000);
  try {
    return await operation(controller.signal);
  } catch (error) {
    if (controller.signal.aborted && !parent?.aborted) throw new ServerError("The connection timed out. Check your connection and try again.");
    throw error;
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener("abort", cancel);
  }
}

async function desktopRequest(workspace: DesktopWorkspace, path: string, body: object, signal?: AbortSignal) {
  const send = (server: string) => secureFetch(server, workspace.serverKey, path, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal,
  });
  let response = await send(workspace.server).catch(() => null);
  if (signal?.aborted) throw new ServerError("Sign-in cancelled");
  if ((!response || response.status === 530 || response.status === 502 || response.status === 503) && workspace.discovery) {
    const server = await discover(workspace.discovery, signal);
    if (signal?.aborted) throw new ServerError("Sign-in cancelled");
    workspace.server = server;
    response = await send(server).catch(() => null);
  }
  if (!response) throw new ServerError("Couldn't reach your workspace. Check your connection and try again.");
  if (!response.ok) {
    const error = await response.json().catch(() => null);
    throw new ServerError(error?.error?.message || "Couldn't sign in. Try a new QR code.", response.status, error?.error?.code || "http");
  }
  return response.json();
}

export async function startDesktopLink(workspace: DesktopWorkspace, signal?: AbortSignal): Promise<DesktopLinkSession> {
  return withDeadline(async requestSignal => {
    const target = { ...workspace };
    if (target.discovery) target.server = await discover(target.discovery, requestSignal);
    const data = await desktopRequest(target, "/v1/device-links", { device: "Mac" }, requestSignal);
    return { ...data, workspace: target };
  }, signal);
}

// A poll never writes account storage: the active screen owns completing sign-in.
export async function pollDesktopLink(session: DesktopLinkSession, signal?: AbortSignal): Promise<Account | null> {
  const data = await withDeadline(requestSignal => desktopRequest(session.workspace, `/v1/device-links/${session.id}/poll`, { secret: session.secret }, requestSignal), signal);
  if (data.status === "pending") return null;
  if (data.status !== "approved" || !data.token || !data.user?.id) throw new ServerError("Couldn't finish signing in. Try a new QR code.");
  return {
    token: data.token, user: data.user, serverName: data.server?.name || "Workspace",
    serverUrl: session.workspace.server, serverKey: session.workspace.serverKey, discovery: session.workspace.discovery,
  };
}

function trustedPath(account: Account, link: DeviceLink) {
  if (!deviceLinkFromParams(link.id, link.serverKey) || !deviceLinkMatchesAccount(link, account)) throw new ServerError("This computer is connecting to a different workspace. Open the Mac app for your workspace and scan its code.");
  return `/v1/device-links/${link.id}`;
}

export async function previewDeviceLink(account: Account, link: DeviceLink, signal?: AbortSignal): Promise<DeviceLinkPreview> {
  return withDeadline(async requestSignal => (await request(account, trustedPath(account, link), { signal: requestSignal })).json(), signal);
}

export async function approveDeviceLink(account: Account, link: DeviceLink) {
  await withDeadline(signal => request(account, trustedPath(account, link) + "/approve", { method: "POST", body: "{}", signal }));
}

export async function denyDeviceLink(account: Account, link: DeviceLink) {
  await withDeadline(signal => request(account, trustedPath(account, link) + "/deny", { method: "POST", body: "{}", signal }));
}
