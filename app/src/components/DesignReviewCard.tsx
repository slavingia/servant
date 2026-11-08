import { Linking, Platform, StyleSheet, Text, View } from "react-native";
import { router } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { Button } from "./Button";
import { DesignThumbnail } from "./DesignThumbnail";
import { parseDesignReview, parseSuggestion, prototypePageUrl, readableLine } from "../lib/prototype-adjustments";
import { createThemedStyles, radius, space, typography } from "../lib/theme";

/** Which card, if any, a message shows as: a design review from this server, or a reviewer's suggestion. */
export function designCardKind(text: string, origin: string | null | undefined): "review" | "suggestion" | null {
  const review = parseDesignReview(text);
  if (review && prototypePageUrl(review.preview, origin)) return "review";
  return parseSuggestion(text) ? "suggestion" : null;
}

/**
 * A design-review message (designReviewText) shown as a card in place of its
 * text: a picture of the page, its status and focus, Open preview, and on web
 * and the Mac app, adjustments. The message itself is unchanged, so older apps
 * still show the text and link.
 */
export function DesignReviewCard({ text, origin, conv, root, ownDesign, inChannel }: { text: string; origin: string | null | undefined; conv: string; root: string; ownDesign?: string | null; inChannel?: boolean }) {
  const styles = useStyles();
  const review = parseDesignReview(text);
  const page = review ? prototypePageUrl(review.preview, origin) : null;
  if (!review || !page) return null;
  const web = Platform.OS === "web";
  const open = () => { if (web) void Linking.openURL(page); else void WebBrowser.openBrowserAsync(page); };
  return <View style={styles.card} accessibilityLabel={`Design review: ${review.title}`}>
    <DesignThumbnail url={page} origin={origin} width={96} height={112} />
    <View style={styles.copy}>
      <Text style={styles.kicker}>Design review</Text>
      <Text style={styles.title} numberOfLines={2}>{review.title}</Text>
      {review.focus ? <Text style={styles.body}><Text style={styles.strong}>Focus: </Text>{review.focus}</Text> : null}
      <View style={styles.row}>
        <Button label="Open preview" kind="secondary" compact onPress={open} accessibilityHint="Opens the live page" />
        {web ? ownDesign
          ? <Button label="Adjust design" kind="secondary" compact onPress={() => router.push({ pathname: "/adjust", params: { chat: ownDesign } })}
            accessibilityHint="Change text, styles and layout on the preview, then add them to your design chat" />
          : <Button label="Suggest adjustments" kind="secondary" compact onPress={() => router.push({ pathname: "/adjust", params: { conv, root, ...(inChannel ? {} : { from: "thread" }) } })}
            accessibilityHint="Change text, styles and layout on the preview, then post them in this thread for the author" />
          : null}
      </View>
      {inChannel ? <Text style={styles.meta}>Reply in the thread with feedback.</Text> : null}
    </View>
  </View>;
}

/**
 * A reviewer's suggestion (suggestionText) shown as a card in place of its text:
 * each change in plain words, without the CSS paths the agent needs. The author
 * can add it to their design chat, unsent.
 */
export function SuggestionCard({ text, onAdd }: { text: string; onAdd?: () => void }) {
  const styles = useStyles();
  const suggestion = parseSuggestion(text);
  if (!suggestion) return null;
  return <View style={styles.card} accessibilityLabel={`Suggested adjustments for ${suggestion.title}`}>
    <View style={styles.copy}>
      <Text style={styles.kicker}>Suggested adjustments</Text>
      <View accessibilityRole="list" style={styles.list}>
        {suggestion.changes.map((line, index) => <Text key={index} style={styles.body}>• {readableLine(line)}</Text>)}
      </View>
      {suggestion.note ? <Text style={styles.body}><Text style={styles.strong}>Reviewer's note: </Text>{suggestion.note}</Text> : null}
      {onAdd ? <View style={styles.row}>
        <Button label="Add to design chat" kind="secondary" compact onPress={onAdd}
          accessibilityHint="Adds these to your design chat's message box, to review and send" />
      </View> : <Text style={styles.meta}>Only the design's author can add these to their design chat.</Text>}
    </View>
  </View>;
}

const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  card: { flexDirection: "row", flexWrap: "wrap", gap: space.sm, marginTop: space.xs, padding: space.sm, borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, backgroundColor: colors.surface, maxWidth: 560 },
  copy: { flex: 1, minWidth: 180, gap: space.xxs },
  kicker: { ...typography.label, color: colors.muted },
  title: { ...typography.bodyStrong, color: colors.ink },
  body: { ...typography.caption, color: colors.ink },
  strong: { fontWeight: "600" },
  meta: { ...typography.meta, color: colors.muted, marginTop: space.xxs },
  list: { gap: 2 },
  row: { flexDirection: "row", flexWrap: "wrap", gap: space.xs, marginTop: space.xxs },
}));
