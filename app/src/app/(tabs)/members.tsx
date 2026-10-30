import { useCallback, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, RefreshControl, StyleSheet, Text, TextInput, View } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { Band, PageTitle } from "../../components/Band";
import { Avatar } from "../../components/Messaging";
import { api, ServerError, type Person } from "../../lib/server";
import { useSession } from "../../lib/session";
import { colors } from "../../lib/theme";

export default function Members() {
  const { account } = useSession();
  const [directory, setDirectory] = useState<{ token: string; people: Person[] } | null>(null);
  const [query, setQuery] = useState("");
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
      router.push({ pathname: "/c/[id]", params: { id: conversation.id } });
    } catch (e) {
      setError(e instanceof ServerError ? e.message : "Couldn't open the conversation. Try again");
    } finally { setOpening(null); }
  };
  return <View style={styles.root}>
    <Band right={account.user.role === "owner" ? <Pressable accessibilityRole="button" onPress={() => router.push("/invite")} hitSlop={12}><Text style={styles.bandLink}>Invite</Text></Pressable> : undefined} />
    <FlatList
      data={shown}
      keyExtractor={person => person.id}
      keyboardShouldPersistTaps="handled"
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); void load(); }} />}
      ListHeaderComponent={<>
        <PageTitle>Members</PageTitle>
        <TextInput accessibilityLabel="Search members" value={query} onChangeText={setQuery} placeholder="Search members" placeholderTextColor={colors.muted} autoCorrect={false} style={styles.search} />
        {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
      </>}
      ListEmptyComponent={people === null && !error ? <ActivityIndicator style={{ marginTop: 40 }} color={colors.blue} /> : <Text style={styles.empty}>{error ? "Pull down to try again" : query.trim() ? "No members match your search" : "No members yet"}</Text>}
      renderItem={({ item }) => {
        const self = item.id === account.user.id;
        return <Pressable accessibilityRole={self ? undefined : "button"} accessibilityLabel={`${item.name}${self ? ", you" : ""}, ${item.owner ? "owner" : "member"}`} accessibilityHint={self ? undefined : "Open direct message"} disabled={self || !!opening} onPress={() => void message(item)} style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.surface }]}>
          <Avatar name={item.name} />
          <View style={styles.copy}><Text style={styles.name}>{item.name}{self ? " (you)" : ""}</Text><Text style={styles.role}>{item.owner ? "Owner" : "Member"}</Text></View>
          {opening === item.id ? <ActivityIndicator color={colors.blue} /> : !self ? <Text accessibilityElementsHidden style={styles.action}>Message</Text> : null}
        </Pressable>;
      }}
      contentContainerStyle={{ paddingBottom: 120, flexGrow: 1 }}
    />
  </View>;
}
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.white },
  bandLink: { color: colors.white, fontSize: 16, fontWeight: "600" },
  search: { marginHorizontal: 20, marginTop: 12, marginBottom: 12, minHeight: 46, borderRadius: 12, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line, paddingHorizontal: 14, fontSize: 17, color: colors.ink },
  row: { minHeight: 76, paddingHorizontal: 20, paddingVertical: 12, flexDirection: "row", alignItems: "center" },
  copy: { flex: 1, marginLeft: 12, marginRight: 12 },
  name: { fontSize: 17, color: colors.ink },
  role: { marginTop: 4, fontSize: 14, color: colors.muted },
  action: { fontSize: 15, color: colors.blue },
  error: { marginHorizontal: 20, marginVertical: 8, fontSize: 15, color: colors.red },
  empty: { marginTop: 40, marginHorizontal: 20, textAlign: "center", fontSize: 16, color: colors.muted },
});
