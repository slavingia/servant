#!/bin/bash
# Build Servant for TestFlight under your Apple Developer team and upload.
# Usage: scripts/testflight.sh <build-number> --notes <notes.md> [--no-upload]
#
# Configuration (environment):
#   SERVANT_APPLE_TEAM_ID       required: your Apple Developer team ID (10 characters).
#   SERVANT_BUNDLE_ID           app bundle id (default com.example.servant); the share
#                               extension is <id>.share, the app group group.<id>.
#   SERVANT_IOS_APP_PROFILE     provisioning profile name for the app (default "Servant Push App Store").
#   SERVANT_IOS_SHARE_PROFILE   provisioning profile name for the share extension (default
#                               "Servant Share App Store"; the older SHARE_PROFILE is still honored).
#   APPLE_ID                    your Apple developer email, for the upload (not needed with --no-upload).
#   SERVANT_APP_PASSWORD_ITEM   keychain item holding the app-specific password for APPLE_ID
#                               (default APP_SPECIFIC_PASSWORD).
#   SERVANT_ASC_APP_ID          the app's numeric Apple ID in App Store Connect, for the What to Test
#                               notes (scripts/notes.py; not needed with --no-upload).
#   SERVANT_ASC_CONFIG          App Store Connect API key config (see scripts/asc.py).
#   ASC_PY                      Python with `cryptography` for scripts/notes.py (default ~/wt/ascenv/bin/python).
# Notes are required: they become TestFlight's What to Test and the build's post
# in Servant's #whats-new (scripts/notes.py).
set -euo pipefail
BUILD=${1:?build number}
[[ "$BUILD" =~ ^[0-9]+(\.[0-9]+){0,2}$ ]] || { echo "Use a numeric build number (up to three dot-separated parts)" >&2; exit 2; }
ROOT=$(cd "$(dirname "$0")/.." && pwd)
NOTES=""; UPLOAD=""
shift; while [ $# -gt 0 ]; do case "$1" in --notes) NOTES=$(cd "$(dirname "$2")" && pwd)/$(basename "$2"); shift 2;; --no-upload) UPLOAD=--no-upload; shift;; *) echo "unknown arg $1"; exit 2;; esac; done
[ -n "$UPLOAD" ] || [ -s "$NOTES" ] || { echo "Add --notes <file>: what changed and what to test"; exit 2; }
TEAM_ID=${SERVANT_APPLE_TEAM_ID:-}
[ -n "$TEAM_ID" ] || { echo "Set SERVANT_APPLE_TEAM_ID to your Apple Developer team ID"; exit 2; }
[ -n "$UPLOAD" ] || [ -n "${SERVANT_ASC_APP_ID:-}" ] || { echo "Set SERVANT_ASC_APP_ID to the app's Apple ID in App Store Connect"; exit 2; }
BUNDLE_ID=${SERVANT_BUNDLE_ID:-com.example.servant}
# app.config.js trims this value too; signing and the generated app must agree.
BUNDLE_ID=$(printf '%s' "$BUNDLE_ID" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
BUNDLE_ID=${BUNDLE_ID:-com.example.servant}
APP_PROFILE=${SERVANT_IOS_APP_PROFILE:-"Servant Push App Store"}
SHARE_PROFILE=${SERVANT_IOS_SHARE_PROFILE:-${SHARE_PROFILE:-"Servant Share App Store"}}
APP=$(cd "$(dirname "$0")/../app" && pwd)
OUT=$HOME/wt/servant-build/$BUILD
# Check both profiles before prebuild or CocoaPods does any work. A successful
# simulator build does not prove these App Store profiles have the App Group.
python3 "$ROOT/scripts/ios-share-release.py" preflight --bundle-id "$BUNDLE_ID" --team-id "$TEAM_ID" \
  --app-profile "$APP_PROFILE" --share-profile "$SHARE_PROFILE"
mkdir -p "$OUT"
cd "$APP"

# Fresh native project so icon/config changes are baked in (ios/ is generated, gitignored).
npx expo prebuild -p ios --clean --no-install
(cd ios && pod install)

/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $BUILD" ios/Servant/Info.plist
# Manual signing on the app target and the share extension (expo-sharing, app.json: target
# expo-sharing-extension, App ID <bundle id>.share, app group group.<bundle id>); Pods/SPM
# framework targets can't take a provisioning profile. The extension's CFBundleVersion comes from
# CURRENT_PROJECT_VERSION and must match the app's. Both profiles need the App Groups capability.
TEAM_ID="$TEAM_ID" APP_PROFILE="$APP_PROFILE" SHARE_PROFILE="$SHARE_PROFILE" BUILD="$BUILD" GEM_HOME=/opt/homebrew/opt/cocoapods/libexec /opt/homebrew/opt/ruby/bin/ruby -rxcodeproj -e 'p=Xcodeproj::Project.open("ios/Servant.xcodeproj"); sign=lambda{|name,profile,extra| t=p.targets.find{|x|x.name==name} or abort("no target #{name}"); t.build_configurations.each{|c| c.build_settings.merge!({"CODE_SIGN_STYLE"=>"Manual","DEVELOPMENT_TEAM"=>ENV["TEAM_ID"],"PROVISIONING_PROFILE_SPECIFIER"=>profile,"CODE_SIGN_IDENTITY"=>"Apple Distribution"}.merge(extra))}}; sign.("Servant",ENV["APP_PROFILE"],{}); sign.("expo-sharing-extension",ENV["SHARE_PROFILE"],{"CURRENT_PROJECT_VERSION"=>ENV["BUILD"]}); p.save'

cat > "$OUT/ExportOptions.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>app-store-connect</string>
  <key>teamID</key><string>$TEAM_ID</string>
  <key>signingStyle</key><string>manual</string>
  <key>provisioningProfiles</key><dict><key>$BUNDLE_ID</key><string>$APP_PROFILE</string><key>$BUNDLE_ID.share</key><string>$SHARE_PROFILE</string></dict>
  <key>destination</key><string>export</string>
</dict></plist>
EOF

xcodebuild -workspace ios/Servant.xcworkspace -scheme Servant -configuration Release \
  -destination "generic/platform=iOS" -archivePath "$OUT/Servant.xcarchive" archive \
  > "$OUT/archive.log" 2>&1 || { tail -40 "$OUT/archive.log"; grep -E "error:" "$OUT/archive.log" | head; exit 1; }
echo "** ARCHIVE SUCCEEDED **"
python3 "$ROOT/scripts/ios-share-release.py" archive --path "$OUT/Servant.xcarchive" \
  --bundle-id "$BUNDLE_ID" --team-id "$TEAM_ID" --build "$BUILD"

xcodebuild -exportArchive -archivePath "$OUT/Servant.xcarchive" -exportPath "$OUT/export" \
  -exportOptionsPlist "$OUT/ExportOptions.plist" > "$OUT/export.log" 2>&1 || { tail -30 "$OUT/export.log"; exit 1; }
python3 "$ROOT/scripts/ios-share-release.py" ipa --path "$OUT/export/Servant.ipa" \
  --bundle-id "$BUNDLE_ID" --team-id "$TEAM_ID" --build "$BUILD"
echo "IPA: $OUT/export/Servant.ipa"

[ "$UPLOAD" = "--no-upload" ] && exit 0
cd "$OUT/export"
xcrun altool --upload-app -f Servant.ipa -t ios -u ${APPLE_ID:?set APPLE_ID to your Apple developer email} -p "@keychain:${SERVANT_APP_PASSWORD_ITEM:-APP_SPECIFIC_PASSWORD}"
"${ASC_PY:-$HOME/wt/ascenv/bin/python}" "$ROOT/scripts/notes.py" "$BUILD" "$NOTES" --testflight  # needs cryptography
