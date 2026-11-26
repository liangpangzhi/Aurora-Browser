#!/bin/bash
#
# Build one fnOS .fpk target:
#   ./build.sh arm    -> dist/fn-browser-arm64.fpk
#   ./build.sh x86    -> dist/fn-browser-x86_64.fpk
#
# Overrides: NODE_VERSION, VERSION, FNPACK_BIN, FNPACK_VERSION.
set -euo pipefail

ARCH="${1:-${ARCH:-arm}}"
case "$ARCH" in
    arm|arm64)        NODE_ARCH=arm64; PLATFORM=arm; OUT_SUFFIX=arm64 ;;
    x86|x86_64|amd64) NODE_ARCH=x64;   PLATFORM=x86; OUT_SUFFIX=x86_64 ;;
    *) echo "Usage: $0 {arm|x86}" >&2; exit 1 ;;
esac

NODE_VERSION="${NODE_VERSION:-v20.18.0}"
FNPACK_VERSION="${FNPACK_VERSION:-1.2.3}"
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

VERSION="${VERSION:-$(awk -F= '$1 ~ /^version[[:space:]]*$/ {gsub(/[[:space:]]/, "", $2); print $2; exit}' manifest)}"
[ -n "$VERSION" ] || { echo "无法从 manifest 读取 version" >&2; exit 1; }

echo "==> [1/6] 生成并校验图标 (${ARCH})..."
if command -v python3 >/dev/null 2>&1; then
    python3 scripts/generate_icons.py
fi
for icon in ICON.PNG ICON_256.PNG app/ui/images/icon_64.png app/ui/images/icon_256.png; do
    [ -f "$icon" ] || { echo "缺少必需图标: $icon" >&2; exit 1; }
done
for required in manifest config/privilege config/resource app cmd; do
    [ -e "$required" ] || { echo "缺少打包必需项: $required" >&2; exit 1; }
done

echo "==> [2/6] 准备 ${NODE_ARCH} 独立 Node.js 运行时..."
RUNTIME_DIR="$ROOT/app/runtime"
mkdir -p "$RUNTIME_DIR"
NODE_BIN="$RUNTIME_DIR/node-${NODE_ARCH}"
if [ ! -x "$NODE_BIN" ]; then
    TMP_DIR="$(mktemp -d)"
    trap 'rm -rf "$TMP_DIR"' EXIT
    curl -fSL "https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz" \
        -o "$TMP_DIR/node.tar.xz"
    tar -xJf "$TMP_DIR/node.tar.xz" -C "$TMP_DIR"
    cp "$TMP_DIR/node-${NODE_VERSION}-linux-${NODE_ARCH}/bin/node" "$NODE_BIN"
    chmod +x "$NODE_BIN"
    rm -rf "$TMP_DIR"
    trap - EXIT
fi

echo "==> [3/6] 安装服务端生产依赖 (跳过 native optional 包以保证跨架构)..."
if command -v npm >/dev/null 2>&1; then
    (cd app/server && npm ci --omit=dev --omit=optional)
else
    echo "警告: 当前环境无 npm，包内将不含 Scramjet 依赖，运行时会回退到轻量内核。"
fi

echo "==> [4/6] 准备 fnpack (按构建主机架构，与目标架构无关)..."
FNPACK_BIN="${FNPACK_BIN:-$(command -v fnpack || true)}"
if [ -z "$FNPACK_BIN" ]; then
    case "$(uname -m)" in
        aarch64|arm64) FNPACK_HOST_ARCH=arm64 ;;
        *)             FNPACK_HOST_ARCH=amd64 ;;
    esac
    FNPACK_BIN="/tmp/fnpack-cli-${FNPACK_HOST_ARCH}"
    if [ ! -x "$FNPACK_BIN" ]; then
        curl -fSL "https://static2.fnnas.com/fnpack/fnpack-${FNPACK_VERSION}-linux-${FNPACK_HOST_ARCH}" \
            -o "$FNPACK_BIN" || \
        curl -fSL "https://static2.fnnas.com/fnpack/fnpack-1.2.1-linux-${FNPACK_HOST_ARCH}" \
            -o "$FNPACK_BIN"
        chmod +x "$FNPACK_BIN"
    fi
fi

echo "==> [5/6] 隔离目录打包 (platform=${PLATFORM}, version=${VERSION})..."
STAGE_DIR="$(mktemp -d)"
trap 'rm -rf "$STAGE_DIR"' EXIT
cp -a manifest ICON.PNG ICON_256.PNG app cmd config "$STAGE_DIR/"
mkdir -p "$STAGE_DIR/app/runtime"
# Ship exactly one Node binary: drop the download-cache node-<arch> files
# (and any stale runtime left by a previous arch build in this workspace)
# so the same binary never lands in the package twice.
rm -f "$STAGE_DIR"/app/runtime/node "$STAGE_DIR"/app/runtime/node-*
cp "$NODE_BIN" "$STAGE_DIR/app/runtime/node"
chmod +x "$STAGE_DIR"/cmd/* "$STAGE_DIR/app/runtime/node"

python3 - "$STAGE_DIR/manifest" "$PLATFORM" "$VERSION" <<'PY'
import sys
path, platform, version = sys.argv[1:4]
lines = []
for line in open(path, encoding="utf-8"):
    key = line.split("=", 1)[0].strip()
    if key == "platform":
        line = f"platform = {platform}\n"
    elif key == "version":
        line = f"version = {version}\n"
    lines.append(line)
open(path, "w", encoding="utf-8").writelines(lines)
PY

(cd "$STAGE_DIR" && "$FNPACK_BIN" build)
FPK_OUT="$(ls -1 "$STAGE_DIR"/*.fpk | head -n 1)"

echo "==> [6/6] 输出产物..."
mkdir -p dist
cp "$FPK_OUT" "dist/fn-browser-${OUT_SUFFIX}.fpk"
rm -rf "$STAGE_DIR"
trap - EXIT

echo "构建完成: dist/fn-browser-${OUT_SUFFIX}.fpk"
