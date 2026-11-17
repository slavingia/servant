import { useEffect, useRef, useState } from "react";
import { Platform, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from "react-native";
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
  goalLabels,
  moveOnboarding,
  normalizeOnboarding,
  onboardingProgress,
  roleLabel,
  toggleGoal,
  type UXGoal,
  type UXOnboardingState,
  type UXRole,
} from "../lib/onboarding";
import { BENEFITS, benefitPage } from "../lib/onboarding-benefits";
import { BenefitPage } from "../components/OnboardingBenefits";
import { createThemedStyles, radius, space, typography } from "../lib/theme";
import { checkboxKeys, useRadioGroup } from "../components/useRadioGroup";

// Laptop browsers at least this wide get the desktop layout: the tour splits
// into words and an example side by side, and setup choices sit in a grid.
const DESKTOP_MIN_WIDTH = 960;

export default function Onboarding() {
  const { account, setAccount } = useSession();
  const styles = useStyles();
  const { width } = useWindowDimensions();
  const desktop = Platform.OS === "web" && width >= DESKTOP_MIN_WIDTH;
  const [state, setState] = useState<UXOnboardingState>(() => normalizeOnboarding(account?.uxOnboarding));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [agentTier, setAgentTier] = useState<number | null | undefined>(undefined);
  // Which "Why Servant" page is showing. Kept on screen only: the tour is short.
  const [page, setPage] = useState(0);
  const scroll = useRef<React.ComponentRef<typeof ScrollView>>(null);

  useEffect(() => {
    if (!account) return;
    let active = true;
    api.projects(account).then(result => {
      if (active) {
        const tier = result.agentTier === undefined
          ? (result.vibeCoder ? 2 : undefined)
          : Number.isInteger(result.agentTier) ? result.agentTier : null;
        setAgentTier(tier);
      }
    }).catch(() => { if (active) setAgentTier(null); });
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
  const showPage = (next: number) => { setPage(benefitPage(next)); scroll.current?.scrollTo({ y: 0, animated: false }); };
  const lastPage = page === BENEFITS.length - 1;
  const finish = async () => {
    const completed = completeOnboarding(state);
    if (!completed.completedAt || !await persist(completed)) return;
    router.replace("/start");
  };

  const why = state.step === "why";
  // Phone: buttons stacked full width. Desktop: primary then link, side by side.
  const actions = (primary: React.ReactNode, link: React.ReactNode) => <>
    {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
    <View style={desktop ? styles.actionsRow : undefined}>{primary}{link}</View>
  </>;
  const primaryStyle = desktop ? styles.actionDesktop : styles.action;

  return (
    <View style={styles.root}>
      <Band />
      <ScrollView ref={scroll} contentContainerStyle={[styles.body, desktop && (why ? styles.bodyDesktop : styles.bodySetup)]} keyboardShouldPersistTaps="handled">
        <Progress step={state.step} page={page} desktop={desktop} />
        <View style={desktop ? styles.stepDesktop : undefined}>
        {why ? <BenefitPage benefit={BENEFITS[page]} agentTier={agentTier} isOwner={account.user.role === "owner"} split={desktop} actions={actions(
          <Button label={lastPage ? "Set up your workspace" : "Next"} busy={busy} onPress={() => lastPage ? goTo("role") : showPage(page + 1)} style={primaryStyle} />,
          page > 0
            ? <Button label="Back" kind="link" disabled={busy} onPress={() => showPage(page - 1)} />
            : <Button label="Skip the tour" kind="link" disabled={busy} onPress={() => goTo("role")} />,
        )} /> : state.step === "role" ? <>
          <Text accessibilityRole="header" style={[styles.title, desktop && styles.titleDesktop]}>How do you work?</Text>
          <Text style={[styles.lead, desktop && styles.leadDesktop]}>Choose the closest fit. It only shapes your starting points; it doesn't change what you can access.</Text>
          <RoleOptions value={state.role ?? null} disabled={busy} onChange={selectRole} grid={desktop} />
          {actions(
            <Button label="Continue" disabled={!state.role} busy={busy} onPress={() => goTo("goals")} style={primaryStyle} />,
            <Button label="Back" kind="link" disabled={busy} onPress={() => { showPage(BENEFITS.length - 1); goTo("why"); }} />,
          )}
        </> : state.step === "goals" ? <>
          <Text accessibilityRole="header" style={[styles.title, desktop && styles.titleDesktop]}>What do you want to do first?</Text>
          <Text style={[styles.lead, desktop && styles.leadDesktop]}>Choose one or more goals. This personalizes suggestions; it does not change your workspace access.</Text>
          <View style={[styles.options, desktop && styles.grid]}>
            {UX_GOALS.map(goal => {
              const selected = state.goals.includes(goal.id);
              return <Pressable key={goal.id} accessibilityRole="checkbox" role="checkbox" aria-checked={selected} aria-disabled={busy || undefined} accessibilityState={{ checked: selected, disabled: busy }} disabled={busy} {...checkboxKeys(() => selectGoal(goal.id), busy)}
                onPress={() => selectGoal(goal.id)} style={({ pressed }) => [styles.goal, desktop && styles.gridItem, selected && styles.optionSelected, pressed && styles.pressed]}>
                <View style={[styles.checkbox, selected && styles.checkboxSelected]}>{selected ? <Text style={styles.check}>✓</Text> : null}</View>
                <Text style={styles.optionTitle}>{goal.label}</Text>
              </Pressable>;
            })}
          </View>
          {actions(
            <Button label="Review setup" disabled={state.goals.length === 0} busy={busy} onPress={() => goTo("ready")} style={primaryStyle} />,
            <Button label="Back" kind="link" disabled={busy} onPress={() => goTo("role")} />,
          )}
        </> : <Ready state={state} agentTier={agentTier} desktop={desktop} actions={actions(
          <Button label="See your starting points" busy={busy} onPress={() => void finish()} style={primaryStyle} />,
          <Button label="Back" kind="link" disabled={busy} onPress={() => goTo("goals")} />,
        )} />}
        </View>
      </ScrollView>
    </View>
  );
}

// One segment per screen of the current part: the tour, then setup (role, goals, review). Each part ends full.
function Progress({ step, page, desktop }: { step: UXOnboardingState["step"]; page: number; desktop: boolean }) {
  const styles = useStyles();
  const { now, total } = onboardingProgress(step, page, BENEFITS.length);
  const bar = <View accessibilityRole="progressbar" accessibilityLabel="Onboarding progress" accessibilityValue={{ min: 1, max: total, now, text: `Step ${now} of ${total}` }} style={[styles.progress, desktop && styles.progressDesktop]}>
    {Array.from({ length: total }, (_, value) => <View key={value} style={[styles.progressSegment, value < now && styles.progressActive]} />)}
  </View>;
  if (!desktop) return bar;
  // On a wide screen there's room to name the part and the step in words.
  return <View style={styles.progressHead}>
    <Text style={styles.progressLabel}>{step === "why" ? "Why Servant" : "Set up your workspace"} · Step {now} of {total}</Text>
    {bar}
  </View>;
}

function AccessNote({ agentTier }: { agentTier: number | null | undefined }) {
  const styles = useStyles();
  const access = agentAccessLabel(agentTier);
  return <View style={styles.note}>
    <Text style={styles.noteTitle}>{access ? `Your agent access: ${access === "No agent" ? "none yet" : `${access} tier`}` : "Your role is a preference, not access"}</Text>
    <Text style={styles.noteBody}>{access ? "Your workspace owner sets this, separately from your role. " : "A workspace owner grants agent access separately. "}A role like UX researcher or Design engineer doesn't turn on research, code, files or GitHub access.</Text>
  </View>;
}

// The next screen lists the starting points; this one confirms the choices and the access they don't change.
function Ready({ state, agentTier, desktop, actions }: { state: UXOnboardingState; agentTier: number | null | undefined; desktop: boolean; actions: React.ReactNode }) {
  const styles = useStyles();
  return <>
    <Text accessibilityRole="header" style={[styles.title, desktop && styles.titleDesktop]}>You're all set</Text>
    <Text style={[styles.lead, desktop && styles.leadDesktop]}>These choices stay on this device. You can change them from You → Restart onboarding.</Text>
    <View style={styles.summary}>
      <Text style={styles.summaryLabel}>Your role</Text>
      <Text style={styles.summaryValue}>{roleLabel(state.role)}</Text>
      <View style={styles.divider} />
      <Text style={styles.summaryLabel}>Your goals</Text>
      {goalLabels(state.goals).map(goal => <Text key={goal} style={styles.summaryGoal}>• {goal}</Text>)}
    </View>
    <AccessNote agentTier={agentTier} />
    {actions}
  </>;
}

const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  body: { width: "100%", maxWidth: 560, alignSelf: "center", paddingHorizontal: space.side, paddingTop: space.lg, paddingBottom: space.xxl },
  bodyDesktop: { maxWidth: 1160, flexGrow: 1, paddingHorizontal: space.xxl, paddingTop: space.xl },
  bodySetup: { maxWidth: 760, paddingHorizontal: space.xxl, paddingTop: space.xl },
  stepDesktop: { flexGrow: 1, justifyContent: "center", paddingVertical: space.lg },
  progress: { flexDirection: "row", gap: space.xs, marginBottom: space.lg },
  progressHead: { gap: space.xs },
  progressLabel: { ...typography.label, color: colors.muted },
  progressDesktop: { marginBottom: 0 },
  titleDesktop: { fontSize: 36, lineHeight: 42, letterSpacing: -0.7 },
  leadDesktop: { fontSize: 17, lineHeight: 26 },
  grid: { flexDirection: "row", flexWrap: "wrap" },
  gridItem: { flexBasis: "45%", flexGrow: 1 },
  actionsRow: { flexDirection: "row", alignItems: "center", gap: space.md, marginTop: space.xl },
  actionDesktop: { minWidth: 240 },
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
}));

function RoleOptions({ value, disabled, onChange, grid = false }: { value: UXRole | null; disabled: boolean; onChange: (role: UXRole) => void; grid?: boolean }) {
  const styles = useStyles();
  const roleRadios = useRadioGroup({ values: UX_ROLES.map(role => role.id), value, onChange, label: "How do you work?", disabled });
  return <View {...roleRadios.group} style={[styles.options, grid && styles.grid]}>
            {UX_ROLES.map((role, index) => {
              const selected = value === role.id;
              return <Pressable key={role.id} {...roleRadios.radio(role.id, index)} accessibilityLabel={`${role.label}. ${role.description}`} style={({ pressed }) => [styles.option, grid && styles.gridItem, selected && styles.optionSelected, pressed && styles.pressed]}>
                <View style={[styles.radio, selected && styles.radioSelected]}>{selected ? <View style={styles.radioDot} /> : null}</View>
                <View style={styles.optionCopy}>
                  <Text style={styles.optionTitle}>{role.label}</Text>
                  <Text style={styles.optionDescription}>{role.description}</Text>
                </View>
              </Pressable>;
            })}
  </View>;
}
