import { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { router, type Href } from "expo-router";
import { AppIcon } from "../components/AppIcon";
import { Button } from "../components/Button";
import { api, saveAccount } from "../lib/server";
import { useSession } from "../lib/session";
import { completeRoleIntro, goalLabels, normalizeOnboarding, roleLabel } from "../lib/onboarding";
import { roleStartTasks } from "../lib/role-start";
import { canCreateDesign as mayCreateDesign } from "../lib/designs";
import { createThemedStyles, radius, space, typography } from "../lib/theme";

// "Product designer" mid-sentence is "product designer"; "UX researcher" keeps its capitals.
const roleInSentence = (label: string) => /^[A-Z][a-z]/.test(label) ? label.charAt(0).toLowerCase() + label.slice(1) : label;

// Each kind of starting point gets its own icon, so the list scans at a glance.
const TASK_ICONS: Record<string, Parameters<typeof AppIcon>[0]["name"]> = {
  "research-study": "compose",
  "research-synthesis": "sparkles",
  "research-prototype": "code",
  "research-design-review": "eye",
  "product-prototype": "code",
  "product-accessibility": "eye",
  "product-review": "search",
  "product-share": "people",
  "content-draft": "compose",
  "content-review": "eye",
  "content-share": "people",
  "engineer-prototype": "code",
  "engineer-accessibility": "eye",
  "engineer-review": "search",
  "engineer-project": "folder",
};

export default function RoleStart() {
  const styles = useStyles();
  const { account, setAccount } = useSession();
  const [agentTier, setAgentTier] = useState<number | null | undefined>(undefined);
  // undefined is still checking; null means the access check failed.
  const [designAvailable, setDesignAvailable] = useState<boolean | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!account) return;
    let active = true;
    api.projects(account).then(result => {
      if (!active) return;
      const tier = result.agentTier === undefined
        ? (result.vibeCoder ? 2 : undefined)
        : Number.isInteger(result.agentTier) ? result.agentTier : null;
      setAgentTier(tier);
      setDesignAvailable(result.vibe === true);
    }).catch(() => { if (active) { setAgentTier(null); setDesignAvailable(null); } });
    return () => { active = false; };
  }, [account?.serverUrl, account?.serverKey, account?.user.id]);

  if (!account) return null;
  const onboarding = normalizeOnboarding(account.uxOnboarding);
  const accessChecked = designAvailable !== undefined;
  const canCreateDesign = designAvailable === null
    ? null
    : designAvailable === undefined
      ? undefined
      : mayCreateDesign(agentTier, designAvailable);
  // Older servers do not report named tiers. They can still verify legacy
  // design access, but they cannot prove the restricted Researcher lane.
  const taskAgentTier = accessChecked && onboarding.role === "ux-researcher" && agentTier === undefined ? null : agentTier;
  const tasks = roleStartTasks(onboarding, { agentTier: taskAgentTier, canCreateDesign });

  const finish = async (href: Href) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const next = completeRoleIntro(onboarding);
    const updated = { ...account, uxOnboarding: next };
    try {
      await saveAccount(updated);
      setAccount(updated);
      router.replace(href);
    } catch {
      setError("Couldn't save your starting point. Try again.");
    } finally {
      setBusy(false);
    }
  };

  // The app's navigation is already around this page, so it has no brand band of its own.
  return <View style={styles.root}>
    <ScrollView contentContainerStyle={styles.body}>
      <Text style={styles.eyebrow}>START HERE</Text>
      <Text accessibilityRole="header" style={styles.title}>Your {roleInSentence(roleLabel(onboarding.role))} workspace</Text>
      <Text style={styles.lead}>We used your goals to put the most useful work first. You can reach every team feature from the main navigation too.</Text>
      <View style={styles.summary}>
        <Text style={styles.summaryLabel}>Your goals</Text>
        {goalLabels(onboarding.goals).map(goal => <Text key={goal} style={styles.goal}>• {goal}</Text>)}
      </View>
      <Text style={styles.sectionTitle}>Starting points</Text>
      {!accessChecked ? <View style={styles.accessCheck}>
        <Text style={styles.accessCheckText}>Checking workspace access…</Text>
      </View> : <View style={styles.tasks}>
        {tasks.map(task => <Pressable key={task.id} accessibilityRole="button"
          accessibilityLabel={`${task.title}${task.locked ? ", locked" : ""}`}
          accessibilityHint={task.locked ? task.reason : task.description}
          accessibilityState={{ disabled: task.locked || busy }} disabled={task.locked || busy}
          onPress={() => void finish(task.href as Href)}
          style={({ pressed }) => [styles.task, task.recommended && styles.taskRecommended, task.locked && styles.taskLocked, pressed && styles.taskPressed]}>
          <View style={styles.taskIcon}><AppIcon name={task.locked ? "lock" : TASK_ICONS[task.id] ?? "chevronRight"} size={18} /></View>
          <View style={styles.taskCopy}>
            {task.recommended ? <Text style={styles.recommended}>RECOMMENDED</Text> : null}
            <Text style={styles.taskTitle}>{task.title}</Text>
            <Text style={styles.taskBody}>{task.locked ? task.reason : task.description}</Text>
          </View>
          {!task.locked ? <AppIcon name="chevronRight" size={18} /> : null}
        </Pressable>)}
      </View>}
      {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
      {accessChecked && onboarding.role === "ux-researcher" && tasks.every(task => task.locked)
        ? <Button label="Explore Research Studio" kind="secondary" disabled={busy} onPress={() => void finish("/research")} style={styles.home} />
        : null}
      <Button label="Go to home" kind="secondary" disabled={busy} onPress={() => void finish("/channels")} style={styles.home} />
    </ScrollView>
  </View>;
}

const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  body: { width: "100%", maxWidth: 640, alignSelf: "center", paddingHorizontal: space.side, paddingTop: space.xl, paddingBottom: space.xxl },
  eyebrow: { ...typography.label, color: colors.blue },
  title: { ...typography.display, color: colors.ink, marginTop: space.xs },
  lead: { ...typography.body, color: colors.muted, marginTop: space.sm },
  summary: { marginTop: space.lg, borderRadius: radius.lg, backgroundColor: colors.subtle, padding: space.md },
  summaryLabel: { ...typography.label, color: colors.muted, marginBottom: space.xs },
  goal: { ...typography.body, color: colors.ink, marginTop: space.xxs },
  sectionTitle: { ...typography.label, color: colors.muted, marginTop: space.xl, marginBottom: space.xs },
  tasks: { gap: space.sm },
  accessCheck: { minHeight: 92, alignItems: "center", justifyContent: "center", borderRadius: radius.lg, backgroundColor: colors.subtle, padding: space.md },
  accessCheckText: { ...typography.caption, color: colors.muted },
  task: { minHeight: 92, flexDirection: "row", alignItems: "center", gap: space.sm, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, borderRadius: radius.lg, padding: space.md, backgroundColor: colors.background },
  taskRecommended: { borderColor: colors.blue, backgroundColor: colors.blueSoft },
  taskLocked: { backgroundColor: colors.subtle },
  taskPressed: { opacity: 0.72 },
  taskIcon: { width: 36, height: 36, borderRadius: radius.md, alignItems: "center", justifyContent: "center", backgroundColor: colors.background },
  taskCopy: { flex: 1, minWidth: 0 },
  recommended: { ...typography.meta, color: colors.blue, fontWeight: "700", marginBottom: 2 },
  taskTitle: { ...typography.bodyStrong, color: colors.ink },
  taskBody: { ...typography.caption, color: colors.muted, marginTop: space.xxs },
  home: { marginTop: space.sm },
  error: { ...typography.caption, color: colors.red, marginTop: space.md },
}));
