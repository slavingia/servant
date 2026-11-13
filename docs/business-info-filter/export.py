"""Export the trained business-information model to ONNX (int8-quantized) and check it matches PyTorch."""
import json, os, sys
import numpy as np, torch
import onnxruntime as ort
from onnxruntime.quantization import quantize_dynamic, QuantType
from transformers import AutoTokenizer
import train
from taxonomy import LABELS

out = sys.argv[1] if len(sys.argv) > 1 else "model"
tok = AutoTokenizer.from_pretrained(train.BASE)
net = train.Net().to("cpu")
net.load_state_dict(torch.load(f"{out}/best.pt", map_location="cpu"))
net.eval()


class Wrap(torch.nn.Module):
    def __init__(self, n):
        super().__init__()
        self.n = n

    def forward(self, input_ids, attention_mask):
        return torch.sigmoid(self.n(input_ids, attention_mask))


w = Wrap(net).eval()
e = tok(["export probe message about a budget", "hola"], padding=True, return_tensors="pt")
torch.onnx.export(
    w, (e["input_ids"], e["attention_mask"]), f"{out}/business-fp32.onnx",
    input_names=["input_ids", "attention_mask"], output_names=["probs"],
    dynamic_axes={"input_ids": {0: "b", 1: "s"}, "attention_mask": {0: "b", 1: "s"}, "probs": {0: "b"}},
    opset_version=17, dynamo=False,
)
quantize_dynamic(f"{out}/business-fp32.onnx", f"{out}/business-int8.onnx", weight_type=QuantType.QInt8, per_channel=True)
for f in ("business-fp32.onnx", "business-int8.onnx"):
    print(f, os.path.getsize(f"{out}/{f}") // 1024, "KB")

# Parity: the exported graphs must agree with PyTorch on real messages.
rows, _ = train.load("data/test")
sample = [r["text"] for r in rows][:400]
with torch.no_grad():
    ref = np.concatenate([
        torch.sigmoid(net(**{"input_ids": b["input_ids"], "attention_mask": b["attention_mask"]})).numpy()
        for b in (tok(sample[i:i + 32], padding=True, truncation=True, max_length=train.MAXLEN, return_tensors="pt") for i in range(0, len(sample), 32))
    ])
for f in ("business-fp32.onnx", "business-int8.onnx"):
    s = ort.InferenceSession(f"{out}/{f}")
    got = []
    for t in sample:
        x = tok(t, truncation=True, max_length=train.MAXLEN, return_tensors="np")
        got.append(s.run(None, {"input_ids": x["input_ids"].astype(np.int64), "attention_mask": x["attention_mask"].astype(np.int64)})[0][0])
    got = np.array(got)
    thr = json.load(open(f"{out}/threshold.json"))["threshold"]
    flips = int(((got[:, -1] >= thr) != (ref[:, -1] >= thr)).sum())
    print(f"{f}: max |prob diff| {np.abs(got - ref).max():.5f}, mean {np.abs(got - ref).mean():.6f}, verdict flips at threshold: {flips}/{len(sample)}")
