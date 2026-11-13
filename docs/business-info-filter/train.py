"""Train the business-information companion to Rampart Edge. Multi-label over taxonomy.LABELS plus an 'any' gate.
Splits by generation call (not by message) so near-duplicates from one call never straddle train/val."""
import glob, json, os, re, sys, hashlib, random, time
import numpy as np, torch, torch.nn as nn
from transformers import AutoTokenizer, AutoModel
from taxonomy import LABELS
BASE = "microsoft/xtremedistil-l6-h256-uncased"
MAXLEN = 256
dev = torch.device("mps" if torch.backends.mps.is_available() else "cpu")

def norm(t): return re.sub(r"\W+", " ", t.lower()).strip()
def load(dirpath, seen=None):
    seen = set() if seen is None else seen; rows = []
    for f in sorted(glob.glob(f"{dirpath}/*.json")):
        d = json.load(open(f)); job = d["job"]; jid = os.path.basename(f)[:-5]
        for it in d["items"]:
            t = (it.get("text") or "").strip(); k = norm(t)
            if len(t) < 3 or k in seen: continue
            seen.add(k)
            labs = [l for l in it.get("labels", []) if l in LABELS]
            if job["kind"] != "neg" and not labs: continue          # a positive with no valid label is noise
            if job["kind"] == "neg": labs = []
            rows.append({"text": t, "labels": labs, "job": jid, "kind": job["kind"], "type": job.get("type", "")})
    return rows, seen

def load_extra(path, seen):
    """Reviewed false-alarm reports (server.mjs business-reports export): JSON lines of {text, labels: []}. Benign rows only.
    They join training, never validation, so the threshold is still picked on data the people reporting cannot influence."""
    rows = []
    for line in open(path, encoding="utf8"):
        if not line.strip(): continue
        it = json.loads(line); t = (it.get("text") or "").strip(); k = norm(t)
        if len(t) < 3 or k in seen or it.get("labels"): continue   # labelled rows are not accepted from reports
        seen.add(k)
        rows.append({"text": t, "labels": [], "job": "report_" + hashlib.md5(k.encode()).hexdigest()[:8], "kind": "neg", "type": "false_alarm_report", "extra": True})
    return rows

def vec(r): return [1.0 if l in r["labels"] else 0.0 for l in LABELS] + [1.0 if r["labels"] else 0.0]

class Net(nn.Module):
    def __init__(self):
        super().__init__()
        self.enc = AutoModel.from_pretrained(BASE); self.drop = nn.Dropout(0.1)
        self.head = nn.Linear(self.enc.config.hidden_size, len(LABELS) + 1)
    def forward(self, input_ids, attention_mask):
        h = self.enc(input_ids=input_ids, attention_mask=attention_mask).last_hidden_state
        m = attention_mask.unsqueeze(-1).to(h.dtype)
        pooled = (h * m).sum(1) / m.sum(1).clamp(min=1)
        return self.head(self.drop(pooled))

def batches(tok, rows, bs, shuffle, rnd=None):
    idx = list(range(len(rows)))
    if shuffle: rnd.shuffle(idx)
    for i in range(0, len(idx), bs):
        chunk = [rows[j] for j in idx[i:i+bs]]
        e = tok([r["text"] for r in chunk], truncation=True, max_length=MAXLEN, padding=True, return_tensors="pt")
        yield e["input_ids"].to(dev), e["attention_mask"].to(dev), torch.tensor([vec(r) for r in chunk]).to(dev)

@torch.no_grad()
def predict(net, tok, rows, bs=64):
    net.eval(); out = []
    for ids, am, _ in batches(tok, rows, bs, False): out.append(torch.sigmoid(net(ids, am)).cpu().numpy())
    return np.concatenate(out) if out else np.zeros((0, len(LABELS) + 1))

def auroc(pos, neg):
    from sklearn.metrics import roc_auc_score
    return float(roc_auc_score([1]*len(pos) + [0]*len(neg), list(pos) + list(neg)))

def threshold_for(neg_scores, max_fpr):
    s = np.sort(np.asarray(neg_scores)); k = int(np.ceil(len(s) * (1 - max_fpr))) - 1
    return float(min(1.0, max(s[min(max(k, 0), len(s) - 1)] + 1e-6, 0.05)))

if __name__ == "__main__":
    epochs = int(os.environ.get("EPOCHS", 5)); lr = float(os.environ.get("LR", 5e-5)); out = os.environ.get("OUT", "model")
    torch.manual_seed(1); rnd = random.Random(1)
    rows, seen = load("data/raw")
    extra = []
    if "--extra" in sys.argv:
        extra = load_extra(sys.argv[sys.argv.index("--extra") + 1], seen)
        print(f"{len(extra)} reviewed false-alarm reports added to training only", flush=True)
    train = [r for r in rows if int(hashlib.md5(r["job"].encode()).hexdigest(), 16) % 10 != 0] + extra
    val = [r for r in rows if int(hashlib.md5(r["job"].encode()).hexdigest(), 16) % 10 == 0]
    print(f"rows {len(rows)}  train {len(train)}  val {len(val)}  (pos {sum(1 for r in train if r['labels'])} / neg {sum(1 for r in train if not r['labels'])})", flush=True)
    tok = AutoTokenizer.from_pretrained(BASE); net = Net().to(dev)
    head_lr = float(os.environ.get("HEAD_LR", lr * 10))   # the output layer starts from nothing: let it learn faster
    opt = torch.optim.AdamW([{"params": net.enc.parameters(), "lr": lr}, {"params": net.head.parameters(), "lr": head_lr}], weight_decay=0.01)
    steps = epochs * ((len(train) + 31) // 32); sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=[lr, head_lr], total_steps=steps, pct_start=0.1)
    lossf = nn.BCEWithLogitsLoss(); best = (-1, None)
    for ep in range(epochs):
        net.train(); t0 = time.time(); tot = 0; n = 0
        for ids, am, y in batches(tok, train, 32, True, rnd):
            opt.zero_grad(); loss = lossf(net(ids, am), y); loss.backward()
            nn.utils.clip_grad_norm_(net.parameters(), 1.0); opt.step(); sched.step(); tot += loss.item(); n += 1
        p = predict(net, tok, val); anyp = p[:, -1]
        isneg = np.array([not r["labels"] for r in val])
        a = auroc(anyp[~isneg], anyp[isneg]); thr = threshold_for(anyp[isneg], 0.01)
        rec = float((anyp[~isneg] >= thr).mean())
        print(f"epoch {ep+1}/{epochs}  loss {tot/n:.4f}  val AUROC {a:.4f}  catch@1%FPR {rec:.3f}  ({time.time()-t0:.0f}s)", flush=True)
        score = rec + a
        if score > best[0]: best = (score, {k: v.detach().cpu().clone() for k, v in net.state_dict().items()}, ep + 1)
    net.load_state_dict(best[1]); print("best epoch", best[2], flush=True)
    os.makedirs(out, exist_ok=True); torch.save(best[1], f"{out}/best.pt")
    json.dump({"labels": LABELS, "best_epoch": best[2]}, open(f"{out}/meta.json", "w"))
