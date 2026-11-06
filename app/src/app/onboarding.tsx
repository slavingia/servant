import { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { router } from "expo-router";
import { Band } from "../components/Band";
import { Button } from "../components/Button";
import { api, saveAccount } from "../lib/server";
import { useSession } from "../lib/session";
import {
  UX_GOALS,
  UX_ROLES,
  agentAccessLabel,
  chooseRole,
  completeOnboarding,
  firstActionForRole,
  goalLabels,
  moveOnboarding,
  normalizeOnboarding,
  roleLabel,
  toggleGoal,
  type UXGoal,
  type UXOnboardingState,
  type UXRole,
} from "../lib/onboarding";
import { createThemedStyles, radius, space, typography } from "../lib/theme";

export default function Onboarding() {
  const { account, setAccount } = useSession();
  const styles = useStyles();
  const [state, setState] = useState<UXOnboardingState>(() => normalizeOnboarding(account?.uxOnboarding));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [agentTier, setAgentTier] = useState<number | null | undefined>(undefined);
  const [designAvailable, setDesignAvailable] = useState<boolean | null>(null);

  useEffect(() => {
    if (!account) return;
    let active = true;
    api.projects(account).then(result => {
      if (active) {
        const tier = result.agentTier === undefined
          ? (result.vibeCoder ? 2 : undefined)
          : Number.isInteger(result.agentTier) ? result.agentTier : null;
        setAgentTier(tier);
        setDesignAvailable(result.vibe === true);
      }
    }).catch(() => { if (active) { setAgentTier(null); setDesignAvailable(null); } });
    return () => { active = false; };
  }, [account?.serverUrl, account?.serverKey, account?.user.id]);

  if (!account) return null;

  const persist = async (next: UXOnboardingState) => {
    setBusy(true);
    setError(null);
    setState(next);
    const updated = { ...account, uxOnboarding: next };
    try {
      await saveAccount(updated);
      setAccount(updated);
      return true;
    } catch {
      setError("Couldn't save your choices. Try again.");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const selectRole = (role: UXRole) => void persist(chooseRole(state, role));
  const selectGoal = (goal: UXGoal) => void persist(toggleGoal(state, goal));
  const goTo = (step: UXOnboardingState["step"]) => void persist(moveOnboarding(state, step));
  const finish = async (href: "/agent" | "/channels" | "/designs") => {
    const completed = completeOnboarding(state);
    if (!completed.completedAt || !await persist(completed)) return;
    router.replace(href);
  };

  return (
    <View style={styles.root}>
      <Band />
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        <Progress step={state.step} />
        {state.step === "role" ? <>
          <Text accessibilityRole="header" style={styles.title}>How do you work?</Text>
          <Text style={styles.lead}>Choose the closest fit. Servant uses this to tailor your starting points.</Text>
          <AccessNote agentTier={agentTier} />
          <View accessibilityRole="radiogroup" style={styles.options}>
            {UX_ROLES.map(role => {
              const selected = state.role === role.id;
              return <Pressable key={role.id} accessibilityRole="radio" accessibilityState={{ selected, checked: selected, disabled: busy }} disabled={busy}
                onPress={() => selectRole(role.id)} style={({ pressed }) => [styles.option, selected && styles.optionSelected, pressed && styles.pressed]}>
                <View style={[styles.radio, selected && styles.radioSelected]}>{selected ? <View style={styles.radioDot} /> : null}</View>
                <View style={styles.optionCopy}>
                  <Text style={styles.optionTitle}>{role.label}</Text>
                  <Text style={styles.optionDescription}>{role.description}</Text>
                </View>
              </Pressable>;
            })}
          </View>
          {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
          <Button label="Continue" disabled={!state.role} busy={busy} onPress={() => goTo("goals")} style={styles.action} />
        </> : state.step === "goals" ? <>
          <Text accessibilityRole="header" style={styles.title}>What do you want to do first?</Text>
          <Text style={styles.lead}>Choose one or more goals. This personalizes suggestions; it does not change your workspace access.</Text>
          <View style={styles.options}>
            {UX_GOALS.map(goal => {
              const selected = state.goals.includes(goal.id);
              return <Pressable key={goal.id} accessibilityRole="checkbox" accessibilityState={{ checked: selected, disabled: busy }} disabled={busy}
                onPress={() => selectGoal(goal.id)} style={({ pressed }) => [styles.goal, selected && styles.optionSelected, pressed && styles.pressed]}>
                <View style={[styles.checkbox, selected && styles.checkboxSelected]}>{selected ? <Text style={styles.check}>✓</Text> : null}</View>
                <Text style={styles.optionTitle}>{goal.label}</Text>
              </Pressable>;
            })}
          </View>
          {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
          <Button label="Review setup" disabled={state.goals.length === 0} busy={busy} onPress={() => goTo("ready")} style={styles.action} />
          <Button label="Back" kind="link" disabled={busy} onPress={() => goTo("role")} />
        </> : <Ready state={state} agentTier={agentTier} designAvailable={designAvailable} busy={busy} error={error} onBack={() => goTo("goals")} onFinish={href => void finish(href)} />}
      </ScrollView>
    </View>
  );
}

function Progress({ step }: { step: UXOnboardingState["step"] }) {
  const styles = useStyles();
  const index = step === "role" ? 0 : step === "goals" ? 1 : 2;
  return <View accessibilityRole="progressbar" accessibilityLabel="Onboarding progress" accessibilityValue={{ min: 1, max: 3, now: index + 1, text: `Step ${index + 1} of 3` }} style={styles.progress}>
    {[0, 1, 2].map(value => <View key={value} style={[styles.progressSegment, value <= index && styles.progressActive]} />)}
  </View>;
}

function AccessNote({ agentTier }: { agentTier: number | null | undefined }) {
  const styles = useStyles();
  const access = agentAccessLabel(agentTier);
  return <View style={styles.note}>
    <Text style={styles.noteTitle}>{access ? `Admin-granted access: ${access}` : "Preferences, not permissions"}</Text>
    <Text style={styles.noteBody}>{access ? "Your workspace owner controls this access. " : "A workspace owner grants agent tiers and tools separately. "}Choosing Researcher or Design engineer as your role preference does not enable research, code, files, or GitHub access.</Text>
  </View>;
}

function Ready({ state, agentTier, designAvailable, busy, error, onBack, onFinish }: { state: UXOnboardingState; agentTier: number | null | undefined; designAvailable: boolean | null; busy: boolean; error: string | null; onBack: () => void; onFinish: (href: "/agent" | "/channels" | "/designs") => void }) {
  const styles = useStyles();
  const canCreateDesign = designAvailable === true && (agentTier === undefined || agentTier === 2 || agentTier === 3);
  const action = firstActionForRole(state.role, { canCreateDesign, agentTier });
  return <>
    <Text accessibilityRole="header" style={styles.title}>Your starting point is ready</Text>
    <Text style={styles.lead}>These choices stay on this device and can be changed from You → Restart onboarding.</Text>
    <View style={styles.summary}>
      <Text style={styles.summaryLabel}>Your role</Text>
      <Text style={styles.summaryValue}>{roleLabel(state.role)}</Text>
      <View style={styles.divider} />
      <Text style={styles.summaryLabel}>Your goals</Text>
      {goalLabels(state.goals).map(goal => <Text key={goal} style={styles.summaryGoal}>• {goal}</Text>)}
    </View>
    <AccessNote agentTier={agentTier} />
    <View style={styles.firstAction}>
      <Text style={styles.firstActionTitle}>{action.label}</Text>
      <Text style={styles.optionDescription}>{action.description}</Text>
    </View>
    {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
    <Button label={action.label} busy={busy} onPress={() => onFinish(action.href)} style={styles.action} />
    {action.href !== "/channels" ? <Button label="Go to home" kind="secondary" disabled={busy} onPress={() => onFinish("/channels")} style={styles.secondary} /> : null}
    <Button label="Back" kind="link" disabled={busy} onPress={onBack} />
  </>;
}

const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  body: { width: "100%", maxWidth: 560, alignSelf: "center", paddingHorizontal: space.side, paddingTop: space.lg, paddingBottom: space.xxl },
  progress: { flexDirection: "row", gap: space.xs, marginBottom: space.lg },
  progressSegment: { flex: 1, height: 4, borderRadius: radius.pill, backgroundColor: colors.line },
  progressActive: { backgroundColor: colors.blue },
  title: { ...typography.display, color: colors.ink },
  lead: { ...typography.body, color: colors.muted, marginTop: space.sm },
  note: { backgroundColor: colors.subtle, borderRadius: radius.md, padding: space.md, marginTop: space.lg, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line },
  noteTitle: { ...typography.bodyStrong, color: colors.ink },
  noteBody: { ...typography.caption, color: colors.muted, marginTop: space.xxs },
  options: { gap: space.sm, marginTop: space.lg },
  option: { minHeight: 76, flexDirection: "row", alignItems: "flex-start", gap: space.sm, padding: space.md, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.background },
  optionSelected: { borderColor: colors.blue, backgroundColor: colors.subtle },
  pressed: { opacity: 0.78 },
  radio: { width: 22, height: 22, borderRadius: 11, borderWidth: 2, borderColor: colors.muted, alignItems: "center", justifyContent: "center", marginTop: 1 },
  radioSelected: { borderColor: colors.blue },
  radioDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.blue },
  optionCopy: { flex: 1 },
  optionTitle: { ...typography.bodyStrong, color: colors.ink },
  optionDescription: { ...typography.caption, color: colors.muted, marginTop: space.xxs },
  goal: { minHeight: 56, flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.md, paddingVertical: space.sm, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.background },
  checkbox: { width: 24, height: 24, borderRadius: radius.sm, borderWidth: 2, borderColor: colors.muted, alignItems: "center", justifyContent: "center" },
  checkboxSelected: { backgroundColor: colors.blue, borderColor: colors.blue },
  check: { color: colors.onPrimary, fontSize: 15, fontWeight: "700", lineHeight: 18 },
  action: { marginTop: space.lg },
  secondary: { marginTop: space.sm },
  error: { ...typography.caption, color: colors.red, marginTop: space.md },
  summary: { marginTop: space.lg, padding: space.lg, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line },
  summaryLabel: { ...typography.label, color: colors.muted },
  summaryValue: { ...typography.heading, color: colors.ink, marginTop: space.xxs },
  summaryGoal: { ...typography.body, color: colors.ink, marginTop: space.xs },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.line, marginVertical: space.md },
  firstAction: { marginTop: space.lg },
  firstActionTitle: { ...typography.heading, color: colors.ink },
}));
