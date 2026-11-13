import { useEffect, useState } from "react";
import { Platform, StyleSheet, Text, View } from "react-native";
import { useActiveCall } from "../lib/active-call";
import { filterSupported, noiseMode, SPEAKER_TIP, speakerLikely } from "../lib/call-audio";
import { setNoisePref, useNoisePref } from "../lib/noise-store";
import { space, typography } from "../lib/theme";
import { Toggle } from "./Toggle";

/**
 * The "Noise reduction" switch, where it does something real:
 * - browsers and the Mac app: the page's own filter, on the check screen and during the call;
 * - Android: the phone's own suppressor, on the check screen (it is set when the microphone opens);
 * - iPhone: nothing we can set from the app, so no switch.
 * On the check screen (`precall`) it also carries the headphones tip when sound is likely to come
 * out of a speaker.
 */
export function NoiseToggle({ precall }: { precall?: boolean }) {
  const on = useNoisePref();
  const mode = noiseMode(Platform.OS);
  const active = useActiveCall();
  const status = precall ? undefined : active?.state.noiseFilter;
  const speaker = useSpeakerTip(!!precall && mode === "filter");
  const [supported] = useState(() => mode === "filter" && filterSupported(globalThis as any));
  if (mode === "none" || (mode === "native" && !precall) || (mode === "filter" && !supported)) return null;
  if (status === "unavailable") {
    return <Text style={styles.note}>Noise reduction unavailable. Using the browser filter.</Text>;
  }
  return (
    <View style={styles.wrap}>
      <View style={styles.row}>
        <View style={{ flex: 1 }}>
          <Text style={styles.label}>Noise reduction</Text>
        </View>
        <Toggle label="Noise reduction" value={on} onValueChange={setNoisePref} offColor="#3A465A" />
      </View>
      {speaker ? <Text style={styles.tip}>{SPEAKER_TIP}</Text> : null}
    </View>
  );
}

// The audio output list only has names once the microphone was allowed, so look a few times.
function useSpeakerTip(enabled: boolean) {
  const [tip, setTip] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    const md = (globalThis as any).navigator?.mediaDevices;
    if (!md?.enumerateDevices) return;
    let gone = false, tries = 0;
    const look = async () => {
      try {
        const outs = (await md.enumerateDevices()).filter((d: any) => d.kind === "audiooutput");
        if (gone) return;
        if (outs.some((d: any) => d.label)) { setTip(speakerLikely(outs)); return; }
      } catch { return; }
      if (++tries < 5) setTimeout(look, 1500);
    };
    void look();
    return () => { gone = true; };
  }, [enabled]);
  return tip;
}

const styles = StyleSheet.create({
  wrap: { gap: 4 },
  row: { flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: 44 },
  label: { ...typography.bodyStrong, color: "#FFFFFF" },
  note: { ...typography.caption, color: "#C9D3E0" },
  tip: { ...typography.caption, color: "#C9D3E0" },
});
