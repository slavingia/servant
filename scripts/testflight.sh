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
#   SERVANT_IOS_SIGNING         manual (default): the two App Store profiles above, installed by name.
#                               automatic: Xcode makes the profiles and signs with a cloud-managed
#                               distribution certificate through the API key in SERVANT_ASC_CONFIG
#                               (Admin role, or App Manager with cloud-managed certificates); the
#                               upload uses the same key, so APPLE_ID and the app password are not needed.
#   SERVANT_RUBY                ruby with the xcodeproj gem (default: Homebrew's ruby with the
#                               CocoaPods gems, else the ruby on PATH).
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
SIGNING=${SERVANT_IOS_SIGNING:-manual}
AUTH=()
case "$SIGNING" in
  manual) ;;
  automatic)
    ASC_CONFIG=${SERVANT_ASC_CONFIG:-$HOME/.config/servant/asc.json}
    [ -f "$ASC_CONFIG" ] || { echo "Automatic signing needs the App Store Connect API key config at $ASC_CONFIG (see scripts/asc.py)"; exit 2; }
    read -r ASC_KEY_ID ASC_ISSUER_ID ASC_KEY_PATH < <(python3 -c 'import json, os, sys
c = json.load(open(sys.argv[1])); print(c["ASC_KEY_ID"], c["ASC_ISSUER_ID"], os.path.expanduser(c["ASC_KEY_PATH"]))' "$ASC_CONFIG")
    [ -f "$ASC_KEY_PATH" ] || { echo "The API key file $ASC_KEY_PATH from $ASC_CONFIG is missing"; exit 2; }
    AUTH=(-allowProvisioningUpdates -authenticationKeyPath "$ASC_KEY_PATH" -authenticationKeyID "$ASC_KEY_ID" -authenticationKeyIssuerID "$ASC_ISSUER_ID") ;;
  *) echo "SERVANT_IOS_SIGNING is manual or automatic, not $SIGNING"; exit 2 ;;
esac
APP=$(cd "$(dirname "$0")/../app" && pwd)
OUT=$HOME/wt/servant-build/$BUILD
# Check both profiles before prebuild or CocoaPods does any work. A successful
# simulator build does not prove these App Store profiles have the App Group.
[ "$SIGNING" = automatic ] || python3 "$ROOT/scripts/ios-share-release.py" preflight --bundle-id "$BUNDLE_ID" --team-id "$TEAM_ID" \
  --app-profile "$APP_PROFILE" --share-profile "$SHARE_PROFILE"
mkdir -p "$OUT"
cd "$APP"

# Fresh native project so icon/config changes are baked in (ios/ is generated, gitignored).
npx expo prebuild -p ios --clean --no-install
# Homebrew's pod and ruby break when RVM's GEM_HOME/GEM_PATH leak into the environment.
case "$(command -v pod)" in /opt/homebrew/*) CLEAN=(env -u GEM_HOME -u GEM_PATH) ;; *) CLEAN=(env) ;; esac
(cd ios && "${CLEAN[@]}" pod install)

/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $BUILD" ios/Servant/Info.plist
# Signing on the app target and the share extension (expo-sharing, app.json: target
# expo-sharing-extension, App ID <bundle id>.share, app group group.<bundle id>); Pods/SPM
# framework targets can't take a provisioning profile. The extension's CFBundleVersion comes from
# CURRENT_PROJECT_VERSION and must match the app's. Manual: both profiles need the App Groups
# capability. Automatic: Xcode registers both App IDs and the group through the API key.
if [ -n "${SERVANT_RUBY:-}" ]; then RUBY=$SERVANT_RUBY; RUBY_GEM_HOME=${GEM_HOME:-}
elif [ -x /opt/homebrew/opt/ruby/bin/ruby ] && [ -d /opt/homebrew/opt/cocoapods/libexec ]; then RUBY=/opt/homebrew/opt/ruby/bin/ruby; RUBY_GEM_HOME=/opt/homebrew/opt/cocoapods/libexec
else RUBY=ruby; RUBY_GEM_HOME=${GEM_HOME:-}; fi
"${CLEAN[@]}" ${RUBY_GEM_HOME:+GEM_HOME=$RUBY_GEM_HOME} ${RUBY_GEM_HOME:+GEM_PATH=$RUBY_GEM_HOME} SIGNING="$SIGNING" TEAM_ID="$TEAM_ID" APP_PROFILE="$APP_PROFILE" SHARE_PROFILE="$SHARE_PROFILE" BUILD="$BUILD" "$RUBY" -rxcodeproj -e 'p=Xcodeproj::Project.open("ios/Servant.xcodeproj"); sign=lambda{|name,profile,extra| t=p.targets.find{|x|x.name==name} or abort("no target #{name}"); t.build_configurations.each{|c| c.build_settings.merge!((ENV["SIGNING"]=="automatic" ? {"CODE_SIGN_STYLE"=>"Automatic","DEVELOPMENT_TEAM"=>ENV["TEAM_ID"],"PROVISIONING_PROFILE_SPECIFIER"=>""} : {"CODE_SIGN_STYLE"=>"Manual","DEVELOPMENT_TEAM"=>ENV["TEAM_ID"],"PROVISIONING_PROFILE_SPECIFIER"=>profile,"CODE_SIGN_IDENTITY"=>"Apple Distribution"}).merge(extra))}}; sign.("Servant",ENV["APP_PROFILE"],{}); sign.("expo-sharing-extension",ENV["SHARE_PROFILE"],{"CURRENT_PROJECT_VERSION"=>ENV["BUILD"]}); p.save'

cat > "$OUT/ExportOptions.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>app-store-connect</string>
  <key>teamID</key><string>$TEAM_ID</string>
  <key>signingStyle</key><string>$SIGNING</string>
$([ "$SIGNING" = automatic ] || printf '  <key>provisioningProfiles</key><dict><key>%s</key><string>%s</string><key>%s.share</key><string>%s</string></dict>\n' "$BUNDLE_ID" "$APP_PROFILE" "$BUNDLE_ID" "$SHARE_PROFILE")  <key>destination</key><string>export</string>
</dict></plist>
EOF

xcodebuild -workspace ios/Servant.xcworkspace -scheme Servant -configuration Release \
  -destination "generic/platform=iOS" -archivePath "$OUT/Servant.xcarchive" ${AUTH[@]+"${AUTH[@]}"} archive \
  > "$OUT/archive.log" 2>&1 || { tail -40 "$OUT/archive.log"; grep -E "error:" "$OUT/archive.log" | head; exit 1; }
echo "** ARCHIVE SUCCEEDED **"
python3 "$ROOT/scripts/ios-share-release.py" archive --path "$OUT/Servant.xcarchive" \
  --bundle-id "$BUNDLE_ID" --team-id "$TEAM_ID" --build "$BUILD"

xcodebuild -exportArchive -archivePath "$OUT/Servant.xcarchive" -exportPath "$OUT/export" \
  -exportOptionsPlist "$OUT/ExportOptions.plist" ${AUTH[@]+"${AUTH[@]}"} > "$OUT/export.log" 2>&1 || { tail -30 "$OUT/export.log"; exit 1; }
python3 "$ROOT/scripts/ios-share-release.py" ipa --path "$OUT/export/Servant.ipa" \
  --bundle-id "$BUNDLE_ID" --team-id "$TEAM_ID" --build "$BUILD"
echo "IPA: $OUT/export/Servant.ipa"

[ "$UPLOAD" = "--no-upload" ] && exit 0
cd "$OUT/export"
if [ "$SIGNING" = automatic ]; then
  # altool reads AuthKey_<id>.p8 from ~/.appstoreconnect/private_keys.
  mkdir -p "$HOME/.appstoreconnect/private_keys"
  [ -e "$HOME/.appstoreconnect/private_keys/AuthKey_$ASC_KEY_ID.p8" ] || ln -s "$ASC_KEY_PATH" "$HOME/.appstoreconnect/private_keys/AuthKey_$ASC_KEY_ID.p8"
  xcrun altool --upload-app -f Servant.ipa -t ios --apiKey "$ASC_KEY_ID" --apiIssuer "$ASC_ISSUER_ID"
else
  xcrun altool --upload-app -f Servant.ipa -t ios -u ${APPLE_ID:?set APPLE_ID to your Apple developer email} -p "@keychain:${SERVANT_APP_PASSWORD_ITEM:-APP_SPECIFIC_PASSWORD}"
fi
"${ASC_PY:-$HOME/wt/ascenv/bin/python}" "$ROOT/scripts/notes.py" "$BUILD" "$NOTES" --testflight  # needs cryptography
