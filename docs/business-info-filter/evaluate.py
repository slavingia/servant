import json, sys, re, numpy as np, torch
import onnxruntime as ort
from transformers import AutoTokenizer
import train
from taxonomy import LABELS
import os
D=os.environ.get("SERVANT_PII_DIR") or os.path.expanduser("~/.local/share/servant/models/rampart-edge")
rs=ort.InferenceSession(D+"/onnx/model_q4.onnx"); rtok=AutoTokenizer.from_pretrained(D)
def rampart(t):
    e=rtok(t,truncation=True,max_length=384,return_tensors="np")
    g,_=rs.run(None,{"input_ids":e["input_ids"].astype(np.int64),"attention_mask":e["attention_mask"].astype(np.int64)})
    return float(1/(1+np.exp(-g[0])))
RAMP_T=0.417801
def load_model(path="model/best.pt"):
    tok=AutoTokenizer.from_pretrained(train.BASE); net=train.Net().to(train.dev); net.load_state_dict(torch.load(path)); net.eval(); return tok,net
def score(rows, tok, net): return train.predict(net,tok,rows)
def report(name, rows, p, thr):
    pos=np.array([bool(r["labels"]) for r in rows]); any_=p[:,-1]; hit=any_>=thr
    ramp=np.array([rampart(r["text"])>=RAMP_T for r in rows])
    print(f"\n=== {name}: {len(rows)} rows ({pos.sum()} sensitive / {(~pos).sum()} benign), threshold {thr:.3f}")
    print(f"  new model      catch {hit[pos].mean():.3f}   false-warn {hit[~pos].mean():.3f}   AUROC {train.auroc(any_[pos],any_[~pos]):.4f}")
    print(f"  base Rampart   catch {ramp[pos].mean():.3f}   false-warn {ramp[~pos].mean():.3f}   (what runs today; neural half only)")
    both=hit|ramp
    print(f"  both together  catch {both[pos].mean():.3f}   false-warn {both[~pos].mean():.3f}")
    return hit
if __name__=="__main__":
    tok,net=load_model()
    rows,seen=train.load("data/raw")
    import hashlib
    val=[r for r in rows if int(hashlib.md5(r["job"].encode()).hexdigest(),16)%10==0]
    pv=score(val,tok,net); isneg=np.array([not r["labels"] for r in val])
    thr=train.threshold_for(pv[isneg,-1],0.01)
    print("threshold chosen on validation negatives (<=1% false warns):",round(thr,4))
    report("validation (same generator, seen only through model selection)",val,pv,thr)
    tests,s2=train.load("data/test",seen); pt=score(tests,tok,net); hitT=report("TEST (new seed, new generation calls, deduped against training)",tests,pt,thr)
    t2,_=train.load("data/test2",s2|{train.norm(r["text"]) for r in tests}); p2=score(t2,tok,net); report("TEST2 hard set (positives with no digits, plus numeric and long benign)",t2,p2,thr)
    print("\nPer category on TEST (single-label positives):")
    for i,l in enumerate(LABELS):
        sel=[j for j,r in enumerate(tests) if r["labels"]==[l]]
        if sel: print(f"  {l:16s} n={len(sel):3d}  caught {np.mean([pt[j,-1]>=thr for j in sel]):.3f}   (right category named: {np.mean([pt[j,i]>=0.5 for j in sel]):.3f})")
    print("\nFalse warns on TEST by benign type:")
    import collections; c=collections.defaultdict(lambda:[0,0])
    for j,r in enumerate(tests):
        if not r["labels"]: c[r["type"]][1]+=1; c[r["type"]][0]+=int(pt[j,-1]>=thr)
    for k,(a,b) in sorted(c.items()): print(f"  {k:18s} {a}/{b}")
    json.dump({"threshold":thr},open("model/threshold.json","w"))
