import { useEffect, useState } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { useNotifications } from '../lib/notifications';
import { colors } from '../lib/theme';
import type { NotificationPreferences } from '../lib/notifications-api';
const choices: { mode: NotificationPreferences['mode']; title: string; detail: string }[] = [
  { mode: 'all', title: 'All messages', detail: 'Every message in your channels and direct messages' },
  { mode: 'mentions', title: 'Direct messages, mentions and replies', detail: 'Includes replies to threads you participate in and replies from the agent' },
  { mode: 'none', title: 'Nothing', detail: 'Keep messages in the app without push alerts' },
];
export default function NotificationSettings() {
  const { supported, enabled, busy, error, preferences, enable, update } = useNotifications();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 15000); return () => clearInterval(timer); }, []);
  if (!supported) return <View style={styles.root}><Text style={styles.description}>Push notifications are available in the iOS and Android apps.</Text></View>;
  const paused = preferences.pausedUntil > now;
  return <ScrollView style={styles.root} contentContainerStyle={styles.content}>
    <Text style={styles.title}>Notifications</Text>
    <Text style={styles.description}>Archived channels stay quiet. Messages in the conversation you're viewing won't interrupt you.</Text>
    {!enabled ? <Pressable disabled={busy} accessibilityRole="button" onPress={enable} style={styles.enable}><Text style={styles.enableText}>{busy ? 'Setting up…' : 'Enable notifications'}</Text></Pressable> : <Pressable accessibilityRole="button" onPress={() => Linking.openSettings()} style={styles.settings}><Text style={styles.link}>Notifications enabled · System settings</Text></Pressable>}
    {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
    <Text style={styles.label}>Notify me about</Text>
    {choices.map(choice => <Pressable key={choice.mode} disabled={busy} accessibilityRole="radio" accessibilityState={{ checked: preferences.mode === choice.mode, disabled: busy }} onPress={() => update({ mode: choice.mode })} style={styles.row}>
      <View style={styles.copy}><Text style={styles.rowTitle}>{choice.title}</Text><Text style={styles.detail}>{choice.detail}</Text></View>
      <Text accessibilityElementsHidden style={styles.check}>{preferences.mode === choice.mode ? '✓' : ''}</Text>
    </Pressable>)}
    <View style={styles.row}><View style={styles.copy}><Text style={styles.rowTitle}>Message previews</Text><Text style={styles.detail}>Show the sender and message on your lock screen</Text></View><Switch accessibilityLabel="Message previews" disabled={busy} value={preferences.previews} onValueChange={previews => update({ previews })} /></View>
    <Text style={styles.label}>Pause notifications</Text>
    {paused ? <><Text style={styles.description}>Paused until {new Date(preferences.pausedUntil).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}</Text><Pressable disabled={busy} accessibilityRole="button" onPress={() => update({ pausedUntil: 0 })} style={styles.settings}><Text style={styles.link}>Resume notifications</Text></Pressable></> : <View style={styles.pauseChoices}>{[['30 minutes', 30], ['1 hour', 60], ['8 hours', 480]].map(([label, minutes]) => <Pressable key={label} disabled={busy} accessibilityRole="button" onPress={() => update({ pausedUntil: Date.now() + Number(minutes) * 60000 })} style={styles.pause}><Text style={styles.link}>{label}</Text></Pressable>)}</View>}
  </ScrollView>;
}
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.white }, content: { padding: 20, paddingBottom: 48 },
  title: { color: colors.ink, fontSize: 26, fontWeight: '700' }, description: { marginTop: 12, color: colors.muted, fontSize: 16, lineHeight: 23 },
  label: { marginTop: 28, marginBottom: 8, color: colors.ink, fontSize: 17, fontWeight: '600' },
  row: { paddingVertical: 16, minHeight: 56, flexDirection: 'row', alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  copy: { flex: 1, marginRight: 12 }, rowTitle: { color: colors.ink, fontSize: 17 }, detail: { color: colors.muted, fontSize: 15, lineHeight: 21, marginTop: 5 }, check: { width: 24, color: colors.blue, fontSize: 24 },
  enable: { marginTop: 20, backgroundColor: colors.blue, padding: 16, borderRadius: 12, alignItems: 'center' }, enableText: { color: colors.white, fontSize: 17, fontWeight: '600' },
  settings: { minHeight: 48, justifyContent: 'center', marginTop: 8 }, link: { color: colors.blue, fontSize: 16, fontWeight: '600' },
  pauseChoices: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 }, pause: { minHeight: 48, justifyContent: 'center', paddingHorizontal: 16, backgroundColor: colors.surface, borderRadius: 24 }, error: { marginTop: 12, color: colors.red, fontSize: 15 },
});
