import { StyleSheet, Text, View } from "react-native";
import { AGENT_LEVELS, FEATURE_EXAMPLE, capText, dailyLimitText, type Benefit } from "../lib/onboarding-benefits";
import { createThemedStyles, radius, space, typography } from "../lib/theme";

// One page of the "Why Servant" tour: a small picture of the feature, drawn
// with the app's own pieces so it follows light and dark mode, then the words.
// Each picture is one image to screen readers, with a label saying what it
// shows; the page's title and points carry the meaning.

export function BenefitPage({ benefit, agentTier, isOwner, split = false, actions }: { benefit: Benefit; agentTier: number | null | undefined; isOwner: boolean; split?: boolean; actions?: React.ReactNode }) {
  const styles = useStyles();
  const own = benefit.id === "cost" ? dailyLimitText(agentTier, isOwner) : null;
  const visual = benefit.id === "charge" ? <ChargeVisual />
    : benefit.id === "example" ? <ExampleVisual />
    : benefit.id === "access" ? <AccessVisual agentTier={isOwner ? 3 : agentTier} />
    : benefit.id === "cost" ? <CostVisual />
    : benefit.id === "data" ? <DataVisual />
    : <EvidenceVisual />;
  const words = <>
    <Text style={styles.kicker}>{benefit.kicker}</Text>
    <Text accessibilityRole="header" style={[styles.title, split && styles.titleSplit]}>{benefit.title}</Text>
    <Text style={[styles.lead, split && styles.leadSplit]}>{benefit.lead}</Text>
  </>;
  const details = <>
    {own ? <View style={styles.own}><Text style={styles.ownText}>{own}</Text></View> : null}
    <View style={[styles.points, split && styles.pointsSplit]}>
      {benefit.points.map(point => <View key={point} style={styles.point}>
        <View style={styles.tick}><Text style={styles.tickMark}>✓</Text></View>
        <Text style={[styles.pointText, split && styles.pointTextSplit]}>{point}</Text>
      </View>)}
    </View>
  </>;
  // Laptop browsers: the words and buttons on the left, the example on a
  // panel to the right, so a page fits on one screen without scrolling.
  if (split) return <View style={styles.split}>
    <View style={styles.splitWords}>{words}{details}{actions}</View>
    <View style={styles.stage}><View style={styles.stageInner}>{visual}</View></View>
  </View>;
  return <View>
    {words}
    <View style={styles.visual}>{visual}</View>
    {details}
    {actions}
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
  return <Frame label="a designer asks for a refund status prototype, the AI builds it, then asks for approval before publishing it for team review, with a Stop button while it works">
    <Mine text="Build a prototype of the refund status page" />
    <Reply text="Done: a working prototype, ready for your review." />
    <View style={styles.approval}>
      <Text style={styles.rowTitle}>Your approval is needed</Text>
      <Text style={styles.approvalText}>Publish the prototype so the team can review it?</Text>
      <Text style={styles.rowMeta}>It shows the exact steps before anything runs.</Text>
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

function ExampleVisual() {
  const styles = useStyles();
  const { ask, steps, total, note } = FEATURE_EXAMPLE;
  return <Frame label={`${ask}. ${steps.map(s => `${s.step}: ${s.today} today, ${s.servant} with Servant`).join("; ")}. In all, ${total.today} today, ${total.servant} with Servant. ${note}`}>
    <Text style={styles.rowTitle}>{ask}</Text>
    <View style={[styles.tlRow, styles.tlHead]}>
      <Text style={[styles.sectionLabel, styles.tlStep]}>Step</Text>
      <Text style={[styles.sectionLabel, styles.tlTime]}>Today</Text>
      <Text style={[styles.sectionLabel, styles.tlTime, styles.tlFast]}>With Servant</Text>
    </View>
    {steps.map(s => {
      const faster = s.servant !== s.today;
      return <View key={s.step} style={[styles.tlRow, styles.rowLine]}>
        <View style={styles.tlStep}>
          <Text style={styles.tlName}>{s.step}</Text>
          {"how" in s && s.how ? <Text style={styles.rowMeta}>{s.how}</Text> : null}
        </View>
        <Text style={[styles.tlValue, styles.tlTime]}>{s.today}</Text>
        <Text style={[styles.tlValue, styles.tlTime, faster ? styles.tlFaster : styles.tlSame]}>{s.servant}</Text>
      </View>;
    })}
    <View style={[styles.tlRow, styles.tlTotal]}>
      <Text style={[styles.rowTitle, styles.tlStep]}>In all</Text>
      <Text style={[styles.rowTitle, styles.tlTime]}>{total.today}</Text>
      <Text style={[styles.rowTitle, styles.tlTime, styles.tlFaster]}>{total.servant}</Text>
    </View>
    <Text style={styles.rowMeta}>{note}</Text>
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
  return <Frame label="your IRS laptop sends messages over an encrypted connection to the team's server, which stores them, and sends what you ask the AI to Treasury Claude Code to answer it. The AI can reach only approved IRS GitHub repositories">
    {box("You", "IRS laptop")}
    <Text style={styles.arrow}>↓  encrypted connection</Text>
    {box("Team server", "Stores messages and files. Owners can see them")}
    <Text style={styles.arrow}>↓  only what you ask the AI</Text>
    {box("Treasury Claude Code", "Reads your question to write the answer")}
    <View style={styles.caution}><Text style={styles.cautionText}>The AI can reach only approved IRS GitHub repositories</Text></View>
  </Frame>;
}

// Research Hub: ask what past studies found, with each finding's source, before commissioning new work.
const SOURCES = ["Refund tracker usability test, 2024", "Call reasons survey, 2025", "Status page interviews, 2025"];

function EvidenceVisual() {
  const styles = useStyles();
  return <Frame label={`you ask what past research says about why people call about their refund. The answer cites three past studies, ${SOURCES.join(", ")}, and names a gap: no research yet with Spanish-speaking taxpayers`}>
    <Mine text="What do we already know about why people call about their refund?" />
    <Reply text="Three past studies agree: people can’t tell whether their refund was sent." />
    <View style={styles.sources}>
      <Text style={styles.sectionLabel}>Sources</Text>
      {SOURCES.map((source, i) => <View key={source} style={styles.source}>
        <Text style={styles.sourceNum}>{i + 1}</Text>
        <Text style={[styles.rowMeta, styles.sourceText]}>{source}</Text>
      </View>)}
    </View>
    <View style={styles.caution}><Text style={styles.cautionText}>Gap: no research yet with Spanish-speaking taxpayers</Text></View>
    <View style={styles.instead}>
      <Text style={styles.rowMeta}>Instead of</Text>
      {["Repeating old studies", "Searching shared drives"].map(t => <Text key={t} style={styles.struck}>{t}</Text>)}
    </View>
  </Frame>;
}

const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  kicker: { ...typography.label, color: colors.brandText, textTransform: "uppercase", letterSpacing: 0.6 },
  title: { ...typography.display, color: colors.ink, marginTop: space.xxs },
  lead: { ...typography.body, color: colors.muted, marginTop: space.sm },
  visual: { marginTop: space.lg },
  titleSplit: { fontSize: 40, lineHeight: 46, letterSpacing: -0.8, marginTop: space.xs },
  leadSplit: { fontSize: 18, lineHeight: 27, marginTop: space.md },
  pointsSplit: { marginTop: space.xl, gap: space.md },
  pointTextSplit: { fontSize: 16, lineHeight: 24 },
  split: { flexDirection: "row", alignItems: "center", gap: 64 },
  splitWords: { flex: 1, maxWidth: 440 },
  stage: { flex: 1.25, minHeight: 540, borderRadius: radius.xl, backgroundColor: colors.blueSoft, padding: space.xl, alignItems: "center", justifyContent: "center" },
  stageInner: { width: "100%", maxWidth: 480 },
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
  tlRow: { flexDirection: "row", alignItems: "flex-start", gap: space.xs, paddingVertical: 6 },
  tlHead: { marginTop: space.xs, paddingBottom: 2 },
  tlStep: { flex: 1 },
  tlTime: { width: 90, textAlign: "right" },
  tlFast: { color: colors.brandText },
  tlName: { ...typography.captionStrong, color: colors.ink },
  tlValue: { ...typography.caption, color: colors.muted, fontVariant: ["tabular-nums"] },
  tlFaster: { color: colors.brandText, fontWeight: "700" },
  tlSame: { color: colors.muted },
  tlTotal: { borderTopWidth: 2, borderTopColor: colors.ink, marginTop: 2, paddingTop: space.xs },
  sources: { gap: space.xxs, marginTop: space.xxs },
  source: { flexDirection: "row", gap: space.xs, alignItems: "flex-start" },
  sourceNum: { ...typography.meta, fontWeight: "700", color: colors.brandText, width: 12 },
  sourceText: { flex: 1, color: colors.ink },
  instead: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm, marginTop: space.xs },
  struck: { ...typography.captionStrong, color: colors.muted, textDecorationLine: "line-through" },
  own: { marginTop: space.md, padding: space.sm, borderRadius: radius.md, backgroundColor: colors.blueSoft },
  ownText: { ...typography.bodyStrong, color: colors.ink },
  points: { marginTop: space.lg, gap: space.sm },
  point: { flexDirection: "row", gap: space.sm, alignItems: "flex-start" },
  tick: { width: 22, height: 22, borderRadius: 11, backgroundColor: colors.blueSoft, alignItems: "center", justifyContent: "center", marginTop: 1 },
  tickMark: { color: colors.brandText, fontSize: 13, fontWeight: "700", lineHeight: 16 },
  pointText: { ...typography.body, color: colors.ink, flex: 1 },
}));
