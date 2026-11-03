import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { router } from "expo-router";
import { useSession } from "../lib/session";
import { api, type Post } from "../lib/server";
import { callsSupported } from "../lib/meeting-call";
import { radius, space, typography, createThemedStyles } from "../lib/theme";
import { Button } from "./Button";

type MeetingInfo = NonNullable<Post["meeting"]>;

/** Under an agent post that belongs to a meeting: Join while it's live, and one tap per next step after. */
export function MeetingCard({ meeting }: { meeting: MeetingInfo }) {
  const styles = useStyles();
  const { account } = useSession();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [steps, setSteps] = useState(meeting.steps);
  // Live updates refresh meeting.steps; a tap here shows at once without waiting for them.
  const shown = meeting.steps.map(s => { const mine = steps.find(x => x.n === s.n); return s.status === "open" && mine && mine.status !== "open" ? mine : s; });

  if (meeting.kind === "call") {
    if (meeting.status !== "live") return <Text style={styles.note}>{meeting.status === "done" ? "Meeting ended · Notes posted" : meeting.status === "failed" ? "Meeting ended" : "Meeting ended · Writing notes…"}</Text>;
    if (!callsSupported()) return <Text style={styles.note}>Meeting in progress</Text>;
    return <View style={styles.actions}>
      <Button label="Join" onPress={() => router.push({ pathname: "/meeting/[id]", params: { id: meeting.id } })} style={styles.button} />
    </View>;
  }

  if (!shown.length) return null;
  const act = async (n: number, action: "accept" | "skip") => {
    if (!account || busy) return;
    setBusy(`${n}:${action}`); setError(null);
    try { setSteps((await api.meetingStep(account, meeting.id, n, action)).steps); }
    catch (e) { setError(e instanceof Error ? e.message : "Couldn't update that step"); }
    finally { setBusy(null); }
  };
  return <View style={styles.card}>
    <Text accessibilityRole="header" style={styles.title}>Next steps</Text>
    {shown.map(step => <View key={step.n} style={styles.step}>
      <Text style={[styles.stepText, step.status === "skipped" && styles.skipped]}>{step.text}{step.owner ? ` · ${step.owner}` : ""}</Text>
      {step.status === "open" ? <View style={styles.actions}>
        <Button label="Skip" kind="secondary" disabled={!!busy} onPress={() => act(step.n, "skip")} />
        <Button label="Do it" busy={busy === `${step.n}:accept`} disabled={!!busy} onPress={() => act(step.n, "accept")} />
      </View> : <Text style={styles.done}>{step.status === "accepted" ? `Started${step.actedBy ? ` by ${step.actedBy.name}` : ""}` : "Skipped"}</Text>}
    </View>)}
    {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
  </View>;
}

const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  card: { marginTop: space.xs, padding: space.sm, gap: space.sm, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line, borderRadius: radius.lg },
  title: { ...typography.label, color: colors.muted },
  step: { gap: space.xs },
  stepText: { ...typography.body, color: colors.ink },
  skipped: { color: colors.muted, textDecorationLine: "line-through" },
  done: { ...typography.caption, color: colors.muted },
  note: { ...typography.caption, color: colors.muted, marginTop: space.xxs },
  actions: { flexDirection: "row", gap: space.xs, marginTop: space.xxs },
  button: { alignSelf: "flex-start", minWidth: 120 },
  error: { ...typography.caption, color: colors.red },
}));
