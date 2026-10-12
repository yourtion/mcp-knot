#!/usr/bin/env bash

# Docker Compose deployment; published images require an explicit release tag.
set -euo pipefail

ENVIRONMENT=production
CONFIG_DIR=./config
RELEASE_VERSION=

while [[ $# -gt 0 ]]; do
    case $1 in
        --env) ENVIRONMENT=${2:?Missing environment}; shift 2 ;;
        --config) CONFIG_DIR=${2:?Missing config directory}; shift 2 ;;
        --release) RELEASE_VERSION=${2:?Missing vX.Y.Z image tag}; shift 2 ;;
        --dev) ENVIRONMENT=development; shift ;;
        --help)
            echo "用法: bash $0 [--config DIR] [--dev | --release vX.Y.Z]"
            echo "默认从源码构建；--release 从 GHCR 拉取指定版本；--dev 使用热重载。"
            exit 0 ;;
        *) echo "未知选项: $1" >&2; exit 1 ;;
    esac
done

case "$ENVIRONMENT" in
    production|development) ;;
    *) echo "环境必须是 production 或 development" >&2; exit 1 ;;
esac

COMPOSE_FILE=docker-compose.yml
if [[ "$ENVIRONMENT" == development ]]; then
    [[ -z "$RELEASE_VERSION" ]] || { echo "--dev 与 --release 不能同时使用" >&2; exit 1; }
    COMPOSE_FILE=docker-compose.dev.yml
elif [[ -n "$RELEASE_VERSION" ]]; then
    [[ "$RELEASE_VERSION" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || {
        echo "发布镜像版本必须是完整的 vX.Y.Z" >&2; exit 1;
    }
    export MCP_KNOT_VERSION="$RELEASE_VERSION"
    COMPOSE_FILE=docker-compose.release.yml
fi

for config in mcp_server.json group.json system.json; do
    [[ -f "$CONFIG_DIR/$config" ]] || { echo "缺少配置文件: $CONFIG_DIR/$config" >&2; exit 1; }
done
export MCP_KNOT_CONFIG_DIR
MCP_KNOT_CONFIG_DIR=$(cd "$CONFIG_DIR" && pwd)

docker compose -f "$COMPOSE_FILE" config --quiet
if [[ -n "$RELEASE_VERSION" ]]; then
    docker compose -f "$COMPOSE_FILE" pull
    docker compose -f "$COMPOSE_FILE" up -d --no-build --wait --wait-timeout 120
elif [[ "$ENVIRONMENT" == production ]]; then
    docker compose -f "$COMPOSE_FILE" up -d --build --wait --wait-timeout 120
else
    docker compose -f "$COMPOSE_FILE" up -d --build
fi

docker compose -f "$COMPOSE_FILE" ps
if [[ "$ENVIRONMENT" == production ]]; then
    # Check the same-origin proxy as well as the container healthchecks.
    curl --fail --silent --show-error http://localhost:8180/api/ping
    curl --fail --silent --show-error http://localhost:8180/api/health
    curl --fail --silent --show-error --output /dev/null http://localhost:8180/
fi
echo "前端: http://localhost:8180；API: http://localhost:8181；存活检查: /api/ping"
echo "日志: docker compose -f $COMPOSE_FILE logs -f"
