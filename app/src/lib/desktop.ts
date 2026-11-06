export type DesktopWorkspace = { server: string; serverKey: string; discovery?: string };

declare global {
  interface Window {
    servantDesktop?: {
      platform: "macos";
      workspace?: DesktopWorkspace;
      takeInvite?: () => string | null;
      onInvite?: (callback: (link: string) => void) => () => void;
      storage?: {
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

// Servant pair links opened on the Mac (from Terminal, Mail or a browser).
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
  const workspace = window.servantDesktop?.workspace;
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
