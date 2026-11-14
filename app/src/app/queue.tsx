import { useCallback, useRef, useState } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useFocusEffect, useLocalSearchParams } from 'expo-router';
import { Button } from '../components/Button';
import { FeedbackTabs } from '../components/FeedbackTabs';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { useSession } from '../lib/session';
import { surveysApi, surveyError, surveyFaces, type ResponsePatch, type Survey, type SurveyDetail, type SurveyResponse } from '../lib/surveys';
import { NO_SURVEY_ACCESS, surveyPermissionsFromServer } from '../lib/survey-permissions';
import { surveyReplyUrl } from '../lib/survey-reply';
import { responseMeta, surveyStatusLabels } from '../lib/survey-labels';
import { radius, space, typography, createThemedStyles, useTheme } from '../lib/theme';

type Filter = 'all' | SurveyResponse['visibility'];
const filters: { id: Filter; label: string }[] = [{ id: 'all', label: 'All feedback' }, { id: 'pending', label: 'Needs review' }, { id: 'reviewed', label: 'Reviewed' }, { id: 'hidden', label: 'Hidden' }];
const statuses: SurveyResponse['status'][] = ['open', 'planned', 'resolved'];

export default function FeedbackQueue() {
  const { account } = useSession();
  const styles = useStyles();
  const { colors } = useTheme();
  const params = useLocalSearchParams<{ survey?: string }>();
  const [selected, setSelected] = useState(params.survey || '');
  const [surveys, setSurveys] = useState<Survey[]>([]);
  const [detail, setDetail] = useState<SurveyDetail | null>(null);
  const [permissions, setPermissions] = useState(NO_SURVEY_ACCESS);
  const [filter, setFilter] = useState<Filter>('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [editing, setEditing] = useState<SurveyResponse | null>(null);
  const [text, setText] = useState('');
  const [reply, setReply] = useState('');
  const [status, setStatus] = useState<SurveyResponse['status']>('open');
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const generation = useRef(0);
  const mutation = useRef(false);
  const refresh = useCallback(async () => {
    if (!account) return;
    const run = ++generation.current;
    setLoading(true); setError(''); setDetail(null); setEditing(null); setSurveys([]); setPermissions(NO_SURVEY_ACCESS); setDeleting(false);
    try {
      const list = await surveysApi.list(account);
      if (run !== generation.current) return;
      setSurveys(list.surveys); setPermissions(surveyPermissionsFromServer(list.permissions));
      const id = list.surveys.some(item => item.id === selected) ? selected : list.surveys[0]?.id;
      if (id) {
        const next = await surveysApi.detail(account, id);
        if (run === generation.current) { setDetail(next); setPermissions(surveyPermissionsFromServer(next.permissions)); }
      }
    } catch (e) {
      if (run === generation.current) { setError(surveyError(e)); setSurveys([]); setDetail(null); setPermissions(NO_SURVEY_ACCESS); setEditing(null); setDeleting(false); }
    } finally { if (run === generation.current) setLoading(false); }
  }, [account, selected]);
  useFocusEffect(useCallback(() => { void refresh(); return () => { generation.current++; }; }, [refresh]));
  const edit = (response: SurveyResponse) => {
    if (!permissions.canManage) return;
    setEditing(response); setText(response.text); setReply(response.reply); setStatus(response.status); setNotice(''); setError('');
  };
  const replyByEmail = async (response: SurveyResponse) => {
    if (!permissions.canManage || !detail) return;
    const url = surveyReplyUrl(response.contactEmail, detail.survey.title);
    if (!url) return;
    const run = generation.current;
    setError(''); setNotice('');
    try {
      await Linking.openURL(url);
    } catch {
      if (run === generation.current) setError('Could not open your email app. Copy the contact email below and write your reply there.');
    }
  };
  const save = async (visibility?: SurveyResponse['visibility']) => {
    if (!account || !permissions.canManage || !editing || mutation.current) return;
    const run = generation.current;
    mutation.current = true; setBusy(true); setError(''); setNotice('');
    const patch: ResponsePatch = { text: text.trim(), reply: reply.trim(), status, ...(visibility ? { visibility } : {}) };
    try {
      const { response } = await surveysApi.respond(account, editing.surveyId, editing.id, patch);
      if (run !== generation.current) return;
      setDetail(value => value?.survey.id === response.surveyId ? { ...value, responses: value.responses.map(item => item.id === response.id ? response : item) } : value);
      setEditing(null);
      setNotice('Saved.');
    } catch (e) { if (run === generation.current) setError(surveyError(e)); }
    finally { mutation.current = false; setBusy(false); }
  };
  const remove = async () => {
    if (!account || !permissions.canManage || !editing || mutation.current) return;
    const run = generation.current;
    mutation.current = true; setBusy(true); setDeleteError('');
    try {
      await surveysApi.remove(account, editing.surveyId, editing.id);
      if (run !== generation.current) return;
      setDeleting(false); setEditing(null); setNotice('Response deleted.');
      await refresh();
    } catch (e) { if (run === generation.current) setDeleteError(surveyError(e)); }
    finally { mutation.current = false; setBusy(false); }
  };
  if (!account) return null;
  const responses = detail?.responses.filter(item => filter === 'all' || item.visibility === filter) || [];
  const pending = detail?.responses.filter(item => item.visibility === 'pending').length || 0;
  return <>
    <ScrollView style={styles.root} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
      <FeedbackTabs current="responses" survey={detail?.survey.id} disabled={busy} />
      <Text style={styles.body}>Survey feedback is private. Team notes and review status are visible to authorized staff only.</Text>
      {permissions.canView && !permissions.canManage ? <Text style={styles.caption}>You have view access. A user researcher or admin can review and edit responses.</Text> : null}
      {surveys.length ? <View accessibilityRole="tablist" accessibilityLabel="Choose a survey" style={styles.selector}>{surveys.map(survey => <Pressable key={survey.id} accessibilityRole="tab" accessibilityState={{ selected: detail?.survey.id === survey.id, disabled: busy || !!editing }} aria-selected={detail?.survey.id === survey.id} disabled={busy || !!editing} onPress={() => { setSelected(survey.id); setNotice(''); }} style={[styles.tab, detail?.survey.id === survey.id && styles.tabSelected]}><Text style={[styles.tabText, detail?.survey.id === survey.id && styles.tabTextSelected]}>{survey.title}</Text></Pressable>)}</View> : null}
      {detail ? <><Text accessibilityRole="header" style={styles.heading}>{detail.survey.title}</Text><Text style={styles.caption}>Responses: {detail.responses.length} · Needs review: {pending}</Text><View accessibilityRole="tablist" accessibilityLabel="Show" style={styles.selector}>{filters.map(item => <Pressable key={item.id} accessibilityRole="tab" accessibilityState={{ selected: filter === item.id, disabled: !!editing }} aria-selected={filter === item.id} disabled={!!editing} onPress={() => setFilter(item.id)} style={[styles.tab, filter === item.id && styles.tabSelected]}><Text style={[styles.tabText, filter === item.id && styles.tabTextSelected]}>{item.label}</Text></Pressable>)}</View></> : null}
      {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
      {notice ? <Text accessibilityLiveRegion="polite" style={styles.caption}>{notice}</Text> : null}
      {loading ? <Text accessibilityLiveRegion="polite" style={styles.caption}>Loading feedback…</Text> : null}
      {!loading && !surveys.length && !error ? <Text style={styles.body}>No surveys.</Text> : null}
      {!loading && detail && !responses.length ? <Text style={styles.body}>No feedback.</Text> : null}
      {responses.map(response => <View key={response.id} style={styles.response}>
        <View style={styles.responseHeader}><Text style={styles.body}>{surveyFaces[response.rating - 1]} {response.rating} / 5</Text><Text style={styles.caption}>{responseMeta(response)}</Text></View>
        {response.contactEmail ? <View style={styles.contact}>
          <Text style={styles.label}>Contact email</Text><Text selectable style={styles.body}>{response.contactEmail}</Text>
          {permissions.canManage && surveyReplyUrl(response.contactEmail, detail?.survey.title || '') ? <View style={styles.actions}><Button label="Reply by email" kind="secondary" compact disabled={busy || !!editing} onPress={() => { void replyByEmail(response); }} /></View> : null}
        </View> : <Text style={styles.caption}>No contact email provided.</Text>}
        {permissions.canManage && editing?.id === response.id ? <>
          <Text style={styles.label}>Feedback</Text><TextInput accessibilityLabel="Feedback text for review" value={text} onChangeText={setText} multiline maxLength={20000} editable={!busy} placeholderTextColor={colors.muted} style={styles.input} textAlignVertical="top" />
          <Text style={styles.caption}>Remove any personal information from feedback.</Text>
          <Text style={styles.label}>Team note</Text><TextInput accessibilityLabel="Team note" value={reply} onChangeText={setReply} multiline maxLength={2000} editable={!busy} placeholderTextColor={colors.muted} style={styles.input} textAlignVertical="top" />
          <Text style={styles.caption}>Private to authorized staff. Not shown to respondents.</Text>
          <Text style={styles.label}>Status</Text><View style={styles.selector}>{statuses.map(value => <Pressable key={value} disabled={busy} accessibilityRole="radio" accessibilityState={{ checked: status === value, disabled: busy }} aria-checked={status === value} onPress={() => setStatus(value)} style={[styles.choice, status === value && styles.choiceSelected]}><Text style={[styles.choiceText, status === value && styles.choiceTextSelected]}>{surveyStatusLabels[value]}</Text></Pressable>)}</View>
          <View style={styles.actions}>
            <Button label="Save" compact busy={busy} onPress={() => { void save(); }} />
            {response.visibility !== 'reviewed' ? <Button label="Mark reviewed" compact kind="secondary" disabled={busy} onPress={() => { void save('reviewed'); }} /> : null}
            {response.visibility !== 'hidden' ? <Button label="Hide" compact kind="secondary" disabled={busy} onPress={() => { void save('hidden'); }} /> : null}
            <Button label="Cancel" compact kind="link" disabled={busy} onPress={() => { setEditing(null); setError(''); }} />
          </View>
          <View style={styles.actions}><Button label="Delete response" kind="danger" compact disabled={busy} onPress={() => { setDeleteError(''); setDeleting(true); }} /></View>
        </> : <>
          <Text selectable style={styles.body}>{response.text || 'Rating only'}</Text>
          {response.reply ? <View style={styles.reply}><Text style={styles.label}>Team note</Text><Text selectable style={styles.body}>{response.reply}</Text></View> : null}
          {permissions.canManage ? <View style={styles.actions}><Button label="Review" accessibilityLabel={`Review feedback rated ${response.rating} of 5`} kind="secondary" compact disabled={busy || !!editing} onPress={() => edit(response)} /></View> : null}
        </>}
      </View>)}
      <Button label="Refresh" kind="link" disabled={loading || busy || !!editing} onPress={() => { void refresh(); }} />
    </ScrollView>
    <ConfirmDialog visible={deleting && permissions.canManage} title="Delete response?" description="Permanently removes this response, contact email, team note and rating from results." confirmLabel="Delete" onCancel={() => setDeleting(false)} onConfirm={() => { void remove(); }} busy={busy} error={deleteError} />
  </>;
}
const useStyles = createThemedStyles(({ colors, controls }) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background }, content: { padding: space.side, paddingBottom: space.xxl, gap: space.md, width: '100%', maxWidth: 840, alignSelf: 'center' },
  heading: { ...typography.heading, color: colors.ink }, body: { ...typography.body, color: colors.ink }, caption: { ...typography.caption, color: colors.muted }, label: { ...typography.label, color: colors.ink }, error: { ...typography.body, color: colors.red },
  contact: { gap: space.xs },
  // The filter tabs of Home, Direct messages and Agent. The status choices in the form below keep their outline.
  tab: { minHeight: 44, paddingHorizontal: space.md, paddingVertical: space.sm, justifyContent: 'center', borderRadius: radius.md }, tabSelected: { backgroundColor: colors.blueSoft }, tabText: { ...typography.bodyStrong, color: colors.muted }, tabTextSelected: { color: colors.blueDark },
  selector: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs }, choice: { minHeight: 44, paddingHorizontal: space.sm, paddingVertical: space.sm, borderWidth: 1, borderColor: colors.borderStrong, borderRadius: radius.sm }, choiceSelected: { backgroundColor: colors.blueSoft, borderColor: colors.blue }, choiceText: { ...typography.captionStrong, color: colors.ink }, choiceTextSelected: { color: colors.blueDark },
  response: { borderBottomWidth: 1, borderBottomColor: colors.line, paddingVertical: space.md, gap: space.sm }, responseHeader: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space.sm }, input: { ...controls.input, ...controls.inputMultiline, minHeight: 104 }, actions: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs }, reply: { padding: space.md, gap: space.xs, borderLeftWidth: 3, borderLeftColor: colors.blue, backgroundColor: colors.surface },
}));
