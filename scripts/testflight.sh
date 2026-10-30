#!/bin/bash
# Build Servant for TestFlight under the IRS team (EXBV39ZXGR) and upload.
# Usage: scripts/testflight.sh <build-number> [--no-upload]
set -euo pipefail
BUILD=${1:?build number}
UPLOAD=${2:-}
APP=$(cd "$(dirname "$0")/../app" && pwd)
OUT=$HOME/wt/servant-build/$BUILD
mkdir -p "$OUT"
cd "$APP"

# Fresh native project so icon/config changes are baked in (ios/ is generated, gitignored).
npx expo prebuild -p ios --clean --no-install
(cd ios && pod install)

/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $BUILD" ios/Servant/Info.plist
# Manual signing on the app target only; Pods/SPM framework targets can't take a provisioning profile.
GEM_HOME=/opt/homebrew/opt/cocoapods/libexec /opt/homebrew/opt/ruby/bin/ruby -rxcodeproj -e 'p=Xcodeproj::Project.open("ios/Servant.xcodeproj"); p.targets.find{|t|t.name=="Servant"}.build_configurations.each{|c| c.build_settings.merge!("CODE_SIGN_STYLE"=>"Manual","DEVELOPMENT_TEAM"=>"EXBV39ZXGR","PROVISIONING_PROFILE_SPECIFIER"=>"Servant Push App Store","CODE_SIGN_IDENTITY"=>"Apple Distribution")}; p.save'

cat > "$OUT/ExportOptions.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>app-store-connect</string>
  <key>teamID</key><string>EXBV39ZXGR</string>
  <key>signingStyle</key><string>manual</string>
  <key>provisioningProfiles</key><dict><key>gov.irs.servant</key><string>Servant Push App Store</string></dict>
  <key>destination</key><string>export</string>
</dict></plist>
EOF

xcodebuild -workspace ios/Servant.xcworkspace -scheme Servant -configuration Release \
  -destination "generic/platform=iOS" -archivePath "$OUT/Servant.xcarchive" archive \
  > "$OUT/archive.log" 2>&1 || { tail -40 "$OUT/archive.log"; grep -E "error:" "$OUT/archive.log" | head; exit 1; }
echo "** ARCHIVE SUCCEEDED **"

xcodebuild -exportArchive -archivePath "$OUT/Servant.xcarchive" -exportPath "$OUT/export" \
  -exportOptionsPlist "$OUT/ExportOptions.plist" > "$OUT/export.log" 2>&1 || { tail -30 "$OUT/export.log"; exit 1; }
unzip -p "$OUT/export/Servant.ipa" 'Payload/*.app/Info.plist' | plutil -p - | grep -E "CFBundleVersion|CFBundleShortVersionString|CFBundleIdentifier"
echo "IPA: $OUT/export/Servant.ipa"

[ "$UPLOAD" = "--no-upload" ] && exit 0
cd "$OUT/export"
xcrun altool --upload-app -f Servant.ipa -t ios -u sahil.lavingia@irs.gov -p @keychain:APP_SPECIFIC_PASSWORD
