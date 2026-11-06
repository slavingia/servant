#!/usr/bin/env python3
"""App Store Connect API helper for Servant. Reads a private config file,
~/.config/servant/asc.json (or the path in SERVANT_ASC_CONFIG), with
{"ASC_KEY_ID": ..., "ASC_ISSUER_ID": ..., "ASC_KEY_PATH": "<path to the .p8>"}.
Never prints secrets."""
import json, os, sys, time, base64, subprocess, urllib.request, urllib.error

CONFIG = os.path.expanduser(os.environ.get("SERVANT_ASC_CONFIG") or "~/.config/servant/asc.json")
try:
    cfg = json.load(open(CONFIG))
except FileNotFoundError:
    sys.exit(f"No App Store Connect config at {CONFIG}. Create it, or set SERVANT_ASC_CONFIG to its path (see the top of {__file__})")
KID, ISS, KEY = cfg["ASC_KEY_ID"], cfg["ASC_ISSUER_ID"], os.path.expanduser(cfg["ASC_KEY_PATH"])


def b64(b):
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def token():
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature
    h = b64(json.dumps({"alg": "ES256", "kid": KID, "typ": "JWT"}).encode())
    now = int(time.time())
    p = b64(json.dumps({"iss": ISS, "iat": now, "exp": now + 1000, "aud": "appstoreconnect-v1"}).encode())
    k = serialization.load_pem_private_key(open(KEY, "rb").read(), None)
    r, s = decode_dss_signature(k.sign(f"{h}.{p}".encode(), ec.ECDSA(hashes.SHA256())))
    return f"{h}.{p}.{b64(r.to_bytes(32, 'big') + s.to_bytes(32, 'big'))}"


def api(method, path, body=None):
    req = urllib.request.Request(
        "https://api.appstoreconnect.apple.com" + path,
        method=method,
        data=json.dumps(body).encode() if body else None,
        headers={"Authorization": "Bearer " + token(), "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req) as r:
            t = r.read()
            return r.status, (json.loads(t) if t else {})
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


if __name__ == "__main__":
    m, p = sys.argv[1], sys.argv[2]
    b = json.loads(sys.argv[3]) if len(sys.argv) > 3 else None
    s, j = api(m, p, b)
    print(s)
    print(json.dumps(j, indent=1)[:6000])
