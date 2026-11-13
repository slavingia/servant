#!/usr/bin/env python3
"""App Store Connect API helper for Servant. Never prints secrets.

Reads a private JSON config from $SERVANT_ASC_CONFIG (default
~/.config/servant/asc.json) with these keys, from an App Store Connect API key
(Users and Access > Integrations > App Store Connect API):

  {"ASC_KEY_ID": "<key id>", "ASC_ISSUER_ID": "<issuer id>",
   "ASC_KEY_PATH": "<path to the downloaded AuthKey_<key id>.p8>"}

Keep the file and the .p8 chmod 600.
"""
import json, os, sys, time, base64, subprocess, urllib.request, urllib.error

CONFIG = os.path.expanduser(os.environ.get("SERVANT_ASC_CONFIG") or "~/.config/servant/asc.json")
if not os.path.isfile(CONFIG):
    sys.exit(f"App Store Connect config not found at {CONFIG}; set SERVANT_ASC_CONFIG")
cfg = json.load(open(CONFIG))
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
