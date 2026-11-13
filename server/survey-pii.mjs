// Survey comments are redacted before storage. Unlike the chat warning, this
// path requires the local model and fails closed without exposing diagnostics.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_INPUT = 2000;
const MAX_OUTPUT = 20000;
const PLACEHOLDER = '[REDACTED]';
const unavailable = () => Object.assign(new Error('Personal information removal is unavailable. Please try submitting your feedback again later.'), { status: 503, code: 'survey_pii_unavailable' });

async function loadLocalRedactor() {
  const dir = process.env.SERVANT_PII_DIR || path.join(os.homedir(), '.local/share/servant/models/rampart-edge');
  const runtime = path.join(dir, 'node_modules/@nationaldesignstudio/rampart-edge/dist');
  const rampart = await import(pathToFileURL(path.join(runtime, 'index.js')).href);
  const redaction = await import(pathToFileURL(path.join(runtime, 'redactor.js')).href);
  const ort = await import(pathToFileURL(path.join(dir, 'node_modules/onnxruntime-node/dist/index.js')).href);
  const modelBytes = new Uint8Array(fs.readFileSync(path.join(dir, 'onnx/model_q4.onnx')));
  const vocabBytes = new Uint8Array(fs.readFileSync(path.join(dir, 'vocab.txt')));
  await rampart.verifyPinned('onnx/model_q4.onnx', modelBytes, rampart.MODEL_FILES['onnx/model_q4.onnx']);
  await rampart.verifyPinned('vocab.txt', vocabBytes, rampart.MODEL_FILES['vocab.txt']);
  const model = await rampart.createGateModel(ort.default ?? ort, modelBytes, new TextDecoder().decode(vocabBytes), { executionProviders: ['cpu'] });
  const gate = new rampart.Gate(model);
  // createRedactor falls back to downloading if no gate model exists. Refuse
  // that path: surveys must use the checked local files and a real span head.
  if (!gate.model?.spanHead) throw unavailable();
  return redaction.createRedactor({ gate });
}

const splitsSurrogate = (text, at) => at > 0 && at < text.length
  && /[\uD800-\uDBFF]/.test(text[at - 1]) && /[\uDC00-\uDFFF]/.test(text[at]);

function checkedSpans(text, spans) {
  if (!Array.isArray(spans) || spans.length > text.length) throw unavailable();
  const sorted = spans.map(span => {
    if (!span || !Number.isInteger(span.start) || !Number.isInteger(span.end)
      || span.start < 0 || span.end <= span.start || span.end > text.length
      || splitsSurrogate(text, span.start) || splitsSurrogate(text, span.end)) throw unavailable();
    return { start: span.start, end: span.end };
  }).sort((a, b) => a.start - b.start || a.end - b.end);
  for (let index = 1; index < sorted.length; index++) if (sorted[index].start < sorted[index - 1].end) throw unavailable();
  return sorted;
}

function replaceSpans(text, spans) {
  let at = 0, result = '';
  for (const span of spans) {
    result += text.slice(at, span.start) + PLACEHOLDER;
    at = span.end;
  }
  result += text.slice(at);
  if (result.length > MAX_OUTPUT) throw unavailable();
  return result;
}

function supplementalSpans(text) {
  // Retain the existing survey checks' breadth: all email domains and long
  // numeric identifiers. Rampart intentionally exempts some public mailboxes.
  // Map compatibility characters back to original UTF-16 offsets so scanning
  // full-width digits or hidden separators never changes unrelated text.
  let normalized = '', offset = 0;
  const offsets = [];
  for (const character of text) {
    const part = character.normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g, '');
    normalized += part;
    if (normalized.length > MAX_OUTPUT) throw unavailable();
    for (let index = 0; index < part.length; index++) offsets.push({ start: offset, end: offset + character.length });
    offset += character.length;
  }
  const spans = [];
  for (const pattern of [/[^\s@]+@[^\s@]+\.[^\s@]+/g, /\d(?:[\s().+\-]*\d){6,}/g]) {
    for (const match of normalized.matchAll(pattern)) {
      const length = match[0].replace(/[.,;:!?)}\]]+$/, '').length;
      spans.push({ start: offsets[match.index].start, end: offsets[match.index + length - 1].end });
    }
  }
  return spans;
}

function unionSpans(spans) {
  const result = [];
  for (const span of spans.sort((a, b) => a.start - b.start || a.end - b.end)) {
    const last = result.at(-1);
    if (last && span.start < last.end) last.end = Math.max(last.end, span.end);
    else result.push({ ...span });
  }
  return result;
}

// The optional loader lets tests exercise failure and recovery without model
// downloads. Production always uses the strict local loader above.
export function createSurveyRedactor({ load = loadLocalRedactor } = {}) {
  let loading = null;
  return async function redact(text) {
    try {
      if (typeof text !== 'string' || text.length > MAX_INPUT) throw unavailable();
      if (!text) return '';
      const supplemental = supplementalSpans(text);
      loading ??= Promise.resolve().then(load).catch(() => { loading = null; throw unavailable(); });
      const redactor = await loading;
      if (typeof redactor?.redact !== 'function') throw unavailable();
      // Use the redactor on every comment, including names that a chat warning
      // would allow. It uses the full model windowing, not a truncated prefix.
      const result = await redactor.redact(text);
      if (!result || typeof result.text !== 'string') throw unavailable();
      const spans = checkedSpans(text, result.spans);
      if (result.text !== replaceSpans(text, spans)) throw unavailable();
      return replaceSpans(text, unionSpans([...spans, ...supplemental]));
    } catch {
      // Never log or attach an inference error, input, spans or original text.
      throw unavailable();
    }
  };
}

export const redactSurveyText = createSurveyRedactor();
