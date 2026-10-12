#!/usr/bin/env bash

# Verify locally built API/Web images; never pulls, pushes or publishes images.
set -euo pipefail

api_image=${1:-mcp-knot/api:test}
web_image=${2:-mcp-knot/web:test}
fixture_dir=$(mktemp -d)
network="mcp-knot-smoke-$$"
api_container="${network}-api"
web_container="${network}-web"

cleanup() {
    result=$?
    if [ "$result" -ne 0 ]; then
        docker inspect --format '{{.Name}} {{json .State}}' "$api_container" "$web_container" 2>/dev/null || true
        docker logs "$api_container" 2>/dev/null || true
        docker logs "$web_container" 2>/dev/null || true
    fi
    docker rm -f "$web_container" "$api_container" >/dev/null 2>&1 || true
    docker network rm "$network" >/dev/null 2>&1 || true
    rm -rf "$fixture_dir"
    exit "$result"
}
trap cleanup EXIT

# Config validation requires at least one definition; disabled means no upstream process/network.
printf '%s\n' '{"servers":{"smoke":{"type":"stdio","command":"node","args":[],"enabled":false}}}' > "$fixture_dir/mcp_server.json"
printf '%s\n' '{}' > "$fixture_dir/group.json"
# Empty system config selects the application's default port without creating credentials here.
printf '%s\n' '{}' > "$fixture_dir/system.json"
printf '%s\n' '{"version":"1.0.0","tools":[]}' > "$fixture_dir/api-tools.json"
# Disposable fixture only: the image runs as UID 1000 and must persist config edits.
chmod -R a+rwX "$fixture_dir"

docker image inspect "$api_image" "$web_image" >/dev/null
docker network create "$network" >/dev/null
docker run --pull=never -d --name "$api_container" --network "$network" \
    --network-alias mcp-knot-api -e NODE_ENV=production -e CONFIG_PATH=/app/config \
    --mount "type=bind,source=$fixture_dir,target=/app/config" "$api_image" >/dev/null

wait_healthy() {
    container=$1
    for ((attempt=0; attempt<60; attempt++)); do
        status=$(docker inspect --format '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' "$container")
        case "$status" in
            'running healthy') return 0 ;;
            exited*|dead*|'running unhealthy') echo "$container: $status" >&2; return 1 ;;
        esac
        sleep 2
    done
    echo "$container did not become healthy within 120 seconds" >&2
    return 1
}

wait_healthy "$api_container"
docker run --pull=never -d --name "$web_container" --network "$network" \
    --network-alias mcp-knot-web "$web_image" >/dev/null
wait_healthy "$web_container"

docker exec "$api_container" node --input-type=module -e '
import { writeFileSync, unlinkSync } from "node:fs";
for (const origin of ["http://localhost:8181", "http://mcp-knot-web"]) {
    const ping = await fetch(origin + "/api/ping");
    if (ping.status !== 200 || !(await ping.json()).success) throw new Error("Ping failed: " + origin);
    const health = await fetch(origin + "/api/health");
    if (health.status !== 200 || !(await health.json()).data.service.isInitialized) throw new Error("Service initialization failed: " + origin);
}
for (const path of ["/", "/groups"]) {
    const page = await fetch("http://mcp-knot-web" + path);
    if (page.status !== 200 || !(await page.text()).includes("<html")) throw new Error("SPA failed: " + path);
}
const marker = "/app/config/smoke-write-check";
writeFileSync(marker, "config mount is writable");
unlinkSync(marker);
console.log("Container smoke passed: image healthchecks, initialized API, nginx API proxy, SPA fallback, writable /app/config.");
'
