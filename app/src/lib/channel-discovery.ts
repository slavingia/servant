import { useCallback, useRef, useState } from "react";
import { useFocusEffect } from "expo-router";
import { api, type BrowseChannel } from "./server";
import { useSession } from "./session";

export function useChannelDiscovery(enabled = true) {
  const { account } = useSession();
  const [channels, setChannels] = useState<BrowseChannel[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const cursor = useRef<string | null>(null);
  const generation = useRef(0);
  const busy = useRef(false);
  const load = useCallback(async (reset = false) => {
    if (!enabled || !account || (!reset && (busy.current || !cursor.current))) return;
    const ticket = reset ? ++generation.current : generation.current;
    if (reset) cursor.current = null;
    busy.current = true; setLoading(true); setError("");
    try {
      const page = await api.browsePage(account, reset ? undefined : cursor.current!);
      if (ticket !== generation.current) return;
      cursor.current = page.nextCursor;
      setChannels(old => {
        if (reset) return page.channels;
        const seen = new Set(old.map(channel => channel.id));
        return [...old, ...page.channels.filter(channel => !seen.has(channel.id))];
      });
    } catch {
      if (ticket === generation.current) setError("Couldn't load other channels. Tap to retry.");
    } finally {
      if (ticket === generation.current) { busy.current = false; setLoading(false); }
    }
  }, [account, enabled]);
  useFocusEffect(useCallback(() => {
    void load(true);
    return () => { generation.current++; busy.current = false; };
  }, [load]));
  return { channels, loading, error, refresh: () => load(true), more: () => load(), retry: () => load(!cursor.current) };
}
