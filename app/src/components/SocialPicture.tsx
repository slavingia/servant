import { useEffect, useRef, useState } from "react";
import { Image, StyleSheet, Text, TextInput, View } from "react-native";
import { Button, ButtonGroup } from "./Button";
import { pickAttachments } from "./Attachments";
import { shareAttachment } from "./MediaGallery";
import type { Account } from "../lib/server";
import { pictureLine, type SocialReply } from "../lib/social";
import { socialApi } from "../lib/social-api";
import { createThemedStyles, radius, space, typography, useTheme } from "../lib/theme";

const said = (reason: unknown, fallback: string) => reason instanceof Error && reason.message ? reason.message : fallback;

/**
 * The picture a post carries. While the post can still change (`onReply` given) someone can attach one, ask Agent
 * to make one from a few words, or take it off; a new picture needs a new approval, like new words. Anyone can
 * save the picture, to post it by hand where Servant doesn't.
 */
export function SocialPicture({ account, reply, label, onReply }: {
  account: Account; reply: SocialReply;
  /** What the post is, for button labels: "Post" or "Reply to Jo Park (@jopark)". */
  label: string;
  /** The reply after its picture changed. Absent when the post can no longer change. */
  onReply?: (reply: SocialReply) => void;
}) {
  const styles = useStyles();
  const { colors } = useTheme();
  const [shown, setShown] = useState<{ id: string; mime: string; data: string } | null>(null);
  const [busy, setBusy] = useState<"attach" | "make" | "remove" | "save" | null>(null);
  const [asking, setAsking] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState("");
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const imageId = reply.image?.id;
  useEffect(() => {
    if (!imageId) return;
    const stop = new AbortController();
    socialApi.image(account, reply.id, stop.signal)
      .then(file => { if (!stop.signal.aborted) setShown({ id: imageId, mime: file.mime, data: file.data }); })
      .catch(reason => { if (!stop.signal.aborted) setError(said(reason, "Couldn't load the picture. Open Social again.")); });
    return () => stop.abort();
  }, [account, reply.id, imageId]);

  const run = async (what: NonNullable<typeof busy>, work: () => Promise<void>, failed: string) => {
    if (busy) return;
    setBusy(what); setError("");
    try { await work(); } catch (reason) { if (mounted.current) setError(said(reason, failed)); } finally { if (mounted.current) setBusy(null); }
  };
  const attach = () => run("attach", async () => {
    const [file] = await pickAttachments(true, [], { limit: 1, imagesOnly: true });
    if (!file) return;
    onReply?.((await socialApi.attachImage(account, reply.id, { name: file.name, data: file.data })).reply);
  }, "Couldn't attach that picture. Try again.");
  const make = () => run("make", async () => {
    const next = (await socialApi.makeImage(account, reply.id, prompt.trim())).reply;
    if (mounted.current) { setAsking(false); setPrompt(""); }
    onReply?.(next);
  }, "Agent couldn't make a picture. Try again, or attach one.");

  const image = reply.image;
  const loaded = image && shown?.id === image.id ? shown : null;
  return <View testID={`social-picture-${reply.id}`} style={styles.root}>
    {image ? <>
      {loaded
        ? <Image testID={`social-image-${reply.id}`} accessibilityLabel={image.byAgent && image.prompt ? `Picture for this post, made by Agent: ${image.prompt}` : `Picture for this post: ${image.name}`} source={{ uri: `data:${loaded.mime};base64,${loaded.data}` }} resizeMode="contain" style={styles.image} />
        : <View style={[styles.image, styles.waiting]}><Text style={styles.meta}>{error ? "The picture didn't load." : "Loading the picture…"}</Text></View>}
      <Text style={styles.meta}>{pictureLine(image)}</Text>
    </> : null}
    {asking ? <View style={styles.askRow}>
      <TextInput testID={`social-picture-prompt-${reply.id}`} accessibilityLabel="What the picture should show" placeholder="What should the picture show? For example: a closed sign on an office door, flat illustration" placeholderTextColor={colors.muted}
        value={prompt} onChangeText={setPrompt} maxLength={500} editable={!busy} autoFocus style={styles.ask} />
      <ButtonGroup>
        <Button testID={`social-picture-go-${reply.id}`} label="Ask Agent" compact busy={busy === "make"} disabled={!prompt.trim() || !!busy} onPress={() => void make()} />
        <Button label="Cancel" kind="link" compact disabled={!!busy} onPress={() => { setAsking(false); setPrompt(""); setError(""); }} />
      </ButtonGroup>
      {busy === "make" ? <Text style={styles.meta}>Agent is making the picture. This can take a minute.</Text> : null}
    </View> : <ButtonGroup>
      {onReply ? <Button testID={`social-picture-add-${reply.id}`} label={image ? "Change picture" : "Add picture"} accessibilityLabel={`${image ? "Change" : "Add"} picture: ${label}`} kind="secondary" compact busy={busy === "attach"} disabled={!!busy} onPress={() => void attach()} /> : null}
      {onReply ? <Button testID={`social-picture-make-${reply.id}`} label="Make a picture" accessibilityLabel={`Ask Agent to make a picture: ${label}`} kind="secondary" compact disabled={!!busy} onPress={() => { setError(""); setAsking(true); }} /> : null}
      {image && loaded ? <Button testID={`social-picture-save-${reply.id}`} label="Save picture" accessibilityLabel={`Save picture: ${label}`} kind="secondary" compact busy={busy === "save"} disabled={!!busy}
        onPress={() => void run("save", () => shareAttachment({ id: image.id, name: image.name, mime: image.mime, size: image.size }, loaded.data), "Couldn't save the picture. Try again.")} /> : null}
      {image && onReply ? <Button testID={`social-picture-remove-${reply.id}`} label="Remove picture" accessibilityLabel={`Remove picture: ${label}`} kind="danger" compact busy={busy === "remove"} disabled={!!busy}
        onPress={() => void run("remove", async () => { onReply((await socialApi.removeImage(account, reply.id)).reply); }, "Couldn't remove the picture. Try again.")} /> : null}
    </ButtonGroup>}
    {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
  </View>;
}

const useStyles = createThemedStyles(({ colors, controls }) => StyleSheet.create({
  root: { gap: space.sm },
  image: { width: "100%", maxWidth: 360, aspectRatio: 1, borderRadius: radius.md, backgroundColor: colors.line },
  waiting: { alignItems: "center", justifyContent: "center" },
  meta: { ...typography.caption, color: colors.muted },
  askRow: { gap: space.sm },
  ask: { ...controls.input },
  error: { ...typography.caption, color: colors.danger },
}));
