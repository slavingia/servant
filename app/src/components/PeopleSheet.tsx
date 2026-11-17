import { useEffect, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Avatar } from "./Messaging";
import { Button, IconButton } from "./Button";
import { CheckBox } from "./CheckBox";
import { Radio } from "./Radio";
import { HISTORY_CHOICES, type ChatHistory } from "../lib/chat-members";
import { api, ServerError, type Person } from "../lib/server";
import { useSession } from "../lib/session";
import { radius, space, typography, createThemedStyles } from "../lib/theme";
import { ServeLoader } from "./ServeLoader";

// Pick people to read an agent chat. Before anything is sent they see all of it; once the chat has
// started, the person inviting chooses how much of what came before they see, as Teams asks.
export function PeopleSheet({ title, exclude, withHistory, busy = false, error, onDone, onClose }: {
  title: string; exclude: string[]; withHistory: boolean; busy?: boolean; error?: string | null;
  onDone: (userIds: string[], history: ChatHistory) => void; onClose: () => void;
}) {
  const styles = useStyles();
  const { account } = useSession();
  const [people, setPeople] = useState<Person[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [history, setHistory] = useState<ChatHistory>("none");
  useEffect(() => {
    if (!account) return;
    api.people(account).then(r => setPeople(r.people.filter(p => !p.agent && p.id !== r.me)))
      .catch(e => setLoadError(e instanceof ServerError ? e.message : "Couldn't load people"));
  }, [account]);
  const choices = (people ?? []).filter(p => !exclude.includes(p.id));
  const toggle = (id: string) => setPicked(list => list.includes(id) ? list.filter(x => x !== id) : [...list, id]);
  return <Modal visible transparent animationType="fade" onRequestClose={onClose}>
    <Pressable accessibilityLabel="Close" style={styles.scrim} onPress={onClose}>
      <Pressable testID="people-sheet" style={styles.sheet} accessibilityViewIsModal onPress={() => {}}>
        <View style={styles.head}>
          <Text accessibilityRole="header" style={styles.title}>{title}</Text>
          <IconButton icon="close" label="Cancel" edge="end" onPress={onClose} />
        </View>
        <ScrollView style={styles.list}>
          {loadError ? <Text accessibilityRole="alert" style={styles.note}>{loadError}</Text>
            : !people ? <ServeLoader style={{ margin: space.lg }} />
            : !choices.length ? <Text style={styles.note}>Everyone here can already read this chat</Text>
            : choices.map(p => {
              const on = picked.includes(p.id);
              return <Pressable key={p.id} testID={`invite-${p.id}`} accessibilityRole="checkbox" accessibilityLabel={p.name}
                accessibilityState={{ checked: on, disabled: busy }} aria-checked={on} disabled={busy} onPress={() => toggle(p.id)}
                style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
                <Avatar name={p.name} userId={p.id} size={36} />
                <Text style={styles.name}>{p.name}</Text>
                <CheckBox on={on} />
              </Pressable>;
            })}
        </ScrollView>
        {withHistory && picked.length ? <View accessibilityRole="radiogroup" accessibilityLabel="How much of the chat they see" style={styles.history}>
          <Text style={styles.label}>How much of the chat they see</Text>
          {HISTORY_CHOICES.map(c => <Radio key={c.id} testID={`history-${c.id}`} accessibilityState={{ checked: history === c.id, disabled: busy }} aria-checked={history === c.id}
            disabled={busy} onPress={() => setHistory(c.id)} style={({ pressed }) => [styles.choice, pressed && styles.pressed]}>
            <View style={[styles.dot, history === c.id && styles.dotOn]}>{history === c.id ? <View style={styles.dotInner} /> : null}</View>
            <Text style={styles.name}>{c.label}</Text>
          </Radio>)}
        </View> : null}
        <Text style={styles.footnote}>They can read the chat, and only you can message the agent</Text>
        {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
        <View style={styles.footer}>
          <Button testID="invite-done" label={picked.length ? "Add" : "Done"} busy={busy}
            onPress={() => picked.length ? onDone(picked, withHistory ? history : "all") : onClose()} />
        </View>
      </Pressable>
    </Pressable>
  </Modal>;
}

const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  scrim: { flex: 1, justifyContent: "flex-end", alignItems: "center", backgroundColor: colors.scrim },
  sheet: { width: "100%", maxWidth: 480, maxHeight: "90%", backgroundColor: colors.background, borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl, paddingTop: space.md, paddingBottom: space.xxl },
  head: { flexDirection: "row", alignItems: "center", paddingLeft: space.side, paddingRight: space.xs },
  title: { ...typography.heading, color: colors.ink, flex: 1 },
  list: { flexGrow: 0 },
  row: { minHeight: 56, paddingHorizontal: space.side, flexDirection: "row", alignItems: "center", gap: space.sm },
  name: { ...typography.body, color: colors.ink, flex: 1 },
  pressed: { backgroundColor: colors.surface },
  history: { paddingTop: space.sm, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  label: { ...typography.captionStrong, color: colors.muted, paddingHorizontal: space.side, paddingBottom: space.xs },
  choice: { minHeight: 44, paddingHorizontal: space.side, flexDirection: "row", alignItems: "center", gap: space.sm },
  dot: { width: 22, height: 22, borderRadius: radius.pill, borderWidth: 2, borderColor: colors.borderStrong, alignItems: "center", justifyContent: "center" },
  dotOn: { borderColor: colors.primary },
  dotInner: { width: 10, height: 10, borderRadius: radius.pill, backgroundColor: colors.primary },
  error: { ...typography.caption, color: colors.red, paddingHorizontal: space.side, paddingTop: space.xs },
  footer: { paddingHorizontal: space.side, paddingTop: space.md, gap: space.xs },
  note: { ...typography.caption, color: colors.muted, padding: space.side },
  footnote: { ...typography.caption, color: colors.muted, paddingHorizontal: space.side, paddingTop: space.sm },
}));
