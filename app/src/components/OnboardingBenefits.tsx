import { Platform, StyleSheet, Text, View } from "react-native";
import { AGENT_LEVELS, BENEFITS, capText, dailyLimitText, type Benefit } from "../lib/onboarding-benefits";
import { createThemedStyles, radius, space, typography } from "../lib/theme";

const mono = Platform.select({ ios: "Menlo", android: "monospace", default: "ui-monospace, Menlo, Consolas, monospace" });

// One page of the "Why Servant" tour: a small picture of the feature, drawn
// with the app's own pieces so it follows light and dark mode, then the words.
// Each picture is one image to screen readers, with a label saying what it
// shows; the page's title and points carry the meaning.

export function BenefitPage({ benefit, agentTier, isOwner }: { benefit: Benefit; agentTier: number | null | undefined; isOwner: boolean }) {
  const styles = useStyles();
  const own = benefit.id === "cost" ? dailyLimitText(agentTier, isOwner) : null;
  return <View>
    <Text style={styles.kicker}>{benefit.kicker}</Text>
    <Text accessibilityRole="header" style={styles.title}>{benefit.title}</Text>
    <Text style={styles.lead}>{benefit.lead}</Text>
    <View style={styles.visual}>
      {benefit.id === "charge" ? <ChargeVisual />
        : benefit.id === "access" ? <AccessVisual agentTier={isOwner ? 3 : agentTier} />
        : benefit.id === "cost" ? <CostVisual />
        : benefit.id === "data" ? <DataVisual />
        : <TimeVisual />}
    </View>
    {own ? <View style={styles.own}><Text style={styles.ownText}>{own}</Text></View> : null}
    <View style={styles.points}>
      {benefit.points.map(point => <View key={point} style={styles.point}>
        <View style={styles.tick}><Text style={styles.tickMark}>✓</Text></View>
        <Text style={styles.pointText}>{point}</Text>
      </View>)}
    </View>
  </View>;
}

export function BenefitDots({ page }: { page: number }) {
  const styles = useStyles();
  return <View style={styles.dots} accessible accessibilityLabel={`Page ${page + 1} of ${BENEFITS.length}`}>
    {BENEFITS.map((b, i) => <View key={b.id} style={[styles.dot, i === page && styles.dotOn]} />)}
  </View>;
}

export function Frame({ label, children }: { label: string; children: React.ReactNode }) {
  const styles = useStyles();
  return <View accessible role="img" accessibilityLabel={`Example: ${label}`} style={styles.frame}>
    <Text style={styles.example}>Example</Text>
    {children}
  </View>;
}

function Chip({ text, tone }: { text: string; tone: "muted" | "blue" }) {
  const styles = useStyles();
  return <View style={[styles.chip, tone === "blue" && styles.chipBlue]}>
    <Text style={[styles.chipText, tone === "blue" && styles.chipTextBlue]}>{text}</Text>
  </View>;
}

export function Mine({ text }: { text: string }) {
  const styles = useStyles();
  return <View style={styles.mine}><Text style={styles.mineText}>{text}</Text></View>;
}

export function Reply({ text }: { text: string }) {
  const styles = useStyles();
  return <View style={styles.reply}>
    <Text style={styles.replyName}>AI assistant</Text>
    <Text style={styles.replyText}>{text}</Text>
  </View>;
}

function ChargeVisual() {
  const styles = useStyles();
  return <Frame label="you ask the AI to summarize interview notes, it asks your approval before saving the summary, and a Stop button shows while it works">
    <Mine text="Summarize this week's interview notes" />
    <View style={styles.approval}>
      <Text style={styles.rowTitle}>Your approval is needed</Text>
      <Text style={styles.approvalText}>Save the summary to the team folder?</Text>
      <View style={styles.command}><Text style={styles.commandText}>cp summary.md team-folder/</Text></View>
      <View style={styles.approvalActions}>
        <View style={[styles.fakeButton, styles.fakeSecondary]}><Text style={styles.fakeSecondaryText}>Deny</Text></View>
        <View style={[styles.fakeButton, styles.fakePrimary]}><Text style={styles.fakePrimaryText}>Allow once</Text></View>
      </View>
    </View>
    <View style={styles.working}>
      <Text style={styles.rowMeta}>The AI is working…</Text>
      <View style={styles.stop}><Text style={styles.stopText}>Stop</Text></View>
    </View>
  </Frame>;
}

function AccessVisual({ agentTier }: { agentTier: number | null | undefined }) {
  const styles = useStyles();
  const mine = AGENT_LEVELS.find(level => level.tier === agentTier);
  return <Frame label={`the five access levels, what each can do and its daily spending cap${mine ? `, with yours, ${mine.label}, marked` : ""}`}>
    {AGENT_LEVELS.map((level, i) => {
      const you = level.tier === agentTier;
      return <View key={level.tier} style={[styles.level, i > 0 && styles.rowLine, you && styles.levelYou]}>
        <View style={{ flex: 1 }}>
          <View style={styles.levelHead}>
            <Text style={styles.rowTitle}>{level.label}</Text>
            {you ? <Chip text="You" tone="blue" /> : null}
          </View>
          <Text style={styles.rowMeta}>{level.does}</Text>
        </View>
        <Text style={styles.limit}>{capText(level.dailyTokens)}</Text>
      </View>;
    })}
  </Frame>;
}

const TOPICS = [{ name: "Prototypes", share: 48 }, { name: "Research", share: 31 }, { name: "Content", share: 21 }];

function CostVisual() {
  const styles = useStyles();
  return <Frame label="a meter at about 22 dollars of a 75 dollar daily cap, and a team usage report of about 142 dollars this week split by topic">
    <View style={styles.meterHead}>
      <Text style={styles.rowTitle}>Today</Text>
      <Text style={styles.rowMeta}>about $22 of $75 cap</Text>
    </View>
    <View style={styles.track}><View style={[styles.fill, { width: "30%" }]} /></View>
    <Text style={styles.rowMeta}>Resets at midnight</Text>
    <View style={[styles.rowLine, styles.report]}>
      <Text style={styles.sectionLabel}>Usage report · whole team · this week</Text>
      <Text style={styles.big}>about $142</Text>
      <View style={styles.topics}>
        {TOPICS.map(t => <Chip key={t.name} text={`${t.name} ${t.share}%`} tone="muted" />)}
      </View>
    </View>
  </Frame>;
}

function DataVisual() {
  const styles = useStyles();
  const box = (title: string, detail: string) => <View style={styles.box}>
    <Text style={styles.rowTitle}>{title}</Text>
    <Text style={styles.rowMeta}>{detail}</Text>
  </View>;
  return <Frame label="your device sends messages over an encrypted connection to the team's server, which stores them, and sends what you ask the AI to the AI provider to answer it. During the pilot, keep taxpayer and personal data out">
    {box("You", "Phone or computer")}
    <Text style={styles.arrow}>↓  encrypted connection</Text>
    {box("Team server", "Stores messages and files. Owners can see them")}
    <Text style={styles.arrow}>↓  only what you ask the AI</Text>
    {box("AI provider", "Reads your question to write the answer")}
    <View style={styles.caution}><Text style={styles.cautionText}>Pilot: keep taxpayer and personal data out</Text></View>
  </Frame>;
}

function TimeVisual() {
  const styles = useStyles();
  return <Frame label="you ask the AI to file a bug report from a conversation and it files it, instead of you filling in forms or typing commands">
    <Mine text="File a bug report from this thread" />
    <Reply text="Done. Bug #412 is filed for the team." />
    <View style={styles.instead}>
      <Text style={styles.rowMeta}>Instead of</Text>
      {["Filling in forms", "Typing commands", "Learning new tools"].map(t => <Text key={t} style={styles.struck}>{t}</Text>)}
    </View>
  </Frame>;
}

const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  kicker: { ...typography.label, color: colors.brandText, textTransform: "uppercase", letterSpacing: 0.6 },
  title: { ...typography.display, color: colors.ink, marginTop: space.xxs },
  lead: { ...typography.body, color: colors.muted, marginTop: space.sm },
  visual: { marginTop: space.lg },
  frame: { padding: space.md, paddingTop: space.lg, borderRadius: radius.lg, backgroundColor: colors.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, gap: space.xs },
  example: { position: "absolute", top: space.xs, right: space.sm, ...typography.meta, color: colors.muted },
  sectionLabel: { ...typography.label, color: colors.muted },
  rowLine: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  rowTitle: { ...typography.bodyStrong, color: colors.ink },
  rowMeta: { ...typography.meta, color: colors.muted },
  chip: { paddingHorizontal: space.xs, paddingVertical: 2, borderRadius: radius.pill, backgroundColor: colors.subtle },
  chipBlue: { backgroundColor: colors.blueSoft },
  chipText: { ...typography.meta, color: colors.muted, fontWeight: "600" },
  chipTextBlue: { color: colors.brandText },
  mine: { alignSelf: "flex-end", maxWidth: "85%", backgroundColor: colors.bubbleMine, borderRadius: radius.lg, borderBottomRightRadius: radius.sm, paddingHorizontal: space.sm, paddingVertical: space.xs },
  mineText: { ...typography.body, color: colors.onPrimary },
  reply: { alignSelf: "flex-start", maxWidth: "90%", backgroundColor: colors.background, borderRadius: radius.lg, borderBottomLeftRadius: radius.sm, paddingHorizontal: space.sm, paddingVertical: space.xs, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line },
  replyName: { ...typography.label, color: colors.brandText },
  replyText: { ...typography.body, color: colors.ink },
  approval: { padding: space.sm, gap: space.xs, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.background },
  approvalText: { ...typography.body, color: colors.ink },
  command: { paddingHorizontal: space.xs, paddingVertical: 4, borderRadius: radius.sm, backgroundColor: colors.subtle },
  commandText: { ...typography.meta, color: colors.muted, fontFamily: mono },
  approvalActions: { flexDirection: "row", gap: space.xs },
  fakeButton: { flex: 1, minHeight: 36, borderRadius: radius.md, alignItems: "center", justifyContent: "center" },
  fakeSecondary: { borderWidth: 1, borderColor: colors.borderStrong },
  fakePrimary: { backgroundColor: colors.primary },
  fakeSecondaryText: { ...typography.label, color: colors.ink },
  fakePrimaryText: { ...typography.label, color: colors.onPrimary },
  working: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  stop: { paddingHorizontal: space.sm, paddingVertical: 4, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.borderStrong },
  stopText: { ...typography.label, color: colors.ink },
  level: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingVertical: space.xs, paddingHorizontal: space.xs, borderRadius: radius.sm },
  levelYou: { backgroundColor: colors.blueSoft, borderTopColor: "transparent" },
  levelHead: { flexDirection: "row", alignItems: "center", gap: space.xs, flexWrap: "wrap" },
  limit: { ...typography.captionStrong, color: colors.ink, fontVariant: ["tabular-nums"] },
  meterHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "baseline" },
  track: { height: 10, borderRadius: radius.pill, backgroundColor: colors.line, overflow: "hidden" },
  fill: { height: "100%", borderRadius: radius.pill, backgroundColor: colors.blue },
  report: { marginTop: space.xs, paddingTop: space.sm, gap: space.xxs },
  big: { ...typography.title, color: colors.ink },
  topics: { flexDirection: "row", flexWrap: "wrap", gap: space.xs, marginTop: space.xxs },
  box: { padding: space.sm, borderRadius: radius.md, backgroundColor: colors.background, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line },
  arrow: { ...typography.meta, color: colors.muted, paddingLeft: space.sm },
  caution: { marginTop: space.xs, padding: space.sm, borderRadius: radius.md, backgroundColor: colors.subtle, borderLeftWidth: 3, borderLeftColor: colors.gold },
  cautionText: { ...typography.captionStrong, color: colors.ink },
  instead: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm, marginTop: space.xs },
  struck: { ...typography.captionStrong, color: colors.muted, textDecorationLine: "line-through" },
  own: { marginTop: space.md, padding: space.sm, borderRadius: radius.md, backgroundColor: colors.blueSoft },
  ownText: { ...typography.bodyStrong, color: colors.ink },
  points: { marginTop: space.lg, gap: space.sm },
  point: { flexDirection: "row", gap: space.sm, alignItems: "flex-start" },
  tick: { width: 22, height: 22, borderRadius: 11, backgroundColor: colors.blueSoft, alignItems: "center", justifyContent: "center", marginTop: 1 },
  tickMark: { color: colors.brandText, fontSize: 13, fontWeight: "700", lineHeight: 16 },
  pointText: { ...typography.body, color: colors.ink, flex: 1 },
  dots: { flexDirection: "row", gap: space.xs, justifyContent: "center", marginTop: space.lg },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.line },
  dotOn: { width: 24, backgroundColor: colors.blue },
}));
