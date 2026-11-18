import { useEffect, useEffectEvent, useRef, useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { Button } from "../../components/Button";
import { codeFromParams, describeCode, LINK_POLL_MS, LINK_WAIT_MS, planLink, type LinkCode } from "../../lib/code-fill-link";
import { api, ServerError, type Account, type CodeRequest } from "../../lib/server";
import { useSession } from "../../lib/session";
import { createThemedStyles, space, typography, useTheme } from "../../lib/theme";

// Opened by servant://code?text=… from a Shortcuts automation on the phone, for a text whose code iOS keeps to the
// site it names (docs/code-requests.md). The code goes to the one request waiting; with several, the person picks.
// It never makes or reads a request, and the code is never shown back or kept here.
export default function CodeFromLink() {
  const params = useLocalSearchParams<{ text?: string; code?: string; site?: string }>();
  const { account } = useSession();
  const found = codeFromParams(params);
  if (!account) return null;
  return <LinkAnswer key={`${found?.code ?? ""}:${found?.site ?? ""}:${account.token}`} account={account} found={found} />;
}

type State =
  | { kind: "looking" }
  | { kind: "waiting" }
  | { kind: "sending" }
  | { kind: "sent"; request: CodeRequest }
  | { kind: "choose"; requests: CodeRequest[] }
  | { kind: "length"; request: CodeRequest; got: number }
  | { kind: "none" }
  | { kind: "error"; message: string };

function LinkAnswer({ account, found }: { account: Account; found: LinkCode | null }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const [state, setState] = useState<State>(found ? { kind: "looking" } : { kind: "error", message: "This link has no code in it. Check the automation passes the text it received, then try again." });
  const [attempt, setAttempt] = useState(0);
  const sent = useRef(false);

  const send = async (request: CodeRequest) => {
    if (!found || sent.current) return;
    sent.current = true;
    setState({ kind: "sending" });
    try {
      const answered = await api.answerCodeRequest(account, request.id, found.code);
      setState({ kind: "sent", request: answered.request });
    } catch (e) {
      sent.current = false;
      setState({ kind: "error", message: e instanceof ServerError && e.message ? e.message : "Couldn't send the code. Check your connection and try again." });
    }
  };

  // The code goes to the request the plan picks; reading found here keeps the look-up below about the code alone.
  const answer = useEffectEvent((request: CodeRequest) => void send(request));
  const code = found?.code ?? null;
  useEffect(() => {
    if (!code) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const until = Date.now() + LINK_WAIT_MS;
    const look = async () => {
      try {
        const { requests } = await api.codeRequests(account);
        if (!live) return;
        const plan = planLink(requests, code);
        if (plan.kind === "wait") {
          if (Date.now() < until) { setState({ kind: "waiting" }); timer = setTimeout(() => void look(), LINK_POLL_MS); }
          else setState({ kind: "none" });
          return;
        }
        if (plan.kind === "send") return answer(plan.request);
        setState(plan);
      } catch (e) {
        if (live) setState({ kind: "error", message: e instanceof ServerError && e.message ? e.message : "Couldn't check for a code request. Check your connection and try again." });
      }
    };
    void look();
    return () => { live = false; if (timer) clearTimeout(timer); };
  }, [account, code, attempt]);

  const done = () => router.canGoBack() ? router.back() : router.replace("/");
  const what = found ? describeCode(found) : "code";

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.body}>
      {state.kind === "sent" ? <>
        <Text accessibilityRole="header" style={styles.title}>Code sent</Text>
        <Text style={styles.lead}>{state.request.device} can continue with {state.request.label} now. The code isn't kept here.</Text>
        <Button label="Done" onPress={done} style={styles.action} />
      </> : state.kind === "choose" ? <>
        <Text accessibilityRole="header" style={styles.title}>Which sign-in is this for?</Text>
        <Text style={styles.lead}>You have {state.requests.length} code requests waiting. Send the {what} to the one you started.</Text>
        {state.requests.map(request => (
          <View key={request.id} style={styles.choice}>
            <Text style={styles.choiceLabel}>{request.label}</Text>
            <Text style={styles.keep}>{request.device}{request.hint ? ` · ${request.hint}` : ""}</Text>
            <Button label={`Send to ${request.label}`} kind="secondary" onPress={() => void send(request)} style={styles.choiceAction} />
          </View>
        ))}
        <Button label="Don't send" kind="link" onPress={done} style={styles.action} />
      </> : state.kind === "length" ? <>
        <Text accessibilityRole="header" style={styles.title}>Code not sent</Text>
        <Text style={styles.lead}>{state.request.device} expects a {state.request.length}-character code for {state.request.label}, but the text had a {state.got}-character one. Open the request and type the code.</Text>
        <Button label="Open the request" onPress={() => router.replace({ pathname: "/code/[id]", params: { id: state.request.id } })} style={styles.action} />
        <Button label="Don't send" kind="link" onPress={done} style={styles.secondary} />
      </> : state.kind === "none" ? <>
        <Text accessibilityRole="header" style={styles.title}>No code request waiting</Text>
        <Text style={styles.lead}>Nothing has asked for a code in the last minute, so the {what} wasn't sent. Start the sign-in, then open the link again.</Text>
        <Button label="Look again" onPress={() => { setState({ kind: "looking" }); setAttempt(n => n + 1); }} style={styles.action} />
        <Button label="Back to Servant" kind="link" onPress={done} style={styles.secondary} />
      </> : state.kind === "error" ? <>
        <Text accessibilityRole="header" style={styles.title}>Code not sent</Text>
        <Text accessibilityRole="alert" style={styles.error}>{state.message}</Text>
        {found ? <Button label="Try again" onPress={() => { setState({ kind: "looking" }); setAttempt(n => n + 1); }} style={styles.action} /> : null}
        <Button label="Back to Servant" kind="link" onPress={done} style={styles.secondary} />
      </> : <>
        <Text accessibilityRole="header" style={styles.title}>{state.kind === "waiting" ? "Waiting for a code request" : "Sending code"}</Text>
        <Text style={styles.lead}>{state.kind === "waiting" ? `Got a ${what}. It goes to the sign-in that asks for it in the next minute.` : `Sending the ${what} to the sign-in that asked for it.`}</Text>
        <ActivityIndicator accessibilityLabel={state.kind === "waiting" ? "Waiting for a code request" : "Sending code"} color={colors.blue} size="large" style={styles.action} />
        {state.kind === "waiting" ? <Button label="Don't send" kind="link" onPress={done} style={styles.secondary} /> : null}
      </>}
    </ScrollView>
  );
}

const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  body: { padding: space.side, paddingBottom: space.xxl, width: "100%", maxWidth: 520, alignSelf: "center" },
  title: { ...typography.title, color: colors.ink },
  lead: { ...typography.body, color: colors.ink, marginTop: space.xs },
  keep: { ...typography.caption, color: colors.muted, marginTop: space.xs },
  error: { ...typography.body, marginTop: space.xs, color: colors.red },
  action: { marginTop: space.md },
  secondary: { marginTop: space.sm },
  choice: { marginTop: space.md, paddingTop: space.md, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  choiceLabel: { ...typography.label, color: colors.ink },
  choiceAction: { marginTop: space.sm },
}));
