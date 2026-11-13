"""Robust threshold: the HIGHEST threshold at which validation catch is still >= 98%. Chosen on validation only.
(The old rule, 'lowest false-warn <= 1% quantile of ~300 negatives', let three examples set the threshold, and a very low
threshold sits inside int8 quantization noise.)"""
import hashlib, json, sys, numpy as np, onnxruntime as ort
from transformers import AutoTokenizer
import train

tok = AutoTokenizer.from_pretrained(train.BASE)
rows, seen = train.load("data/raw")
val = [r for r in rows if int(hashlib.md5(r["job"].encode()).hexdigest(), 16) % 10 == 0]
pos = np.array([bool(r["labels"]) for r in val])


def probs(path, texts):
    s = ort.InferenceSession(path, providers=["CPUExecutionProvider"])
    out = []
    for t in texts:
        x = tok(t, truncation=True, max_length=train.MAXLEN, return_tensors="np")
        out.append(s.run(None, {"input_ids": x["input_ids"].astype(np.int64), "attention_mask": x["attention_mask"].astype(np.int64)})[0][0][-1])
    return np.array(out)


res = {}
for name in ("business-fp32.onnx", "business-int8.onnx"):
    p = probs("model/" + name, [r["text"] for r in val])
    res[name] = p
    print(name, "positives: p5 %.2f p25 %.2f median %.2f | negatives: median %.4f p95 %.3f p99 %.3f max %.3f" % (
        np.percentile(p[pos], 5), np.percentile(p[pos], 25), np.median(p[pos]),
        np.median(p[~pos]), np.percentile(p[~pos], 95), np.percentile(p[~pos], 99), p[~pos].max()))
    print("   threshold -> val catch / val false-warn")
    for t in (0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7):
        print(f"     {t:.2f} -> {np.mean(p[pos] >= t):.3f} / {np.mean(p[~pos] >= t):.3f}")
p = res["business-int8.onnx"]
ts = np.arange(0.02, 0.95, 0.01)
ok = [t for t in ts if np.mean(p[pos] >= t) >= 0.98]
thr = float(max(ok))
print(f"\nchosen threshold (highest with val catch >= 98%, int8): {thr:.2f}")
json.dump({"threshold": thr, "rule": "highest threshold with validation catch >= 0.98 on the int8 graph"}, open("model/threshold_int8.json", "w"))
json.dump({"threshold": thr}, open("model/threshold.json", "w"))
