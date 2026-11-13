export type DesktopNotice = { accountId: string; title: string; body: string; data: Record<string, unknown> };

export type DesktopWorkspace = { server: string; serverKey: string; discovery?: string };

declare global {
  interface Window {
    servantDesktop?: {
      platform: "macos";
      workspace?: DesktopWorkspace;
      takeInvite?: () => string | null;
      onInvite?: (callback: (link: string) => void) => () => void;
      notifications?: {
        show(value: DesktopNotice): Promise<boolean>;
        setBadge(count: number): Promise<void>;
        take(): DesktopNotice | null;
        onClick(callback: (value: DesktopNotice) => void): () => void;
      };
      storage?: {
        version?: number;
        getItem(key: string): Promise<string | null>;
        setItem(key: string, value: string): Promise<void>;
        removeItem(key: string): Promise<void>;
      };
    };
  }
}

export function isDesktop() {
  return typeof window !== "undefined" && window.servantDesktop?.platform === "macos";
}

// servant://pair links opened on the Mac (from Terminal, Mail or a browser).
// Calls back with the one that launched the app, then with each new one.
export function watchDesktopInvites(callback: (link: string) => void): () => void {
  if (!isDesktop()) return () => {};
  const bridge = window.servantDesktop!;
  const first = bridge.takeInvite?.();
  if (first) callback(first);
  return bridge.onInvite?.(callback) ?? (() => {});
}

// This configuration is bundled with the Mac app. QR codes never supply an
// address to which the phone should send its account credentials.
export function getDesktopWorkspace(): DesktopWorkspace | null {
  if (!isDesktop()) return null;
  return validWorkspace(window.servantDesktop?.workspace);
}

// The hosted web app (servant.com) is built for one server: its address and public key are
// compiled in (EXPO_PUBLIC_SERVANT_WORKSPACE, set when the page is exported), so the key comes from
// the website and never from the server it is about to trust. Absent in store builds and local dev.
export function getWebWorkspace(raw: string | undefined = process.env.EXPO_PUBLIC_SERVANT_WORKSPACE): DesktopWorkspace | null {
  if (typeof window === "undefined" || isDesktop() || !raw) return null;
  try { return validWorkspace(JSON.parse(raw)); } catch { return null; }
}

export function validWorkspace(workspace: DesktopWorkspace | undefined | null): DesktopWorkspace | null {
  if (!workspace || !/^(02|03)[0-9a-f]{64}$/.test(workspace.serverKey)) return null;
  try {
    const server = new URL(workspace.server);
    const loopback = server.hostname === "localhost" || server.hostname === "127.0.0.1" || server.hostname === "[::1]";
    if (server.protocol !== "https:" && !(server.protocol === "http:" && loopback)) return null;
    if (server.username || server.password) return null;
    if (workspace.discovery) {
      const discovery = new URL(workspace.discovery);
      if (discovery.protocol !== "https:" || discovery.username || discovery.password) return null;
    }
    return workspace;
  } catch {
    return null;
  }
}
