import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { router } from "expo-router";
import { Button } from "../components/Button";
import { Avatar } from "../components/Messaging";
import { AppIcon } from "../components/AppIcon";
import { api, ServerError, type Person } from "../lib/server";
import { useSession } from "../lib/session";
import { radius, space, typography, useTheme, createThemedStyles } from "../lib/theme";

// Pick one person for a direct message, or a few for a group message.
export default function NewMessage() {
  const styles = useStyles();
  const { colors } = useTheme();
  const { account } = useSession();
  const [people, setPeople] = useState<Person[] | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadPeople = useCallback(() => {
    if (!account) return;
    void api.people(account).then(
      (d) => { setError(null); setPeople(d.people.filter((p) => p.id !== d.me)); },
      (e) => {
        setPeople([]);
        setError(e instanceof ServerError ? e.message : "Couldn't load people");
      },
    );
  }, [account]);
  useEffect(loadPeople, [loadPeople]);
  if (!account) return null;

  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length >= 8 ? p : [...p, id]));
  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const c = await api.openDm(account, picked);
      router.replace({ pathname: "/c/[id]", params: { id: c.id, compose: "1" } });
    } catch (e) {
      setError(e instanceof ServerError ? e.message : "Couldn't start the conversation");
      setBusy(false);
    }
  };
  const shown = (people ?? []).filter((p) => p.name.toLowerCase().includes(query.trim().toLowerCase()));

  return (
    <View style={styles.root}>
      <View style={styles.recipientRow}>
        <Text style={styles.to}>To:</Text>
        <TextInput accessibilityLabel="Search people" value={query} onChangeText={setQuery} placeholder="Name or teammate" placeholderTextColor={colors.muted} style={styles.search} autoCorrect={false} autoCapitalize="none" />
      </View>
      <Text style={styles.intro}>Choose up to eight people.</Text>
      {picked.length ? <View style={styles.selection}>
        <Text accessibilityLiveRegion="polite" style={styles.selectionCount}>{picked.length} of 8 selected</Text>
        <ScrollView horizontal contentContainerStyle={styles.chips} keyboardShouldPersistTaps="handled">{picked.map(id => <Pressable key={id} disabled={busy} accessibilityState={{ disabled: busy }} accessibilityRole="button" accessibilityLabel={`Remove ${people?.find(p => p.id === id)?.name ?? "person"}`} onPress={() => toggle(id)} style={styles.chip}>
          <Text style={styles.chipText}>{people?.find(p => p.id === id)?.name ?? "Person"}</Text><AppIcon name="close" size={14} color={colors.blueDark} />
        </Pressable>)}</ScrollView>
      </View> : null}
      <FlatList
        data={shown}
        keyExtractor={(p) => p.id}
        keyboardShouldPersistTaps="handled"
        ListEmptyComponent={
          people === null ? (
            <ActivityIndicator style={{ marginTop: 40 }} color={colors.blue} />
          ) : (
            <View style={styles.empty}>
              <Text accessibilityRole={error ? "alert" : undefined} style={styles.emptyText}>{error ?? (people.length ? "No people match your search." : account.user.role === "owner" ? "Invite a teammate to start a conversation." : "Your teammates will appear here when they join.")}</Text>
              {error ? <Button label="Try again" kind="secondary" onPress={() => { setError(null); setPeople(null); loadPeople(); }} style={{ marginTop: space.md }} /> : !people.length && account.user.role === "owner" ? <Button label="Invite a teammate" kind="secondary" onPress={() => router.push("/invite")} style={{ marginTop: space.md }} /> : null}
            </View>
          )
        }
        renderItem={({ item }) => {
          const on = picked.includes(item.id);
          const disabled = busy || (!on && picked.length >= 8);
          return (
            <Pressable
              accessibilityRole="checkbox"
              accessibilityLabel={item.name}
              accessibilityState={{ checked: on, disabled }}
              disabled={disabled}
              onPress={() => toggle(item.id)}
              style={({ pressed }) => [styles.row, on && styles.rowSelected, disabled && !on && styles.rowDisabled, pressed && { backgroundColor: colors.surface }]}
            >
              <Avatar name={item.name} userId={item.id} size={36} />
              <Text style={styles.name}>{item.name}</Text>
              <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={[styles.check, on && styles.checkOn]}>{on ? <AppIcon name="check" size={16} color={colors.onPrimary} /> : null}</View>
            </Pressable>
          );
        }}
        contentContainerStyle={{ paddingBottom: space.lg }}
      />
      <View style={styles.footer}>
        {error && people?.length ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
        <Button label={picked.length > 1 ? "Start group message" : "Message"} onPress={start} busy={busy} disabled={!picked.length} />
      </View>
    </View>
  );
}

const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  recipientRow: { flexDirection: "row", alignItems: "center", paddingHorizontal: space.side, gap: space.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  to: { ...typography.bodyStrong, color: colors.muted },
  intro: { ...typography.caption, marginVertical: space.sm, marginHorizontal: space.side, color: colors.muted },
  search: { ...typography.body, flex: 1, minWidth: 0, minHeight: 48, paddingVertical: space.sm, color: colors.ink },
  selection: { paddingHorizontal: space.side, paddingBottom: space.sm },
  selectionCount: { ...typography.caption, color: colors.muted, marginBottom: space.xs },
  chips: { flexDirection: "row", gap: space.xs },
  chip: { minHeight: 44, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: space.xs, paddingHorizontal: space.sm, backgroundColor: colors.blueSoft, borderRadius: radius.sm },
  chipText: { ...typography.captionStrong, color: colors.blueDark },
  row: { minHeight: 60, paddingHorizontal: space.side, paddingVertical: space.sm, flexDirection: "row", alignItems: "center" },
  rowSelected: { backgroundColor: colors.blueSoft },
  rowDisabled: { opacity: 0.5 },
  name: { ...typography.body, flex: 1, marginLeft: space.sm, marginRight: space.sm, color: colors.ink },
  check: { width: 22, height: 22, borderRadius: 4, borderWidth: 1.5, borderColor: colors.borderStrong, alignItems: "center", justifyContent: "center" },
  checkOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  empty: { marginTop: space.xl, marginHorizontal: space.side, alignItems: "center" },
  emptyText: { ...typography.body, textAlign: "center", color: colors.muted },
  footer: { padding: space.side, paddingBottom: space.xl, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  error: { ...typography.caption, color: colors.red, marginBottom: space.sm },
}));
