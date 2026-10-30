import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Alert, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { Button } from "../components/Button";
import { Avatar } from "../components/Messaging";
import { api, ServerError, type Conversation, type Person } from "../lib/server";
import { useLive } from "../lib/live";
import { useSession } from "../lib/session";
import { colors } from "../lib/theme";

export default function ChannelInfo() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { account } = useSession();
  const { refresh } = useLive();
  const [conv, setConv] = useState<Conversation | null>(null);
  const [topic, setTopic] = useState("");
  const [everyone, setEveryone] = useState<Person[]>([]);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [opening, setOpening] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!account) return;
    try {
      const [c, p] = await Promise.all([api.conversation(account, id), api.people(account)]);
      setConv(c.conversation);
      setTopic(c.conversation.topic);
      setEveryone(p.people);
    } catch (e) {
      setError(e instanceof ServerError ? e.message : "Couldn't load the channel");
    }
  }, [account, id]);
  useEffect(() => {
    load();
  }, [load]);

  if (!account || !conv) return <View style={styles.root}>{error ? <Text style={styles.error}>{error}</Text> : null}</View>;
  const memberIds = new Set((conv.members ?? []).map((m) => m.id));
  const notIn = everyone.filter((p) => !memberIds.has(p.id));

  const saveTopic = async () => {
    try {
      await api.updateChannel(account, id, { topic });
      setSaved(true);
      setError(null);
      refresh();
    } catch (e) {
      setError(e instanceof ServerError ? e.message : "Couldn't save");
    }
  };
  const add = async (p: Person) => {
    try {
      await api.addMembers(account, id, [p.id]);
      await load();
    } catch (e) {
      setError(e instanceof ServerError ? e.message : "Couldn't add them");
    }
  };
  const message = async (person: Person) => {
    if (opening || person.id === account.user.id) return;
    setOpening(person.id);
    setError(null);
    try {
      const conversation = await api.openDm(account, [person.id]);
      router.push({ pathname: "/c/[id]", params: { id: conversation.id, compose: "1" } });
    } catch (e) {
      setError(e instanceof ServerError ? e.message : "Couldn't open the conversation. Try again");
    } finally {
      setOpening(null);
    }
  };
  const leave = () => {
    const go = async () => {
      try {
        await api.leave(account, id);
        refresh();
        router.dismissTo("/channels");
      } catch (e) {
        setError(e instanceof ServerError ? e.message : "Couldn't leave");
      }
    };
    if (Platform.OS === "web") return void go();
    Alert.alert(`Leave #${conv.title}?`, conv.private ? "You'll need someone to add you back" : "You can join again from Browse channels", [
      { text: "Cancel", style: "cancel" },
      { text: "Leave", style: "destructive", onPress: go },
    ]);
  };

  return (
    <ScrollView style={styles.root} contentContainerStyle={{ padding: 20, paddingBottom: 48 }} keyboardShouldPersistTaps="handled">
      <Text style={styles.title}>#{conv.title}</Text>
      <Text style={styles.sub}>
        {conv.private ? "Private" : "Public"} · {conv.memberCount} {conv.memberCount === 1 ? "member" : "members"}
      </Text>

      <Text style={styles.label}>Topic</Text>
      <TextInput
        accessibilityLabel="Topic"
        value={topic}
        onChangeText={(t) => {
          setTopic(t);
          setSaved(false);
        }}
        placeholder="What's this channel for?"
        placeholderTextColor="#8A8F96"
        style={styles.input}
        maxLength={250}
      />
      {topic !== conv.topic && !saved ? <Button label="Save topic" kind="secondary" onPress={saveTopic} style={{ marginTop: 10 }} /> : null}
      {saved ? <Text style={styles.ok}>Saved</Text> : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}

      <View style={styles.sectionRow}>
        <Text style={styles.label}>Members</Text>
        {notIn.length ? (
          <Pressable accessibilityRole="button" onPress={() => setAdding((a) => !a)} hitSlop={8}>
            <Text style={styles.link}>{adding ? "Done" : "Add people"}</Text>
          </Pressable>
        ) : null}
      </View>
      {adding
        ? notIn.map((p) => (
            <Pressable key={p.id} accessibilityRole="button" accessibilityLabel={`Add ${p.name}`} onPress={() => add(p)} style={styles.person}>
              <Avatar name={p.name} size={32} />
              <Text style={styles.personName}>{p.name}</Text>
              <Text style={styles.link}>Add</Text>
            </Pressable>
          ))
        : (conv.members ?? []).map((p) => (
            <Pressable
              key={p.id}
              accessibilityRole={p.id === account.user.id ? undefined : "button"}
              accessibilityLabel={`${p.name}${p.id === account.user.id ? ", you" : ""}`}
              accessibilityHint={p.id === account.user.id ? undefined : "Open direct message"}
              disabled={p.id === account.user.id || !!opening}
              onPress={() => void message(p)}
              style={({ pressed }) => [styles.person, pressed && { backgroundColor: colors.surface }]}
            >
              <Avatar name={p.name} size={32} />
              <Text style={styles.personName}>
                {p.name}
                {p.id === account.user.id ? " (you)" : ""}
              </Text>
              {opening === p.id ? <ActivityIndicator color={colors.blue} /> : p.id !== account.user.id ? <Text style={styles.messageLink}>Message</Text> : null}
            </Pressable>
          ))}

      {conv.name !== "general" ? (
        <Pressable accessibilityRole="button" onPress={leave} style={styles.danger}>
          <Text style={styles.dangerText}>Leave channel</Text>
        </Pressable>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.white },
  title: { fontSize: 26, fontWeight: "700", color: colors.ink },
  sub: { marginTop: 4, fontSize: 15, color: colors.muted },
  label: { marginTop: 24, marginBottom: 8, fontSize: 15, fontWeight: "600", color: colors.ink },
  input: { minHeight: 50, borderWidth: 1, borderColor: colors.line, borderRadius: 12, backgroundColor: colors.surface, paddingHorizontal: 14, fontSize: 17, color: colors.ink },
  ok: { marginTop: 8, color: colors.muted, fontSize: 15 },
  error: { marginTop: 12, color: colors.red, fontSize: 15 },
  sectionRow: { flexDirection: "row", alignItems: "flex-end", justifyContent: "space-between" },
  link: { color: colors.blue, fontSize: 16, fontWeight: "600", marginBottom: 8 },
  messageLink: { color: colors.blue, fontSize: 15, marginLeft: 12 },
  person: { minHeight: 48, flexDirection: "row", alignItems: "center" },
  personName: { flex: 1, marginLeft: 12, fontSize: 17, color: colors.ink },
  danger: { marginTop: 32, alignSelf: "center", minHeight: 44, justifyContent: "center", paddingHorizontal: 20 },
  dangerText: { color: colors.red, fontSize: 17 },
});
