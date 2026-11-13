#!/usr/bin/env python3
"""Open a build to everyone through a public TestFlight link.

  scripts/public-testflight.py <build-number> [--group "Public"] [--limit 10000]
      [--feedback you@example.org] [--privacy https://example.org/privacy]
      [--description "..."] [--notes notes.md] [--encryption-exempt]

Needs SERVANT_ASC_APP_ID (the app's numeric Apple ID in App Store Connect) and the
scripts/asc.py config. Waits for App Store Connect to finish processing the build
(up to 30 minutes), then:

1. Fills in the test information every external build needs once: feedback email,
   privacy policy URL and a description (--feedback, --privacy, --description; later
   runs keep what is set unless given again).
2. With --encryption-exempt, answers the export compliance question for this build
   as "uses only exempt encryption". Leave it out to answer in App Store Connect.
3. Creates the external group (default "Public") with a public link, or reuses it,
   and adds the build. New testers join through the link, up to --limit at a time.
4. Submits the build for Beta App Review when it is the first build in that group
   or a new version; Apple usually answers within a day or two. Until approval the
   link exists but only internal testers can install.

Prints the public link. The link never changes for the group, so it can go on a
website or in a README as soon as this prints it.
"""
import os, sys, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))
from asc import api  # noqa: E402

APP_ID = os.environ.get("SERVANT_ASC_APP_ID", "")


def arg(name, default=None):
    if name in sys.argv:
        i = sys.argv.index(name)
        if i + 1 < len(sys.argv):
            return sys.argv[i + 1]
    return default


def fail(message):
    sys.exit(f"public-testflight: {message}")


def wait_for_build(build):
    deadline = time.time() + 1800
    while True:
        s, j = api("GET", f"/v1/builds?filter[app]={APP_ID}&filter[version]={build}&sort=-uploadedDate&limit=1")
        data = j.get("data", []) if s == 200 else []
        if data and data[0]["attributes"].get("processingState") == "VALID":
            return data[0]
        if data and data[0]["attributes"].get("processingState") in ("FAILED", "INVALID"):
            fail(f"build {build} is {data[0]['attributes']['processingState']} in App Store Connect")
        if time.time() > deadline:
            fail(f"build {build} is not processed yet; run again later")
        print(f"Waiting for App Store Connect to process build {build}...", flush=True)
        time.sleep(30)


def test_information(feedback, privacy, description):
    s, j = api("GET", f"/v1/apps/{APP_ID}/betaAppLocalizations")
    locs = j.get("data", []) if s == 200 else []
    attrs = {k: v for k, v in (("feedbackEmail", feedback), ("privacyPolicyUrl", privacy), ("description", description)) if v}
    en = next((l for l in locs if l["attributes"].get("locale") == "en-US"), None)
    if en and attrs:
        s, _ = api("PATCH", f"/v1/betaAppLocalizations/{en['id']}", {"data": {"type": "betaAppLocalizations", "id": en["id"], "attributes": attrs}})
    elif not en:
        if not (feedback and privacy):
            fail("the first external build needs --feedback and --privacy (and ideally --description)")
        s, _ = api("POST", "/v1/betaAppLocalizations", {"data": {"type": "betaAppLocalizations", "attributes": {**attrs, "locale": "en-US"},
                   "relationships": {"app": {"data": {"type": "apps", "id": APP_ID}}}}})
    else:
        return True
    print(f"Test information: {'set' if s in (200, 201) else f'failed ({s})'}")
    return s in (200, 201)


def review_contact(feedback):
    s, j = api("GET", f"/v1/apps/{APP_ID}/betaAppReviewDetail")
    if s != 200:
        return False
    d = j["data"]
    if d["attributes"].get("contactEmail") or not feedback:
        return True
    name = os.environ.get("SERVANT_REVIEW_CONTACT_NAME", "Servant maintainer").split(" ", 1) + [""]
    attrs = {"contactEmail": feedback, "contactFirstName": name[0], "contactLastName": name[1] or "Team",
             "contactPhone": os.environ.get("SERVANT_REVIEW_CONTACT_PHONE", "+1 555 555 0100"),
             "notes": "Servant is a client for a self-hosted server. Join with the invite link in these notes, or run a server from the public repository."}
    s, _ = api("PATCH", f"/v1/betaAppReviewDetails/{d['id']}", {"data": {"type": "betaAppReviewDetails", "id": d["id"], "attributes": attrs}})
    print(f"Beta review contact: {'set' if s == 200 else f'failed ({s})'}")
    return s == 200


def encryption_exempt(build_id):
    s, _ = api("PATCH", f"/v1/builds/{build_id}", {"data": {"type": "builds", "id": build_id, "attributes": {"usesNonExemptEncryption": False}}})
    print(f"Export compliance (exempt): {'set' if s == 200 else f'failed ({s})'}")
    return s == 200


def public_group(name, limit):
    s, j = api("GET", f"/v1/betaGroups?filter[app]={APP_ID}&filter[name]={name}")
    groups = [g for g in j.get("data", [])] if s == 200 else []
    if groups:
        g = groups[0]
        if not g["attributes"].get("publicLinkEnabled"):
            s, j = api("PATCH", f"/v1/betaGroups/{g['id']}", {"data": {"type": "betaGroups", "id": g["id"],
                       "attributes": {"publicLinkEnabled": True, "publicLinkLimitEnabled": True, "publicLinkLimit": int(limit)}}})
            g = j.get("data", g)
        return g
    s, j = api("POST", "/v1/betaGroups", {"data": {"type": "betaGroups", "attributes": {"name": name, "isInternalGroup": False,
               "publicLinkEnabled": True, "publicLinkLimitEnabled": True, "publicLinkLimit": int(limit), "feedbackEnabled": True},
               "relationships": {"app": {"data": {"type": "apps", "id": APP_ID}}}}})
    if s != 201:
        fail(f"could not create the group {name}: {j.get('errors', j)}")
    return j["data"]


def add_build(group_id, build_id):
    s, j = api("POST", f"/v1/betaGroups/{group_id}/relationships/builds", {"data": [{"type": "builds", "id": build_id}]})
    if s not in (200, 204):
        fail(f"could not add the build to the group: {j.get('errors', j)}")


def submit_for_review(build_id):
    s, j = api("GET", f"/v1/builds/{build_id}/betaAppReviewSubmission")
    if s == 200 and j.get("data"):
        print(f"Beta App Review: already {j['data']['attributes'].get('betaReviewState', 'submitted').lower().replace('_', ' ')}")
        return True
    s, j = api("POST", "/v1/betaAppReviewSubmissions", {"data": {"type": "betaAppReviewSubmissions",
               "relationships": {"build": {"data": {"type": "builds", "id": build_id}}}}})
    if s == 201:
        print("Beta App Review: submitted")
        return True
    print(f"Beta App Review: not submitted ({s}): {j.get('errors', j)}")
    return False


def whats_new(build_id, path):
    text = open(path).read().strip()[:4000]
    s, j = api("GET", f"/v1/builds/{build_id}/betaBuildLocalizations")
    locs = j.get("data", []) if s == 200 else []
    if locs:
        s, _ = api("PATCH", f"/v1/betaBuildLocalizations/{locs[0]['id']}", {"data": {"type": "betaBuildLocalizations", "id": locs[0]["id"], "attributes": {"whatsNew": text}}})
    else:
        s, _ = api("POST", "/v1/betaBuildLocalizations", {"data": {"type": "betaBuildLocalizations", "attributes": {"whatsNew": text, "locale": "en-US"},
                   "relationships": {"build": {"data": {"type": "builds", "id": build_id}}}}})
    print(f"What to Test: {'set' if s in (200, 201) else f'failed ({s})'}")


if __name__ == "__main__":
    if len(sys.argv) < 2 or sys.argv[1].startswith("-"):
        sys.exit(__doc__)
    if not APP_ID:
        fail("set SERVANT_ASC_APP_ID to the app's Apple ID in App Store Connect")
    build = sys.argv[1]
    b = wait_for_build(build)
    ok = test_information(arg("--feedback"), arg("--privacy"), arg("--description"))
    ok = review_contact(arg("--feedback")) and ok
    if "--encryption-exempt" in sys.argv:
        ok = encryption_exempt(b["id"]) and ok
    if arg("--notes"):
        whats_new(b["id"], arg("--notes"))
    group = public_group(arg("--group", "Public"), arg("--limit", "10000"))
    add_build(group["id"], b["id"])
    ok = submit_for_review(b["id"]) and ok
    s, j = api("GET", f"/v1/betaGroups/{group['id']}")
    link = j.get("data", {}).get("attributes", {}).get("publicLink") if s == 200 else None
    print(f"Public TestFlight link: {link or '(not issued yet; check the group in App Store Connect)'}")
    sys.exit(0 if ok else 1)
