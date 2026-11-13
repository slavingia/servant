#!/usr/bin/env python3
"""Synthetic signing fixtures: no Apple account, private key or macOS required."""
import contextlib
import copy
import datetime
import hashlib
import importlib.util
import io
import os
import plistlib
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("ios_share_release", ROOT / "scripts/ios-share-release.py")
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
BUNDLE = "com.example.servant"
TEAM = "TESTTEAM00"
GROUP = "group." + BUNDLE
CERT = b"synthetic certificate"
IDENTITIES = {hashlib.sha1(CERT).hexdigest().upper()}


def profile(identifier=BUNDLE):
    return {
        "Name": "Synthetic App Store", "UUID": "synthetic-profile",
        "Platform": ["iOS"], "TeamIdentifier": [TEAM], "ApplicationIdentifierPrefix": ["PREFIX0000"],
        "ExpirationDate": datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(days=30),
        "DeveloperCertificates": [CERT],
        "Entitlements": {"application-identifier": "PREFIX0000." + identifier,
                         release.TEAM: TEAM, release.GROUPS: [GROUP], "get-task-allow": False},
    }


class ProvisioningTests(unittest.TestCase):
    def check_profile(self, value):
        return release.validate_profile(value, BUNDLE, TEAM, GROUP, "App")

    def test_valid_profile_and_legacy_app_id_prefix(self):
        self.check_profile(profile())

    def test_old_app_profile_without_group_is_rejected(self):
        value = profile()
        del value["Entitlements"][release.GROUPS]
        with self.assertRaisesRegex(release.ReleaseError, "missing the shared App Group.*Regenerate"):
            self.check_profile(value)

    def test_expired_profile_is_rejected(self):
        value = profile()
        value["ExpirationDate"] = datetime.datetime(2000, 1, 1)
        with self.assertRaisesRegex(release.ReleaseError, "expired"):
            self.check_profile(value)

    def test_other_team_identifier_and_app_group_are_rejected(self):
        mutations = [
            ("TeamIdentifier", ["OTHERTEAM0"]),
            ("Platform", ["OSX"]),
            ("Entitlements", {**profile()["Entitlements"], "application-identifier": "PREFIX0000.*"}),
            ("Entitlements", {**profile()["Entitlements"], release.GROUPS: ["group.com.example.other"]}),
            ("Entitlements", {**profile()["Entitlements"], release.TEAM: "OTHERTEAM0"}),
        ]
        for key, value in mutations:
            with self.subTest(key=key, value=value):
                changed = profile()
                changed[key] = value
                with self.assertRaises(release.ReleaseError):
                    self.check_profile(changed)

    def test_development_ad_hoc_and_enterprise_profiles_are_rejected(self):
        for updates in [{"ProvisionedDevices": []}, {"ProvisionsAllDevices": True},
                        {"Entitlements": {**profile()["Entitlements"], "get-task-allow": True}}]:
            with self.subTest(updates=updates), self.assertRaisesRegex(release.ReleaseError, "App Store distribution"):
                self.check_profile({**profile(), **updates})

    def test_missing_extension_profile_has_install_action(self):
        with self.assertRaisesRegex(release.ReleaseError, "Share extension: no installed profile.*Create or regenerate"):
            release.select_profile([], "Synthetic Share", BUNDLE + ".share", TEAM, GROUP, "Share extension", IDENTITIES)

    def test_available_profile_without_private_key_is_rejected(self):
        with self.assertRaisesRegex(release.ReleaseError, "certificate has no valid signing identity"):
            release.select_profile([profile()], "Synthetic App Store", BUNDLE, TEAM, GROUP, "App", set())

    def test_valid_renewed_profile_is_selected_even_if_old_copy_is_installed(self):
        expired = profile()
        expired["ExpirationDate"] = datetime.datetime(2000, 1, 1)
        release.select_profile([expired, profile()], "Synthetic App Store", BUNDLE, TEAM, GROUP, "App", IDENTITIES)
        release.select_profile([profile()], "synthetic-profile", BUNDLE, TEAM, GROUP, "App", IDENTITIES)


class SignedReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.container = Path(self.temp.name).resolve()
        self.app = self.container / "Servant.app"
        self.share = self.app / "PlugIns/share.appex"
        self.share.mkdir(parents=True)
        self.profiles = {self.app: profile(), self.share: profile(BUNDLE + ".share")}
        self.entitlements = {path: copy.deepcopy(p["Entitlements"]) for path, p in self.profiles.items()}
        self.write_info(self.app, BUNDLE)
        self.write_info(self.share, BUNDLE + ".share", {"NSExtension": {"NSExtensionPointIdentifier": "com.apple.share-services"}})
        self.addCleanup(patch.stopall)
        self.profile_mock = patch.object(release, "profile_at", side_effect=lambda path, role: self.profiles[path.parent.resolve()]).start()
        self.command_mock = patch.object(release, "run", side_effect=self.command).start()

    def write_info(self, path, identifier, extra=None):
        (path / "Info.plist").write_bytes(plistlib.dumps({
            "CFBundleIdentifier": identifier, "CFBundleVersion": "50", "CFBundleShortVersionString": "1.0", **(extra or {})}))

    def command(self, command, message):
        self.assertEqual(command[0], "codesign")
        if "--display" in command:
            return plistlib.dumps(self.entitlements[Path(command[-1]).resolve()])
        self.assertEqual(command[1:4], ["--verify", "--deep", "--strict"])
        return b""

    def check_release(self):
        release.validate_container(self.container, BUNDLE, TEAM, "50")

    def test_archive_cli_validates_products_applications(self):
        archive = self.container / "Release.xcarchive"
        (archive / "Products").mkdir(parents=True)
        (archive / "Products/Applications").symlink_to(self.container, target_is_directory=True)
        with contextlib.redirect_stdout(io.StringIO()):
            result = release.main(["archive", "--path", str(archive), "--build", "50",
                                   "--bundle-id", BUNDLE, "--team-id", TEAM])
        self.assertEqual(result, 0)
        self.assertEqual(self.command_mock.call_count, 4)

    def test_actual_app_and_extension_are_verified(self):
        self.check_release()
        self.assertEqual(self.profile_mock.call_count, 2)
        self.assertEqual(self.command_mock.call_count, 4)

    def test_missing_embedded_extension_is_rejected(self):
        (self.share / "Info.plist").unlink()
        self.share.rmdir()
        with self.assertRaisesRegex(release.ReleaseError, "exactly one embedded share extension"):
            self.check_release()

    def test_extension_build_identifier_version_and_type_are_checked(self):
        for extra, message in [({"CFBundleVersion": "49"}, "build number"),
                               ({"CFBundleIdentifier": "com.example.other.share"}, "embedded share extension"),
                               ({"CFBundleShortVersionString": "0.9"}, "version does not match"),
                               ({"NSExtension": {"NSExtensionPointIdentifier": "com.apple.widgetkit-extension"}}, "not a share target")]:
            with self.subTest(extra=extra):
                self.write_info(self.share, BUNDLE + ".share", {"NSExtension": {"NSExtensionPointIdentifier": "com.apple.share-services"}, **extra})
                with self.assertRaisesRegex(release.ReleaseError, message):
                    self.check_release()

    def test_signed_group_is_required_on_both_targets(self):
        for path in [self.app, self.share]:
            with self.subTest(role=path.name):
                entitlements = self.entitlements[path]
                entitlements[release.GROUPS] = []
                with self.assertRaisesRegex(release.ReleaseError, "signature is missing the shared App Group"):
                    self.check_release()
                entitlements[release.GROUPS] = [GROUP]

    def test_signed_groups_must_be_authorized_by_embedded_profile(self):
        self.entitlements[self.share][release.GROUPS].append("group.com.example.other")
        with self.assertRaisesRegex(release.ReleaseError, "not authorized by the embedded profile"):
            self.check_release()

    def test_signature_failure_blocks_release(self):
        self.command_mock.side_effect = release.ReleaseError("App: signature verification failed.")
        with self.assertRaisesRegex(release.ReleaseError, "signature verification failed"):
            self.check_release()

    def test_export_using_stale_embedded_profile_is_rejected(self):
        del self.profiles[self.share]["Entitlements"][release.GROUPS]
        with self.assertRaisesRegex(release.ReleaseError, "Share extension:.*missing the shared App Group"):
            self.check_release()

    def test_signed_application_identifier_must_match_embedded_profile(self):
        self.entitlements[self.share]["application-identifier"] = "OTHER00000." + BUNDLE + ".share"
        with self.assertRaisesRegex(release.ReleaseError, "signed identity.*do not match"):
            self.check_release()


class CommandTests(unittest.TestCase):
    def test_tool_errors_do_not_print_signing_details(self):
        with patch.object(subprocess, "run", side_effect=subprocess.CalledProcessError(1, "security", stderr=b"private signing details")):
            with self.assertRaisesRegex(release.ReleaseError, "Retry signing") as caught:
                release.run(["security"], "Retry signing")
            self.assertNotIn("private", str(caught.exception))

    def test_testflight_stops_before_prebuild_when_profiles_are_missing(self):
        with tempfile.TemporaryDirectory() as folder:
            temporary = Path(folder)
            binaries = temporary / "bin"
            binaries.mkdir()
            marker = temporary / "prebuild-ran"
            for name, contents in [("security", '#!/bin/sh\n[ "$1" = "find-identity" ] && exit 0\nexit 1\n'),
                                   ("npx", '#!/bin/sh\ntouch "$PREFLIGHT_MARKER"\nexit 99\n')]:
                script = binaries / name
                script.write_text(contents)
                script.chmod(0o755)
            environment = {**os.environ, "PATH": str(binaries) + os.pathsep + os.environ["PATH"],
                           "SERVANT_APPLE_TEAM_ID": TEAM, "SERVANT_BUNDLE_ID": BUNDLE,
                           "SERVANT_IOS_APP_PROFILE": "Synthetic App Store", "SERVANT_IOS_SHARE_PROFILE": "Synthetic Share",
                           "PREFLIGHT_MARKER": str(marker)}
            result = subprocess.run(["bash", str(ROOT / "scripts/testflight.sh"), "50", "--no-upload"],
                                    env=environment, capture_output=True, text=True)
            self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
            self.assertIn("no installed profile", result.stderr)
            self.assertFalse(marker.exists())

    def test_malformed_plist_reports_only_safe_error(self):
        with self.assertRaisesRegex(release.ReleaseError, "Invalid fixture"):
            release.read_plist(b"<?xml version=\"1.0\"?><plist><dict><private", "Invalid fixture")

    def test_ipa_cli_extracts_then_checks_payload_and_cleans_up(self):
        visited = []
        def command(arguments, message):
            self.assertEqual(arguments[:3], ["ditto", "-x", "-k"])
            self.assertEqual(arguments[3], "synthetic.ipa")
            output = Path(arguments[4])
            (output / "Payload").mkdir()
            (output / "Payload/extracted-marker").touch()
            return b""
        def validate(directory, bundle_id, team_id, build):
            self.assertTrue((directory / "extracted-marker").is_file())
            self.assertEqual((bundle_id, team_id, build), (BUNDLE, TEAM, "50"))
            visited.append(directory)
        with patch.object(release, "run", side_effect=command), patch.object(release, "validate_container", side_effect=validate), contextlib.redirect_stdout(io.StringIO()):
            result = release.main(["ipa", "--path", "synthetic.ipa", "--build", "50",
                                   "--bundle-id", BUNDLE, "--team-id", TEAM])
        self.assertEqual(result, 0)
        self.assertEqual(len(visited), 1)
        self.assertFalse(visited[0].exists())

    def test_bad_build_stops_testflight_before_preflight_or_prebuild(self):
        result = subprocess.run(["bash", str(ROOT / "scripts/testflight.sh"), "../50", "--no-upload"],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 2)
        self.assertIn("Use a numeric build number", result.stderr)
        self.assertNotIn("iOS share preflight", result.stderr)

    def test_cli_reports_only_safe_error(self):
        output = io.StringIO()
        with contextlib.redirect_stderr(output):
            result = release.main(["preflight", "--bundle-id", BUNDLE, "--team-id", "invalid-private-value"])
        self.assertEqual(result, 1)
        self.assertNotIn("invalid-private-value", output.getvalue())


if __name__ == "__main__":
    unittest.main()
