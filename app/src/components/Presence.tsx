import { useEffect, useState } from "react";
import { StyleSheet, Text, type StyleProp, type TextStyle } from "react-native";
import { useLive } from "../lib/live";
import { presenceLabel } from "../lib/message-status";
import type { Person } from "../lib/server";
import { typography, createThemedStyles } from "../lib/theme";

export function useStatusNow() {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** The people whose presence has something to say; a bar above a DM hides when nobody's does. */
export function usePresentPeers(people: readonly Person[]) {
  const { presence, connected } = useLive();
  const now = useStatusNow();
  return people.filter(person => !person.agent && presenceLabel(presence[person.id] ?? { ...person, online: false }, now, connected));
}

export function PresenceLine({ person, style }: { person: Person; style?: StyleProp<TextStyle> }) {
  const styles = useStyles();
  const { presence, connected } = useLive();
  const now = useStatusNow();
  if (person.agent) return null;
  const label = presenceLabel(presence[person.id] ?? { ...person, online: false }, now, connected) ;
  if (!label) return null;
  return <Text accessibilityLabel={`${person.name}, ${label}`} style={[styles.status, style]}>{label === "Online" ? <Text style={styles.online}>● </Text> : null}{label}</Text>;
}

const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  status: { ...typography.meta, color: colors.muted },
  online: { color: colors.green },
}));
