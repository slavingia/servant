import { useCallback, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, RefreshControl, StyleSheet, Text, TextInput, View } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { PageTitle } from "../../components/Band";
import { Avatar } from "../../components/Messaging";
import { Button } from "../../components/Button";
import { AppIcon } from "../../components/AppIcon";
import { useStatusNow } from "../../components/Presence";
import { api, ServerError, type Person } from "../../lib/server";
import { useLive } from "../../lib/live";
import { presenceLabel } from "../../lib/message-status";
import { useSession } from "../../lib/session";
import { space, typography, useTheme, createThemedStyles } from "../../lib/theme";

export default function Members() {
  const styles = useStyles();
  const { colors, controls } = useTheme();
  const { account } = useSession();
  const { presence, connected } = useLive();
  const now = useStatusNow();
  const [directory, setDirectory] = useState<{ token: string; people: Person[] } | null>(null);
  const [query, setQuery] = useState("");
  const [searchFocused, setSearchFocused] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [opening, setOpening] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    if (!account) return;
    try {
      const result = await api.people(account);
      setDirectory({ token: account.token, people: result.people });
      setError(null);
    } catch (e) {
      setError(e instanceof ServerError ? e.message : "Couldn't load members. Pull down to try again");
    } finally { setRefreshing(false); }
  }, [account]);
  useFocusEffect(useCallback(() => { void load(); }, [load]));
  if (!account) return null;
  const people = directory?.token === account.token ? directory.people : null;
  const shown = (people ?? []).filter(person => person.name.toLowerCase().includes(query.trim().toLowerCase()));
  const message = async (person: Person) => {
    if (opening) return;
    setOpening(person.id); setError(null);
    try {
      const conversation = await api.openDm(account, [person.id]);
      router.push({ pathname: "/c/[id]", params: { id: conversation.id, compose: "1" } });
    } catch (e) {
      setError(e instanceof ServerError ? e.message : "Couldn't open the conversation. Try again");
    } finally { setOpening(null); }
  };
  return <View style={styles.root}>
    <FlatList
      data={shown}
      keyExtractor={person => person.id}
      keyboardShouldPersistTaps="handled"
      refreshControl={<RefreshControl tintColor={colors.blue} colors={[colors.blue]} progressBackgroundColor={colors.surface} refreshing={refreshing} onRefresh={() => { setRefreshing(true); void load(); }} />}
      ListHeaderComponent={<>
        <PageTitle action={account.user.role === "owner" ? <Button label="Invite people" kind="link" compact onPress={() => router.push("/invite")} /> : undefined}>People</PageTitle>
        <View style={[styles.searchBox, searchFocused && controls.inputFocused]}>
          <AppIcon name="search" size={18} color={colors.muted} />
          <TextInput accessibilityLabel="Search people" value={query} onChangeText={setQuery} placeholder="Find a teammate" placeholderTextColor={colors.muted} autoCapitalize="none" autoCorrect={false} returnKeyType="search" onFocus={() => setSearchFocused(true)} onBlur={() => setSearchFocused(false)} style={styles.search} />
        </View>
        {people && shown.length ? <Text style={styles.resultCount}>{query.trim() ? `${shown.length} ${shown.length === 1 ? "result" : "results"}` : `${people.length} ${people.length === 1 ? "member" : "members"}`}</Text> : null}
        {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
      </>}
      ListEmptyComponent={people === null && !error ? <ActivityIndicator accessibilityLabel="Loading members" style={styles.loading} color={colors.blue} /> : <View style={styles.empty}>
        <Text style={styles.emptyTitle}>{error ? "Couldn't load members" : query.trim() ? "No matching members" : "No members yet"}</Text>
        <Text style={styles.emptyBody}>{error ? "Try again to see who's here." : query.trim() ? "Try a different name or clear your search." : "People will appear here when they join your server."}</Text>
        {error ? <Button label="Try again" kind="secondary" busy={refreshing} onPress={() => { setRefreshing(true); void load(); }} style={styles.emptyAction} /> : query.trim() ? <Button label="Clear search" kind="secondary" onPress={() => setQuery("")} style={styles.emptyAction} /> : null}
      </View>}
      renderItem={({ item }) => {
        const self = item.id === account.user.id;
        const status = self ? "" : presenceLabel(presence[item.id] ?? { ...item, online: false }, now, connected);
        return <Pressable accessibilityRole={self ? undefined : "button"} accessibilityLabel={`${item.name}${self ? ", you" : ""}, ${item.owner ? "owner" : "member"}${status ? `, ${status}` : ""}`} accessibilityHint={self ? undefined : "Open direct message"} disabled={self || !!opening} onPress={() => void message(item)} style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.surface }]}>
          <Avatar name={item.name} size={36} />
          <View style={styles.copy}><Text style={styles.name}>{item.name}{self ? <Text style={styles.you}> · You</Text> : null}</Text><Text style={[styles.role, status === "Online" && styles.online]}>{item.owner ? "Workspace owner" : "Member"}{status ? ` · ${status}` : ""}</Text></View>
          {opening === item.id ? <ActivityIndicator color={colors.blue} /> : !self ? <AppIcon name="chat" size={18} color={colors.muted} /> : null}
        </Pressable>;
      }}
      contentContainerStyle={styles.content}
    />
  </View>;
}
const useStyles = createThemedStyles(({ colors, controls }) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  content: { paddingBottom: space.xl, flexGrow: 1 },
  searchBox: { ...controls.input, flexDirection: "row", alignItems: "center", gap: space.xs, marginHorizontal: space.side, marginBottom: space.md, paddingVertical: 0, backgroundColor: colors.surface },
  search: { ...typography.body, flex: 1, minWidth: 0, minHeight: 44, paddingVertical: space.sm, color: colors.ink },
  resultCount: { ...typography.caption, marginHorizontal: space.side, marginBottom: space.xs, color: colors.muted },
  row: { minHeight: 64, paddingHorizontal: space.side, paddingVertical: space.sm, flexDirection: "row", alignItems: "center" },
  copy: { flex: 1, minWidth: 0, marginHorizontal: space.sm },
  name: { ...typography.bodyStrong, color: colors.ink },
  you: { ...typography.body, color: colors.muted },
  role: { ...typography.caption, marginTop: 2, color: colors.muted },
  online: { color: colors.blueDark },
  error: { ...typography.caption, marginHorizontal: space.side, marginVertical: space.xs, color: colors.red },
  loading: { marginTop: space.xxl },
  empty: { marginTop: space.xxl, paddingHorizontal: space.lg, alignItems: "center" },
  emptyTitle: { ...typography.heading, color: colors.ink, textAlign: "center" },
  emptyBody: { ...typography.body, marginTop: space.xs, maxWidth: 320, color: colors.muted, textAlign: "center" },
  emptyAction: { marginTop: space.lg },
}));
