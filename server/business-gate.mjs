// Sensitive BUSINESS information check: a small companion to Rampart Edge (pii-gate.mjs), trained on synthetic data
// (docs/business-info-filter.md). It warns before a chat message with a live-looking secret, a bid price or other
// non-public procurement detail, an unreleased budget figure, a security finding, restricted or pre-decisional text,
// a personnel matter, vendor-proprietary material or tax return details is saved.
//
// Runs on this machine; nothing is sent anywhere. Files live beside the Rampart Edge model, in <model dir>/business
// (SERVANT_PII_DIR, default ~/.local/share/servant/models/rampart-edge), so a deploy never copies them, and are
// checksum-verified before use. Turn on in config.json:  "piiWarning": { "enabled": true, "businessInfo": true }
// Warn only. If the files are missing or do not load, this check is skipped and sending works as before.
// The warning is general: it never quotes the message and does not guess which category it is.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { piiWarningEnabled, screenText } from "./pii-gate.mjs";

const DIR = () => path.join(process.env.SERVANT_PII_DIR || path.join(os.homedir(), ".local/share/servant/models/rampart-edge"), "business");
const MAX_TOKENS = 256;
const MAX_CHARS = 4000; // the model reads the first 256 word pieces; this just bounds the work

export const BUSINESS_WARNING = "This looks like it may have sensitive business information, such as a secret or password, a bid or budget figure, a security finding, restricted or unreleased material, or details about personnel or someone's tax return. Servant isn't approved for sensitive information.";

export function businessWarningEnabled(raw) { return !!raw && typeof raw === "object" && raw.enabled === true && raw.businessInfo === true; }

// ---- WordPiece (BERT, lower-cased, accents stripped), checked against the Python tokenizer in business-gate.test.mjs ----
const isPunct = (ch) => {
  const c = ch.codePointAt(0);
  return (c >= 33 && c <= 47) || (c >= 58 && c <= 64) || (c >= 91 && c <= 96) || (c >= 123 && c <= 126) || /\p{P}/u.test(ch);
};
const isCjk = (c) => (c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3400 && c <= 0x4dbf) || (c >= 0x20000 && c <= 0x2a6df) || (c >= 0x2a700 && c <= 0x2ebef) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0x2f800 && c <= 0x2fa1f);

export function createTokenizer(vocabText) {
  const ids = new Map();
  const lines = vocabText.split("\n");
  if (lines.at(-1) === "") lines.pop();
  lines.forEach((t, i) => ids.set(t, i));
  const need = (t) => { if (!ids.has(t)) throw new Error(`vocab has no ${t}`); return ids.get(t); };
  const unk = need("[UNK]"), cls = need("[CLS]"), sep = need("[SEP]"), pad = need("[PAD]");
  const SPECIAL = new Set(["[PAD]", "[UNK]", "[CLS]", "[SEP]", "[MASK]"]);
  function basic(text) {
    let clean = "";
    for (const ch of text) {
      const c = ch.codePointAt(0);
      if (c === 0 || c === 0xfffd) continue;
      if (/\p{Cc}|\p{Cf}/u.test(ch) && ch !== "\t" && ch !== "\n" && ch !== "\r") continue;
      if (/\s/u.test(ch)) { clean += " "; continue; }
      clean += isCjk(c) ? ` ${ch} ` : ch;
    }
    const out = [];
    for (const word of clean.split(/\s+/).filter(Boolean)) {
      const norm = word.toLowerCase().normalize("NFD").replace(/\p{Mn}/gu, "");
      let cur = "";
      for (const ch of norm) {
        if (isPunct(ch)) { if (cur) out.push(cur); out.push(ch); cur = ""; } else cur += ch;
      }
      if (cur) out.push(cur);
    }
    return out;
  }
  function wordPiece(word) {
    if ([...word].length > 100) return [unk];
    const chars = [...word], out = [];
    let start = 0;
    while (start < chars.length) {
      let end = chars.length, found = null;
      while (start < end) {
        const piece = (start > 0 ? "##" : "") + chars.slice(start, end).join("");
        if (ids.has(piece)) { found = ids.get(piece); break; }
        end--;
      }
      if (found === null) return [unk];
      out.push(found); start = end;
    }
    return out;
  }
  function encode(text) {
    const out = [];
    for (const segment of text.split(/(\[PAD\]|\[UNK\]|\[CLS\]|\[SEP\]|\[MASK\])/)) {
      if (SPECIAL.has(segment)) { out.push(ids.get(segment)); continue; }
      for (const w of basic(segment)) out.push(...wordPiece(w));
    }
    return out;
  }
  return { encode, cls, sep, pad, size: ids.size };
}

function sha256(file) { return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"); }

let loading = null;
async function load() {
  const dir = DIR();
  const meta = JSON.parse(fs.readFileSync(path.join(dir, "threshold.json"), "utf8"));
  for (const [name, want] of Object.entries(meta.files || {})) {
    const file = path.join(dir, name);
    if (fs.statSync(file).size !== want.bytes || sha256(file) !== want.sha256) throw new Error(`${name} does not match its checksum`);
  }
  if (!Number.isFinite(meta.threshold) || meta.threshold <= 0 || meta.threshold >= 1) throw new Error("bad threshold");
  const ortRoot = path.join(process.env.SERVANT_PII_DIR || path.join(os.homedir(), ".local/share/servant/models/rampart-edge"), "node_modules/onnxruntime-node/dist/index.js");
  const ort = await import(pathToFileURL(ortRoot).href);
  const lib = ort.default ?? ort;
  const session = await lib.InferenceSession.create(path.join(dir, "business-int8.onnx"), { executionProviders: ["cpu"] });
  const tokenizer = createTokenizer(fs.readFileSync(path.join(dir, "vocab.txt"), "utf8"));
  const maxTokens = Math.min(Number(meta.maxTokens) || MAX_TOKENS, 512);
  return {
    threshold: meta.threshold,
    async score(text) {
      const body = tokenizer.encode(String(text || "").slice(0, MAX_CHARS)).slice(0, maxTokens - 2);
      const input = BigInt64Array.from([tokenizer.cls, ...body, tokenizer.sep].map(BigInt));
      const mask = BigInt64Array.from(input, () => 1n);
      const out = await session.run({
        input_ids: new lib.Tensor("int64", input, [1, input.length]),
        attention_mask: new lib.Tensor("int64", mask, [1, input.length]),
      });
      const probs = out[Object.keys(out)[0]].data;
      return probs[probs.length - 1]; // the last output is "any sensitive business information"
    },
  };
}
export function business() {
  return (loading ??= load().catch((e) => { console.error(`[servant] business-info check unavailable: ${e?.message || e}`); return null; }));
}

/** Both checks, in order: personal information first (it names what it found), then business information.
 * `raw` is the piiWarning config (true is accepted as { enabled: true }). null = fine to send, else { message, types? }. */
export async function screenMessage(text, raw, { personal = screenText, businessCheck = screenBusiness } = {}) {
  const cfg = raw === true ? { enabled: true } : raw;
  if (!piiWarningEnabled(cfg)) return null;
  const warn = await personal(text);
  if (warn) return warn;
  return businessWarningEnabled(cfg) ? businessCheck(text) : null;
}

/** For a false-alarm report: did the business check really warn on this text, and with what score? Never throws.
 * { warned: false } when it would not warn (or cannot run), so a report can only ever be about a real warning. */
export async function businessVerdict(text, { score } = {}) {
  try {
    const clean = String(text || "");
    if (!clean.trim()) return { warned: false };
    if (score) { const p = await score(clean); return { warned: p >= 0.5, score: p }; }
    const m = await business();
    if (!m) return { warned: false };
    const p = await m.score(clean);
    return { warned: p >= m.threshold, score: p };
  } catch { return { warned: false }; }
}

// null = fine to send; otherwise { message }. Never throws. `score` is for tests.
export async function screenBusiness(text, { score } = {}) {
  try {
    const clean = String(text || "");
    if (!clean.trim()) return null;
    let p, threshold;
    if (score) { p = await score(clean); threshold = 0.5; }
    else {
      const m = await business();
      if (!m) return null;
      p = await m.score(clean); threshold = m.threshold;
    }
    return p >= threshold ? { message: BUSINESS_WARNING, business: true } : null;
  } catch (e) {
    console.error(`[servant] business-info check failed: ${e?.message || e}`);
    return null;
  }
}
