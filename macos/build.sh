#!/bin/zsh
# Builds Manuscript.app in this folder's parent. Run again if you move the folder
# or reinstall Node. Add --install to also copy it to /Applications.
set -euo pipefail
cd "$(dirname "$0")/.."
HOME_DIR="$PWD"
APP="$HOME_DIR/Manuscript.app"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
NODE="$(command -v node || true)"
[[ -n "$NODE" ]] || { echo "Node.js not found. Install it from nodejs.org first."; exit 1; }

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

echo "Compiling…"
xcrun swiftc -O -swift-version 5 -o "$APP/Contents/MacOS/Manuscript" macos/main.swift -framework Cocoa -framework WebKit

echo "Drawing icon…"
xcrun swiftc -swift-version 5 -o "$TMP/icon" macos/icon.swift -framework Cocoa
"$TMP/icon" "$TMP/icon.png"
ICONSET="$TMP/AppIcon.iconset"
mkdir "$ICONSET"
for s in 16 32 128 256 512; do
  sips -z $s $s "$TMP/icon.png" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  sips -z $((s * 2)) $((s * 2)) "$TMP/icon.png" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"

cat > "$APP/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Manuscript</string>
  <key>CFBundleDisplayName</key><string>Manuscript</string>
  <key>CFBundleIdentifier</key><string>local.manuscript.app</string>
  <key>CFBundleExecutable</key><string>Manuscript</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.productivity</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
  <key>ManuscriptHome</key><string>$HOME_DIR</string>
  <key>NodePath</key><string>$NODE</string>
</dict>
</plist>
EOF

codesign --force -s - "$APP" 2>/dev/null
echo "Built $APP"

if [[ "${1:-}" == "--install" ]]; then
  rm -rf "/Applications/Manuscript.app"
  cp -R "$APP" "/Applications/Manuscript.app"
  echo "Installed /Applications/Manuscript.app"
fi
