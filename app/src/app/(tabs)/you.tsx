import { type ComponentRef, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import * as ImagePicker from "expo-image-picker";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import { router, useScrollToTop } from "expo-router";
import { api, saveAccount, ServerError } from "../../lib/server";
import { usePhotos } from "../../lib/photos";
import { PageTitle } from "../../components/Band";
import { Avatar } from "../../components/Messaging";
import { pickImageOnWeb } from "../../lib/pick-image-web";
import { PhotoCropper, type CropSource } from "../../components/PhotoCropper";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { AppIcon } from "../../components/AppIcon";
import { useSession } from "../../lib/session";
import { createThemedStyles, useTheme, radius, space, typography } from "../../lib/theme";
import { startOnboarding } from "../../lib/onboarding";
import { appName } from "../../lib/app-identity";

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
  const { account, setAccount, signOut } = useSession();
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
  // Joined before email codes: confirm your work email so nobody else can pose as you.
  const [emailNeeded, setEmailNeeded] = useState(false);
  const [emailStep, setEmailStep] = useState<null | "email" | "code">(null);
  const [emailDraft, setEmailDraft] = useState("");
  const [codeDraft, setCodeDraft] = useState("");
  const [challenge, setChallenge] = useState("");
  const [emailBusy, setEmailBusy] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [onboardingError, setOnboardingError] = useState<string | null>(null);
  useEffect(() => {
    if (!account) return;
    let live = true;
    api.emailRequired(account).then(v => { if (live) setEmailNeeded(v); }).catch(() => {});
    return () => { live = false; };
  }, [account?.user.id]);
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
      setEmailNeeded(false); setEmailStep(null);
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
      router.replace("/welcome");
    } catch {
      setError("Couldn't sign out. Try again.");
    } finally {
      setLeaving(false);
    }
  };

  const restartOnboarding = async () => {
    setOnboardingError(null);
    const updated = { ...account, uxOnboarding: startOnboarding() };
    try {
      await saveAccount(updated);
      setAccount(updated);
      router.push("/onboarding");
    } catch {
      setOnboardingError("Couldn't restart onboarding. Try again.");
    }
  };

  return (
    <View style={styles.root}>
    <ScrollView ref={scrollRef} style={styles.root} contentContainerStyle={styles.content} contentInsetAdjustmentBehavior="automatic">
      <PageTitle>You</PageTitle>
      <Pressable testID="profile-photo" accessibilityRole="button" accessibilityLabel={hasPhoto ? "Change your profile photo" : "Add a profile photo"} accessibilityHint="Everyone on this server sees it"
        accessibilityState={{ busy: photoBusy, expanded: hasPhoto ? photoMenu : undefined }} disabled={photoBusy}
        onPress={() => { if (hasPhoto) setPhotoMenu(open => !open); else void choosePhoto(); }}
        style={({ pressed }) => [styles.profile, pressed && { opacity: 0.7 }]}>
        <View>
          <Avatar name={account.user.name} userId={account.user.id} size={56} />
          <View style={styles.photoBadge}>{photoBusy ? <ActivityIndicator size="small" color={colors.onPrimary} /> : <AppIcon name={hasPhoto ? "compose" : "plus"} size={12} color={colors.onPrimary} strokeWidth={2.4} />}</View>
        </View>
        <View style={styles.profileCopy}>
          <Text style={styles.profileName}>{account.user.name}</Text>
          <Text style={styles.profileRole}>{account.serverName} · {owner ? "Workspace owner" : "Member"}</Text>
          <View style={styles.linkRow}>
            <Text style={styles.photoLink}>{photoBusy ? "Saving photo…" : hasPhoto ? "Change photo" : "Add a photo"}</Text>
            <Pressable testID="change-name" accessibilityRole="button" hitSlop={8} onPress={() => { setNameDraft(account.user.name); setNameError(null); setEditingName(true); }}>
              <Text style={styles.photoLink}>Change name</Text>
            </Pressable>
          </View>
        </View>
      </Pressable>
      {photoMenu && hasPhoto ? <View style={[styles.group, styles.photoMenu]}>
        <Row label="Choose from library" onPress={() => void choosePhoto()} />
        <Pressable accessibilityRole="button" onPress={() => void removePhoto()} style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.subtle }]}>
          <Text style={[styles.rowLabel, { color: colors.red }]}>Remove photo</Text>
        </Pressable>
      </View> : null}
      {photoError ? <Text accessibilityRole="alert" style={styles.photoError}>{photoError}</Text> : null}
      {editingName ? <View style={[styles.group, styles.nameEditor]}>
        <TextInput testID="name-input" value={nameDraft} onChangeText={setNameDraft} autoFocus maxLength={40} autoCapitalize="words" autoCorrect={false}
          accessibilityLabel="Your name" returnKeyType="done" onSubmitEditing={() => void saveName()} placeholder="Your name" placeholderTextColor={colors.muted} style={styles.nameInput} />
        {nameError ? <Text accessibilityRole="alert" style={styles.photoError}>{nameError}</Text> : null}
        <View style={styles.nameActions}>
          <Pressable accessibilityRole="button" disabled={nameBusy} onPress={() => { setEditingName(false); setNameError(null); }} style={styles.nameAction}><Text style={styles.photoLink}>Cancel</Text></Pressable>
          <Pressable testID="name-save" accessibilityRole="button" accessibilityState={{ busy: nameBusy }} disabled={nameBusy} onPress={() => void saveName()} style={styles.nameAction}><Text style={styles.photoLink}>{nameBusy ? "Saving…" : "Save"}</Text></Pressable>
        </View>
      </View> : null}
      {emailNeeded ? <View style={[styles.group, styles.nameEditor]}>
        {emailStep === null ? <Pressable testID="confirm-email" accessibilityRole="button" onPress={() => { setEmailError(null); setEmailStep("email"); }} style={styles.nameAction}>
          <Text style={styles.photoLink}>Confirm your work email</Text>
        </Pressable> : emailStep === "email" ? <>
          <TextInput testID="email-input" value={emailDraft} onChangeText={setEmailDraft} autoFocus autoCapitalize="none" autoCorrect={false} keyboardType="email-address"
            accessibilityLabel="Work email" returnKeyType="send" onSubmitEditing={() => void sendEmail()} placeholder="you@irs.gov" placeholderTextColor={colors.muted} style={styles.nameInput} />
          {emailError ? <Text accessibilityRole="alert" style={styles.photoError}>{emailError}</Text> : null}
          <View style={styles.nameActions}>
            <Pressable accessibilityRole="button" disabled={emailBusy} onPress={() => { setEmailStep(null); setEmailError(null); }} style={styles.nameAction}><Text style={styles.photoLink}>Cancel</Text></Pressable>
            <Pressable testID="email-send" accessibilityRole="button" accessibilityState={{ busy: emailBusy }} disabled={emailBusy} onPress={() => void sendEmail()} style={styles.nameAction}><Text style={styles.photoLink}>{emailBusy ? "Sending…" : "Send code"}</Text></Pressable>
          </View>
        </> : <>
          <Text style={styles.hint}>We sent a six-digit code to {emailDraft}</Text>
          <TextInput testID="email-code" value={codeDraft} onChangeText={setCodeDraft} autoFocus keyboardType="number-pad" maxLength={8} textContentType="oneTimeCode"
            accessibilityLabel="Six-digit code" returnKeyType="done" onSubmitEditing={() => void confirmEmail()} placeholder="Code" placeholderTextColor={colors.muted} style={styles.nameInput} />
          {emailError ? <Text accessibilityRole="alert" style={styles.photoError}>{emailError}</Text> : null}
          <View style={styles.nameActions}>
            <Pressable accessibilityRole="button" disabled={emailBusy} onPress={() => { setEmailStep("email"); setEmailError(null); }} style={styles.nameAction}><Text style={styles.photoLink}>Back</Text></Pressable>
            <Pressable testID="email-confirm" accessibilityRole="button" accessibilityState={{ busy: emailBusy }} disabled={emailBusy} onPress={() => void confirmEmail()} style={styles.nameAction}><Text style={styles.photoLink}>{emailBusy ? "Checking…" : "Confirm"}</Text></Pressable>
          </View>
        </>}
      </View> : null}
      <Text accessibilityRole="header" style={styles.section}>Preferences</Text>
      <View style={styles.group}>
        <Row label="Notifications" onPress={() => router.push("/notifications")} />
        <Row label="Link a computer" onPress={() => router.push("/link-computer")} />
        <Row label="Restart onboarding" onPress={() => void restartOnboarding()} />
      </View>
      {onboardingError ? <Text accessibilityRole="alert" style={styles.photoError}>{onboardingError}</Text> : null}

      <Text accessibilityRole="header" style={styles.section}>Workspace</Text>
      <View style={styles.group}>
        <Row label="People" onPress={() => router.push("/members")} />
        <Row label="Shame board" onPress={() => router.push("/leaderboard")} />
        {owner ? <Row label="Invite people" onPress={() => router.push("/invite")} /> : null}
        <Row label="Archived" onPress={() => router.push("/archived-channels")} />
      </View>

      <Pressable accessibilityRole="button" onPress={() => { setError(null); setConfirming(true); }} style={styles.danger}>
        <Text style={styles.dangerText}>Sign out</Text>
      </Pressable>
    </ScrollView>
    <PhotoCropper source={cropSource} onCancel={() => setCropSource(null)} onDone={b64 => { setCropSource(null); void uploadPhoto(b64); }} />
      <ConfirmDialog visible={confirming} title={`Sign out of ${appName}?`} description="You'll need a new invite to sign in again." confirmLabel="Sign out" onConfirm={() => void leave()} onCancel={() => setConfirming(false)} busy={leaving} error={error} />
    </View>
  );
}

const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  hint: { ...typography.caption, color: colors.muted, marginTop: space.xs, marginHorizontal: space.xs },
  root: { flex: 1, backgroundColor: colors.groupedBackground },
  content: { paddingBottom: space.xl, width: "100%", maxWidth: 680, alignSelf: "center" },
  profile: { marginHorizontal: space.side, marginBottom: space.xs, paddingVertical: space.sm, flexDirection: "row", alignItems: "center", gap: space.sm },
  profileCopy: { flex: 1, minWidth: 0 },
  profileName: { ...typography.heading, color: colors.ink },
  profileRole: { ...typography.caption, color: colors.muted, marginTop: space.xxs },
  linkRow: { flexDirection: "row", flexWrap: "wrap", columnGap: space.lg },
  photoLink: { ...typography.captionStrong, color: colors.blue, marginTop: space.xxs },
  photoBadge: { position: "absolute", right: -2, bottom: -2, width: 22, height: 22, borderRadius: 11, backgroundColor: colors.primary, borderWidth: 2, borderColor: colors.groupedBackground, alignItems: "center", justifyContent: "center" },
  photoMenu: { marginTop: -space.xxs },
  // Text links, but 44pt tall targets.
  nameAction: { minHeight: 44, justifyContent: "center", paddingHorizontal: space.xs },
  nameEditor: { padding: space.md, gap: space.sm },
  nameInput: { ...typography.body, color: colors.ink, minHeight: 44 },
  nameActions: { flexDirection: "row", justifyContent: "flex-end", gap: space.lg },
  photoError: { ...typography.caption, color: colors.red, marginHorizontal: space.side, marginTop: -space.xs, marginBottom: space.md },
  section: { ...typography.label, marginHorizontal: space.side, marginTop: space.sm, marginBottom: space.xs, color: colors.muted },
  group: { backgroundColor: colors.groupedCard, marginHorizontal: space.side, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, overflow: "hidden", marginBottom: space.md },
  row: { minHeight: 48, paddingHorizontal: space.md, paddingVertical: space.sm, flexDirection: "row", alignItems: "center", gap: space.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  rowLabel: { ...typography.body, color: colors.ink, flex: 1 },
  rowValue: { ...typography.body, color: colors.muted, flex: 1, textAlign: "right" },
  danger: { marginHorizontal: space.side, marginTop: space.xs, minHeight: 48, justifyContent: "center", paddingHorizontal: space.md, backgroundColor: colors.groupedCard, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line },
  dangerText: { ...typography.bodyStrong, color: colors.red },
  notes: { padding: space.md },
  notesHeader: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: space.xs, marginBottom: space.xs },
  notesTitle: { ...typography.bodyStrong, color: colors.ink },
  build: { ...typography.caption, color: colors.muted, marginLeft: "auto" },
  notesText: { ...typography.caption, color: colors.muted },
  notesLink: { ...typography.captionStrong, marginTop: space.sm, color: colors.blue },
  version: { ...typography.caption, marginTop: space.md, textAlign: "center", color: colors.muted },
}));
