#!/bin/bash
# Build Servant for Android and ship to Firebase App Distribution (internal group "Servant internal").
# Usage: scripts/firebase.sh <build-number> --notes <notes.md> [--no-upload]
# Notes are required: what changed and what to test. They become the Firebase
# release notes and the build's post in Servant's #whats-new (scripts/notes.py).
# Also builds the Play AAB (app-release.aab); scripts/play.py uploads it to the internal track.
# Key: .certs/servant-release.keystore (git-ignored), password in keychain item servant-android-key.
# Needs FIREBASE_PROJECT (project id) and FIREBASE_APP_ID (the Android app's id, 1:…:android:…)
# from the environment for the upload; FIREBASE_GROUP defaults to servant-internal.
set -euo pipefail
export ANDROID_HOME=${ANDROID_HOME:-$HOME/Library/Android/sdk}
export JAVA_HOME=${JAVA_HOME:-$(/usr/libexec/java_home -v 17 2>/dev/null || /usr/libexec/java_home)}
BUILD=${1:?build number}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
NOTES=""; NO_UPLOAD=""
shift; while [ $# -gt 0 ]; do case "$1" in --notes) NOTES=$(cd "$(dirname "$2")" && pwd)/$(basename "$2"); shift 2;; --no-upload) NO_UPLOAD=1; shift;; *) echo "unknown arg $1"; exit 2;; esac; done
[ -n "$NO_UPLOAD" ] || [ -s "$NOTES" ] || { echo "Add --notes <file>: what changed and what to test"; exit 2; }
if [ -z "$NO_UPLOAD" ]; then
  [ -n "${FIREBASE_PROJECT:-}" ] && [ -n "${FIREBASE_APP_ID:-}" ] || { echo "Set FIREBASE_PROJECT and FIREBASE_APP_ID (see the top of $0), or pass --no-upload"; exit 2; }
fi
APP_ID=${FIREBASE_APP_ID:-}
PROJECT=${FIREBASE_PROJECT:-}
GROUP=${FIREBASE_GROUP:-servant-internal}
FB="env -u GOOGLE_CLOUD_QUOTA_PROJECT -u GOOGLE_CLOUD_PROJECT -u CLOUDSDK_CORE_PROJECT -u GOOGLE_APPLICATION_CREDENTIALS firebase"
PW=$(security find-generic-password -a servant -s servant-android-key -w)

cd "$ROOT/app"
npx expo prebuild --platform android --no-install >/dev/null
G=android/app/build.gradle
# Release signing from env; prebuild regenerates android/, so patch every build.
python3 - "$G" "$BUILD" <<'EOF'
import re,sys
p,build=sys.argv[1:3]; s=open(p).read()
if "SERVANT_KEYSTORE" not in s:
    s=s.replace("signingConfigs {", """signingConfigs {
        release {
            storeFile file(System.getenv("SERVANT_KEYSTORE"))
            storePassword System.getenv("SERVANT_KEY_PW")
            keyAlias "servant"
            keyPassword System.getenv("SERVANT_KEY_PW")
        }""",1)
    i=s.index("buildTypes {"); j=s.index("release {",i)
    k=s.index("signingConfig signingConfigs.debug",j)
    s=s[:k]+"signingConfig signingConfigs.release"+s[k+len("signingConfig signingConfigs.debug"):]
s=re.sub(r"versionCode \d+", f"versionCode {build}", s)
open(p,"w").write(s)
EOF

cd android
SERVANT_KEYSTORE="$ROOT/.certs/servant-release.keystore" SERVANT_KEY_PW="$PW" ./gradlew -q assembleRelease bundleRelease
AAB=$PWD/app/build/outputs/bundle/release/app-release.aab
APK=app/build/outputs/apk/release/app-release.apk
"$(ls -d ~/Library/Android/sdk/build-tools/* | tail -1)/apksigner" verify --print-certs "$APK" | grep -m1 "certificate DN"
[ -n "$NO_UPLOAD" ] && { echo "$PWD/$APK"; echo "$AAB"; exit 0; }

$FB appdistribution:distribute "$APK" --app "$APP_ID" --groups "$GROUP" --project "$PROJECT" \
  --release-notes-file "$NOTES" 2>&1 | grep -E "uploaded|distributed|console|Error|testing"
python3 "$ROOT/scripts/notes.py" "$BUILD" "$NOTES"
