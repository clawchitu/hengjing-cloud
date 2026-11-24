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
#   - 前端静态文件（npm run build:delivery 的 dist/：演示数据与演示账号已在打包时剔除，dataSource 恒为 real）
#   - config.js：生产配置。下发白名单为空且 writeMode 为 off，即生产环境禁止一切下发，
#                直到负责人另行书面确认后，由对方运维按 docs/部署说明.md 修改。
#   - version.json：版本、commit、构建时间
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# API_BASE 精确白名单：只允许下面两种写法，逐字比较（不做大小写、空白、结尾斜杠等任何规范化）。
#   https://control.cosyhome.com.cn/v1   直连生产接口
#   /api                                 同源，由对方 nginx 反向代理到生产接口
# 其余（空串、空白、引号、换行、其他域名、http、端口、多余路径、路径穿越等）一律报错退出。
PROD_API='https://control.cosyhome.com.cn/v1'
SAME_ORIGIN_API='/api'
# 只有完全没设置才用默认值；设成空串也算写错，报错
API_BASE="${API_BASE-$PROD_API}"
if [ "$API_BASE" != "$PROD_API" ] && [ "$API_BASE" != "$SAME_ORIGIN_API" ]; then
  printf 'API_BASE 只能是 %s 或 %s，收到：%q\n' "$PROD_API" "$SAME_ORIGIN_API" "$API_BASE" >&2
  exit 1
fi
# 仅供测试：只做参数校验（scripts/build-prod.test.ts）
if [ "${CHECK_ONLY:-}" = 1 ]; then echo "API_BASE 校验通过：$API_BASE"; exit 0; fi

OUT_DIR="${OUT_DIR:-$ROOT/release}"
mkdir -p "$OUT_DIR"
OUT_DIR="$(cd "$OUT_DIR" && pwd)"   # 转绝对路径，后面会 cd 进子目录

VERSION="$(node -p "require('./package.json').version")"
COMMIT="$(git rev-parse --short HEAD 2>/dev/null || echo nogit)"
DIRTY=""
if [ -n "$(git status --porcelain 2>/dev/null || true)" ]; then DIRTY="-dirty"; fi
BUILT_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
NAME="hengjing-cloud-${VERSION}-${COMMIT}${DIRTY}"

command -v zip >/dev/null && command -v unzip >/dev/null || { echo "需要 zip 与 unzip 命令" >&2; exit 1; }

echo "==> 构建（npm ci 请事先执行；Node >= 22.12）"
# 交付模式（vite build --mode delivery）：构建期常量 __HJC_MOCK__ = false，演示数据（src/mock）与演示账号
# 在打包时剔除，dataSource 恒为 real（config.js 写 mock 也无效）。见 src/build-flags.d.ts。
# 构建时默认值也按生产写死（进程环境变量优先于 .env 文件），这样即使部署后 config.js 没加载，
# 前端回退到的构建默认值同样是：生产环境、禁止一切下发。
VITE_API_BASE="$API_BASE" VITE_API_ENV=prod VITE_DATA_SOURCE=real \
VITE_WRITE_MODE=off VITE_WRITE_PROJECT_CODES="" \
  npm run build:delivery

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

echo "==> 打包"
if [ -n "$DIRTY" ]; then echo "警告：工作区有未提交改动，正式交付请在合并后的 main、干净工作区重新打包" >&2; fi
ZIP="$OUT_DIR/$NAME.zip"
rm -f "$ZIP" "$ZIP.sha256"
( cd "$STAGE" && zip -qr "$ZIP" . )

echo "==> 自检（解开打好的 zip 检查，验的是实际交付物）"
CHECK="$(mktemp -d)"
trap 'rm -rf "$CHECK"' EXIT
# 失败时删掉 zip、同名 .sha256 和暂存目录（暂存目录就是可直接部署的站点，不能留下没过自检的）
fail() { echo "自检失败：$*" >&2; rm -rf "$ZIP" "$ZIP.sha256" "$STAGE"; exit 1; }
( cd "$CHECK" && unzip -q "$ZIP" ) || fail "zip 解不开"
# 1. 在隔离的 vm 里执行 config.js，按实际字段值检查（不靠 grep 文本）
node scripts/check-config.mjs "$CHECK/config.js" "$PROD_API" "$SAME_ORIGIN_API" || fail "config.js 字段不符合生产要求"
# 2. index.html 用同步的普通 <script src="/config.js">（不带 async/defer）加载配置；应用是 type=module 且不带 async，
#    浏览器会在页面解析完后才执行模块，所以 config.js 一定先执行（vite 会把模块脚本挪到 <head>，按位置判断不对）
node -e '
  const h = require("fs").readFileSync(process.argv[1], "utf8")
  const tags = h.match(/<script\b[^>]*>/g) || []
  const cfg = tags.filter((t) => /\ssrc="\/config\.js"/.test(t))
  const mods = tags.filter((t) => /\stype="module"/.test(t))
  const bad = (m) => { console.error("index.html：" + m); process.exit(1) }
  if (cfg.length !== 1) bad("应有且只有一个 <script src=\"/config.js\">")
  if (/\s(async|defer|type=)/.test(cfg[0])) bad("config.js 必须是同步的普通脚本：" + cfg[0])
  if (!mods.length) bad("没有应用的 module 脚本")
  if (mods.some((t) => /\sasync/.test(t))) bad("应用脚本不能带 async（否则可能先于 config.js 执行）")
' "$CHECK/index.html" || fail "index.html"
# 3. 包里不能有演示数据与演示账号（特征串取自 src/mock、演示登录和页面里写死的演示文案；「演示」二字一律不许出现）。cosyhome 单独出现才算演示账号，
#    control.cosyhome.com.cn 这类域名里的不算
MOCK_PATTERN='演示|400-820-1234|2025年6月18日|更新于 14:30|hjadmin|(^|[^.A-Za-z0-9_-])cosyhome([^.A-Za-z0-9_-]|$)|张建国|华东运维中心|上海恒境暖通|朝阳壹号院|PRJ-[0-9]{5}|DLR-[0-9]{3}|GRP-[A-Z]{2}-[0-9]{3}|hjc-mock-|CMD-2025|多云转晴|2025-06-18|演示计数|/api/login'
HITS="$(grep -rIEl "$MOCK_PATTERN" "$CHECK")" && RC=0 || RC=$?
[ "$RC" -le 1 ] || fail "grep 执行出错（$RC）"
if [ -n "$HITS" ]; then
  echo "$HITS" >&2
  grep -rIEoh "$MOCK_PATTERN" "$CHECK" | sort | uniq -c >&2 || true
  fail "包里含演示数据或演示账号（见上）"
fi
echo "演示数据特征串检查通过"
if grep -rIl "test\.cosyhome\.com\.cn" "$CHECK" >/dev/null 2>&1; then
  echo "注意：包内文件含测试环境域名（仅为代码里的环境判断常量，不是请求地址）：" >&2
  grep -rIl "test\.cosyhome\.com\.cn" "$CHECK" >&2 || true
fi
( cd "$OUT_DIR" && { shasum -a 256 "$NAME.zip" 2>/dev/null || sha256sum "$NAME.zip"; } > "$NAME.zip.sha256" )

rm -rf "$STAGE"   # 只交付 zip
echo "完成：$ZIP"
cat "$OUT_DIR/$NAME.zip.sha256"
