// Warns before personal information is saved in a chat (docs/features.md "A warning before personal information").
// Rampart Edge (National Design Studio, CC0) runs here on this machine: a 1.45 MB model plus checksummed
// rules. Nothing is sent anywhere. The model files and runtime live outside the releases, in
// $SERVANT_PII_DIR (default ~/.local/share/servant/models/rampart-edge), so a deploy never copies them.
// Turn on in config.json:  "piiWarning": { "enabled": true }
// Warn only: the person can send anyway. A full name alone does not warn. If the model cannot load, the
// rules still run; if nothing loads, sending works as before.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DIR = () => process.env.SERVANT_PII_DIR || path.join(os.homedir(), ".local/share/servant/models/rampart-edge");
const WORDS = {
  GOV_ID: "a government ID number",
  FINANCIAL: "a card or bank number",
  PHONE: "a phone number",
  EMAIL: "a personal email address",
  ADDRESS: "a home address",
  DOB_KEYED: "a date of birth",
  URL_HANDLE: "a personal profile link",
  OTHER_ID: "a case or record number",
};
export const WARN_TYPES = Object.keys(WORDS);

export function piiWarningEnabled(raw) { return !!raw && typeof raw === "object" && raw.enabled === true; }

export function warningText(types) {
  const list = types.map(t => WORDS[t]).filter(Boolean);
  const joined = list.length > 1 ? `${list.slice(0, -1).join(", ")} and ${list.at(-1)}` : list[0];
  return `This looks like it has ${joined}. Servant isn't approved for personal or sensitive information.`;
}

// The types that should warn: model/rule spans minus bare names.
export function typesToWarn(spans) {
  return [...new Set((spans || []).map(s => s.type).filter(t => WARN_TYPES.includes(t)))];
}

let loading = null;
async function load() {
  const dir = DIR();
  const rp = await import(pathToFileURL(path.join(dir, "node_modules/@nationaldesignstudio/rampart-edge/dist/index.js")).href);
  try {
    const ort = await import(pathToFileURL(path.join(dir, "node_modules/onnxruntime-node/dist/index.js")).href);
    const bytes = new Uint8Array(fs.readFileSync(path.join(dir, "onnx/model_q4.onnx")));
    await rp.verifyPinned("onnx/model_q4.onnx", bytes, rp.MODEL_FILES["onnx/model_q4.onnx"]);
    const model = await rp.createGateModel(ort.default ?? ort, bytes, fs.readFileSync(path.join(dir, "vocab.txt"), "utf8"), { executionProviders: ["cpu"] });
    return { gate: new rp.Gate(model), model: true };
  } catch (e) {
    console.error(`[servant] PII model unavailable, using rules only: ${e?.message || e}`);
    return { gate: rp.createValidatorGate(), model: false };
  }
}
export function pii() { return (loading ??= load().catch(e => { console.error(`[servant] PII check unavailable: ${e?.message || e}`); return null; })); }

// null = fine to send; otherwise { types, message }. Never throws.
export async function screenText(text, { check } = {}) {
  try {
    const gate = check ? { check } : (await pii())?.gate;
    if (!gate) return null;
    const decision = await gate.check(String(text || "").slice(0, 20000));
    if (decision.verdict !== "BLOCK") return null;
    const types = typesToWarn(decision.spans);
    return types.length ? { types, message: warningText(types) } : null;
  } catch (e) {
    console.error(`[servant] PII check failed: ${e?.message || e}`);
    return null;
  }
}
