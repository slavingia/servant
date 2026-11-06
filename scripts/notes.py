#!/usr/bin/env python3
"""Post a build's notes everywhere testers look.

  scripts/notes.py <build> <notes.md> [--testflight]

1. #whats-new in Servant: one post per build (re-running updates it). Testers
   tap it from You > What's new and talk about it in the post's thread, and
   everyone gets a notification.
2. --testflight: TestFlight "What to Test" for that build (waits for Apple to
   finish processing, up to 30 minutes).

Firebase gets the same text through firebase.sh --notes.
"""
import os, subprocess, sys, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APP_ID = "6828900254"


def server(build, path):
    r = subprocess.run(["node", os.path.join(ROOT, "server/server.mjs"), "release", build, path], capture_output=True, text=True)
    print((r.stdout or r.stderr).strip())
    return r.returncode == 0


def testflight(build, text):
    sys.path.insert(0, os.path.join(ROOT, "scripts"))
    from asc import api
    deadline = time.time() + 1800
    while True:
        s, j = api("GET", f"/v1/builds?filter[app]={APP_ID}&filter[version]={build}&include=betaBuildLocalizations")
        builds = j.get("data", []) if s == 200 else []
        if builds and builds[0]["attributes"].get("processingState") == "VALID":
            break
        if time.time() > deadline:
            print(f"TestFlight build {build} isn't processed yet; run again later: scripts/notes.py {build} <notes> --testflight")
            return False
        time.sleep(30)
    bid = builds[0]["id"]
    locs = [i for i in j.get("included", []) if i["type"] == "betaBuildLocalizations"]
    attrs = {"whatsNew": text[:4000]}
    if locs:
        s, _ = api("PATCH", f"/v1/betaBuildLocalizations/{locs[0]['id']}",
                   {"data": {"type": "betaBuildLocalizations", "id": locs[0]["id"], "attributes": attrs}})
    else:
        s, _ = api("POST", "/v1/betaBuildLocalizations", {"data": {"type": "betaBuildLocalizations",
                   "attributes": {**attrs, "locale": "en-US"}, "relationships": {"build": {"data": {"type": "builds", "id": bid}}}}})
    print(f"TestFlight What to Test for build {build}: {'set' if s in (200, 201) else f'failed ({s})'}")
    return s in (200, 201)


if __name__ == "__main__":
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    build, path = sys.argv[1], sys.argv[2]
    text = open(path).read().strip()
    if not text:
        sys.exit("The notes file is empty")
    ok = server(build, path)
    if "--testflight" in sys.argv:
        ok = testflight(build, text) and ok
    sys.exit(0 if ok else 1)
