#!/bin/bash

# MCP Knot 配置恢复脚本
# 用法: ./scripts/restore-backup.sh <backup_file>

set -e  # 遇到错误立即退出

# ==================== 配置 ====================

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# ==================== 函数定义 ====================

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

confirm() {
    read -p "$1 (y/n) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        log_warn "操作已取消"
        exit 1
    fi
}

# ==================== 参数检查 ====================

if [ $# -eq 0 ]; then
    log_error "用法: $0 <backup_file>"
    echo ""
    echo "示例:"
    echo "  $0 /backup/mcp-knot/config_20240115_103000.tar.gz"
    echo ""
    echo "可用的备份文件:"
    if [ -d "/backup/mcp-knot" ]; then
        ls -lh /backup/mcp-knot/config_*.tar.gz 2>/dev/null || echo "  没有找到备份文件"
    else
        echo "  备份目录不存在"
    fi
    exit 1
fi

BACKUP_FILE=$1

# 检查备份文件是否存在
if [ ! -f "$BACKUP_FILE" ]; then
    log_error "备份文件不存在: $BACKUP_FILE"
    exit 1
fi

# ==================== 恢复确认 ====================

log_warn "========================================="
log_warn "警告: 此操作将覆盖当前配置！"
log_warn "========================================="
log_info "备份文件: $BACKUP_FILE"
log_info "文件大小: $(du -h $BACKUP_FILE | cut -f1)"
log_info "创建时间: $(stat -f %Sm -t '%Y-%m-%d %H:%M:%S' $BACKUP_FILE 2>/dev/null || stat -c %y $BACKUP_FILE 2>/dev/null)"
echo ""

confirm "确认从此备份恢复配置？"

# ==================== 备份当前配置 ====================

log_info "备份当前配置..."

CONFIG_DIR="/etc/mcp-knot/config"
CURRENT_BACKUP="/tmp/mcp-knot-config-before-restore-$(date +%Y%m%d_%H%M%S).tar.gz"

if [ -d "$CONFIG_DIR" ]; then
    tar -czf $CURRENT_BACKUP $CONFIG_DIR
    log_info "当前配置已备份到: $CURRENT_BACKUP"
else
    log_warn "配置目录不存在，跳过备份"
fi

# ==================== 停止服务 ====================

log_info "停止服务..."

if pm2 list | grep -q "mcp-knot-api"; then
    pm2 stop mcp-knot-api
    log_info "服务已停止"
else
    log_warn "服务未运行"
fi

# ==================== 恢复配置 ====================

log_info "恢复配置..."

# 解压备份文件
tar -xzf $BACKUP_FILE -C /

log_info "配置已恢复"

# ==================== 验证配置 ====================

log_info "验证配置..."

# 检查配置文件是否存在
if [ ! -f "$CONFIG_DIR/system.json" ]; then
    log_error "system.json 不存在"
    log_warn "正在恢复之前的配置..."
    tar -xzf $CURRENT_BACKUP -C /
    exit 1
fi

# 验证 JSON 格式
if ! cat $CONFIG_DIR/system.json | jq . > /dev/null 2>&1; then
    log_error "system.json 格式无效"
    log_warn "正在恢复之前的配置..."
    tar -xzf $CURRENT_BACKUP -C /
    exit 1
fi

log_info "配置验证通过"

# ==================== 启动服务 ====================

log_info "启动服务..."

if pm2 list | grep -q "mcp-knot-api"; then
    pm2 restart mcp-knot-api
else
    cd backend
    pm2 start dist/index.js --name mcp-knot-api
fi

log_info "服务已启动"

# ==================== 健康检查 ====================

log_info "执行健康检查..."

# 等待服务启动
sleep 5

# 检查服务状态
if pm2 list | grep -q "online.*mcp-knot-api"; then
    log_info "服务运行正常"
else
    log_error "服务启动失败"
    log_warn "正在恢复之前的配置..."
    tar -xzf $CURRENT_BACKUP -C /
    pm2 restart mcp-knot-api
    exit 1
fi

# 检查 HTTP 端点
if curl -f http://localhost:8181/api/ping > /dev/null 2>&1; then
    log_info "健康检查通过"
else
    log_error "健康检查失败"
    log_warn "正在恢复之前的配置..."
    tar -xzf $CURRENT_BACKUP -C /
    pm2 restart mcp-knot-api
    exit 1
fi

# ==================== 恢复完成 ====================

log_info "========================================="
log_info "配置恢复成功！"
log_info "========================================="
log_info "恢复的备份: $BACKUP_FILE"
log_info "时间: $(date)"
log_info ""
log_info "之前的配置已保存到: $CURRENT_BACKUP"
log_info ""
log_info "后续步骤:"
log_info "1. 检查服务状态: pm2 status"
log_info "2. 查看日志: pm2 logs mcp-knot-api"
log_info "3. 验证配置: 访问 Web 界面"
log_info ""
log_info "如需回滚，运行:"
log_info "  $0 $CURRENT_BACKUP"
log_info "========================================="
