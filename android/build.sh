#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
SDK=${ANDROID_SDK_ROOT:-${ANDROID_HOME:-$HOME/Android/Sdk}}
BT="$SDK/build-tools/35.0.0"
JAR="$SDK/platforms/android-35/android.jar"
BUILD=${MMC_BUILD:-$PWD/build}
KEY=${MMC_KEYSTORE:-$HOME/.config/mesh-mission-control/release.keystore}
mkdir -p "$BUILD/classes" "$BUILD/dex" "$(dirname "$KEY")"
"$BT/aapt" package -f -M AndroidManifest.xml -S res -A assets -I "$JAR" -F "$BUILD/unsigned.apk"
javac -source 8 -target 8 -classpath "$JAR" -d "$BUILD/classes" src/io/github/earlvanze/meshmission/MainActivity.java
"$BT/d8" --min-api 23 --lib "$JAR" --output "$BUILD/dex" "$BUILD/classes/io/github/earlvanze/meshmission/"*.class
python3 -c 'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1],"a",zipfile.ZIP_DEFLATED); z.write(sys.argv[2],"classes.dex"); z.close()' "$BUILD/unsigned.apk" "$BUILD/dex/classes.dex"
"$BT/zipalign" -f 4 "$BUILD/unsigned.apk" "$BUILD/aligned.apk"
if [ ! -f "$KEY" ]; then keytool -genkeypair -keystore "$KEY" -storepass android -keypass android -alias mesh -keyalg RSA -keysize 2048 -validity 10000 -dname 'CN=Mesh Mission Control' >/dev/null 2>&1; chmod 600 "$KEY"; fi
"$BT/apksigner" sign --ks "$KEY" --ks-pass pass:android --key-pass pass:android --out "$BUILD/mesh-mission-control.apk" "$BUILD/aligned.apk"
"$BT/apksigner" verify "$BUILD/mesh-mission-control.apk"
