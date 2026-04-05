#!/usr/bin/env bash
# Build the Swift audio-capture-helper as a universal (arm64 + x86_64) binary
# and place it at dist/bin/audio-capture-helper so it ships in the npm tarball.
#
# If `.env.signing` is present and complete, also code-sign with hardened
# runtime and submit the binary to Apple notary service. Otherwise produces
# an unsigned binary (with a log line saying so).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
HELPER_DIR="$ROOT_DIR/swift-helper"
OUT_DIR="$ROOT_DIR/dist/bin"
OUT_BIN="$OUT_DIR/audio-capture-helper"
ENTITLEMENTS="$HELPER_DIR/AudioCaptureHelper.entitlements"

mkdir -p "$OUT_DIR"
cd "$HELPER_DIR"

echo "[build-helper] building arm64..."
swift build -c release --arch arm64

echo "[build-helper] building x86_64..."
swift build -c release --arch x86_64

ARM64_BIN="$HELPER_DIR/.build/arm64-apple-macosx/release/audio-capture-helper"
X86_BIN="$HELPER_DIR/.build/x86_64-apple-macosx/release/audio-capture-helper"

if [[ ! -f "$ARM64_BIN" ]]; then
  echo "[build-helper] arm64 binary missing at $ARM64_BIN" >&2
  exit 1
fi
if [[ ! -f "$X86_BIN" ]]; then
  echo "[build-helper] x86_64 binary missing at $X86_BIN" >&2
  exit 1
fi

echo "[build-helper] lipo → $OUT_BIN"
lipo -create "$ARM64_BIN" "$X86_BIN" -output "$OUT_BIN"
chmod +x "$OUT_BIN"

# ------------------------------------------------------------------
# Optional: code-sign + notarize (requires .env.signing with Developer
# ID Application identity + App Store Connect API key credentials)
# ------------------------------------------------------------------
if [[ -f "$ROOT_DIR/.env.signing" ]]; then
  # shellcheck disable=SC1091
  set -a
  source "$ROOT_DIR/.env.signing"
  set +a
fi

if [[ -n "${APPLE_SIGNING_IDENTITY:-}" && \
      -n "${APPLE_TEAM_ID:-}" && \
      -n "${APPLE_ISSUER_ID:-}" && \
      -n "${APPLE_KEY_ID:-}" && \
      -n "${APPLE_KEY_PATH:-}" ]]; then
  if [[ ! -f "$APPLE_KEY_PATH" ]]; then
    echo "[build-helper] APPLE_KEY_PATH points to a missing file: $APPLE_KEY_PATH" >&2
    exit 1
  fi
  if [[ ! -f "$ENTITLEMENTS" ]]; then
    echo "[build-helper] entitlements file missing: $ENTITLEMENTS" >&2
    exit 1
  fi

  echo "[build-helper] signing with hardened runtime..."
  codesign --force --sign "$APPLE_SIGNING_IDENTITY" \
    --options runtime \
    --timestamp \
    --entitlements "$ENTITLEMENTS" \
    "$OUT_BIN"
  codesign --verify --verbose=2 "$OUT_BIN"

  echo "[build-helper] submitting to notary service (this takes 30s–2min)..."
  ZIP="$OUT_DIR/audio-capture-helper.zip"
  ditto -c -k --keepParent "$OUT_BIN" "$ZIP"

  xcrun notarytool submit "$ZIP" \
    --key "$APPLE_KEY_PATH" \
    --key-id "$APPLE_KEY_ID" \
    --issuer "$APPLE_ISSUER_ID" \
    --wait

  rm -f "$ZIP"

  # Stapling a raw Mach-O binary isn't supported — macOS fetches the
  # notarization ticket online on first launch. Spctl-assess can still
  # confirm the ticket resolves correctly.
  echo "[build-helper] Gatekeeper assessment:"
  spctl --assess --type execute --verbose=4 "$OUT_BIN" 2>&1 || true

  echo "[build-helper] signed + notarized ✔"
else
  echo "[build-helper] (unsigned — no .env.signing configured)"
  echo "[build-helper] Users will hit a Gatekeeper prompt on first launch."
  echo "[build-helper] See .env.signing.example to enable signing."
fi

echo "[build-helper] done:"
lipo -info "$OUT_BIN"
