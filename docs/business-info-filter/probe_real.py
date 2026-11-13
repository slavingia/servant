"""Two checks the synthetic sets cannot give:
 1. Real-FORMAT secrets (documented example formats from providers; assembled from pieces so no scanner sees a literal key).
 2. REAL prose false-alarm rate: paragraphs from this repo's own README/docs, which are business text but contain nothing sensitive."""
import glob, json, os, re, numpy as np, onnxruntime as ort
from transformers import AutoTokenizer
import train

tok = AutoTokenizer.from_pretrained(train.BASE)
thr = json.load(open("model/threshold_int8.json"))["threshold"]
s = ort.InferenceSession("model/business-int8.onnx", providers=["CPUExecutionProvider"])


def p(t):
    x = tok(t, truncation=True, max_length=train.MAXLEN, return_tensors="np")
    return float(s.run(None, {"input_ids": x["input_ids"].astype(np.int64), "attention_mask": x["attention_mask"].astype(np.int64)})[0][0][-1])


J = "".join
secrets = {
    "aws access key": f"here is the key: {J(['AKIA','IOSFODNN7EXAMPLE'])}",
    "aws pair": f"aws_access_key_id = {J(['AKIA','IOSFODNN7EXAMPLE'])}\naws_secret_access_key = {J(['wJalrXUtnFEMI/K7MDENG/','bPxRfiCYEXAMPLEKEY'])}",
    "github token": f"use {J(['ghp','_','16C7e42F292c6912E7710c838347Ae178B4a'])} for the push",
    "slack token": f"SLACK_BOT_TOKEN={J(['xoxb','-','123456789012-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx'])}",
    "stripe live": f"stripe key {J(['sk','_live_','4eC39HqLyjWDarjtT1zdp7dc'])} please rotate",
    "google api key": f"maps key: {J(['AIza','SyA-1234567890abcdefghijklmnopqrstuv'])}",
    "jwt": f"Authorization: Bearer {J(['eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9','.','eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ','.','SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'])}",
    "pem header": f"{J(['-----BEGIN RSA PRIV','ATE KEY-----'])}\nMIIEowIBAAKCAQEAxExampleExampleExample\n{J(['-----END RSA PRIV','ATE KEY-----'])}",
    "postgres url": "DATABASE_URL=postgres://app_user:Tr0ub4dor&3xQ@db-prod-01.internal.example:5432/orders",
    "password plain": "the admin password for the vault is Gr33n-Tiger!42, don't share",
    "npm token": f"//registry.npmjs.org/:_authToken={J(['npm','_','abcdefghijklmnopqrstuvwxyz0123456789'])}",
    "sendgrid": f"SENDGRID_API_KEY={J(['SG','.','abcdefghijklmnopqrstuv','.','abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG'])}",
}
print("REAL-FORMAT SECRETS (model alone, threshold %.3f):" % thr)
caught = 0
for k, v in secrets.items():
    sc = p(v)
    caught += sc >= thr
    print(f"  {'CAUGHT' if sc >= thr else 'MISSED'} {sc:.2f}  {k}")
print(f"  -> {caught}/{len(secrets)}\n")

paras = []
for f in ["README.md", "AGENTS.md", "SECURITY.md", "CONTRIBUTING.md"] + sorted(glob.glob("docs/*.md")):
    path = os.path.join(os.environ.get("SERVANT_REPO", "."), f)   # run from, or point SERVANT_REPO at, the repo root
    if not os.path.exists(path):
        continue
    text = open(path, encoding="utf8").read()
    text = re.sub(r"```.*?```", "", text, flags=re.S)
    for para in re.split(r"\n\s*\n", text):
        para = re.sub(r"[#>*_`|\-]{1,}", " ", para).strip()
        if 60 <= len(para) <= 1200:
            paras.append((f, para))
print(f"REAL PROSE: {len(paras)} paragraphs from {len(set(f for f, _ in paras))} repo docs")
sc = np.array([p(t) for _, t in paras])
fa = sc >= thr
print(f"  false warns: {fa.sum()}/{len(paras)} = {fa.mean():.3f}")
for i in np.argsort(-sc)[:min(10, int(fa.sum()))]:
    print(f"   {sc[i]:.2f} [{paras[i][0]}] {paras[i][1][:140]!r}")
