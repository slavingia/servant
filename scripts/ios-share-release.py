#!/usr/bin/env python3
"""Fail early on missing share provisioning; verify the actual signed release.

Only Python's standard library is required. macOS security, codesign and ditto
inspect signing material without printing it. Unit tests use synthetic data.
"""
import argparse
import datetime
import hashlib
import plistlib
import re
import subprocess
import sys
import tempfile
from pathlib import Path
from xml.parsers.expat import ExpatError

GROUPS = "com.apple.security.application-groups"
TEAM = "com.apple.developer.team-identifier"


class ReleaseError(Exception):
    pass


def require(condition, message):
    if not condition:
        raise ReleaseError(message)


def run(command, message):
    try:
        result = subprocess.run(command, capture_output=True, check=True)
        return result.stdout
    except (OSError, subprocess.CalledProcessError):
        # Tool diagnostics contain signing identities and private local paths.
        raise ReleaseError(message) from None


def read_plist(data, message):
    try:
        value = plistlib.loads(data)
        require(isinstance(value, dict), message)
        return value
    except (ValueError, plistlib.InvalidFileException, ExpatError):
        raise ReleaseError(message) from None


def profile_at(path, role):
    data = run(["security", "cms", "-D", "-i", str(path)],
               f"{role}: cannot decode the provisioning profile. Download and install it again.")
    return read_plist(data, f"{role}: the provisioning profile is invalid. Download it again.")


def validate_profile(profile, bundle_id, team_id, group_id, role, now=None):
    fix = "Regenerate and install the App Store profile after enabling the shared App Group on its App ID."
    entitlements = profile.get("Entitlements", {})
    now = now or datetime.datetime.now(datetime.timezone.utc)
    expires = profile.get("ExpirationDate")
    if isinstance(expires, datetime.datetime) and expires.tzinfo is None:
        expires = expires.replace(tzinfo=datetime.timezone.utc)
    require(isinstance(expires, datetime.datetime) and expires > now,
            f"{role}: the provisioning profile has expired or has no expiry. {fix}")
    require(team_id in profile.get("TeamIdentifier", []) and entitlements.get(TEAM) == team_id,
            f"{role}: the provisioning profile belongs to a different team. {fix}")
    prefixes = profile.get("ApplicationIdentifierPrefix", [])
    require(any(entitlements.get("application-identifier") == f"{prefix}.{bundle_id}" for prefix in prefixes),
            f"{role}: the provisioning profile does not match the exact bundle identifier. {fix}")
    require(group_id in entitlements.get(GROUPS, []),
            f"{role}: the provisioning profile is missing the shared App Group. {fix}")
    require("iOS" in profile.get("Platform", []),
            f"{role}: the provisioning profile is not for iOS. {fix}")
    require(entitlements.get("get-task-allow") is False
            and "ProvisionedDevices" not in profile and not profile.get("ProvisionsAllDevices"),
            f"{role}: an App Store distribution profile is required. {fix}")
    return entitlements


def installed_profiles():
    home = Path.home()
    roots = [home / "Library/MobileDevice/Provisioning Profiles",
             home / "Library/Developer/Xcode/UserData/Provisioning Profiles"]
    profiles = []
    for root in roots:
        for file in root.glob("*.mobileprovision"):
            try:
                profiles.append(profile_at(file, "Installed profile"))
            except ReleaseError:
                pass  # Unrelated unreadable profiles must not block this release.
    return profiles


def select_profile(profiles, name, bundle_id, team_id, group_id, role, identities):
    matches = [p for p in profiles if p.get("Name") == name or p.get("UUID") == name]
    require(matches, f"{role}: no installed profile matches the configured profile name or UUID. "
            "Create or regenerate an App Store profile with the shared App Group, install it, "
            "and set the corresponding SERVANT_IOS_APP_PROFILE or SERVANT_IOS_SHARE_PROFILE.")
    errors = []
    for profile in matches:
        try:
            validate_profile(profile, bundle_id, team_id, group_id, role)
            certificates = profile.get("DeveloperCertificates", [])
            require(any(hashlib.sha1(cert).hexdigest().upper() in identities for cert in certificates),
                    f"{role}: its distribution certificate has no valid signing identity on this Mac. "
                    "Install the matching certificate and private key, or regenerate the profile with an available certificate.")
            return
        except ReleaseError as error:
            errors.append(str(error))
    raise ReleaseError(errors[0])


def preflight(bundle_id, team_id, app_profile, share_profile):
    output = run(["security", "find-identity", "-v", "-p", "codesigning"],
                 "Cannot inspect signing identities. Unlock the signing keychain and retry.").decode()
    identities = set(re.findall(r"\b[0-9A-Fa-f]{40}\b", output.upper()))
    profiles = installed_profiles()
    for role, name, identifier in [("App", app_profile, bundle_id),
                                    ("Share extension", share_profile, bundle_id + ".share")]:
        select_profile(profiles, name, identifier, team_id, "group." + bundle_id, role, identities)


def info_at(bundle, role):
    try:
        return read_plist((bundle / "Info.plist").read_bytes(), f"{role}: Info.plist is invalid. Rebuild the native app.")
    except OSError:
        raise ReleaseError(f"{role}: Info.plist is missing. Rebuild the native app.") from None


def validate_signed_bundle(bundle, bundle_id, team_id, group_id, build, role):
    info = info_at(bundle, role)
    require(info.get("CFBundleIdentifier") == bundle_id,
            f"{role}: the built bundle identifier does not match the release configuration. Rebuild with SERVANT_BUNDLE_ID.")
    require(info.get("CFBundleVersion") == build,
            f"{role}: the built build number does not match the requested build. Rebuild both targets together.")
    run(["codesign", "--verify", "--deep", "--strict", str(bundle)],
        f"{role}: signature verification failed. Rebuild and sign with the configured distribution profile.")
    signed = read_plist(run(["codesign", "--display", "--entitlements", "-", "--xml", str(bundle)],
                           f"{role}: cannot read signed entitlements. Rebuild with distribution signing."),
                        f"{role}: signed entitlements are invalid. Rebuild with distribution signing.")
    profile = profile_at(bundle / "embedded.mobileprovision", role)
    allowed = validate_profile(profile, bundle_id, team_id, group_id, role)
    require(signed.get("application-identifier") == allowed.get("application-identifier")
            and signed.get(TEAM) == team_id and signed.get("get-task-allow") is False,
            f"{role}: signed identity or distribution entitlements do not match the profile. Rebuild with the correct profile.")
    require(group_id in signed.get(GROUPS, []),
            f"{role}: the signature is missing the shared App Group. Regenerate the native project and rebuild.")
    require(set(signed[GROUPS]).issubset(allowed[GROUPS]),
            f"{role}: a signed App Group is not authorized by the embedded profile. Regenerate the profile and rebuild.")
    return info


def validate_app(app, bundle_id, team_id, build):
    group_id = "group." + bundle_id
    host = validate_signed_bundle(app, bundle_id, team_id, group_id, build, "App")
    extensions = list((app / "PlugIns").glob("*.appex"))
    matching = [p for p in extensions if info_at(p, "Extension").get("CFBundleIdentifier") == bundle_id + ".share"]
    require(len(matching) == 1,
            "Share extension: exactly one embedded share extension is required. Enable expo-sharing for iOS and rebuild.")
    share = validate_signed_bundle(matching[0], bundle_id + ".share", team_id, group_id, build, "Share extension")
    require(share.get("NSExtension", {}).get("NSExtensionPointIdentifier") == "com.apple.share-services",
            "Share extension: the built extension is not a share target. Regenerate the native project and rebuild.")
    require(bool(host.get("CFBundleShortVersionString"))
            and share.get("CFBundleShortVersionString") == host.get("CFBundleShortVersionString"),
            "Share extension: its version does not match the app. Rebuild both targets together.")


def validate_container(directory, bundle_id, team_id, build):
    apps = list(directory.glob("*.app"))
    require(len(apps) == 1, "Release must contain exactly one app. Archive and export the Servant scheme again.")
    validate_app(apps[0], bundle_id, team_id, build)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["preflight", "archive", "ipa"])
    parser.add_argument("--bundle-id", required=True)
    parser.add_argument("--team-id", required=True)
    parser.add_argument("--app-profile")
    parser.add_argument("--share-profile")
    parser.add_argument("--build")
    parser.add_argument("--path", type=Path)
    args = parser.parse_args(argv)
    try:
        require(re.fullmatch(r"[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+", args.bundle_id),
                "Set SERVANT_BUNDLE_ID to the app's reverse-DNS identifier.")
        require(re.fullmatch(r"[A-Z0-9]{10}", args.team_id), "Set SERVANT_APPLE_TEAM_ID to the 10-character team identifier.")
        if args.command == "preflight":
            require(args.app_profile and args.share_profile, "Set both app and share extension profile names.")
            preflight(args.bundle_id, args.team_id, args.app_profile, args.share_profile)
        else:
            require(args.path and args.build and re.fullmatch(r"[0-9]+(\.[0-9]+){0,2}", args.build),
                    "Provide the release path and a numeric build number.")
            if args.command == "archive":
                validate_container(args.path / "Products/Applications", args.bundle_id, args.team_id, args.build)
            else:
                with tempfile.TemporaryDirectory(prefix="servant-ipa-check-") as folder:
                    run(["ditto", "-x", "-k", str(args.path), folder], "Cannot extract the exported IPA. Export the archive again.")
                    validate_container(Path(folder) / "Payload", args.bundle_id, args.team_id, args.build)
        print(f"iOS share {args.command}: OK (app and share extension)")
        return 0
    except ReleaseError as error:
        print(f"iOS share {args.command}: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
