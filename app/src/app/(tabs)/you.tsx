import { type ComponentRef, useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import * as ImagePicker from "expo-image-picker";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import { router, useFocusEffect, useLocalSearchParams, useScrollToTop, type Href } from "expo-router";
import { emailConfirmed, takeSuggestedEmail } from "../../lib/email-nudge";
import { api, saveAccount, ServerError } from "../../lib/server";
import { usePhotos } from "../../lib/photos";
import { PageTitle } from "../../components/Band";
import { Button, ButtonGroup } from "../../components/Button";
import { destinationGroups } from "../../lib/destinations";
import { Avatar } from "../../components/Messaging";
import { pickImageOnWeb } from "../../lib/pick-image-web";
import { PhotoCropper, type CropSource } from "../../components/PhotoCropper";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { ServerSwitcher } from "../../components/ServerSwitcher";
import { AppIcon } from "../../components/AppIcon";
import { DeepWorkSwitch } from "../../components/DeepWorkSwitch";
import { useSession } from "../../lib/session";
import { useFeatures } from "../../lib/features";
import { createThemedStyles, useTheme, radius, space, typography, linkUnderline } from "../../lib/theme";

function Row({ label, value, onPress }: { label: string; value?: string; onPress?: () => void }) {
  const { colors } = useTheme();
  const styles = useStyles();
  const content = <>
      <Text style={styles.rowLabel}>{label}</Text>
      {value ? <Text style={styles.rowValue}>{value}</Text> : null}
      {onPress ? <AppIcon name="chevronRight" size={16} color={colors.muted} /> : null}
    </>;
  if (!onPress) return <View style={styles.row}>{content}</View>;
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.subtle }]}>
      {content}
    </Pressable>
  );
}

export default function Settings() {
  // Tapping the tab you're already on scrolls back to the top.
  const scrollRef = useRef<ComponentRef<typeof ScrollView>>(null);
  useScrollToTop(scrollRef);
  const { account, setAccount, signOut, surveyPermissions } = useSession();
  const features = useFeatures();
  const { colors } = useTheme();
  const styles = useStyles();
  const [confirming, setConfirming] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const photos = usePhotos();
  const [photoBusy, setPhotoBusy] = useState(false);
  const [photoMenu, setPhotoMenu] = useState(false);
  const [cropSource, setCropSource] = useState<CropSource | null>(null);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [nameBusy, setNameBusy] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  // Joined before email codes: add your work email so a code can sign you in anywhere.
  // /you?email=1 (the banner) or /you?email=<address> (after claiming an account) opens the form.
  const params = useLocalSearchParams<{ email?: string }>();
  const [emailNeeded, setEmailNeeded] = useState<boolean | null>(null);
  const [emailStep, setEmailStep] = useState<null | "email" | "code">(null);
  const [emailDraft, setEmailDraft] = useState("");
  const [codeDraft, setCodeDraft] = useState("");
  const [challenge, setChallenge] = useState("");
  const [emailBusy, setEmailBusy] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);
  useEffect(() => {
    if (!account) return;
    let live = true;
    api.emailRequired(account).then(v => { if (live) setEmailNeeded(v); }).catch(() => {});
    return () => { live = false; };
  }, [account]);
  useFocusEffect(useCallback(() => {
    if (!params.email || !emailNeeded) return;
    setEmailError(null);
    setEmailStep("email");
    const suggested = params.email.includes("@") ? params.email : takeSuggestedEmail();
    if (suggested) setEmailDraft(suggested);
    router.setParams({ email: "" });
  }, [params.email, emailNeeded]));
  if (!account) return null;
  const owner = account.user.role === "owner";
  const sendEmail = async () => {
    if (emailBusy) return;
    setEmailBusy(true); setEmailError(null);
    try {
      const out = await api.sendMyEmailCode(account, emailDraft.trim());
      setChallenge(out.challenge); setEmailDraft(out.email); setCodeDraft(""); setEmailStep("code");
    } catch (e) { setEmailError(e instanceof ServerError ? e.message : "Couldn't send the code. Try again."); }
    finally { setEmailBusy(false); }
  };
  const confirmEmail = async () => {
    if (emailBusy) return;
    setEmailBusy(true); setEmailError(null);
    try {
      await api.confirmMyEmail(account, challenge, codeDraft.trim());
      setEmailNeeded(false); setEmailStep(null); emailConfirmed();
    } catch (e) { setEmailError(e instanceof ServerError ? e.message : "Couldn't confirm. Try again."); }
    finally { setEmailBusy(false); }
  };

  const hasPhoto = !!photos?.versions[account.user.id];
  // Square, 512px JPEG: small enough for everyone's phone to load quickly.
  const uploadPhoto = async (base64: string) => {
    setPhotoBusy(true);
    try {
      const { person } = await api.setPhoto(account, base64);
      photos?.learn([person]);
    } catch (e) {
      setPhotoError(e instanceof ServerError ? e.message : "Couldn't use that photo. Try another one.");
    } finally {
      setPhotoBusy(false);
    }
  };
  const choosePhoto = async () => {
    if (photoBusy) return;
    setPhotoMenu(false);
    setPhotoError(null);
    // Phones crop in the system picker; the web picker can't, so it gets our own crop dialog.
    let asset: { uri: string; width: number; height: number };
    try {
      if (Platform.OS === "web") {
        const image = await pickImageOnWeb();
        if (!image) return;
        setCropSource(image);
        return;
      }
      const picked = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], allowsEditing: true, aspect: [1, 1], quality: 1 });
      if (picked.canceled || !picked.assets[0]) return;
      asset = picked.assets[0];
    } catch { setPhotoError("Couldn't use that photo. Try a JPEG or PNG."); return; }
    setPhotoBusy(true);
    try {
      const side = Math.min(asset.width, asset.height);
      const context = ImageManipulator.manipulate(asset.uri);
      if (asset.width !== asset.height) context.crop({ originX: (asset.width - side) / 2, originY: (asset.height - side) / 2, width: side, height: side });
      context.resize({ width: 512, height: 512 });
      const image = await (await context.renderAsync()).saveAsync({ format: SaveFormat.JPEG, compress: 0.8, base64: true });
      if (!image.base64) throw new Error("no data");
      const { person } = await api.setPhoto(account, image.base64.replace(/^data:[^,]*,/, ""));
      photos?.learn([person]);
    } catch (e) {
      setPhotoError(e instanceof ServerError ? e.message : "Couldn't use that photo. Try another one.");
    } finally {
      setPhotoBusy(false);
    }
  };
  const removePhoto = async () => {
    setPhotoMenu(false);
    setPhotoError(null);
    setPhotoBusy(true);
    try { photos?.learn([(await api.removePhoto(account)).person]); }
    catch (e) { setPhotoError(e instanceof ServerError ? e.message : "Couldn't remove your photo. Try again."); }
    finally { setPhotoBusy(false); }
  };

  const saveName = async () => {
    if (nameBusy) return;
    const next = nameDraft.replace(/\s+/g, " ").trim();
    if (!next) { setNameError("Enter a name"); return; }
    if (next === account.user.name) { setEditingName(false); return; }
    setNameBusy(true);
    setNameError(null);
    try {
      const { user } = await api.rename(account, next);
      const updated = { ...account, user: { ...account.user, name: user.name } };
      await saveAccount(updated);
      setAccount(updated);
      setEditingName(false);
    } catch (e) {
      setNameError(e instanceof ServerError ? e.message : "Couldn't change your name. Try again.");
    } finally {
      setNameBusy(false);
    }
  };

  const leave = async () => {
    if (leaving) return;
    setLeaving(true);
    setError(null);
    try {
      await signOut();
    } catch {
      setError("Couldn't sign out. Try again.");
    } finally {
      setLeaving(false);
    }
  };

  return (
    <View style={styles.root}>
    <ScrollView ref={scrollRef} style={styles.root} contentContainerStyle={styles.content} contentInsetAdjustmentBehavior="automatic">
      <PageTitle>You</PageTitle>
      {/* The photo and "Change name" are two separate buttons side by side: a button inside a button is invalid on the
          web and lets the outer one swallow the inner for screen-reader users. */}
      <View style={styles.profile}>
        <Pressable testID="profile-photo" accessibilityRole="button" accessibilityLabel={hasPhoto ? "Change your profile photo" : "Add a profile photo"} accessibilityHint="Everyone on this server sees it"
          accessibilityState={{ busy: photoBusy, expanded: hasPhoto ? photoMenu : undefined }} aria-expanded={hasPhoto ? photoMenu : undefined} disabled={photoBusy}
          onPress={() => { if (hasPhoto) setPhotoMenu(open => !open); else void choosePhoto(); }}
          style={({ pressed }) => [pressed && { opacity: 0.7 }]}>
          <Avatar name={account.user.name} userId={account.user.id} size={56} />
          <View style={styles.photoBadge}>{photoBusy ? <ActivityIndicator size="small" color={colors.onPrimary} /> : <AppIcon name={hasPhoto ? "compose" : "plus"} size={12} color={colors.onPrimary} strokeWidth={2.4} />}</View>
        </Pressable>
        <View style={styles.profileCopy}>
          <Text style={styles.profileName}>{account.user.name}</Text>
          <Text style={styles.profileRole}>{account.serverName} · {owner ? "Workspace owner" : "Member"}</Text>
          <View style={styles.linkRow}>
            <Pressable accessibilityRole="button" accessibilityLabel={hasPhoto ? "Change your profile photo" : "Add a profile photo"} disabled={photoBusy} style={styles.linkAction}
              onPress={() => { if (hasPhoto) setPhotoMenu(open => !open); else void choosePhoto(); }}>
              <Text style={styles.photoLink}>{photoBusy ? "Saving photo…" : hasPhoto ? "Change photo" : "Add a photo"}</Text>
            </Pressable>
            <Pressable testID="change-name" accessibilityRole="button" accessibilityLabel="Change your name" style={styles.linkAction} onPress={() => { setNameDraft(account.user.name); setNameError(null); setEditingName(true); }}>
              <Text style={styles.photoLink}>Change name</Text>
            </Pressable>
          </View>
        </View>
      </View>
      {photoMenu && hasPhoto ? <View style={[styles.group, styles.photoMenu]}>
        <Row label="Choose from library" onPress={() => void choosePhoto()} />
        <Pressable accessibilityRole="button" onPress={() => void removePhoto()} style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.subtle }]}>
          <Text style={[styles.rowLabel, { color: colors.red }]}>Remove photo</Text>
        </Pressable>
      </View> : null}
      {photoError ? <Text accessibilityRole="alert" style={styles.photoError}>{photoError}</Text> : null}
      {/* Small forms, like every other: a label, the shared field, then the main action and Cancel. */}
      {editingName ? <View style={[styles.group, styles.nameEditor]}>
        <Text style={styles.fieldLabel}>Your name</Text>
        <TextInput testID="name-input" value={nameDraft} onChangeText={setNameDraft} autoFocus maxLength={40} autoCapitalize="words" autoCorrect={false}
          accessibilityLabel="Your name" returnKeyType="done" onSubmitEditing={() => void saveName()} placeholderTextColor={colors.muted} style={styles.field} />
        {nameError ? <Text accessibilityRole="alert" style={styles.fieldError}>{nameError}</Text> : null}
        <ButtonGroup>
          <Button testID="name-save" label="Save" compact busy={nameBusy} onPress={() => void saveName()} />
          <Button label="Cancel" kind="link" compact disabled={nameBusy} onPress={() => { setEditingName(false); setNameError(null); }} />
        </ButtonGroup>
      </View> : null}
      {emailNeeded ? <View style={[styles.group, styles.nameEditor]}>
        {emailStep === null ? <ButtonGroup>
          <Button testID="confirm-email" label="Add your work email" kind="secondary" compact onPress={() => { setEmailError(null); setEmailDraft(d => d || takeSuggestedEmail()); setEmailStep("email"); }} />
        </ButtonGroup> : emailStep === "email" ? <>
          <Text style={styles.fieldLabel}>Work email</Text>
          <TextInput testID="email-input" value={emailDraft} onChangeText={setEmailDraft} autoFocus autoCapitalize="none" autoCorrect={false} keyboardType="email-address"
            accessibilityLabel="Work email" returnKeyType="send" onSubmitEditing={() => void sendEmail()} placeholder="you@example.gov" placeholderTextColor={colors.muted} style={styles.field} />
          {emailError ? <Text accessibilityRole="alert" style={styles.fieldError}>{emailError}</Text> : null}
          <ButtonGroup>
            <Button testID="email-send" label="Send code" compact busy={emailBusy} onPress={() => void sendEmail()} />
            <Button label="Cancel" kind="link" compact disabled={emailBusy} onPress={() => { setEmailStep(null); setEmailError(null); }} />
          </ButtonGroup>
        </> : <>
          <Text style={styles.fieldLabel}>Six-digit code</Text>
          <Text style={styles.fieldHint}>We sent it to {emailDraft}</Text>
          <TextInput testID="email-code" value={codeDraft} onChangeText={setCodeDraft} autoFocus keyboardType="number-pad" maxLength={8} textContentType="oneTimeCode"
            accessibilityLabel="Six-digit code" returnKeyType="done" onSubmitEditing={() => void confirmEmail()} placeholderTextColor={colors.muted} style={styles.field} />
          {emailError ? <Text accessibilityRole="alert" style={styles.fieldError}>{emailError}</Text> : null}
          <ButtonGroup>
            <Button testID="email-confirm" label="Confirm" compact busy={emailBusy} onPress={() => void confirmEmail()} />
            <Button label="Back" kind="link" compact disabled={emailBusy} onPress={() => { setEmailStep("email"); setEmailError(null); }} />
          </ButtonGroup>
        </>}
      </View> : null}
      <Text accessibilityRole="header" style={styles.section}>Preferences</Text>
      <View style={styles.group}>
        {/* On a phone there is no sidebar, so your Deep work switch (deep-work.ts) lives here. */}
        <DeepWorkSwitch />
        <Row label="Notifications" onPress={() => router.push("/notifications")} />
        <Row label="Link a computer" onPress={() => router.push("/link-computer")} />
      </View>

      <Text accessibilityRole="header" style={styles.section}>Servers</Text>
      <View style={[styles.group, { paddingHorizontal: space.md, paddingVertical: space.xs }]}><ServerSwitcher /></View>
      {/* The same places as the sidebar, under the same names and in the same groups (destinations.ts). */}
      {destinationGroups("you", { features, owner, canViewSurveys: surveyPermissions.canView }).map(entry => <View key={entry.group}>
        <Text accessibilityRole="header" style={styles.section}>{entry.title}</Text>
        <View style={styles.group}>
          {entry.places.map(place => <Row key={place.id} label={place.label} onPress={() => router.push(place.path as Href)} />)}
        </View>
      </View>)}

      <View style={styles.signOut}><Button label="Sign out of this server" kind="danger" onPress={() => { setError(null); setConfirming(true); }} /></View>
    </ScrollView>
    <PhotoCropper source={cropSource} onCancel={() => setCropSource(null)} onDone={b64 => { setCropSource(null); void uploadPhoto(b64); }} />
      <ConfirmDialog visible={confirming} title={`Sign out of ${account.serverName}?`} description="Your other servers stay signed in. You can return with a sign-in link or a new invite." confirmLabel="Sign out" onConfirm={() => void leave()} onCancel={() => setConfirming(false)} busy={leaving} error={error} />
    </View>
  );
}

const useStyles = createThemedStyles(({ colors, controls }) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.groupedBackground },
  content: { paddingBottom: space.xl, width: "100%", maxWidth: 680, alignSelf: "center" },
  profile: { marginHorizontal: space.side, marginBottom: space.xs, paddingVertical: space.sm, flexDirection: "row", alignItems: "center", gap: space.sm },
  profileCopy: { flex: 1, minWidth: 0 },
  profileName: { ...typography.heading, color: colors.ink },
  profileRole: { ...typography.caption, color: colors.muted, marginTop: space.xxs },
  linkRow: { flexDirection: "row", flexWrap: "wrap", columnGap: space.lg },
  photoLink: { ...typography.captionStrong, color: colors.blue, ...linkUnderline },
  linkAction: { minHeight: 44, justifyContent: "center" },
  photoBadge: { position: "absolute", right: -2, bottom: -2, width: 22, height: 22, borderRadius: radius.pill, backgroundColor: colors.primary, borderWidth: 2, borderColor: colors.groupedBackground, alignItems: "center", justifyContent: "center" },
  photoMenu: { marginTop: -space.xxs },
  // Text links, but 44pt tall targets.
  nameEditor: { padding: space.md, gap: space.sm },
  fieldLabel: { ...typography.label, color: colors.ink },
  fieldHint: { ...typography.caption, color: colors.muted },
  field: controls.input,
  fieldError: { ...typography.caption, color: colors.red },
  photoError: { ...typography.caption, color: colors.red, marginHorizontal: space.side, marginTop: -space.xs, marginBottom: space.md },
  section: { ...typography.label, marginHorizontal: space.side, marginTop: space.sm, marginBottom: space.xs, color: colors.muted },
  group: { backgroundColor: colors.groupedCard, marginHorizontal: space.side, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, overflow: "hidden", marginBottom: space.md },
  row: { minHeight: 48, paddingHorizontal: space.md, paddingVertical: space.sm, flexDirection: "row", alignItems: "center", gap: space.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  rowLabel: { ...typography.body, color: colors.ink, flex: 1 },
  rowValue: { ...typography.body, color: colors.muted, flex: 1, textAlign: "right" },
  signOut: { marginHorizontal: space.side, marginTop: space.xs },
  notes: { padding: space.md },
  notesHeader: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: space.xs, marginBottom: space.xs },
  notesTitle: { ...typography.bodyStrong, color: colors.ink },
  build: { ...typography.caption, color: colors.muted, marginLeft: "auto" },
  notesText: { ...typography.caption, color: colors.muted },
  notesLink: { ...typography.captionStrong, marginTop: space.sm, color: colors.blue, ...linkUnderline },
  version: { ...typography.caption, marginTop: space.md, textAlign: "center", color: colors.muted },
}));
