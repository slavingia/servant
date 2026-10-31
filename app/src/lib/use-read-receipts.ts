import { useCallback, useLayoutEffect, useRef } from "react";
import { AppState, Platform } from "react-native";
import { api, type Account, type Post } from "./server";
import { createReadReceiptQueue } from "./read-receipts";

const VIEWABILITY = { viewAreaCoveragePercentThreshold: 50, minimumViewTime: 500 };
type VisibleItems = { viewableItems: { item: Post; isViewable: boolean }[] };

export function useReadReceipts(account: Account | null, conversationId: string, focused: boolean, enabled = true, scope = "", posts?: Post[]) {
  const latestAccount = useRef(account);
  const latestPosts = useRef(posts);
  const identity = account ? JSON.stringify([account.serverKey, account.token, account.user.id]) : "";
  const controller = useRef<{
    update: (posts: Post[]) => void;
    refreshPosts: () => void;
    setScreenActive: (active: boolean) => void;
  } | null>(null);
  const screenActive = useRef(focused && enabled);

  useLayoutEffect(() => { latestAccount.current = account; }, [account]);
  useLayoutEffect(() => { latestPosts.current = posts; }, [posts]);

  useLayoutEffect(() => {
    screenActive.current = focused && enabled;
    // Disabled means the list is absent/loading or inaccessible. Do not reuse
    // its old visible rows when a replacement snapshot mounts in a new position.
    if (!enabled) controller.current?.update([]);
    controller.current?.setScreenActive(screenActive.current);
  }, [focused, enabled]);

  useLayoutEffect(() => {
    const initialAccount = latestAccount.current;
    if (!initialAccount || !conversationId) return;
    const queue = createReadReceiptQueue({ conversationId, me: initialAccount.user.id,
      send: messageIds => {
        const currentAccount = latestAccount.current;
        if (!currentAccount || currentAccount.token !== initialAccount.token || currentAccount.serverKey !== initialAccount.serverKey)
          return Promise.reject(new Error("Account changed"));
        return api.markMessagesRead(currentAccount, conversationId, messageIds);
      },
    });
    let foreground = AppState.currentState === "active";
    let androidFocused = true;
    let disposed = false;
    let activeSince = Date.now();
    let previouslyActive = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const isActive = () => !disposed && screenActive.current && foreground && androidFocused;
    const cancel = () => { if (timer) clearTimeout(timer); timer = null; };
    const schedule = (delay: number) => {
      if (!isActive() || timer || !queue.hasPending()) return;
      timer = setTimeout(async () => {
        timer = null;
        queue.setActive(isActive());
        await queue.flush();
        schedule(5000);
      }, delay);
    };
    const updateActive = () => {
      const active = isActive();
      if (active && !previouslyActive) activeSince = Date.now();
      previouslyActive = active;
      queue.setActive(active);
      cancel();
      // Give a newly foregrounded screen time to be seen, even if its list's
      // last viewability callback happened while it was in the background.
      schedule(500);
    };
    const controls = {
      update(posts: Post[]) {
        queue.setVisible(posts);
        if (latestPosts.current) queue.refreshPosts(latestPosts.current);
        queue.setActive(isActive());
        // FlatList applies its own dwell threshold. Also require 500 ms of
        // foreground time if its timer started while this screen was hidden.
        schedule(Math.max(0, 500 - (Date.now() - activeSince)));
      },
      refreshPosts() {
        if (latestPosts.current) queue.refreshPosts(latestPosts.current);
        // Keep newly completed content on screen briefly before acknowledging.
        schedule(500);
      },
      setScreenActive: updateActive,
    };
    controller.current = controls;
    const state = AppState.addEventListener("change", value => {
      foreground = value === "active";
      updateActive();
    });
    const blur = Platform.OS === "android" ? AppState.addEventListener("blur", () => { androidFocused = false; updateActive(); }) : null;
    const focus = Platform.OS === "android" ? AppState.addEventListener("focus", () => { androidFocused = true; updateActive(); }) : null;
    updateActive();
    return () => {
      disposed = true;
      cancel();
      queue.dispose();
      state.remove(); blur?.remove(); focus?.remove();
      if (controller.current === controls) controller.current = null;
    };
  }, [identity, conversationId, scope]);

  useLayoutEffect(() => { controller.current?.refreshPosts(); }, [posts]);

  const onViewableItemsChanged = useCallback(({ viewableItems }: VisibleItems) => {
    controller.current?.update(viewableItems.filter(item => item.isViewable).map(item => item.item));
  }, []);
  return { onViewableItemsChanged, viewabilityConfig: VIEWABILITY };
}
