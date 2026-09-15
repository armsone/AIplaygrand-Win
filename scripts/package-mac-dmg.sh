#!/bin/bash
# Run after APPLE_KEYCHAIN_PROFILE=<existing profile> npm run dist:mac.
# Input: signed/notarized .app, output directory. Output: signed/notarized portable-folder DMG.
# Stops on invalid signatures, missing notarization, existing output, or any packaging failure.
set -euo pipefail
project_root="$(cd "$(dirname "$0")/.." && pwd)"
app_path="${1:?Usage: bash scripts/package-mac-dmg.sh <notarized.app> <output-directory>}"
output_dir="${2:?Specify an output directory}"
version="$(node -p "require(process.argv[1]).version" "$project_root/package.json")"
identity="${CODESIGN_IDENTITY:-Developer ID Application: BYOUNG KI HAN (T7B4EPLHPK)}"
notary_profile="${NOTARY_PROFILE:-ccmb-notary}"
output_path="$output_dir/AIplaygrand-Win-Mac-$version-arm64.dmg"
[[ -d "$app_path" && ! -e "$output_path" ]]
[[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$app_path/Contents/Info.plist")" == 'org.aiplaygrand.win' ]]
[[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app_path/Contents/Info.plist")" == "$version" ]]
lipo -verify_arch arm64 "$app_path/Contents/MacOS/AIplaygrand-Win"
codesign --verify --deep --strict "$app_path"
xcrun stapler validate "$app_path"
mkdir -p "$project_root/work" "$output_dir"
stage_dir="$(mktemp -d "$project_root/work/mac-dmg.XXXXXX")"
mkdir "$stage_dir/AIplaygrand-Win"
ditto "$app_path" "$stage_dir/AIplaygrand-Win/AIplaygrand-Win.app"
cp "$project_root/Mac-시작하기.txt" "$stage_dir/먼저 읽어주세요.txt"
cp "$project_root/Mac-시작하기.txt" "$project_root/시연-안내.md" "$stage_dir/AIplaygrand-Win/"
hdiutil create -volname "AIplaygrand-Win $version" -srcfolder "$stage_dir" -format UDZO "$output_path"
codesign --force --timestamp --sign "$identity" "$output_path"
xcrun notarytool submit "$output_path" --keychain-profile "$notary_profile" --wait
xcrun stapler staple "$output_path"
xcrun stapler validate "$output_path"
shasum -a 256 "$output_path"
