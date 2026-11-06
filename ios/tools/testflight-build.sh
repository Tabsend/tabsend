#!/bin/zsh
# Builds the iPhone app for TestFlight on this Mac. No iPhone needed.
#
#   ios/tools/testflight-build.sh 723           signs a copy, checks it, and stops
#   ios/tools/testflight-build.sh 723 upload    signs it and sends it to App Store Connect
#
# The number is the build number. Each upload needs one higher than the last (TestFlight showed
# 579 on 2026-11-03; 723 was the commit count on 2026-11-05).
#
# Why not a plain Xcode archive: it wants a development profile, which needs a registered iPhone,
# and the team has none. So the archive is made unsigned, the permissions an unsigned build loses
# are put back by hand, and Xcode then signs it for the App Store with the Apple account it is
# signed in to. The same method as voice-mode-ios/tools/testflight-build.sh.
set -euo pipefail

build="${1:?Give the build number, for example: ios/tools/testflight-build.sh 723}"
mode="${2:-export}"
[[ "$build" =~ '^[0-9]+$' ]] || { echo "The build number must be a whole number."; exit 1; }
[[ "$mode" == "export" || "$mode" == "upload" ]] || { echo "Second word: upload, or nothing."; exit 1; }

team="6Z5P8M8V52"
cd "${0:A:h}/.."
xcodegen generate > /dev/null

work="$HOME/Library/Developer/Xcode/DerivedData/Tabsend-testflight"
archive="$work/Tabsend.xcarchive"
export_plist="$work/export.plist"
rm -rf "$archive" "$work/export" "$work/entitlements"
mkdir -p "$work/entitlements"

xcodebuild -project Tabsend.xcodeproj -scheme Tabsend -configuration Release \
  -destination 'generic/platform=iOS' -derivedDataPath "$work" -archivePath "$archive" \
  CODE_SIGNING_ALLOWED=NO CURRENT_PROJECT_VERSION="$build" archive > "$work/archive.log" 2>&1 \
  || { grep -E 'error:' "$work/archive.log" | sort -u; echo "Archive failed: $work/archive.log"; exit 1; }

# The permission files name the team's prefix with a placeholder that Xcode fills in when it signs.
# Here nothing signs, so fill it in before putting the permissions back.
for name in Tabsend TabsendShare TabsendNotify; do
  src="App/$name.entitlements"
  [[ "$name" == "TabsendShare" ]] && src="App/ShareExtension/TabsendShare.entitlements"
  [[ "$name" == "TabsendNotify" ]] && src="App/NotifyExtension/TabsendNotify.entitlements"
  sed "s/\$(AppIdentifierPrefix)/$team./g" "$src" > "$work/entitlements/$name.entitlements"
done

app="$archive/Products/Applications/Tabsend.app"
codesign -f -s - --entitlements "$work/entitlements/TabsendShare.entitlements" "$app/PlugIns/TabsendShare.appex"
codesign -f -s - --entitlements "$work/entitlements/TabsendNotify.entitlements" "$app/PlugIns/TabsendNotify.appex"
codesign -f -s - --entitlements "$work/entitlements/Tabsend.entitlements" "$app"

cat > "$export_plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>method</key><string>app-store-connect</string>
<key>destination</key><string>$mode</string>
<key>signingStyle</key><string>automatic</string>
<key>teamID</key><string>$team</string>
<key>manageAppVersionAndBuildNumber</key><false/>
</dict></plist>
EOF

xcodebuild -exportArchive -archivePath "$archive" -exportPath "$work/export" \
  -exportOptionsPlist "$export_plist" -allowProvisioningUpdates > "$work/export.log" 2>&1 \
  || { grep -E 'error:' "$work/export.log" | sort -u; echo "Signing failed: $work/export.log"; exit 1; }

if [[ "$mode" == "export" ]]; then
  # Stop here if a permission went missing: such a build would upload fine and then not work.
  check="$work/check"
  rm -rf "$check"; mkdir -p "$check"
  unzip -q "$work/export/Tabsend.ipa" -d "$check"
  main="$check/Payload/Tabsend.app"
  share="$main/PlugIns/TabsendShare.appex"
  notify="$main/PlugIns/TabsendNotify.appex"
  need() {  # need <bundle> <text that must be in its permissions>
    codesign -d --entitlements - --xml "$1" 2>/dev/null | plutil -p - | grep -q -F "$2" \
      || { echo "Missing in ${1:t}: $2"; exit 1; }
  }
  need "$main" "applinks:account.tabsend.org"
  need "$main" "group.io.tabsend.app"
  need "$main" "$team.io.tabsend.shared"
  need "$main" '"aps-environment" => "production"'
  need "$main" '"get-task-allow" => false'
  need "$share" "group.io.tabsend.app"
  need "$share" "$team.io.tabsend.shared"
  # The notification extension (P-29) reads the link's keys from the same two places.
  need "$notify" "group.io.tabsend.app"
  need "$notify" "$team.io.tabsend.shared"
  echo "Build number in the file: $(plutil -extract CFBundleVersion raw "$main/Info.plist")"
  rm -rf "$check"
fi

echo "Done ($mode). Delete $work when finished: disk space is tight."
