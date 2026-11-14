import { StyleSheet, Text, View } from "react-native";
import type { TourVisual } from "../lib/role-tour";
import { createThemedStyles, radius, space, typography } from "../lib/theme";
import { Frame, Mine, Reply } from "./OnboardingBenefits";

// Small drawn examples of each feature, in the app's own colors. Invented
// content only: no real study, design, person or taxpayer. Each is one image
// to screen readers (Frame), described by its label.

type Tone = "muted" | "blue" | "good" | "warn";

function Tag({ text, tone = "muted" }: { text: string; tone?: Tone }) {
  const styles = useStyles();
  return <View style={[styles.tag, styles[`tag_${tone}`]]}><Text style={[styles.tagText, styles[`tagText_${tone}`]]}>{text}</Text></View>;
}

function FakeButton({ label, primary }: { label: string; primary?: boolean }) {
  const styles = useStyles();
  return <View style={[styles.fake, primary ? styles.fakePrimary : styles.fakeSecondary]}>
    <Text style={primary ? styles.fakePrimaryText : styles.fakeSecondaryText}>{label}</Text>
  </View>;
}

function MiniPage({ children }: { children: React.ReactNode }) {
  const styles = useStyles();
  return <View style={styles.page}>
    <View style={styles.pageBar}>{[0, 1, 2].map(i => <View key={i} style={styles.pageDot} />)}</View>
    <View style={styles.pageBody}>{children}</View>
  </View>;
}

const LABELS: Record<TourVisual, string> = {
  study: "a tree test study with two activities and a Preview as participant button",
  synthesis: "three themes drawn from interviews and survey comments, with sources and one evidence gap",
  prototype: "you describe a refund status page and get a live preview of it",
  "design-review": "a design review listing what fits research, what conflicts and what to test next",
  accessibility: "the Accessibility tab of Adjust design listing a small tap target, missing alt text and low contrast, with a button to ask the agent to fix them",
  evidence: "you ask what evidence supports a design change and the AI answers with findings, a risk and a next step",
  share: "a design posted in a team channel, with replies and a request for the agent to summarize the feedback",
  "content-draft": "you paste formal notice wording and the AI suggests plainer words",
  "content-review": "a suggested wording change shown on a teammate's design",
  project: "a project release with each stage, its owner and its status",
};

export function RoleTourDemo({ visual }: { visual: TourVisual }) {
  const styles = useStyles();
  const body = (() => {
    switch (visual) {
      case "study": return <>
        <Text style={styles.title}>Records tree test</Text>
        {[["1", "Tree testing", "Find where to check a refund"], ["2", "Survey", "Three follow-up questions"]].map(([n, kind, what]) =>
          <View key={n} style={styles.row}>
            <View style={styles.num}><Text style={styles.numText}>{n}</Text></View>
            <View style={styles.grow}><Text style={styles.strong}>{kind}</Text><Text style={styles.meta}>{what}</Text></View>
          </View>)}
        <FakeButton label="Preview as participant" />
      </>;
      case "synthesis": return <>
        <Text style={styles.meta}>From 12 interviews and 340 survey comments</Text>
        {[["Can't tell if a payment went through", "8 interviews · 120 comments"], ["Notice wording feels like a threat", "5 interviews · 64 comments"]].map(([theme, src]) =>
          <View key={theme} style={styles.theme}><Text style={styles.strong}>{theme}</Text><Text style={styles.meta}>{src}</Text></View>)}
        <View style={[styles.theme, styles.gap]}><Text style={styles.strong}>Gap: no Spanish-speaking participants</Text><Text style={styles.meta}>Say so; don't guess</Text></View>
      </>;
      case "prototype": return <>
        <Mine text="A refund status page with a three-step timeline" />
        <MiniPage>
          <View style={[styles.bar, { width: "55%", height: 8 }]} />
          <View style={styles.timeline}>
            {[true, true, false].map((done, i) => <View key={i} style={styles.stepRow}>
              <View style={[styles.stepDot, done && styles.stepDotOn]} />
              <View style={[styles.bar, { width: `${60 - i * 12}%` }]} />
            </View>)}
          </View>
          <View style={styles.pageButton} />
        </MiniPage>
        <View style={styles.headRow}><Tag text="Live preview" tone="blue" /><Text style={styles.meta}>Share for review</Text></View>
      </>;
      case "design-review": return <>
        <Text style={styles.strong}>Payment plan page · review</Text>
        {([["good", "Fits", "Plain status labels match 2 studies"], ["warn", "Conflicts", "The due date people look for first is hidden"], ["blue", "Test next", "Do people find Next steps?"]] as const).map(([tone, tag, line]) =>
          <View key={tag} style={styles.row}><Tag text={tag} tone={tone} /><Text style={[styles.meta, styles.grow]}>{line}</Text></View>)}
        <Text style={styles.meta}>Cites each source. Never says a design is validated.</Text>
      </>;
      case "accessibility": return <>
        <View style={styles.tabs}>{["Edit", "Changes", "Accessibility"].map(t => <Text key={t} style={[styles.tab, t === "Accessibility" && styles.tabOn]}>{t}</Text>)}</View>
        {[["Button “Go”", "Is smaller than 24 × 24 px, so it's hard to tap."], ["Image", "Has no alt text."], ["Body text", "Contrast 2.9:1, needs 4.5:1"]].map(([what, problem]) =>
          <View key={what} style={styles.finding}><Text style={styles.strong}>{what}</Text><Text style={styles.meta}>{problem}</Text></View>)}
        <FakeButton label="Ask the agent to fix these" primary />
      </>;
      case "evidence": return <>
        <Mine text="What supports moving payment status to the top?" />
        <Reply text="Two studies found people look for status first. Risk: no phone data yet. Next: a first-click test." />
      </>;
      case "share": return <>
        <Text style={styles.channel}># design-reviews</Text>
        <View style={styles.post}>
          <Text style={styles.strong}>Maya O.</Text>
          <Text style={styles.meta}>New refund status page, ready for eyes</Text>
          <View style={styles.card}><View style={styles.thumb} /><View style={styles.grow}><Text style={styles.strong}>Refund status</Text><Text style={styles.meta}>Live preview</Text></View></View>
          <Text style={styles.replies}>4 replies</Text>
        </View>
        <Mine text="@agent sum up the feedback in this thread" />
      </>;
      case "content-draft": return <>
        <Mine text="Plainer, please: “Your remittance has been applied to your outstanding liability.”" />
        <Reply text="“We applied your payment to what you owe.”" />
      </>;
      case "content-review": return <>
        <MiniPage>
          <View style={[styles.bar, { width: "40%", height: 8 }]} />
          <View style={styles.suggest}>
            <Text style={styles.old}>Remittance received</Text>
            <Text style={styles.strong}>Payment received</Text>
          </View>
          <View style={[styles.bar, { width: "70%" }]} />
          <View style={[styles.bar, { width: "55%" }]} />
        </MiniPage>
        <View style={styles.headRow}><Tag text="Suggestion" tone="blue" /><Text style={styles.meta}>The author accepts it or not</Text></View>
      </>;
      case "project": return <>
        <View style={styles.headRow}><Text style={styles.title}>Refund tracker · Release 3</Text></View>
        {([["Design", "Maya O.", "Done", "good"], ["Content", "Lena B.", "In progress", "blue"], ["Research", "Sam P.", "Next", "muted"]] as const).map(([stage, who, status, tone]) =>
          <View key={stage} style={styles.row}>
            <View style={styles.grow}><Text style={styles.strong}>{stage}</Text><Text style={styles.meta}>{who}</Text></View>
            <Tag text={status} tone={tone} />
          </View>)}
      </>;
    }
  })();
  return <Frame label={LABELS[visual]}>{body}</Frame>;
}

const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  headRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.xs, flexWrap: "wrap" },
  row: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingVertical: 2 },
  grow: { flex: 1, minWidth: 0 },
  title: { ...typography.bodyStrong, color: colors.ink },
  strong: { ...typography.captionStrong, color: colors.ink },
  meta: { ...typography.meta, color: colors.muted },
  num: { width: 24, height: 24, borderRadius: 12, backgroundColor: colors.blueSoft, alignItems: "center", justifyContent: "center" },
  numText: { ...typography.label, color: colors.brandText },
  tag: { paddingHorizontal: space.xs, paddingVertical: 2, borderRadius: radius.pill },
  tag_muted: { backgroundColor: colors.subtle },
  tag_blue: { backgroundColor: colors.blueSoft },
  tag_good: { backgroundColor: colors.greenSoft },
  tag_warn: { backgroundColor: colors.redSoft },
  tagText: { ...typography.meta, fontWeight: "600" },
  tagText_muted: { color: colors.muted },
  tagText_blue: { color: colors.brandText },
  tagText_good: { color: colors.greenDark },
  tagText_warn: { color: colors.red },
  fake: { minHeight: 36, borderRadius: radius.md, alignItems: "center", justifyContent: "center", marginTop: space.xxs },
  fakePrimary: { backgroundColor: colors.primary },
  fakeSecondary: { borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.background },
  fakePrimaryText: { ...typography.label, color: colors.onPrimary },
  fakeSecondaryText: { ...typography.label, color: colors.ink },
  theme: { padding: space.sm, borderRadius: radius.md, backgroundColor: colors.background, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line },
  gap: { borderLeftWidth: 3, borderLeftColor: colors.gold },
  page: { borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, backgroundColor: colors.background, overflow: "hidden" },
  pageBar: { flexDirection: "row", gap: 4, padding: 6, backgroundColor: colors.subtle },
  pageDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.borderStrong },
  pageBody: { padding: space.sm, gap: space.xs },
  bar: { height: 5, borderRadius: 3, backgroundColor: colors.borderStrong, opacity: 0.45 },
  timeline: { gap: 6, marginTop: 2 },
  stepRow: { flexDirection: "row", alignItems: "center", gap: space.xs },
  stepDot: { width: 10, height: 10, borderRadius: 5, borderWidth: 2, borderColor: colors.borderStrong },
  stepDotOn: { backgroundColor: colors.blue, borderColor: colors.blue },
  pageButton: { width: 72, height: 18, borderRadius: radius.sm, backgroundColor: colors.primary, marginTop: 2 },
  tabs: { flexDirection: "row", gap: space.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line, paddingBottom: space.xxs },
  tab: { ...typography.label, color: colors.muted, paddingBottom: 2 },
  tabOn: { color: colors.brandText, borderBottomWidth: 2, borderBottomColor: colors.blue },
  finding: { paddingVertical: 4, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  channel: { ...typography.captionStrong, color: colors.muted },
  post: { gap: 2 },
  card: { flexDirection: "row", alignItems: "center", gap: space.xs, marginTop: space.xxs, padding: space.xs, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, backgroundColor: colors.background },
  thumb: { width: 36, height: 28, borderRadius: radius.sm, backgroundColor: colors.blueSoft },
  replies: { ...typography.label, color: colors.brandText, marginTop: 2 },
  suggest: { padding: space.xs, borderRadius: radius.sm, backgroundColor: colors.blueSoft, borderLeftWidth: 3, borderLeftColor: colors.blue, gap: 2 },
  old: { ...typography.meta, color: colors.muted, textDecorationLine: "line-through" },
}));
