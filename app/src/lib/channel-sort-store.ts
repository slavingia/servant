import { useSyncExternalStore } from "react";
import { getItem, setItem } from "./storage";
import { isChannelSort, type ChannelSort } from "./channel-sort";

// The chosen sort (per device) and a just-dragged order that the server
// hasn't confirmed yet. Shared by the Home list and the desktop sidebar.
const KEY = "servant.channelSort";
type State = { sort: ChannelSort; pending: string[] | null };
let state: State = { sort: "recent", pending: null };
let loaded = false;
const listeners = new Set<() => void>();
const emit = (next: Partial<State>) => { state = { ...state, ...next }; listeners.forEach(l => l()); };

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!loaded) {
    loaded = true;
    void getItem(KEY).then(value => { if (isChannelSort(value)) emit({ sort: value }); }).catch(() => {});
  }
  return () => { listeners.delete(listener); };
}

export function useChannelSort() {
  return useSyncExternalStore(subscribe, () => state, () => state);
}

export function setChannelSort(sort: ChannelSort) {
  emit({ sort });
  void setItem(KEY, sort).catch(() => {});
}

export function setPendingOrder(pending: string[] | null) {
  emit({ pending });
}
