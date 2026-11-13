import { useState } from "react";
import { Platform, Pressable, ScrollView, Share, StyleSheet, Text, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { useLocalSearchParams } from "expo-router";
import { useActiveCall } from "../lib/active-call";
import { useSession } from "../lib/session";
import { api, ServerError, type GuestAction, type GuestLinkAction } from "../lib/server";
import { guestShareMessage, guestsSummary, inviteLabel, knockBanner } from "../lib/guest-invite";
import { radius, space, typography, useTheme } from "../lib/theme";

const DARK = "#0B1220";

/**
 * The guest door inside a call: "Invite guests" makes the meeting's link and shares it, a banner
 * tells the host when someone knocks (Admit / Deny right there), and a small panel lists who is
 * waiting and who is in. Reads everything from the call's own two-second poll (state.guests); shows
 * nothing unless the server has guests turned on. Rendered by app/meeting/[id].tsx with one line.
 */
export function GuestInvite() {
  const { colors } = useTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { account } = useSession();
  const active = useActiveCall();
  const [open, setOpen] = useState(false);
  const [link, setLink] = useState<{ url: string; on: boolean } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  // Knocks the host already answered, hidden until the next poll agrees.
  const [decided, setDecided] = useState<ReadonlySet<string>>(() => new Set());
  const mine = active?.id === id ? active : null;
  const state = mine?.state;
  const guests = state?.guests;
  if (!account || !id || !guests || !state || (state.status !== "live" && state.status !== "connecting")) return null;
  const host = !!state.host;
  const web = Platform.OS === "web";
  const banner = host ? knockBanner(guests.pending, decided) : null;
  const summary = guestsSummary(guests, host);
  const present = guests.present;
  const pending = host ? guests.pending.filter(p => !decided.has(p.id)) : [];
  const linkOn = link ? link.on : guests.on;
  const fail = (e: unknown, fallback: string) => setNote(e instanceof ServerError ? e.message : fallback);

  const shareLink = async (l: { url: string; on: boolean }) => {
    if (web) {
      try { if (!(await Clipboard.setStringAsync(l.url))) throw new Error("clipboard"); setCopied(true); setNote(null); setTimeout(() => setCopied(false), 2500); }
      catch { setNote(`Couldn't copy. The link is ${l.url}`); }
    } else {
      await Share.share({ message: guestShareMessage(l.url, account.user.name) }).catch(() => setNote("Couldn't open sharing. Try again"));
    }
  };
  const invite = async () => {
    if (busy) return;
    setBusy("link"); setNote(null);
    try { const l = link ?? await api.guestLink(account, id, "create"); setLink(l); await shareLink(l); }
    catch (e) { fail(e, "Couldn't make the guest link. Try again"); }
    finally { setBusy(null); }
  };
  const linkAction = async (action: GuestLinkAction) => {
    if (busy) return;
    setBusy(action); setNote(null);
    try { const l = await api.guestLink(account, id, action); setLink(l); if (action === "rotate") setNote("New link made. The old one no longer works"); }
    catch (e) { fail(e, "Couldn't change the guest link. Try again"); }
    finally { setBusy(null); }
  };
  const act = async (gid: string, action: GuestAction) => {
    if (busy) return;
    setBusy(gid); setNote(null);
    try { await api.guestAction(account, id, gid, action); setDecided(prev => new Set([...prev, gid])); }
    catch (e) { fail(e, "Couldn't do that. Try again"); }
    finally { setBusy(null); }
  };

  return (
    <View testID="guest-invite" style={styles.wrap}>
      {banner ? (
        <View testID="guest-knock" accessible accessibilityRole="alert" accessibilityLiveRegion="assertive" accessibilityLabel={`${banner.title}${banner.more ? `, and ${banner.more} more waiting` : ""}`} style={[styles.banner, { backgroundColor: colors.primary }]}>
          <View style={{ flex: 1, minWidth: 120 }}>
            <Text style={[styles.bannerTitle, { color: colors.onPrimary }]} numberOfLines={2}>{banner.title}</Text>
            <Text style={[styles.bannerSub, { color: colors.onPrimary }]}>{banner.more ? `${banner.more} more waiting · Guests are recorded too` : "Guests are recorded too"}</Text>
          </View>
          <Pill label="Admit" light disabled={busy === banner.id} onPress={() => void act(banner.id, "admit")} a11y={`Admit ${banner.name}`} />
          <Pill label="Deny" disabled={busy === banner.id} onPress={() => void act(banner.id, "deny")} a11y={`Deny ${banner.name}`} />
        </View>
      ) : null}
      <View style={styles.row}>
        <Pill label={inviteLabel(!!link, copied, web)} disabled={busy === "link"} onPress={() => void invite()} a11y={link ? (web ? "Copy guest link" : "Share guest link") : "Invite guests"} />
        {summary ? <Pill label={summary} active={open} onPress={() => setOpen(v => !v)} a11y={`Guests, ${summary}`} /> : null}
        {!summary && (link || guests.on) ? <Pill label={open ? "Hide" : "Guest link"} active={open} onPress={() => setOpen(v => !v)} a11y="Guest link settings" /> : null}
      </View>
      {note ? <Text accessibilityRole="alert" style={styles.note} selectable>{note}</Text> : null}
      {open ? (
        <View testID="guest-panel" style={styles.panel}>
          {pending.length ? <>
            <Text style={styles.heading}>Waiting to join</Text>
            {pending.map(p => (
              <View key={p.id} style={styles.person}>
                <Text style={styles.name} numberOfLines={1}>{p.name}</Text>
                <Pill label="Admit" light small disabled={busy === p.id} onPress={() => void act(p.id, "admit")} a11y={`Admit ${p.name}`} />
                <Pill label="Deny" small disabled={busy === p.id} onPress={() => void act(p.id, "deny")} a11y={`Deny ${p.name}`} />
              </View>
            ))}
          </> : null}
          <Text style={styles.heading}>{present.length ? "Guests" : "No guests"}</Text>
          <ScrollView style={{ maxHeight: 140 }}>
            {present.map(p => (
              <View key={p.id} style={styles.person}>
                <Text style={styles.name} numberOfLines={1}>{p.name}{p.connected ? "" : " · Connecting"}</Text>
                {host ? <Pill label="Remove" small danger disabled={busy === p.id} onPress={() => void act(p.id, "remove")} a11y={`Remove ${p.name}`} /> : null}
              </View>
            ))}
          </ScrollView>
          <Text style={styles.meta}>Guests can see and hear everyone and are recorded. No screen sharing, conversation or Research access.</Text>
          {host ? (
            <View style={styles.row}>
              <Pill label={linkOn ? "Turn link off" : "Turn link on"} small disabled={!!busy} onPress={() => void linkAction(linkOn ? "off" : "on")} a11y={linkOn ? "Turn the guest link off" : "Turn the guest link on"} />
              <Pill label="New link" small disabled={!!busy} onPress={() => void linkAction("rotate")} a11y="Make a new guest link" />
            </View>
          ) : null}
          {!linkOn ? <Text style={styles.meta}>Link off. Existing guests remain.</Text> : null}
        </View>
      ) : null}
    </View>
  );
}

function Pill({ label, onPress, a11y, active, light, small, danger, disabled }: { label: string; onPress: () => void; a11y: string; active?: boolean; light?: boolean; small?: boolean; danger?: boolean; disabled?: boolean }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={a11y} accessibilityState={{ selected: !!active, disabled: !!disabled }} aria-pressed={active} disabled={disabled} onPress={onPress}
      style={({ pressed }) => [styles.pill, small && styles.pillSmall, (active || light) && styles.pillLight, danger && styles.pillDanger, disabled && { opacity: 0.6 }, pressed && { opacity: 0.8 }]}>
      <Text style={[styles.pillText, (active || light) && { color: DARK }]} numberOfLines={1}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: 20, paddingBottom: space.xs, gap: space.xs },
  row: { flexDirection: "row", flexWrap: "wrap", gap: space.xs },
  banner: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.xs, padding: space.sm, borderRadius: radius.lg },
  bannerTitle: { ...typography.bodyStrong },
  bannerSub: { ...typography.caption },
  pill: { minHeight: 48, paddingHorizontal: space.md, borderRadius: radius.pill, alignItems: "center", justifyContent: "center", backgroundColor: "#243045" },
  pillSmall: { minHeight: 44, paddingHorizontal: space.sm },
  pillLight: { backgroundColor: "#FFFFFF" },
  pillDanger: { backgroundColor: "#D11242" },
  pillText: { ...typography.bodyStrong, color: "#FFFFFF" },
  note: { ...typography.caption, color: "#C9D3E0" },
  panel: { padding: space.sm, borderRadius: radius.lg, backgroundColor: "#1B2433", gap: space.xs },
  heading: { ...typography.label, color: "#C9D3E0" },
  person: { flexDirection: "row", alignItems: "center", gap: space.xs, paddingVertical: 4 },
  name: { ...typography.body, color: "#FFFFFF", flex: 1 },
  meta: { ...typography.caption, color: "#8E9BB3" },
});
