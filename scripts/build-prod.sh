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
mkdir -p "$OUT_DIR"
OUT_DIR="$(cd "$OUT_DIR" && pwd)"   # 转绝对路径，后面会 cd 进子目录

case "$API_BASE" in
  /api) ;;
  https://*) ;;
  *) echo "API_BASE 只能是 /api 或 https:// 开头的完整地址：$API_BASE" >&2; exit 1 ;;
esac
if [[ "$API_BASE" == https://* ]]; then
  API_LC="$(printf '%s' "$API_BASE" | tr '[:upper:]' '[:lower:]')"
  HOSTPORT="${API_LC#https://}"; HOSTPORT="${HOSTPORT%%/*}"
  HOST="${HOSTPORT%%:*}"
  PORT=""; [[ "$HOSTPORT" == *:* ]] && PORT="${HOSTPORT#*:}"
  # 主机名：小写字母数字与连字符组成的标签，点分隔，至少两段，标签不以连字符开头或结尾
  LABEL='[a-z0-9]([a-z0-9-]*[a-z0-9])?'
  if [[ ! "$HOST" =~ ^${LABEL}(\.${LABEL})+$ ]] || { [ -n "$PORT" ] && { [[ ! "$PORT" =~ ^[0-9]{1,5}$ ]] || [ "$((10#$PORT))" -lt 1 ] || [ "$((10#$PORT))" -gt 65535 ]; }; } \
     || [[ ! "$API_LC" =~ ^https://[^/]+(/[a-z0-9._~-]+)*$ ]]; then
    echo "API_BASE 不是有效的 https 地址：$API_BASE" >&2; exit 1
  fi
  case "$HOST" in test.cosyhome.com.cn) echo "生产包不能指向测试环境：$API_BASE" >&2; exit 1 ;; esac
fi
if [[ ! "$API_BASE" =~ ^[A-Za-z0-9:/._~-]+$ ]]; then echo "API_BASE 含非法字符：$API_BASE" >&2; exit 1; fi

VERSION="$(node -p "require('./package.json').version")"
COMMIT="$(git rev-parse --short HEAD 2>/dev/null || echo nogit)"
DIRTY=""
if [ -n "$(git status --porcelain 2>/dev/null || true)" ]; then DIRTY="-dirty"; fi
BUILT_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
NAME="hengjing-cloud-${VERSION}-${COMMIT}${DIRTY}"

command -v zip >/dev/null || { echo "需要 zip 命令" >&2; exit 1; }

echo "==> 构建（npm ci 请事先执行；Node >= 22.12）"
# 构建时默认值也按生产写死（进程环境变量优先于 .env 文件），这样即使部署后 config.js 没加载，
# 前端回退到的构建默认值同样是：生产环境、禁止一切下发。
VITE_API_BASE="$API_BASE" VITE_API_ENV=prod VITE_DATA_SOURCE=real \
VITE_WRITE_MODE=off VITE_WRITE_PROJECT_CODES="" \
  npm run build

[ -f dist/index.html ] || { echo "dist/index.html 不存在，构建失败" >&2; exit 1; }

case "$OUT_DIR/" in "$ROOT/dist/"*) echo "OUT_DIR 不能放在 dist 里" >&2; exit 1 ;; esac
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
if [ -n "$DIRTY" ]; then echo "警告：工作区有未提交改动，正式交付请在合并后的 main、干净工作区重新打包" >&2; fi
ZIP="$OUT_DIR/$NAME.zip"
rm -f "$ZIP"
( cd "$STAGE" && zip -qr "$ZIP" . )
( cd "$OUT_DIR" && { shasum -a 256 "$NAME.zip" 2>/dev/null || sha256sum "$NAME.zip"; } > "$NAME.zip.sha256" )

echo "完成：$ZIP"
cat "$OUT_DIR/$NAME.zip.sha256"
