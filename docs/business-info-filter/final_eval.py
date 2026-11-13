"""Final calibration on the int8 graph that will ship: choose the threshold on validation negatives only (<=1% false warns),
then report every held-out set at that single threshold. Also checks how well the category head names what it found."""
import glob, hashlib, json, collections, numpy as np, onnxruntime as ort
from transformers import AutoTokenizer
import train
from taxonomy import LABELS
from evaluate import rampart, RAMP_T

tok = AutoTokenizer.from_pretrained(train.BASE)
s = ort.InferenceSession("model/business-int8.onnx", providers=["CPUExecutionProvider"])


def probs(texts):
    out = []
    for t in texts:
        x = tok(t, truncation=True, max_length=train.MAXLEN, return_tensors="np")
        out.append(s.run(None, {"input_ids": x["input_ids"].astype(np.int64), "attention_mask": x["attention_mask"].astype(np.int64)})[0][0])
    return np.array(out)


rows, seen = train.load("data/raw")
val = [r for r in rows if int(hashlib.md5(r["job"].encode()).hexdigest(), 16) % 10 == 0]
pv = probs([r["text"] for r in val])
neg = np.array([not r["labels"] for r in val])
thr = json.load(open("model/threshold_int8.json"))["threshold"]   # set by pick_threshold.py on validation only
print(f"threshold {thr:.4f} (from pick_threshold.py: highest threshold keeping validation catch >= 98%, int8 graph)\n")

tests, s2 = train.load("data/test", seen)
t2, _ = train.load("data/test2", s2 | {train.norm(r["text"]) for r in tests})
ood = []
for f in sorted(glob.glob("data/ood/*.json")):
    d = json.load(open(f))
    for t in d["items"]:
        if t.strip():
            ood.append({"text": t, "labels": d["labels"], "type": "hard" if f.split("/")[-1] in {f"neg_{k}.json" for k in range(0, 8, 2)} else "plain"})


def rep(name, rs):
    p = probs([r["text"] for r in rs])
    pos = np.array([bool(r["labels"]) for r in rs])
    hit = p[:, -1] >= thr
    ramp = np.array([rampart(r["text"]) >= RAMP_T for r in rs])
    print(f"{name:34s} n={len(rs):4d} ({pos.sum()}+/{(~pos).sum()}-)  catch {hit[pos].mean():.3f}  false-warn {hit[~pos].mean():.3f}  AUROC {train.auroc(p[pos, -1], p[~pos, -1]):.4f}   | base Rampart catch {ramp[pos].mean():.3f} fw {ramp[~pos].mean():.3f}", flush=True)
    return p, pos, hit


rep("validation", val)
pt, post, hitt = rep("TEST (new seed)", tests)
rep("TEST2 (no-digit / numeric / long)", t2)
po, poso, hito = rep("INDEPENDENT (Fable 5.2, personas)", ood)
print()
# Category naming: argmax among the 8 category outputs, for messages the gate flagged
for name, rs, p, pos, hit in (("TEST", tests, pt, post, hitt), ("INDEPENDENT", ood, po, poso, hito)):
    ok = tot = 0
    conf = collections.Counter()
    for i, r in enumerate(rs):
        if pos[i] and hit[i] and len(r["labels"]) == 1:
            tot += 1
            g = LABELS[int(np.argmax(p[i, :-1]))]
            ok += g == r["labels"][0]
            if g != r["labels"][0]:
                conf[(r["labels"][0], g)] += 1
    print(f"{name}: argmax category right on {ok}/{tot} = {ok / tot:.3f}; most common mixups: {conf.most_common(4)}")
print("\nFalse warns on INDEPENDENT set:")
for i in np.where(hito & ~poso)[0]:
    print(f"  {po[i, -1]:.2f} {ood[i]['text'][:150]!r}")
print("\nMissed on INDEPENDENT set:")
for i in np.where(~hito & poso)[0]:
    print(f"  {po[i, -1]:.2f} {ood[i]['labels']} {ood[i]['text'][:150]!r}")
