import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, ServerError } from "./server";
import { useSession } from "./session";

// Profile photos, fetched once per version and shared by every Avatar.
// The server sends a version with each person ("photo"); the image itself is
// encrypted end-to-end like everything else, so it comes over the API rather
// than as a plain image URL.

type Entry = { version: string; uri: string };
type Photos = {
  // Latest known version per person (from /v1/people and person.updated).
  versions: Record<string, string | null>;
  uri: (userId: string | undefined) => string | null;
  learn: (people: { id: string; photo?: string | null }[]) => void;
};

const Ctx = createContext<Photos | null>(null);

export function PhotoProvider({ children }: { children: ReactNode }) {
  const { account } = useSession();
  const identity = account ? `${account.serverUrl}:${account.token}` : "";
  const [state, setState] = useState<{ identity: string; versions: Record<string, string | null>; images: Record<string, Entry> }>({ identity, versions: {}, images: {} });
  const loading = useRef(new Set<string>());
  const current = state.identity === identity ? state : { identity, versions: {}, images: {} };

  const learn = useCallback((people: { id: string; photo?: string | null }[]) => {
    setState(s => {
      const base = s.identity === identity ? s : { identity, versions: {}, images: {} };
      let changed = base !== s;
      const versions = { ...base.versions };
      for (const p of people) {
        const v = p.photo ?? null;
        if (versions[p.id] !== v) { versions[p.id] = v; changed = true; }
      }
      return changed ? { ...base, versions } : s;
    });
  }, [identity]);

  // Fetch any version we know about but haven't loaded.
  useEffect(() => {
    if (!account) return;
    for (const [id, version] of Object.entries(current.versions)) {
      if (!version || current.images[id]?.version === version) continue;
      const key = `${id}:${version}`;
      if (loading.current.has(key)) continue;
      loading.current.add(key);
      api.photo(account, id).then(photo => {
        setState(s => s.identity !== identity ? s : { ...s, images: { ...s.images, [id]: { version: photo.version, uri: `data:${photo.mime};base64,${photo.data}` } } });
      }).catch((e: unknown) => {
        // Removed in the meantime: forget it rather than retrying.
        if (e instanceof ServerError && e.status === 404) setState(s => s.identity !== identity ? s : { ...s, versions: { ...s.versions, [id]: null } });
      }).finally(() => loading.current.delete(key));
    }
  }, [account, identity, current.versions, current.images]);

  const value = useMemo<Photos>(() => ({
    versions: current.versions,
    uri: (userId) => {
      if (!userId) return null;
      const version = current.versions[userId];
      const image = current.images[userId];
      // Show the previous photo while a new one loads; nothing once it's removed.
      return version && image ? image.uri : null;
    },
    learn,
  }), [current.versions, current.images, learn]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function usePhotos() {
  return useContext(Ctx);
}
