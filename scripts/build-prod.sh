#!/usr/bin/env bash
# 生成给对方 nginx（int.cosyhome.com.cn）部署的静态包。
# 只构建和打包，不部署、不连接任何接口（含生产接口）。
#
# 用法：
#   scripts/build-prod.sh                 # 默认直连 https://control.cosyhome.com.cn/v1（对方需为本站开 CORS）
#   API_BASE=/api scripts/build-prod.sh   # 走 nginx 反向代理方案，config.js 里 apiBase 写 /api
#   OUT_DIR=/tmp/release scripts/build-prod.sh
#
# 产物：$OUT_DIR/hengjing-cloud-<版本>-<commit>.zip（解压即是站点根目录）
#   - 前端静态文件（npm run build 的 dist/）
#   - config.js：生产配置。下发白名单为空且 writeMode 为 off，即生产环境禁止一切下发，
#                直到负责人另行书面确认后，由对方运维按 docs/部署说明.md 修改。
#   - version.json：版本、commit、构建时间
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

API_BASE="${API_BASE:-https://control.cosyhome.com.cn/v1}"
OUT_DIR="${OUT_DIR:-$ROOT/release}"

case "$API_BASE" in
  *\'*|*\"*|*\\*|*[[:space:]]*) echo "API_BASE 含非法字符：$API_BASE" >&2; exit 1 ;;
esac

VERSION="$(node -p "require('./package.json').version")"
COMMIT="$(git rev-parse --short HEAD 2>/dev/null || echo nogit)"
DIRTY=""
if [ -n "$(git status --porcelain 2>/dev/null || true)" ]; then DIRTY="-dirty"; fi
BUILT_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
NAME="hengjing-cloud-${VERSION}-${COMMIT}${DIRTY}"

command -v zip >/dev/null || { echo "需要 zip 命令" >&2; exit 1; }

echo "==> 构建（npm ci 请事先执行；Node >= 22.12）"
# 构建时变量不写入任何后端地址；运行时配置全部在 config.js。
env -u VITE_API_BASE -u VITE_API_ENV -u VITE_DATA_SOURCE -u VITE_WRITE_MODE -u VITE_WRITE_PROJECT_CODES \
  npm run build

[ -f dist/index.html ] || { echo "dist/index.html 不存在，构建失败" >&2; exit 1; }

STAGE="$OUT_DIR/$NAME"
rm -rf "$STAGE"
mkdir -p "$STAGE"
cp -R dist/. "$STAGE/"

echo "==> 写入生产 config.js（禁止一切下发）"
cat > "$STAGE/config.js" <<CFG
// 恒境云生产配置。部署时只改这个文件即可换后端，不用重新构建。
// 下发（写操作）：writeProjectCodes 为空且 writeMode 为 'off'，生产环境禁止一切下发。
// 开放下发必须有负责人的书面确认，详见 部署说明.md「下发开关」。
window.__HJC_CONFIG__ = {
  apiBase: '${API_BASE}',
  apiEnv: 'prod',
  dataSource: 'real',
  writeMode: 'off',
  writeProjectCodes: []
}
CFG

cat > "$STAGE/version.json" <<VER
{"name":"hengjing-cloud","version":"${VERSION}","commit":"${COMMIT}${DIRTY}","builtAt":"${BUILT_AT}","apiBase":"${API_BASE}"}
VER

echo "==> 自检"
grep -q "writeProjectCodes: \[\]" "$STAGE/config.js" || { echo "config.js 白名单不为空" >&2; exit 1; }
grep -q "writeMode: 'off'" "$STAGE/config.js" || { echo "config.js writeMode 不是 off" >&2; exit 1; }
grep -q "dataSource: 'real'" "$STAGE/config.js" || { echo "config.js dataSource 不是 real" >&2; exit 1; }
if grep -rIl "test\.cosyhome\.com\.cn" "$STAGE" >/dev/null 2>&1; then
  echo "注意：包内文件含测试环境域名（仅为代码里的环境判断常量，不是请求地址）：" >&2
  grep -rIl "test\.cosyhome\.com\.cn" "$STAGE" >&2 || true
fi

echo "==> 打包"
ZIP="$OUT_DIR/$NAME.zip"
rm -f "$ZIP"
( cd "$STAGE" && zip -qr "$ZIP" . )
( cd "$OUT_DIR" && shasum -a 256 "$NAME.zip" > "$NAME.zip.sha256" )

echo "完成：$ZIP"
cat "$OUT_DIR/$NAME.zip.sha256"
