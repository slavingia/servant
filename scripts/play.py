#!/usr/bin/env python3
"""Google Play internal testing for Servant.

  play.py check                 does the app exist + can the key reach it?
  play.py upload <aab> [notes]  upload AAB, release it to the internal track (testers only)

Tester lists are console-only (Testing > Internal testing > Testers).

Credential: a Play Console service account key, path in PLAY_JSON_KEY (chmod 600).
Package: app/app.json expo.android.package, or PLAY_PACKAGE.
Play cannot create apps via API; the app record must exist in Play Console first.
"""
import json, os, sys, time, base64, urllib.request, urllib.error, subprocess

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PKG = os.environ.get("PLAY_PACKAGE") or json.load(open(os.path.join(ROOT, "app", "app.json")))["expo"]["android"]["package"]
if not os.environ.get("PLAY_JSON_KEY"):
    sys.exit("Set PLAY_JSON_KEY to your Play Console service account key (JSON)")
KEY = os.path.expanduser(os.environ["PLAY_JSON_KEY"])
API = "https://androidpublisher.googleapis.com/androidpublisher/v3/applications/" + PKG
UP = "https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications/" + PKG


def token():
    k = json.load(open(KEY))
    b = lambda d: base64.urlsafe_b64encode(d).rstrip(b"=")
    now = int(time.time())
    head = b(json.dumps({"alg": "RS256", "typ": "JWT"}).encode())
    claim = b(json.dumps({"iss": k["client_email"], "scope": "https://www.googleapis.com/auth/androidpublisher",
                          "aud": k["token_uri"], "iat": now, "exp": now + 3600}).encode())
    msg = head + b"." + claim
    pem = "/tmp/servant-play-%d.pem" % os.getpid()
    fd = os.open(pem, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    os.write(fd, k["private_key"].encode()); os.close(fd)
    try:
        sig = subprocess.run(["openssl", "dgst", "-sha256", "-sign", pem], input=msg, capture_output=True, check=True).stdout
    finally:
        os.remove(pem)
    body = ("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=" + (msg + b"." + b(sig)).decode()).encode()
    return json.load(urllib.request.urlopen(urllib.request.Request(k["token_uri"], body)))["access_token"]


def call(method, url, tok, data=None, ctype="application/json"):
    if data is not None and not isinstance(data, bytes):
        data = json.dumps(data).encode()
    req = urllib.request.Request(url, data, method=method, headers={"Authorization": "Bearer " + tok, "Content-Type": ctype})
    try:
        r = urllib.request.urlopen(req, timeout=600)
        return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read())
        except Exception:
            return e.code, {}


def main(tries=3):
    cmd = sys.argv[1] if len(sys.argv) > 1 else "check"
    tok = token()
    s, edit = call("POST", API + "/edits", tok, {})
    if s != 200:
        print("Play: cannot open an edit for %s (%s): %s" % (PKG, s, edit.get("error", {}).get("message", edit)))
        sys.exit(2)
    e = edit["id"]
    if cmd == "check":
        s, t = call("GET", f"{API}/edits/{e}/tracks/internal", tok)
        print("app exists; internal track:", json.dumps(t.get("releases", []))[:400])
        call("DELETE", f"{API}/edits/{e}", tok)
    elif cmd == "upload":
        aab = sys.argv[2]
        notes = sys.argv[3] if len(sys.argv) > 3 else "Internal build"
        s, b = call("POST", f"{UP}/edits/{e}/bundles?uploadType=media", tok, open(aab, "rb").read(), "application/octet-stream")
        if s != 200:
            print("upload failed", s, b); sys.exit(1)
        vc = str(b["versionCode"])
        s, t = call("PUT", f"{API}/edits/{e}/tracks/internal", tok, {"track": "internal", "releases": [{
            "versionCodes": [vc], "status": "completed", "name": f"{vc} (internal)",
            "releaseNotes": [{"language": "en-US", "text": notes}]}]})
        if s != 200:
            print("track failed", s, t); sys.exit(1)
        s, c = call("POST", f"{API}/edits/{e}:commit", tok)
        if s == 400 and "outside of this Edit" in str(c) and tries > 1:  # console edit raced us
            time.sleep(30); return main(tries - 1)
        if s != 200:  # brand-new apps may only accept status "draft" until first rollout
            print("commit failed", s, c.get("error", {}).get("message", "")); sys.exit(1)
        print("internal track: versionCode", vc, "released (completed)")


if __name__ == "__main__":
    main()
