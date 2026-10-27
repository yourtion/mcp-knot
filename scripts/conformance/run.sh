#!/usr/bin/env bash
#
# Task 13: 官方 MCP conformance TCK 接入脚本（acceptance gate）。
#
# 用法：
#   pnpm test:conformance
#
# 做什么：
#   1. 构建 backend（dist）；
#   2. 在固定端口 8181 以「开放访问」配置起 Hub（OAuth 未配置 → /:group/mcp 全开）；
#      配置**完全自包含**：在临时目录里生成最小 system/group/mcp_server.json，
#      不依赖仓库 backend/config/*.json（那些被 .gitignore 忽略，干净 CI 里不存在），
#      仅连接仓库内确定性的 stdio 测试上游，不连接任何外部服务；
#   3. 用官方 @modelcontextprotocol/conformance v0.1.16（npx 拉取，不加为依赖）
#      在 server 模式下连 http://localhost:8181/default/mcp 跑 active suite；
#   4. 用 scripts/conformance/expected-failures.yaml 作 baseline：所有失败必须落在
#      baseline 内，且 baseline 内不得有已恢复（stale）条目，否则 exit 1（抓回归）。
#
# 关于「双 era」与 suite 选择（与 brief 假设的差异，详见 task-13-report.md）：
#   - conformance v0.1.16 的 server 场景仅覆盖 spec-version 2025-06-18 / 2025-11-25，
#     无 2026-07-28 场景；故「双 era」目标在 server 模式下无 2026-07-28 可跑。
#   - server 模式的 --suite 仅支持 active（默认）/ all / pending；
#     brief 假设的 `backcompat` suite 只存在于 client 模式，server 模式不可用。
#   - --spec-version 是「累积过滤器」（含该日期及之前引入的场景），不是按 era 切换协议。
#     2025-11-25 覆盖全部 server 场景，故脚本以该版本跑全套 active suite。
#   如未来 TCK 增加 2026-07-28 server 场景，可在此循环里追加该 spec-version。
set -euo pipefail

# ---------- 可配置项（环境变量覆盖） ----------
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CONFORMANCE_PKG="@modelcontextprotocol/conformance@0.1.16"
HUB_PORT="${HUB_PORT:-8181}"
# HUB_GROUP：自包含配置只生成 default 组（见下方 TMP_CONFIG 生成段）。
# 不再支持通过 HUB_GROUP 指向其他组——干净 CI 里没有别的组，避免误导。
HUB_GROUP="default"
HUB_URL="http://localhost:${HUB_PORT}/${HUB_GROUP}/mcp"
# 网关验证可明确指定独立入口；Hub 仍在本机启动并做直连寻址验证。
TCK_URL="${CONFORMANCE_URL:-${HUB_URL}}"
SPEC_VERSION="${SPEC_VERSION:-2025-11-25}"   # 累积过滤；覆盖全部 server 场景
SUITE="${SUITE:-active}"
BASELINE="${REPO_ROOT}/scripts/conformance/expected-failures.yaml"
OUT_DIR="${OUT_DIR:-${REPO_ROOT}/.conformance-results}"

# ---------- 工具函数 ----------
log()  { printf '\033[36m[conformance]\033[0m %s\n' "$*"; }
err()  { printf '\033[31m[conformance ERROR]\033[0m %s\n' "$*" >&2; }

HUB_PID=""
TMP_CONFIG=""
HUB_LOG=""   # 每次运行用 mktemp 生成，运行结束在 trap 里清理（不再用全局 /tmp 固定路径）
cleanup() {
  if [[ -n "${HUB_PID}" ]] && kill -0 "${HUB_PID}" 2>/dev/null; then
    log "关闭 Hub（pid=${HUB_PID}）"
    kill "${HUB_PID}" 2>/dev/null || true
    # 给进程一点时间优雅退出，再强杀
    for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 "${HUB_PID}" 2>/dev/null || break; sleep 0.3; done
    kill -9 "${HUB_PID}" 2>/dev/null || true
    wait "${HUB_PID}" 2>/dev/null || true
  fi
}
finish() {
  cleanup
  [[ -n "${TMP_CONFIG}" && -d "${TMP_CONFIG}" ]] && rm -rf "${TMP_CONFIG}"
  [[ -n "${HUB_LOG}" && -f "${HUB_LOG}" ]] && rm -f "${HUB_LOG}"
}
trap finish EXIT INT TERM

# ---------- 0. 前置检查 ----------
command -v node >/dev/null || { err "未找到 node"; exit 2; }
[[ -f "${BASELINE}" ]]     || { err "baseline 文件不存在：${BASELINE}"; exit 2; }

# ---------- 1. 构建 backend ----------
# backend rootDir=src，产物入口固定为 dist/index.js
# （与 package.json 的 start 入口一致）
BACKEND_ENTRY="${REPO_ROOT}/backend/dist/index.js"
if [[ "${CONFORMANCE_SKIP_BUILD:-0}" != "1" ]]; then
  log "构建 backend（确保验证当前源码）"
  (cd "${REPO_ROOT}" && pnpm --filter @mcp-core/mcp-knot-share build >/dev/null \
    && pnpm --filter @mcp-core/mcp-knot-protocol build >/dev/null \
    && pnpm --filter @mcp-core/mcp-knot-core build >/dev/null \
    && pnpm --filter @mcp-core/mcp-knot-api build >/dev/null) || { err "backend 构建失败"; exit 2; }
fi
[[ -f "${BACKEND_ENTRY}" ]] || { err "构建后仍找不到入口：${BACKEND_ENTRY}"; exit 2; }

# ---------- 2. 起 Hub（开放访问配置） ----------
# 端口占用预检：若 8181 已被占用（多半是上次跑残留的 Hub），直接失败，避免连到错实例。
if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"${HUB_PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
  err "端口 ${HUB_PORT} 已被占用，请先停掉占用进程（多为上次 conformance 残留的 Hub）。"
  err "  查询：lsof -nP -iTCP:${HUB_PORT} -sTCP:LISTEN"
  exit 3
fi

# 用临时 CONFIG_PATH 放一份**自包含**的最小配置，完全不依赖仓库 backend/config/*.json
# （这些 .json 被 .gitignore 忽略，干净 CI checkout 里不存在）。
#
# 设计目标（C1 修复）：
#   - 只有 default 组，且该组只引用仓库内的 stdio fixture server。
#     这样既满足 GroupSchema 的 servers.min(1) 校验，又不引入任何外部服务依赖，
#     也不依赖工作树里未提交的 group.json / mcp_server.json。
#   - system.json={} → port 默认 8181、OAuth 未配置 → /:group/mcp 全开，TCK 无需凭据。
#   - 上游 ID=test，原始工具名 simple_text 等经真实 Hub 命名空间规则变为
#     test_simple_text 等 TCK 名称；不更改生产命名规则、不注册生产测试别名。
#   - 不生成 api-tools.json：JsonStorage 在缺失时不报错，且无 apiToolService 注册。
TMP_CONFIG="$(mktemp -d)"

# system.json：空对象触发 system=空分支（port 默认 8181，OAuth 未配置）
printf '{}\n' > "${TMP_CONFIG}/system.json"

# group.json：default 组只引用隔离的测试上游
cat > "${TMP_CONFIG}/group.json" <<'EOF'
{
  "default": {
    "id": "default",
    "name": "conformance-default",
    "description": "隔离的工具 conformance 测试组，不连外部上游",
    "servers": ["test"],
    "tools": []
  }
}
EOF

# JSON 由 Node 编码，仓库路径含空格/引号时仍保持参数边界。
node --input-type=module - "${TMP_CONFIG}" "${REPO_ROOT}" <<'EOF'
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const [config, root] = process.argv.slice(2);
writeFileSync(join(config, 'mcp_server.json'), JSON.stringify({
  servers: { test: {
    type: 'stdio', command: process.execPath,
    args: [join(root, 'scripts/conformance/tool-fixtures.mjs'), 'serve'],
    env: {}, enabled: true,
  } },
}));
EOF
# 若调用方通过 HUB_PORT 改了端口，写进 system.json（需要完整 system 校验，故仅当端口非默认时
# 走环境变量 HUB_PORT 让 index.ts 读取——index.ts 当前只读 config，不读 env，因此改端口需配
# 置文件；默认 8181 即可，不在此处支持改端口以避免触发 system 全字段校验）。
if [[ "${HUB_PORT}" != "8181" ]]; then
  err "HUB_PORT 非 8181 暂不支持（需 system.json 完整字段校验），请保持默认。"
  exit 2
fi

log "启动 Hub：port=${HUB_PORT} endpoint=/${HUB_GROUP}/mcp（开放访问）"
HUB_LOG="$(mktemp -t p7-conformance-hub.XXXXXX.log)"
( cd "${REPO_ROOT}/backend" \
  && exec env CONFIG_PATH="${TMP_CONFIG}" node "${BACKEND_ENTRY}" ) >"${HUB_LOG}" 2>&1 &
HUB_PID=$!

# ---------- 3. 等 Hub 就绪 ----------
log "等待 Hub 就绪…"
ready=0
for _ in $(seq 1 60); do
  if curl -sf -o /dev/null -m 1 -X POST "${HUB_URL}" \
        -H 'Content-Type: application/json' \
        -H 'Accept: application/json, text/event-stream' \
        -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"'"${SPEC_VERSION}"'","capabilities":{},"clientInfo":{"name":"tck-probe","version":"1"}}}'; then
    ready=1; break
  fi
  kill -0 "${HUB_PID}" 2>/dev/null || { err "Hub 进程已退出，日志见 ${HUB_LOG}"; tail -20 "${HUB_LOG}" >&2 || true; exit 3; }
  sleep 0.5
done
if [[ "${ready}" != "1" ]]; then
  err "Hub 在 30s 内未就绪，日志见 ${HUB_LOG}"
  tail -20 "${HUB_LOG}" >&2 || true
  exit 3
fi
log "Hub 就绪（${HUB_URL}）"

# ---------- 4. 跑 conformance TCK ----------
mkdir -p "${OUT_DIR}"
rm -rf "${OUT_DIR:?}"/*

node --input-type=module - "${OUT_DIR}" "${HUB_URL}" "${TCK_URL}" "${SPEC_VERSION}" <<'EOF'
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const [output, directHubUrl, testedUrl, specVersion] = process.argv.slice(2);
const url = new URL(testedUrl);
if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
  throw new Error('CONFORMANCE_URL must be an HTTP(S) endpoint without credentials');
}
writeFileSync(join(output, 'target.json'), JSON.stringify({
  profile: testedUrl === directHubUrl ? 'direct' : 'gateway',
  testedUrl, directHubUrl, specVersion,
  conformancePackage: '@modelcontextprotocol/conformance@0.1.16',
}, null, 2) + '\n');
EOF

log "验证真实 Hub 工具寻址及 legacy/modern 内容转发"
node "${REPO_ROOT}/scripts/conformance/verify-tools.mjs" "${HUB_URL}"

log "运行 conformance TCK：spec=${SPEC_VERSION} suite=${SUITE}"
log "  npx ${CONFORMANCE_PKG} server --url ${TCK_URL} --suite ${SUITE} --spec-version ${SPEC_VERSION}"

# TCK 在 baseline 全部命中时 exit 0；出现 unexpected / stale 时 exit 1。
set +e
npx "${CONFORMANCE_PKG}" server \
  --url "${TCK_URL}" \
  --suite "${SUITE}" \
  --spec-version "${SPEC_VERSION}" \
  --expected-failures "${BASELINE}" \
  -o "${OUT_DIR}" \
  --verbose
TCK_EXIT=$?
set -e

# 区分实际失败与 warning-only 场景。诊断分类不改变 TCK 的 baseline 门禁。
set +e
node "${REPO_ROOT}/scripts/conformance/summarize.mjs" "${OUT_DIR}"
SUMMARY_EXIT=$?
set -e

# ---------- 5. 结果 ----------
if [[ "${TCK_EXIT}" -eq 0 ]]; then
  if [[ "${SUMMARY_EXIT}" -ne 0 ]]; then
    err "Conformance 结果不完整或格式无效。"
    exit "${SUMMARY_EXIT}"
  fi
  log "Conformance baseline 门禁通过：无新增失败、无 stale 项；实际失败和警告见 summary.json。"
  exit 0
else
  err "❌ conformance 未通过（exit ${TCK_EXIT}）：存在 unexpected failure 或 stale baseline 条目。"
  err "   结果目录：${OUT_DIR}"
  err "   Hub 日志：${HUB_LOG}"
  err "   - unexpected failure = 真实回归，需修复 Hub；"
  err "   - stale baseline 条目 = 之前失败的场景现在通过了，需从 expected-failures.yaml 移除。"
  exit "${TCK_EXIT}"
fi
