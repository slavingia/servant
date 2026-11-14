import { useEffect, useRef, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { router, type Href } from "expo-router";
import { AppIcon } from "../components/AppIcon";
import { Button } from "../components/Button";
import { RoleTourDemo } from "../components/RoleTourDemo";
import { api, saveAccount } from "../lib/server";
import { useSession } from "../lib/session";
import { completeRoleIntro, normalizeOnboarding, roleIntroRequired, roleLabel } from "../lib/onboarding";
import { roleStartTasks } from "../lib/role-start";
import { tourPage, tourPages } from "../lib/role-tour";
import { canCreateDesign as mayCreateDesign } from "../lib/designs";
import { createThemedStyles, radius, space, typography } from "../lib/theme";

// "Product designer" mid-sentence is "product designer"; "UX researcher" keeps its capitals.
const roleInSentence = (label: string) => /^[A-Z][a-z]/.test(label) ? label.charAt(0).toLowerCase() + label.slice(1) : label;

/**
 * The optional role tour, opened from the start page or You: one page per
 * starting point for the person's role, each with a drawn example, how it
 * works, and whether they can use it now. Access is checked the same way as on
 * the start page, so locked features are shown with what unlocks them.
 */
export default function RoleTour() {
  const styles = useStyles();
  const { account, setAccount } = useSession();
  const [agentTier, setAgentTier] = useState<number | null | undefined>(undefined);
  const [designAvailable, setDesignAvailable] = useState<boolean | null | undefined>(undefined);
  const [researchHold, setResearchHold] = useState(true);
  const [page, setPage] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scroll = useRef<React.ComponentRef<typeof ScrollView>>(null);

  useEffect(() => {
    if (!account) return;
    let active = true;
    api.projects(account).then(result => {
      if (!active) return;
      setAgentTier(result.agentTier === undefined ? (result.vibeCoder ? 2 : undefined) : Number.isInteger(result.agentTier) ? result.agentTier : null);
      setDesignAvailable(result.vibe === true);
      // Older servers don't report the hold; the pilot build defaults it on.
      setResearchHold(result.researchHold !== false);
    }).catch(() => { if (active) { setAgentTier(null); setDesignAvailable(null); } });
    return () => { active = false; };
  }, [account?.serverUrl, account?.serverKey, account?.user.id]);

  if (!account) return null;
  const onboarding = normalizeOnboarding(account.uxOnboarding);
  const accessChecked = designAvailable !== undefined;
  const canCreateDesign = designAvailable === null ? null : designAvailable === undefined ? undefined : mayCreateDesign(agentTier, designAvailable);
  const taskAgentTier = accessChecked && onboarding.role === "ux-researcher" && agentTier === undefined ? null : agentTier;
  const pages = tourPages(roleStartTasks(onboarding, { agentTier: taskAgentTier, canCreateDesign }), researchHold);
  const index = tourPage(page, pages.length);
  const current = pages[index];
  const last = index === pages.length - 1;

  const leave = async (href: Href) => {
    if (busy) return;
    // Trying a feature from the tour counts as picking a starting point, as on the start page.
    if (!roleIntroRequired(account.uxOnboarding)) { router.replace(href); return; }
    setBusy(true);
    setError(null);
    const updated = { ...account, uxOnboarding: completeRoleIntro(onboarding) };
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
  const show = (next: number) => { setPage(tourPage(next, pages.length)); scroll.current?.scrollTo({ y: 0, animated: false }); };
  const done = () => router.canGoBack() ? router.back() : router.replace("/start");

  return <View style={styles.root}>
    <ScrollView ref={scroll} contentContainerStyle={styles.body}>
      <Text style={styles.eyebrow}>{`YOUR ${roleInSentence(roleLabel(onboarding.role)).toUpperCase()} TOUR${current ? ` · ${index + 1} OF ${pages.length}` : ""}`}</Text>
      {!onboarding.role ? <>
        <Text accessibilityRole="header" style={styles.title}>Choose your role first</Text>
        <Text style={styles.lead}>The tour shows the features for your role. Pick one in You → Restart onboarding.</Text>
        <Button label="Go back" kind="secondary" onPress={done} style={styles.action} />
      </> : !accessChecked ? <View style={styles.checking}><Text style={styles.meta}>Checking workspace access…</Text></View> : current ? <>
        <Text accessibilityRole="header" style={styles.title}>{current.task.title}</Text>
        <Text style={styles.lead}>{current.demo.lead}</Text>
        <View style={styles.visual}><RoleTourDemo visual={current.demo.visual} /></View>
        <View style={styles.how}>
          {current.demo.how.map((line, i) => <View key={line} style={styles.howRow}>
            <View style={styles.num}><Text style={styles.numText}>{i + 1}</Text></View>
            <Text style={styles.howText}>{line}</Text>
          </View>)}
        </View>
        <View style={[styles.status, current.status === "ready" ? styles.statusReady : styles.statusOff]}>
          <AppIcon name={current.status === "ready" ? "check" : current.status === "held" ? "clock" : "lock"} size={16} />
          <Text style={styles.statusText}>{current.note}</Text>
        </View>
        {current.status === "ready" ? <Button label={`Try it: ${current.task.title}`} kind="secondary" busy={busy} onPress={() => void leave(current.task.href as Href)} style={styles.action} /> : null}
        <View style={styles.dots} accessible accessibilityLabel={`Feature ${index + 1} of ${pages.length}`}>
          {pages.map((p, i) => <View key={p.task.id} style={[styles.dot, i === index && styles.dotOn]} />)}
        </View>
        {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
        <Button label={last ? "Finish the tour" : "Next feature"} disabled={busy} onPress={() => last ? done() : show(index + 1)} style={styles.action} />
        {index > 0 ? <Button label="Back" kind="link" disabled={busy} onPress={() => show(index - 1)} /> : <Button label="Skip the tour" kind="link" disabled={busy} onPress={done} />}
      </> : <>
        <Text accessibilityRole="header" style={styles.title}>Nothing to show yet</Text>
        <Button label="Go back" kind="secondary" onPress={done} style={styles.action} />
      </>}
    </ScrollView>
  </View>;
}

const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  body: { width: "100%", maxWidth: 560, alignSelf: "center", paddingHorizontal: space.side, paddingTop: space.xl, paddingBottom: space.xxl },
  eyebrow: { ...typography.label, color: colors.brandText, letterSpacing: 0.6 },
  title: { ...typography.display, color: colors.ink, marginTop: space.xs },
  lead: { ...typography.body, color: colors.muted, marginTop: space.sm },
  meta: { ...typography.caption, color: colors.muted },
  checking: { minHeight: 120, alignItems: "center", justifyContent: "center", marginTop: space.lg, borderRadius: radius.lg, backgroundColor: colors.subtle },
  visual: { marginTop: space.lg },
  how: { marginTop: space.lg, gap: space.sm },
  howRow: { flexDirection: "row", gap: space.sm, alignItems: "flex-start" },
  num: { width: 24, height: 24, borderRadius: 12, backgroundColor: colors.blueSoft, alignItems: "center", justifyContent: "center", marginTop: 1 },
  numText: { ...typography.label, color: colors.brandText },
  howText: { ...typography.body, color: colors.ink, flex: 1 },
  status: { flexDirection: "row", alignItems: "center", gap: space.xs, marginTop: space.lg, padding: space.sm, borderRadius: radius.md },
  statusReady: { backgroundColor: colors.greenSoft },
  statusOff: { backgroundColor: colors.subtle },
  statusText: { ...typography.captionStrong, color: colors.ink, flex: 1 },
  dots: { flexDirection: "row", gap: space.xs, justifyContent: "center", marginTop: space.lg },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.line },
  dotOn: { width: 24, backgroundColor: colors.blue },
  action: { marginTop: space.md },
  error: { ...typography.caption, color: colors.red, marginTop: space.md },
}));
