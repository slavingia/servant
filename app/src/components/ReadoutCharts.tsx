import { memo, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import Svg, { Circle, Line, Rect } from "react-native-svg";
import type { QuestionSummary } from "../lib/readout-answers";
import { confidenceText, formatSeconds, isSmallGroup, MIN_COMPARE, percent, points, SMALL_GROUP_MIN, type ActivityResult } from "../lib/readout";
import { createThemedStyles, radius, space, typography, useTheme } from "../lib/theme";

// Dot-and-range charts for a study readout. Each row's words are ordinary text
// (read by screen readers and copied with the page); the drawn mark beside them
// repeats those numbers, so it's hidden from assistive technology.

function Track({ value, lo, hi, min, max, zero }: { value: number; lo: number | null; hi: number | null; min: number; max: number; zero?: number }) {
  const { colors } = useTheme();
  const [width, setWidth] = useState(0);
  const h = 24, pad = 8;
  const x = (v: number) => pad + (Math.min(max, Math.max(min, v)) - min) / (max - min) * (width - 2 * pad);
  return <View onLayout={event => setWidth(event.nativeEvent.layout.width)} style={{ height: h }} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" aria-hidden>
    {width > 0 ? <Svg width={width} height={h}>
      <Line x1={pad} x2={width - pad} y1={h / 2} y2={h / 2} stroke={colors.line} strokeWidth={2} />
      {zero !== undefined ? <Line x1={x(zero)} x2={x(zero)} y1={2} y2={h - 2} stroke={colors.borderStrong} strokeWidth={1.25} strokeDasharray="3 3" /> : null}
      {lo != null && hi != null ? <>
        <Line x1={x(lo)} x2={x(hi)} y1={h / 2} y2={h / 2} stroke={colors.blueDark} strokeWidth={2} />
        <Line x1={x(lo)} x2={x(lo)} y1={h / 2 - 6} y2={h / 2 + 6} stroke={colors.blueDark} strokeWidth={2} />
        <Line x1={x(hi)} x2={x(hi)} y1={h / 2 - 6} y2={h / 2 + 6} stroke={colors.blueDark} strokeWidth={2} />
      </> : null}
      <Circle cx={x(value)} cy={h / 2} r={6} fill={colors.blue} />
    </Svg> : null}
  </View>;
}

function Axis({ labels }: { labels: string[] }) {
  const styles = useStyles();
  return <View style={styles.axis} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" aria-hidden>
    {labels.map((label, i) => <Text key={i} style={styles.axisLabel}>{label}</Text>)}
  </View>;
}

// Memoized: the readout's text changes on every keystroke, its results don't.
/** Each design's main measure, out of everyone assigned, with its 95% range. */
function RatesChartBase({ activity }: { activity: ActivityResult }) {
  const styles = useStyles();
  const what = activity.hasSignal ? "Task success" : "Said they completed the task";
  return <View style={styles.chart}>
    <Text accessibilityRole="header" style={styles.chartTitle}>{what}, everyone assigned</Text>
    {activity.designs.map(d => <View key={d.id} style={styles.row}>
      <View style={styles.rowHead}>
        <Text style={styles.rowName} numberOfLines={2}>{d.letter} · {d.label}</Text>
        <Text style={styles.rowValue}>{d.primary ? percent(d.primary.p) : "—"}</Text>
      </View>
      {d.primary ? <Track value={d.primary.p} lo={d.primary.lo} hi={d.primary.hi} min={0} max={1} /> : null}
      <Text style={styles.rowDetail}>{d.primary
        ? `${d.primary.k} of ${d.primary.n} assigned · 95% range ${percent(d.primary.lo)} to ${percent(d.primary.hi)}${isSmallGroup(d) ? ` · fewer than ${SMALL_GROUP_MIN} people, so hidden in what you share` : ""}`
        : "No one assigned"}</Text>
    </View>)}
    <Axis labels={["0%", "50%", "100%"]} />
  </View>;
}

/** Each design compared with A, in percentage points, with its range; the dashed line is no difference. */
function DifferenceChartBase({ activity }: { activity: ActivityResult }) {
  const styles = useStyles();
  if (!activity.comparisons.length) return null;
  const extent = Math.max(0.1, ...activity.comparisons.flatMap(c => c.enough && c.primary ? [Math.abs(c.primary.d), Math.abs(c.primary.lo ?? 0), Math.abs(c.primary.hi ?? 0)] : []));
  const max = Math.ceil(extent * 10) / 10;
  return <View style={styles.chart}>
    <Text accessibilityRole="header" style={styles.chartTitle}>Compared with A, in percentage points</Text>
    {activity.comparisons.map(c => {
      const d = activity.designs.find(x => x.id === c.designId)!;
      const readable = c.enough && c.primary && c.primary.lo != null && c.primary.hi != null;
      return <View key={c.designId} style={styles.row}>
        <View style={styles.rowHead}>
          <Text style={styles.rowName} numberOfLines={2}>{c.letter} · {d.label}</Text>
          <Text style={styles.rowValue}>{readable ? points(c.primary!.d) : "—"}</Text>
        </View>
        {readable ? <Track value={c.primary!.d} lo={c.primary!.lo} hi={c.primary!.hi} min={-max} max={max} zero={0} /> : null}
        <Text style={styles.rowDetail}>{!c.enough
          ? `Too early to compare: fewer than ${MIN_COMPARE} people in a design.`
          : readable
            ? `${confidenceText(activity.confidence)} range ${points(c.primary!.lo!)} to ${points(c.primary!.hi!)} points · ${c.primary!.lo! > 0 || c.primary!.hi! < 0 ? "the range excludes zero" : "the range includes zero"}`
            : "Too few results to compare."}</Text>
      </View>;
    })}
    <Axis labels={[points(-max), "0", points(max)]} />
  </View>;
}

/** Each design's median active time (people who finished), with its 95% range. A secondary measure. */
function TimesChartBase({ activity }: { activity: ActivityResult }) {
  const styles = useStyles();
  const timed = activity.designs.filter(d => d.time);
  if (!timed.length) return null;
  const top = Math.max(...timed.map(d => Math.max(d.time!.m, d.time!.hi ?? 0)));
  const step = top > 300 ? 60 : top > 60 ? 30 : 10;
  const max = Math.max(step, Math.ceil(top / step) * step);
  return <View style={styles.chart}>
    <Text accessibilityRole="header" style={styles.chartTitle}>Median active time, people who finished (secondary)</Text>
    {activity.designs.map(d => <View key={d.id} style={styles.row}>
      <View style={styles.rowHead}>
        <Text style={styles.rowName} numberOfLines={2}>{d.letter} · {d.label}</Text>
        <Text style={styles.rowValue}>{d.time ? formatSeconds(d.time.m) : "—"}</Text>
      </View>
      {d.time ? <Track value={d.time.m} lo={d.time.lo} hi={d.time.hi} min={0} max={max} /> : null}
      <Text style={styles.rowDetail}>{!d.time
        ? "No times recorded"
        : `${d.time.n} ${d.time.n === 1 ? "person" : "people"} · ${d.time.lo != null && d.time.hi != null ? `95% range ${formatSeconds(d.time.lo)} to ${formatSeconds(d.time.hi)}` : "too few for a range"}${isSmallGroup(d) ? " · hidden in what you share" : ""}`}</Text>
    </View>)}
    <Axis labels={["0 s", formatSeconds(max / 2), formatSeconds(max)]} />
  </View>;
}

/** How many gave each rating, as one bar per design, darker toward the top of the scale. */
function Distribution({ counts }: { counts: number[] }) {
  const { colors } = useTheme();
  const [width, setWidth] = useState(0);
  const total = counts.reduce((s, n) => s + n, 0);
  const h = 14;
  // Where each segment starts: the share of everyone with a lower rating.
  const starts = counts.map((_, i) => counts.slice(0, i).reduce((s, n) => s + n, 0) / Math.max(1, total) * width);
  return <View onLayout={event => setWidth(event.nativeEvent.layout.width)} style={{ height: h }} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" aria-hidden>
    {width > 0 && total > 0 ? <Svg width={width} height={h}>
      {counts.map((n, i) => {
        const w = n / total * width;
        return n ? <Rect key={i} x={starts[i]} y={0} width={Math.max(0, w - 1)} height={h} rx={2} fill={colors.blue} fillOpacity={0.18 + 0.82 * (i / Math.max(1, counts.length - 1))} /> : null;
      })}
    </Svg> : null}
  </View>;
}

/** A rating or choice question's answers per design: the median and how many gave each rating, or how many chose each option. */
function QuestionChartBase({ question, hiddenIds }: { question: QuestionSummary; hiddenIds: string[] }) {
  const styles = useStyles();
  const scale = question.kind === "scale";
  const key = scale ? `${question.lowLabel || question.highLabel ? `1 = ${question.lowLabel || "lowest"}, ${question.choices.length} = ${question.highLabel || "highest"}` : `Rated 1 to ${question.choices.length}`}. Each bar runs from the lowest ratings (lightest) to the highest (darkest).` : question.multiple ? "People could choose more than one." : "";
  return <View style={styles.chart}>
    <Text accessibilityRole="header" style={styles.chartTitle}>{question.text}</Text>
    {key ? <Text style={styles.rowDetail}>{key}</Text> : null}
    {question.designs.map(d => <View key={d.id} style={styles.row}>
      <View style={styles.rowHead}>
        <Text style={styles.rowName} numberOfLines={2}>{d.letter} · {d.label}</Text>
        <Text style={styles.rowValue}>{scale ? d.median == null ? "—" : `Median ${Number.isInteger(d.median) ? d.median : d.median.toFixed(1)}` : `${d.n} ${d.n === 1 ? "person" : "people"}`}</Text>
      </View>
      {scale && d.n ? <Distribution counts={d.counts} /> : null}
      <Text style={styles.rowDetail}>{d.n
        ? `${scale ? `${d.n} ${d.n === 1 ? "person" : "people"} · ` : ""}${question.choices.map((c, i) => `${c}: ${d.counts[i]}`).join(" · ")}${hiddenIds.includes(d.id) ? " · hidden in what you share" : ""}`
        : "No answers"}</Text>
    </View>)}
  </View>;
}

const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  chart: { gap: space.sm, padding: space.md, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, backgroundColor: colors.background },
  chartTitle: { ...typography.captionStrong, color: colors.ink },
  row: { gap: 2 },
  rowHead: { flexDirection: "row", alignItems: "baseline", gap: space.sm },
  rowName: { ...typography.caption, color: colors.ink, flex: 1 },
  rowValue: { ...typography.bodyStrong, color: colors.ink },
  rowDetail: { ...typography.meta, color: colors.muted },
  axis: { flexDirection: "row", justifyContent: "space-between", paddingHorizontal: 2 },
  axisLabel: { ...typography.meta, color: colors.muted },
}));

export const RatesChart = memo(RatesChartBase);
export const DifferenceChart = memo(DifferenceChartBase);
export const TimesChart = memo(TimesChartBase);
export const QuestionChart = memo(QuestionChartBase);
