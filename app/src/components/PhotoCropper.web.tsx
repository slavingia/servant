import { useRef, useState } from "react";
import { Modal, StyleSheet, Text, View } from "react-native";
import { Button } from "./Button";
import { radius, space, typography, createThemedStyles } from "../lib/theme";
import type { CropSource } from "./PhotoCropper";

export type { CropSource };
const FRAME = 280;
const OUT = 512;

// Web has no native crop screen, so this one lets you drag and zoom the photo inside a square, like the phone does.
export function PhotoCropper({ source, onCancel, onDone }: { source: CropSource | null; onCancel: () => void; onDone: (base64: string) => void }) {
  return source ? <Cropper key={source.uri} source={source} onCancel={onCancel} onDone={onDone} /> : null;
}

function Cropper({ source, onCancel, onDone }: { source: CropSource; onCancel: () => void; onDone: (base64: string) => void }) {
  const styles = useStyles();
  const [zoom, setZoom] = useState(1);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const drag = useRef<{ px: number; py: number; ox: number; oy: number } | null>(null);
  const base = Math.max(FRAME / source.width, FRAME / source.height);
  const scale = base * zoom;
  const w = source.width * scale;
  const h = source.height * scale;
  const clamp = (p: { x: number; y: number }, nextW = w, nextH = h) => ({
    x: Math.min((nextW - FRAME) / 2, Math.max(-(nextW - FRAME) / 2, p.x)),
    y: Math.min((nextH - FRAME) / 2, Math.max(-(nextH - FRAME) / 2, p.y)),
  });
  const changeZoom = (z: number) => {
    const s = base * z;
    setZoom(z);
    setPos(p => clamp(p, source.width * s, source.height * s));
  };
  const save = () => {
    setBusy(true);
    const img = new window.Image();
    img.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = OUT; canvas.height = OUT;
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("canvas");
        const side = FRAME / scale;
        const sx = source.width / 2 - pos.x / scale - side / 2;
        const sy = source.height / 2 - pos.y / scale - side / 2;
        ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, OUT, OUT);
        ctx.drawImage(img, sx, sy, side, side, 0, 0, OUT, OUT);
        onDone(canvas.toDataURL("image/jpeg", 0.8).replace(/^data:[^,]*,/, ""));
      } catch { setBusy(false); setFailed(true); }
    };
    img.onerror = () => { setBusy(false); setFailed(true); };
    img.src = source.uri;
  };
  return (
    <Modal visible transparent animationType="fade" onRequestClose={() => { if (!busy) onCancel(); }}>
      <View style={styles.scrim}>
        <View style={styles.dialog} accessibilityViewIsModal>
          <Text accessibilityRole="header" style={styles.title}>Crop your photo</Text>
          <Text style={styles.description}>Drag to move it. Use the slider to zoom.</Text>
          <div
            data-testid="photo-crop-frame"
            style={{ position: "relative", width: FRAME, height: FRAME, overflow: "hidden", alignSelf: "center", marginTop: 16, borderRadius: 12, background: "#000", touchAction: "none", cursor: "grab", userSelect: "none" }}
            onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); drag.current = { px: e.clientX, py: e.clientY, ox: pos.x, oy: pos.y }; }}
            onPointerMove={e => { const d = drag.current; if (d) setPos(clamp({ x: d.ox + e.clientX - d.px, y: d.oy + e.clientY - d.py })); }}
            onPointerUp={() => { drag.current = null; }}
            onPointerCancel={() => { drag.current = null; }}
          >
            <img src={source.uri} alt="" draggable={false} style={{ position: "absolute", left: FRAME / 2 - w / 2 + pos.x, top: FRAME / 2 - h / 2 + pos.y, width: w, height: h, maxWidth: "none", pointerEvents: "none" }} />
            <div style={{ position: "absolute", inset: 0, borderRadius: "50%", boxShadow: "0 0 0 400px rgba(0,0,0,0.5)", border: "2px solid #fff", pointerEvents: "none" }} />
          </div>
          <input
            type="range" min={1} max={4} step={0.01} value={zoom} aria-label="Zoom"
            onChange={e => changeZoom(Number(e.target.value))}
            style={{ width: FRAME, alignSelf: "center", marginTop: 16 }}
          />
          {failed ? <Text accessibilityRole="alert" style={styles.error}>Couldn't use that photo. Try another one.</Text> : null}
          <View style={styles.actions}>
            <Button label="Cancel" kind="secondary" onPress={onCancel} disabled={busy} />
            <Button label="Save photo" onPress={save} busy={busy} />
          </View>
        </View>
      </View>
    </Modal>
  );
}

const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  scrim: { flex: 1, justifyContent: "center", alignItems: "center", padding: space.lg, backgroundColor: "rgba(17,46,81,0.42)" },
  dialog: { width: "100%", maxWidth: 360, backgroundColor: colors.background, borderRadius: radius.lg, padding: space.lg },
  title: { ...typography.heading, color: colors.ink },
  description: { ...typography.body, color: colors.muted, marginTop: space.sm },
  error: { ...typography.caption, color: colors.red, marginTop: space.sm },
  actions: { flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", gap: space.xs, marginTop: space.lg },
}));
