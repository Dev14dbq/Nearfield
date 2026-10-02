#!/bin/bash
# Builds Nearfield for macOS and installs it into /Applications.
# (`cargo tauri build` trips over proc-macros here, so the binary is built with cargo first.)
set -euo pipefail
cd "$(dirname "$0")/src-tauri"
CARGO_PROFILE_RELEASE_LTO=off cargo build --release
cargo tauri bundle --bundles app,dmg
pkill -x nearfield 2>/dev/null || true
rm -rf /Applications/Nearfield.app
cp -R target/release/bundle/macos/Nearfield.app /Applications/Nearfield.app
echo "Installed: /Applications/Nearfield.app"
echo "Installer: $(pwd)/target/release/bundle/dmg/"
