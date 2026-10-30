// Slack-style "Alex is typing…": who else is typing in this conversation (or thread).
import { useCallback, useEffect, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { api, type Account } from "./server";
import { useLive } from "./live";
import { colors } from "./theme";

// A typing ping lasts this long unless it is refreshed.
const SHOW_MS = 6000;
// While someone keeps typing, their phone re-sends the ping this often.
const PING_EVERY_MS = 3000;

export function typingText(names: string[]) {
  if (names.length === 0) return "";
  if (names.length === 1) return `${names[0]} is typing…`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing…`;
  return "Several people are typing…";
}

/** Who is typing here. `threadRoot` null = the main conversation, not its threads. */
export function useTyping(conversationId: string, threadRoot: string | null, me: string) {
  const { subscribe } = useLive();
  const [typing, setTyping] = useState<Record<string, { name: string; until: number }>>({});

  useEffect(
    () =>
      subscribe((e) => {
        if (e.event === "typing") {
          const d = e.data;
          if (d.conversationId !== conversationId || d.threadRoot !== threadRoot || d.user.id === me) return;
          setTyping((t) => ({ ...t, [d.user.id]: { name: d.user.name, until: Date.now() + SHOW_MS } }));
        } else if (e.event === "message.created") {
          // Their message arrived: they've stopped typing.
          const uid = e.data.user.id;
          setTyping((t) => {
            if (!t[uid]) return t;
            const { [uid]: _gone, ...rest } = t;
            return rest;
          });
        }
      }),
    [subscribe, conversationId, threadRoot, me],
  );

  // Drop people whose ping has run out.
  const active = Object.keys(typing).length > 0;
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      const now = Date.now();
      setTyping((t) => {
        const kept = Object.fromEntries(Object.entries(t).filter(([, v]) => v.until > now));
        return Object.keys(kept).length === Object.keys(t).length ? t : kept;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [active]);

  return Object.values(typing).map((v) => v.name);
}

/** Call on every keystroke; sends at most one ping every few seconds. */
export function useTypingPing(account: Account | null, conversationId: string, threadRoot?: string) {
  const last = useRef(0);
  return useCallback(
    (text: string) => {
      if (!account || !text.trim()) return;
      const now = Date.now();
      if (now - last.current < PING_EVERY_MS) return;
      last.current = now;
      void api.typing(account, conversationId, threadRoot);
    },
    [account, conversationId, threadRoot],
  );
}

export function TypingLine({ names }: { names: string[] }) {
  const text = typingText(names);
  // The line keeps its height so the messages don't jump when someone starts typing.
  return (
    <View style={styles.line} accessibilityLiveRegion="polite" accessible={!!text} accessibilityLabel={text || undefined}>
      <Text style={styles.text} numberOfLines={1}>
        {text}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  line: { height: 20, paddingHorizontal: 20, justifyContent: "center", backgroundColor: colors.white },
  text: { fontSize: 13, color: colors.muted },
});
