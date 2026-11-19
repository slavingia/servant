import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, Text, View, type GestureResponderEvent } from "react-native";
import { router, Stack } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppIcon } from "../components/AppIcon";
import { PageTitle } from "../components/Band";
import { Button } from "../components/Button";
import { Radio } from "../components/Radio";
import { landingHref, useFeatures } from "../lib/features";
import { openNewChat } from "../lib/new-chat";
import { api, ServerError } from "../lib/server";
import { useSession } from "../lib/session";
import { createThemedStyles, radius, space, typography, useTheme } from "../lib/theme";
import { ROLE_NOTE, STEP_TITLE, TOUR_STEPS, accessSummary, chargeLead, chargePoints, chosenRole, dataPoints, levelRows, limitPage, stepAfter, stepLabel, swipeTurn, tourRoles, tryPage, type TourFacts, type TourPoint } from "../lib/tour";
import { markTourSeen } from "../lib/tour-seen";

// The onboarding tour (lib/tour.ts): six short pages, shown once after someone joins and again from You, "Take
// the tour". A person chooses their own role, then reads what is true for them on this server: what stops the
// agent, their access level, their daily limit in dollars, and where their data goes. It ends with first asks.
// Every page has Skip; skipping and finishing both save "seen" (lib/tour-seen.ts).
export default function Tour() {
  const { account, updateAccount } = useSession();
  const styles = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const landing = landingHref(useFeatures());
  const [facts, setFacts] = useState<TourFacts | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [index, setIndex] = useState(0);
  const [chosen, setChosen] = useState<string | null>(null);
  const [roleError, setRoleError] = useState<string | null>(null);
  const saving = useRef(0);

  useEffect(() => {
    if (!account) return;
    let live = true;
    api.tour(account).then(answer => {
      if (!live) return;
      const read = { ...answer, roles: tourRoles(answer.roles) };
      setFacts(read);
      setChosen(read.jobRole);
    }).catch(error => {
      if (live) setLoadError(error instanceof ServerError && error.status === 404 ? "This server doesn't have the tour yet. Ask your owner to update it." : "Couldn't load the tour. Check your connection and try again.");
    });
    return () => { live = false; };
    // Once per account and per "Try again": a profile refresh must not restart the tour.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account?.token, account?.serverUrl, attempt]);

  const go = useCallback((by: 1 | -1) => setIndex(at => stepAfter(at, by)), []);
  // A swipe turns the page. The page keeps its own up-and-down scrolling: only where the finger came down and
  // where it lifted are read (swipeTurn).
  const touch = useRef<{ x: number; y: number } | null>(null);
  const swipe = useMemo(() => ({
    onTouchStart: (event: GestureResponderEvent) => { const at = event.nativeEvent.touches[0] ?? event.nativeEvent; touch.current = { x: at.pageX, y: at.pageY }; },
    onTouchEnd: (event: GestureResponderEvent) => {
      const from = touch.current, at = event.nativeEvent.changedTouches[0] ?? event.nativeEvent;
      touch.current = null;
      const turn = from ? swipeTurn(at.pageX - from.x, at.pageY - from.y) : 0;
      if (turn) go(turn);
    },
    onTouchCancel: () => { touch.current = null; },
  }), [go]);
  // In a browser and the Mac app, the arrow keys turn the page.
  useEffect(() => {
    if (Platform.OS !== "web") return;
    const onKey = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (event.key === "ArrowRight") go(1);
      else if (event.key === "ArrowLeft") go(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go]);

  if (!account) return null;

  // Finishing and skipping are the same: "seen" is saved, then back to where the tour was opened from.
  const leave = (ask?: string) => {
    markTourSeen(account);
    if (router.canGoBack()) router.back(); else router.replace(landing);
    // A first ask opens a new agent chat with the words in the message box, ready to read, change and send.
    if (ask) openNewChat(account, {}, {}, ask);
  };

  const choose = async (id: string) => {
    if (id === chosen) return;
    const before = chosen, run = ++saving.current;
    setChosen(id);
    setRoleError(null);
    try {
      const { user } = await api.setJobRole(account, id);
      // Beside their name on You. Nothing about access is read from it.
      await updateAccount({ ...account, user: { ...account.user, jobRole: user.jobRole } });
    } catch (error) {
      if (run !== saving.current) return;
      setChosen(before);
      setRoleError(error instanceof ServerError ? `Couldn't save your role: ${error.message}. Try again.` : "Couldn't save your role. Check your connection and try again.");
    }
  };

  const step = TOUR_STEPS[index]!;
  const last = index === TOUR_STEPS.length - 1;
  const role = facts ? chosenRole(facts, chosen) : null;

  const points = (list: TourPoint[]) => <View style={styles.points}>
    {list.map(point => <View key={point.title} style={styles.point}>
      <Text style={styles.pointTitle}>{point.title}</Text>
      <Text style={styles.pointBody}>{point.body}</Text>
    </View>)}
  </View>;

  const page = () => {
    if (!facts) return null;
    if (step === "role") return <>
      <PageTitle description="Choose the one closest to your work. You can change it here any time.">{STEP_TITLE.role}</PageTitle>
      <View accessibilityRole="radiogroup" accessibilityLabel="Your role" style={styles.card}>
        {facts.roles.map((entry, at) => {
          const on = entry.id === chosen;
          return <Radio key={entry.id} testID={`tour-role-${entry.id}`} accessibilityLabel={entry.label} accessibilityState={{ checked: on }} aria-checked={on} onPress={() => void choose(entry.id)}
            style={({ pressed }) => [styles.choice, at === facts.roles.length - 1 && styles.lastRow, pressed && { backgroundColor: colors.subtle }]}>
            <Text style={[styles.choiceLabel, on && styles.choiceOn]}>{entry.label}</Text>
            {on ? <AppIcon name="check" size={18} color={colors.blue} /> : null}
          </Radio>;
        })}
      </View>
      {roleError ? <Text accessibilityRole="alert" style={styles.error}>{roleError}</Text> : null}
      <Text style={styles.note}>{ROLE_NOTE} People on this server see your role beside your name.</Text>
    </>;
    if (step === "charge") {
      const example = (role ?? facts.roles.find(entry => entry.id === "other"))?.asks[0];
      return <>
        <PageTitle description={chargeLead(facts, role)}>{STEP_TITLE.charge}</PageTitle>
        {facts.agent.kind !== "none" && example ? <View accessible accessibilityRole="image" accessibilityLabel={`Example: you ask "${example}" While the agent is working, the Send button is a Stop button.`} style={[styles.card, styles.example]}>
          <Text style={styles.exampleTag}>Example</Text>
          <View style={styles.bubble}><Text style={styles.bubbleText}>{example}</Text></View>
          <View style={styles.working}>
            <Text style={styles.workingText}>{facts.agentName} is working…</Text>
            <View style={styles.stop}><AppIcon name="stop" size={14} color={colors.onPrimary} /></View>
          </View>
        </View> : null}
        {points(chargePoints(facts))}
      </>;
    }
    if (step === "access") {
      const summary = accessSummary(facts), rows = levelRows(facts);
      return <>
        <PageTitle description="Your owner chooses what your agent may do. This is what you have now.">{STEP_TITLE.access}</PageTitle>
        <View style={[styles.card, styles.callout]}>
          <Text style={styles.calloutTag}>Your level</Text>
          <Text testID="tour-level" style={styles.calloutTitle}>{summary.title}</Text>
          <Text style={styles.calloutBody}>{summary.body}</Text>
        </View>
        <Text style={styles.note}>{role ? `You said your role is ${role.label}. ` : ""}{ROLE_NOTE}</Text>
        {rows.length ? <>
          <Text accessibilityRole="header" style={styles.section}>Levels on this server</Text>
          <View style={styles.card}>
            {rows.map((row, at) => <View key={row.tier} accessible accessibilityLabel={`${row.label}${row.mine ? ", your level" : ""}: ${row.hint}`} style={[styles.row, at === rows.length - 1 && styles.lastRow]}>
              <View style={styles.rowCopy}>
                <Text style={[styles.rowLabel, row.mine && styles.choiceOn]}>{row.label}</Text>
                <Text style={styles.rowHint}>{row.hint}</Text>
              </View>
              {row.mine ? <Text style={styles.yours}>Yours</Text> : null}
            </View>)}
          </View>
        </> : null}
      </>;
    }
    if (step === "limit") {
      const limit = limitPage(facts), rows = facts.owner || facts.agent.kind === "none" ? [] : levelRows(facts);
      return <>
        <PageTitle description="The agent's work is counted in tokens, and tokens cost money. Each person has a limit for the day.">{STEP_TITLE.limit}</PageTitle>
        {limit.headline ? <View style={[styles.card, styles.callout]}>
          <Text testID="tour-limit" style={styles.calloutTitle}>{limit.headline}</Text>
          {limit.lines.map(line => <Text key={line} style={styles.calloutBody}>{line}</Text>)}
        </View> : null}
        {limit.note ? <Text style={styles.note}>{limit.note}</Text> : null}
        {rows.length ? <>
          <Text accessibilityRole="header" style={styles.section}>Where each level starts</Text>
          <View style={styles.card}>
            {rows.map((row, at) => <View key={row.tier} accessible accessibilityLabel={`${row.label}${row.mine ? ", your level" : ""}: ${row.cost}`} style={[styles.row, at === rows.length - 1 && styles.lastRow]}>
              <Text style={[styles.rowLabel, styles.rowCopy, row.mine && styles.choiceOn]}>{row.label}{row.mine ? " (yours)" : ""}</Text>
              <Text style={styles.rowValue}>{row.cost}</Text>
            </View>)}
          </View>
        </> : null}
      </>;
    }
    if (step === "data") return <>
      <PageTitle description="What you write goes to one place: the server your team runs.">{STEP_TITLE.data}</PageTitle>
      {points(dataPoints(facts))}
    </>;
    const asking = tryPage(facts, role);
    return <>
      <PageTitle description={asking.lead}>{STEP_TITLE.try}</PageTitle>
      {asking.asks.length ? <View style={styles.card}>
        {asking.asks.map((ask, at) => asking.canAsk
          ? <Pressable key={ask} testID={`tour-ask-${at}`} accessibilityRole="button" accessibilityLabel={ask} accessibilityHint="Opens a new agent chat with these words filled in" onPress={() => leave(ask)}
              style={({ pressed }) => [styles.row, at === asking.asks.length - 1 && styles.lastRow, pressed && { backgroundColor: colors.subtle }]}>
              <Text style={[styles.rowLabel, styles.rowCopy]}>{ask}</Text>
              <AppIcon name="chevronRight" size={16} color={colors.muted} />
            </Pressable>
          : <View key={ask} style={[styles.row, at === asking.asks.length - 1 && styles.lastRow]}><Text style={[styles.rowLabel, styles.rowCopy]}>{ask}</Text></View>)}
      </View> : null}
      <Text style={styles.note}>{role ? `These are for the role you chose, ${role.label}. ` : ""}You can open this tour again from You, under Take the tour.</Text>
    </>;
  };

  return (
    <View style={[styles.root, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <Stack.Screen options={{ headerShown: false, title: "Tour" }} />
      <View style={styles.frame}>
        <View style={styles.top}>
          <View style={styles.progress} accessible accessibilityRole="progressbar" accessibilityLabel={stepLabel(index)} aria-valuemin={1} aria-valuemax={TOUR_STEPS.length} aria-valuenow={index + 1} aria-valuetext={stepLabel(index)} aria-live="polite" accessibilityLiveRegion="polite">
            <View style={styles.dots}>{TOUR_STEPS.map((name, at) => <View key={name} style={[styles.dot, at === index && styles.dotOn]} />)}</View>
            <Text testID="tour-step" style={styles.stepText}>Step {index + 1} of {TOUR_STEPS.length}</Text>
          </View>
          <Button testID="tour-skip" label="Skip" accessibilityLabel="Skip the tour" kind="link" compact onPress={() => leave()} />
        </View>
        {facts ? <View style={styles.body} {...swipe}>
          <ScrollView key={step} style={styles.body} contentContainerStyle={styles.content}>{page()}</ScrollView>
        </View> : <View style={styles.waiting}>
          {loadError ? <>
            <Text accessibilityRole="alert" style={styles.loadError}>{loadError}</Text>
            <Button label="Try again" onPress={() => { setLoadError(null); setAttempt(n => n + 1); }} style={styles.retry} />
          </> : <ActivityIndicator accessibilityLabel="Loading the tour" color={colors.muted} />}
        </View>}
        {facts ? <View style={styles.bottom}>
          {index > 0 ? <Button testID="tour-back" label="Back" kind="secondary" onPress={() => go(-1)} style={styles.back} /> : null}
          <Button testID="tour-next" label={last ? "Done" : "Next"} onPress={() => { if (last) leave(); else go(1); }} style={styles.next} />
        </View> : null}
      </View>
    </View>
  );
}

const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.groupedBackground },
  // One column, the width of a page of settings, in the middle of a wide window.
  frame: { flex: 1, width: "100%", maxWidth: 680, alignSelf: "center" },
  top: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.sm, paddingLeft: space.side, minHeight: 48 },
  progress: { flexDirection: "row", alignItems: "center", gap: space.sm, flexShrink: 1 },
  dots: { flexDirection: "row", alignItems: "center", gap: space.xs },
  dot: { width: 8, height: 8, borderRadius: radius.pill, backgroundColor: colors.borderStrong, opacity: 0.45 },
  dotOn: { width: 24, backgroundColor: colors.primary, opacity: 1 },
  stepText: { ...typography.caption, color: colors.muted },
  body: { flex: 1 },
  content: { paddingBottom: space.lg },
  waiting: { flex: 1, alignItems: "center", justifyContent: "center", padding: space.lg },
  loadError: { ...typography.body, color: colors.ink, textAlign: "center" },
  retry: { marginTop: space.md, minWidth: 200 },
  bottom: { flexDirection: "row", gap: space.sm, paddingHorizontal: space.side, paddingVertical: space.sm, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  back: { flex: 1 },
  next: { flex: 2 },
  card: { backgroundColor: colors.groupedCard, marginHorizontal: space.side, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, overflow: "hidden", marginBottom: space.sm },
  choice: { minHeight: 48, paddingHorizontal: space.md, paddingVertical: space.sm, flexDirection: "row", alignItems: "center", gap: space.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  choiceLabel: { ...typography.body, color: colors.ink, flex: 1 },
  choiceOn: { ...typography.bodyStrong },
  lastRow: { borderBottomWidth: 0 },
  note: { ...typography.caption, color: colors.muted, marginHorizontal: space.side, marginBottom: space.md },
  error: { ...typography.caption, color: colors.red, marginHorizontal: space.side, marginBottom: space.xs },
  example: { padding: space.md, gap: space.sm },
  exampleTag: { ...typography.label, color: colors.muted },
  bubble: { alignSelf: "flex-end", maxWidth: "90%", backgroundColor: colors.bubbleMine, borderRadius: radius.lg, paddingHorizontal: space.sm, paddingVertical: space.xs },
  bubbleText: { ...typography.body, color: colors.onPrimary },
  working: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.sm },
  workingText: { ...typography.caption, color: colors.muted, flex: 1 },
  stop: { width: 32, height: 32, borderRadius: radius.md, backgroundColor: colors.primary, alignItems: "center", justifyContent: "center" },
  points: { marginHorizontal: space.side, gap: space.md, marginTop: space.xs, marginBottom: space.md },
  point: { gap: space.xxs },
  pointTitle: { ...typography.bodyStrong, color: colors.ink },
  pointBody: { ...typography.body, color: colors.muted },
  callout: { padding: space.md, gap: space.xxs },
  calloutTag: { ...typography.label, color: colors.muted },
  calloutTitle: { ...typography.title, color: colors.ink },
  calloutBody: { ...typography.body, color: colors.muted },
  section: { ...typography.label, marginHorizontal: space.side, marginTop: space.xs, marginBottom: space.xs, color: colors.muted },
  row: { minHeight: 48, paddingHorizontal: space.md, paddingVertical: space.sm, flexDirection: "row", alignItems: "center", gap: space.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  rowCopy: { flex: 1, minWidth: 0 },
  rowLabel: { ...typography.body, color: colors.ink },
  rowHint: { ...typography.caption, color: colors.muted },
  rowValue: { ...typography.caption, color: colors.muted, textAlign: "right", flexShrink: 1 },
  yours: { ...typography.captionStrong, color: colors.ink },
}));
