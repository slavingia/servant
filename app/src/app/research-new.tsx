import { useEffect, useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { AppIcon } from "../components/AppIcon";
import { PageTitle } from "../components/Band";
import { Button } from "../components/Button";
import {
  buildResearchPrompt,
  isResearchTaskKind,
  missingResearchFields,
  researchChatTitle,
  researchTask,
  type ResearchBrief,
  type ResearchFieldId,
} from "../lib/research-studio";
import { api, ServerError } from "../lib/server";
import { setDraft } from "../lib/drafts";
import { useSession } from "../lib/session";
import { createThemedStyles, radius, space, typography, useTheme } from "../lib/theme";

export default function NewResearchWork() {
  const styles = useStyles();
  const { colors } = useTheme();
  const { kind: rawKind } = useLocalSearchParams<{ kind?: string | string[] }>();
  const requestedKind = Array.isArray(rawKind) ? rawKind[0] : rawKind;
  const kind = isResearchTaskKind(requestedKind) ? requestedKind : "study";
  const task = researchTask(kind);
  const { account } = useSession();
  const [title, setTitle] = useState("");
  const [answers, setAnswers] = useState<Partial<Record<ResearchFieldId, string>>>({});
  const [agentTier, setAgentTier] = useState<number | null | undefined>(undefined);
  const [accessError, setAccessError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!account) return;
    let active = true;
    setAgentTier(undefined);
    setAccessError(null);
    api.projects(account).then(result => {
      if (!active) return;
      const tier = result.agentTier;
      if (typeof tier === "number" && Number.isInteger(tier)) setAgentTier(tier);
      else {
        setAgentTier(null);
        setAccessError("This workspace did not report Researcher access.");
      }
    }).catch(() => {
      if (!active) return;
      setAgentTier(null);
      setAccessError("Researcher access could not be verified. Return to Research Studio and try again.");
    });
    return () => { active = false; };
  }, [account?.serverUrl, account?.serverKey, account?.user.id]);

  if (!account) return null;
  const update = (field: ResearchFieldId, value: string) => setAnswers(current => ({ ...current, [field]: value }));
  const brief = (): ResearchBrief => ({ kind, title, answers });

  const create = async () => {
    if (busy || agentTier !== 4) return;
    const current = brief();
    const missing = missingResearchFields(current);
    if (missing.length) {
      setError(`Complete ${missing.length === 1 ? missing[0] : `${missing.slice(0, -1).join(", ")} and ${missing.at(-1)}`}.`);
      return;
    }
    setBusy(true);
    setError(null);
    const expectedTitle = researchChatTitle(kind, title);
    try {
      const chat = await api.newChat(account, { title: expectedTitle, requiredAgentRole: "researcher" });
      // The server checks the role atomically. The response marker also keeps a
      // server that predates that check from silently accepting the wrong lane.
      if (chat.agentRole !== "researcher") {
        await api.deleteChat(account, chat.id).catch(() => {});
        setError(chat.mode === "vibe"
          ? "This workspace created a design workspace instead of a researcher chat. Ask a workspace owner to confirm your Researcher access."
          : "This workspace couldn't verify a researcher chat. Ask a workspace owner to update or confirm Researcher access.");
        return;
      }
      setDraft(`chat:${chat.id}`, buildResearchPrompt(current));
      router.replace({ pathname: "/chat/[id]", params: { id: chat.id, title: expectedTitle, compose: "1", research: "1" } });
    } catch (e) {
      setError(e instanceof ServerError ? e.message : "Couldn't start this research chat. Try again.");
    } finally {
      setBusy(false);
    }
  };

  if (agentTier === undefined) return <View style={styles.loading}>
    <Stack.Screen options={{ title: task.actionLabel }} />
    <ActivityIndicator accessibilityLabel="Checking Researcher access" accessibilityRole="progressbar" color={colors.blue} />
    <Text style={styles.loadingText}>Checking Researcher access…</Text>
  </View>;

  if (agentTier !== 4) return <View style={styles.root}>
    <Stack.Screen options={{ title: task.actionLabel }} />
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>
      <PageTitle description={task.description}>{task.actionLabel}</PageTitle>
      <View style={styles.locked}>
        <View style={styles.lockedIcon}><AppIcon name="lock" size={22} color={colors.muted} /></View>
        <Text accessibilityRole="header" style={styles.lockedTitle}>Researcher access is required</Text>
        <Text style={styles.lockedBody}>{accessError ?? "Ask a workspace owner to grant the Researcher agent tier. Choosing a research goal during onboarding does not change workspace permissions."}</Text>
        <Button label="Back to Research Studio" kind="secondary" onPress={() => router.replace("/research")} style={styles.lockedAction} />
      </View>
    </ScrollView>
  </View>;

  return <View style={styles.root}>
    <Stack.Screen options={{ title: task.actionLabel }} />
    <ScrollView contentInsetAdjustmentBehavior="automatic" keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
      <PageTitle description={task.description}>{task.actionLabel}</PageTitle>
      <View style={styles.note}>
        <AppIcon name="sparkles" size={17} color={colors.blueDark} />
        <Text style={styles.noteText}>Your answers become an unsent draft in a private researcher chat. Review or edit the prompt before you send it.</Text>
      </View>

      <Text accessibilityRole="header" style={styles.sectionTitle}>Name the work</Text>
      <View style={styles.field}>
        <Text style={styles.label}>Working title</Text>
        <TextInput value={title} onChangeText={setTitle} accessibilityLabel="Working title" placeholder="A short, recognizable name" placeholderTextColor={colors.muted}
          maxLength={Math.max(20, 80 - task.titlePrefix.length)} autoCapitalize="sentences" autoCorrect style={styles.input} />
      </View>

      <Text accessibilityRole="header" style={styles.sectionTitle}>Build the brief</Text>
      <Text style={styles.sectionDescription}>Required fields are marked. Add only what is safe to share with your workspace's researcher agent.</Text>
      {task.fields.map(field => <View key={field.id} style={styles.field}>
        <Text style={styles.label}>{field.label}{field.required ? " *" : ""}</Text>
        <TextInput value={answers[field.id] ?? ""} onChangeText={value => update(field.id, value)} accessibilityLabel={`${field.label}${field.required ? ", required" : ", optional"}`}
          placeholder={field.placeholder} placeholderTextColor={colors.muted} multiline={field.multiline} textAlignVertical={field.multiline ? "top" : "center"}
          autoCapitalize="sentences" autoCorrect style={[styles.input, field.multiline && styles.multiline]} />
      </View>)}

      <View style={styles.boundary}>
        <Text style={styles.boundaryTitle}>What happens next</Text>
        <Text style={styles.boundaryBody}>Servant creates an ordinary titled chat and places a structured prompt in its composer. Nothing is sent, shared, published, or used to contact participants until you choose what to do next.</Text>
      </View>
      {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
      <Button label="Review in researcher chat" busy={busy} onPress={() => { void create(); }} style={styles.primary} />
      <Button label="Cancel" kind="link" disabled={busy} onPress={() => router.replace("/research")} />
    </ScrollView>
  </View>;
}

const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  loading: { flex: 1, alignItems: "center", justifyContent: "center", gap: space.sm, backgroundColor: colors.background },
  loadingText: { ...typography.caption, color: colors.muted },
  content: { width: "100%", maxWidth: 680, alignSelf: "center", paddingBottom: space.xxl },
  note: { flexDirection: "row", alignItems: "flex-start", gap: space.sm, marginHorizontal: space.side, padding: space.md, borderRadius: radius.md, backgroundColor: colors.blueSoft },
  noteText: { ...typography.caption, color: colors.ink, flex: 1 },
  sectionTitle: { ...typography.heading, color: colors.ink, marginTop: space.lg, marginHorizontal: space.side },
  sectionDescription: { ...typography.caption, color: colors.muted, marginTop: space.xxs, marginHorizontal: space.side, marginBottom: space.sm },
  field: { gap: space.xs, marginTop: space.md, marginHorizontal: space.side },
  label: { ...typography.bodyStrong, color: colors.ink },
  input: { ...typography.body, minHeight: 48, paddingHorizontal: space.md, paddingVertical: space.sm, borderRadius: radius.md, borderWidth: 1, borderColor: colors.borderStrong, color: colors.ink, backgroundColor: colors.background },
  multiline: { minHeight: 104 },
  boundary: { marginHorizontal: space.side, marginTop: space.lg, padding: space.md, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, backgroundColor: colors.surface },
  boundaryTitle: { ...typography.bodyStrong, color: colors.ink },
  boundaryBody: { ...typography.caption, color: colors.muted, marginTop: space.xxs },
  error: { ...typography.caption, color: colors.red, marginHorizontal: space.side, marginTop: space.md },
  primary: { marginHorizontal: space.side, marginTop: space.lg },
  locked: { alignItems: "center", marginHorizontal: space.side, marginTop: space.lg, padding: space.lg, borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, backgroundColor: colors.surface },
  lockedIcon: { width: 50, height: 50, alignItems: "center", justifyContent: "center", borderRadius: radius.lg, backgroundColor: colors.background },
  lockedTitle: { ...typography.heading, color: colors.ink, textAlign: "center", marginTop: space.md },
  lockedBody: { ...typography.body, color: colors.muted, textAlign: "center", maxWidth: 420, marginTop: space.xs },
  lockedAction: { minWidth: 220, marginTop: space.lg },
}));
