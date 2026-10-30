import { useEffect, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { router } from "expo-router";
import { Button } from "../components/Button";
import { Avatar } from "../components/Messaging";
import { api, HubError, type Person } from "../lib/hub";
import { useSession } from "../lib/session";
import { colors } from "../lib/theme";

// Pick one person for a direct message, or a few for a group message.
export default function NewMessage() {
  const { account } = useSession();
  const [people, setPeople] = useState<Person[] | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!account) return;
    api.people(account).then(
      (d) => setPeople(d.people.filter((p) => p.id !== d.me)),
      (e) => {
        setPeople([]);
        setError(e instanceof HubError ? e.message : "Couldn't load people");
      },
    );
  }, [account]);
  if (!account) return null;

  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length >= 8 ? p : [...p, id]));
  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const c = await api.openDm(account, picked);
      router.replace({ pathname: "/c/[id]", params: { id: c.id } });
    } catch (e) {
      setError(e instanceof HubError ? e.message : "Couldn't start the conversation");
      setBusy(false);
    }
  };
  const shown = (people ?? []).filter((p) => p.name.toLowerCase().includes(query.trim().toLowerCase()));

  return (
    <View style={styles.root}>
      <TextInput accessibilityLabel="Search people" value={query} onChangeText={setQuery} placeholder="Search people" placeholderTextColor="#8A8F96" style={styles.search} autoCorrect={false} />
      <FlatList
        data={shown}
        keyExtractor={(p) => p.id}
        keyboardShouldPersistTaps="handled"
        ListEmptyComponent={
          people === null ? (
            <ActivityIndicator style={{ marginTop: 40 }} color={colors.blue} />
          ) : (
            <Text style={styles.empty}>{error ?? (people.length ? "No one matches" : "No one else is on this server yet. Invite someone from the You tab")}</Text>
          )
        }
        renderItem={({ item }) => {
          const on = picked.includes(item.id);
          return (
            <Pressable
              accessibilityRole="checkbox"
              accessibilityState={{ checked: on }}
              onPress={() => toggle(item.id)}
              style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.surface }]}
            >
              <Avatar name={item.name} />
              <Text style={styles.name}>{item.name}</Text>
              <View style={[styles.check, on && styles.checkOn]}>{on ? <Text style={styles.tick}>✓</Text> : null}</View>
            </Pressable>
          );
        }}
        contentContainerStyle={{ paddingBottom: 120 }}
      />
      <View style={styles.footer}>
        {error && people?.length ? <Text style={styles.error}>{error}</Text> : null}
        <Button label={picked.length > 1 ? "Start group message" : "Start conversation"} onPress={start} busy={busy} disabled={!picked.length} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.white },
  search: { margin: 20, marginBottom: 8, minHeight: 46, borderRadius: 12, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line, paddingHorizontal: 14, fontSize: 17, color: colors.ink },
  row: { minHeight: 60, paddingHorizontal: 20, flexDirection: "row", alignItems: "center" },
  name: { flex: 1, marginLeft: 12, fontSize: 17, color: colors.ink },
  check: { width: 26, height: 26, borderRadius: 13, borderWidth: 2, borderColor: colors.line, alignItems: "center", justifyContent: "center" },
  checkOn: { backgroundColor: colors.blue, borderColor: colors.blue },
  tick: { color: colors.white, fontWeight: "700" },
  empty: { marginTop: 40, marginHorizontal: 20, textAlign: "center", color: colors.muted, fontSize: 16 },
  footer: { padding: 20, paddingBottom: 36, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  error: { color: colors.red, fontSize: 15, marginBottom: 12 },
});
