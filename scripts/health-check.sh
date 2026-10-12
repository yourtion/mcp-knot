#!/bin/bash

# MCP Knot 健康检查脚本
# 用法: ./scripts/health-check.sh [options]
# 选项:
#   --verbose    显示详细信息
#   --json       以 JSON 格式输出

set -e

# ==================== 配置 ====================

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# 默认选项
VERBOSE=false
JSON_OUTPUT=false

# 解析命令行参数
while [[ $# -gt 0 ]]; do
    case $1 in
        --verbose)
            VERBOSE=true
            shift
            ;;
        --json)
            JSON_OUTPUT=true
            shift
            ;;
        *)
            echo "未知选项: $1"
            exit 1
            ;;
    esac
done

# ==================== 函数定义 ====================

log_info() {
    if [ "$JSON_OUTPUT" = false ]; then
        echo -e "${GREEN}[✓]${NC} $1"
    fi
}

log_warn() {
    if [ "$JSON_OUTPUT" = false ]; then
        echo -e "${YELLOW}[!]${NC} $1"
    fi
}

log_error() {
    if [ "$JSON_OUTPUT" = false ]; then
        echo -e "${RED}[✗]${NC} $1"
    fi
}

# ==================== 健康检查 ====================

# 初始化结果
OVERALL_STATUS="healthy"
CHECKS=()

# 1. 检查 PM2 进程
if [ "$VERBOSE" = true ] && [ "$JSON_OUTPUT" = false ]; then
    echo "检查 PM2 进程..."
fi

if pm2 list | grep -q "online.*mcp-knot-api"; then
    log_info "PM2 进程运行正常"
    CHECKS+=('{"name":"pm2_process","status":"healthy","message":"进程运行正常"}')
else
    log_error "PM2 进程未运行"
    OVERALL_STATUS="unhealthy"
    CHECKS+=('{"name":"pm2_process","status":"unhealthy","message":"进程未运行"}')
fi

# 2. 检查 HTTP 端点
if [ "$VERBOSE" = true ] && [ "$JSON_OUTPUT" = false ]; then
    echo "检查 HTTP 端点..."
fi

HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:8181/api/ping 2>/dev/null || echo "000")

if [ "$HTTP_STATUS" = "200" ]; then
    log_info "HTTP 端点响应正常 (200)"
    CHECKS+=('{"name":"http_endpoint","status":"healthy","message":"HTTP 200"}')
else
    log_error "HTTP 端点响应异常 ($HTTP_STATUS)"
    OVERALL_STATUS="unhealthy"
    CHECKS+=('{"name":"http_endpoint","status":"unhealthy","message":"HTTP '$HTTP_STATUS'"}')
fi

# 3. 检查响应时间
if [ "$VERBOSE" = true ] && [ "$JSON_OUTPUT" = false ]; then
    echo "检查响应时间..."
fi

RESPONSE_TIME=$(curl -s -o /dev/null -w "%{time_total}" http://localhost:8181/api/ping 2>/dev/null || echo "0")
RESPONSE_TIME_MS=$(echo "$RESPONSE_TIME * 1000" | bc)

if (( $(echo "$RESPONSE_TIME < 1" | bc -l) )); then
    log_info "响应时间正常 (${RESPONSE_TIME_MS}ms)"
    CHECKS+=('{"name":"response_time","status":"healthy","message":"'${RESPONSE_TIME_MS}'ms"}')
elif (( $(echo "$RESPONSE_TIME < 3" | bc -l) )); then
    log_warn "响应时间较慢 (${RESPONSE_TIME_MS}ms)"
    if [ "$OVERALL_STATUS" = "healthy" ]; then
        OVERALL_STATUS="degraded"
    fi
    CHECKS+=('{"name":"response_time","status":"degraded","message":"'${RESPONSE_TIME_MS}'ms"}')
else
    log_error "响应时间过慢 (${RESPONSE_TIME_MS}ms)"
    OVERALL_STATUS="unhealthy"
    CHECKS+=('{"name":"response_time","status":"unhealthy","message":"'${RESPONSE_TIME_MS}'ms"}')
fi

# 4. 检查内存使用
if [ "$VERBOSE" = true ] && [ "$JSON_OUTPUT" = false ]; then
    echo "检查内存使用..."
fi

if command -v pm2 &> /dev/null; then
    MEMORY_MB=$(pm2 jlist | jq -r '.[] | select(.name=="mcp-knot-api") | .monit.memory' | awk '{print int($1/1024/1024)}')
    
    if [ -n "$MEMORY_MB" ]; then
        if [ "$MEMORY_MB" -lt 512 ]; then
            log_info "内存使用正常 (${MEMORY_MB}MB)"
            CHECKS+=('{"name":"memory_usage","status":"healthy","message":"'${MEMORY_MB}'MB"}')
        elif [ "$MEMORY_MB" -lt 1024 ]; then
            log_warn "内存使用较高 (${MEMORY_MB}MB)"
            if [ "$OVERALL_STATUS" = "healthy" ]; then
                OVERALL_STATUS="degraded"
            fi
            CHECKS+=('{"name":"memory_usage","status":"degraded","message":"'${MEMORY_MB}'MB"}')
        else
            log_error "内存使用过高 (${MEMORY_MB}MB)"
            OVERALL_STATUS="unhealthy"
            CHECKS+=('{"name":"memory_usage","status":"unhealthy","message":"'${MEMORY_MB}'MB"}')
        fi
    else
        log_warn "无法获取内存使用信息"
        CHECKS+=('{"name":"memory_usage","status":"unknown","message":"无法获取"}')
    fi
fi

# 5. 检查 CPU 使用
if [ "$VERBOSE" = true ] && [ "$JSON_OUTPUT" = false ]; then
    echo "检查 CPU 使用..."
fi

if command -v pm2 &> /dev/null; then
    CPU_PERCENT=$(pm2 jlist | jq -r '.[] | select(.name=="mcp-knot-api") | .monit.cpu')
    
    if [ -n "$CPU_PERCENT" ]; then
        if (( $(echo "$CPU_PERCENT < 50" | bc -l) )); then
            log_info "CPU 使用正常 (${CPU_PERCENT}%)"
            CHECKS+=('{"name":"cpu_usage","status":"healthy","message":"'${CPU_PERCENT}'%"}')
        elif (( $(echo "$CPU_PERCENT < 80" | bc -l) )); then
            log_warn "CPU 使用较高 (${CPU_PERCENT}%)"
            if [ "$OVERALL_STATUS" = "healthy" ]; then
                OVERALL_STATUS="degraded"
            fi
            CHECKS+=('{"name":"cpu_usage","status":"degraded","message":"'${CPU_PERCENT}'%"}')
        else
            log_error "CPU 使用过高 (${CPU_PERCENT}%)"
            OVERALL_STATUS="unhealthy"
            CHECKS+=('{"name":"cpu_usage","status":"unhealthy","message":"'${CPU_PERCENT}'%"}')
        fi
    else
        log_warn "无法获取 CPU 使用信息"
        CHECKS+=('{"name":"cpu_usage","status":"unknown","message":"无法获取"}')
    fi
fi

# 6. 检查磁盘空间
if [ "$VERBOSE" = true ] && [ "$JSON_OUTPUT" = false ]; then
    echo "检查磁盘空间..."
fi

DISK_USAGE=$(df -h / | awk 'NR==2 {print $5}' | sed 's/%//')

if [ "$DISK_USAGE" -lt 70 ]; then
    log_info "磁盘空间充足 (已使用 ${DISK_USAGE}%)"
    CHECKS+=('{"name":"disk_space","status":"healthy","message":"'${DISK_USAGE}'%"}')
elif [ "$DISK_USAGE" -lt 85 ]; then
    log_warn "磁盘空间不足 (已使用 ${DISK_USAGE}%)"
    if [ "$OVERALL_STATUS" = "healthy" ]; then
        OVERALL_STATUS="degraded"
    fi
    CHECKS+=('{"name":"disk_space","status":"degraded","message":"'${DISK_USAGE}'%"}')
else
    log_error "磁盘空间严重不足 (已使用 ${DISK_USAGE}%)"
    OVERALL_STATUS="unhealthy"
    CHECKS+=('{"name":"disk_space","status":"unhealthy","message":"'${DISK_USAGE}'%"}')
fi

# 7. 检查日志文件
if [ "$VERBOSE" = true ] && [ "$JSON_OUTPUT" = false ]; then
    echo "检查日志文件..."
fi

LOG_FILE="/var/log/mcp-knot/app.log"

if [ -f "$LOG_FILE" ]; then
    # 检查最近的错误
    ERROR_COUNT=$(tail -n 100 $LOG_FILE | grep -c "ERROR" || echo "0")
    
    if [ "$ERROR_COUNT" -eq 0 ]; then
        log_info "日志正常 (无错误)"
        CHECKS+=('{"name":"log_errors","status":"healthy","message":"无错误"}')
    elif [ "$ERROR_COUNT" -lt 5 ]; then
        log_warn "日志中有少量错误 ($ERROR_COUNT 个)"
        if [ "$OVERALL_STATUS" = "healthy" ]; then
            OVERALL_STATUS="degraded"
        fi
        CHECKS+=('{"name":"log_errors","status":"degraded","message":"'$ERROR_COUNT'个错误"}')
    else
        log_error "日志中有大量错误 ($ERROR_COUNT 个)"
        OVERALL_STATUS="unhealthy"
        CHECKS+=('{"name":"log_errors","status":"unhealthy","message":"'$ERROR_COUNT'个错误"}')
    fi
else
    log_warn "日志文件不存在"
    CHECKS+=('{"name":"log_errors","status":"unknown","message":"日志文件不存在"}')
fi

# 8. 检查配置文件
if [ "$VERBOSE" = true ] && [ "$JSON_OUTPUT" = false ]; then
    echo "检查配置文件..."
fi

CONFIG_DIR="/etc/mcp-knot/config"

if [ -d "$CONFIG_DIR" ]; then
    # 检查必需的配置文件
    MISSING_CONFIGS=()
    
    [ ! -f "$CONFIG_DIR/system.json" ] && MISSING_CONFIGS+=("system.json")
    [ ! -f "$CONFIG_DIR/mcp_server.json" ] && MISSING_CONFIGS+=("mcp_server.json")
    [ ! -f "$CONFIG_DIR/group.json" ] && MISSING_CONFIGS+=("group.json")
    
    if [ ${#MISSING_CONFIGS[@]} -eq 0 ]; then
        log_info "配置文件完整"
        CHECKS+=('{"name":"config_files","status":"healthy","message":"配置完整"}')
    else
        log_error "缺少配置文件: ${MISSING_CONFIGS[*]}"
        OVERALL_STATUS="unhealthy"
        CHECKS+=('{"name":"config_files","status":"unhealthy","message":"缺少配置"}')
    fi
else
    log_error "配置目录不存在"
    OVERALL_STATUS="unhealthy"
    CHECKS+=('{"name":"config_files","status":"unhealthy","message":"目录不存在"}')
fi

# ==================== 输出结果 ====================

if [ "$JSON_OUTPUT" = true ]; then
    # JSON 格式输出
    CHECKS_JSON=$(IFS=,; echo "${CHECKS[*]}")
    echo "{\"status\":\"$OVERALL_STATUS\",\"timestamp\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"checks\":[$CHECKS_JSON]}"
else
    # 人类可读格式输出
    echo ""
    echo "========================================="
    echo "健康检查结果"
    echo "========================================="
    echo "总体状态: $OVERALL_STATUS"
    echo "检查时间: $(date)"
    echo "========================================="
    
    if [ "$OVERALL_STATUS" = "healthy" ]; then
        echo -e "${GREEN}系统运行正常${NC}"
        exit 0
    elif [ "$OVERALL_STATUS" = "degraded" ]; then
        echo -e "${YELLOW}系统运行但有警告${NC}"
        exit 1
    else
        echo -e "${RED}系统运行异常${NC}"
        exit 2
    fi
fi
