#!/bin/bash

# MCP Knot 生产环境部署脚本
# 用法: ./scripts/deploy-production.sh [options]
# 选项:
#   --skip-backup    跳过备份
#   --skip-tests     跳过测试
#   --skip-build     跳过构建
#   --force          强制部署（跳过确认）

set -e  # 遇到错误立即退出

# ==================== 配置 ====================

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# 默认选项
SKIP_BACKUP=false
SKIP_TESTS=false
SKIP_BUILD=false
FORCE=false

# 解析命令行参数
while [[ $# -gt 0 ]]; do
    case $1 in
        --skip-backup)
            SKIP_BACKUP=true
            shift
            ;;
        --skip-tests)
            SKIP_TESTS=true
            shift
            ;;
        --skip-build)
            SKIP_BUILD=true
            shift
            ;;
        --force)
            FORCE=true
            shift
            ;;
        *)
            echo -e "${RED}未知选项: $1${NC}"
            exit 1
            ;;
    esac
done

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
    if [ "$FORCE" = true ]; then
        return 0
    fi
    
    read -p "$1 (y/n) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        log_warn "操作已取消"
        exit 1
    fi
}

check_command() {
    if ! command -v $1 &> /dev/null; then
        log_error "$1 未安装，请先安装"
        exit 1
    fi
}

# ==================== 前置检查 ====================

log_info "开始部署前检查..."

# 检查必需的命令
check_command node
check_command pnpm
check_command pm2
check_command git

# 检查 Node.js 版本
NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
    log_error "Node.js 版本必须 >= 18，当前版本: $(node -v)"
    exit 1
fi

# 检查是否在项目根目录
if [ ! -f "package.json" ]; then
    log_error "请在项目根目录运行此脚本"
    exit 1
fi

# 检查是否有未提交的更改
if [ -n "$(git status --porcelain)" ]; then
    log_warn "检测到未提交的更改"
    confirm "是否继续部署？"
fi

log_info "前置检查完成"

# ==================== 备份 ====================

if [ "$SKIP_BACKUP" = false ]; then
    log_info "创建配置备份..."
    
    BACKUP_DIR="/backup/mcp-knot"
    DATE=$(date +%Y%m%d_%H%M%S)
    
    # 创建备份目录
    mkdir -p $BACKUP_DIR
    
    # 备份配置文件
    if [ -d "/etc/mcp-knot/config" ]; then
        tar -czf $BACKUP_DIR/config_$DATE.tar.gz /etc/mcp-knot/config
        log_info "配置已备份到: $BACKUP_DIR/config_$DATE.tar.gz"
    else
        log_warn "配置目录不存在，跳过备份"
    fi
    
    # 清理旧备份（保留最近 30 天）
    find $BACKUP_DIR -name "config_*.tar.gz" -mtime +30 -delete
    
    log_info "备份完成"
else
    log_warn "跳过备份步骤"
fi

# ==================== 拉取最新代码 ====================

log_info "拉取最新代码..."

# 获取当前分支
CURRENT_BRANCH=$(git branch --show-current)
log_info "当前分支: $CURRENT_BRANCH"

# 拉取代码
git pull origin $CURRENT_BRANCH

log_info "代码更新完成"

# ==================== 安装依赖 ====================

log_info "安装依赖..."

pnpm install --frozen-lockfile

log_info "依赖安装完成"

# ==================== 运行测试 ====================

if [ "$SKIP_TESTS" = false ]; then
    log_info "运行测试..."
    
    # 运行单元测试
    pnpm test
    
    # 运行 E2E 测试
    pnpm test:e2e
    
    log_info "测试通过"
else
    log_warn "跳过测试步骤"
fi

# ==================== 构建 ====================

if [ "$SKIP_BUILD" = false ]; then
    log_info "构建项目..."
    
    # 清理旧的构建文件
    pnpm clean
    
    # 构建所有包
    pnpm build:production
    
    log_info "构建完成"
else
    log_warn "跳过构建步骤"
fi

# ==================== 代码质量检查 ====================

log_info "运行代码质量检查..."

pnpm check

log_info "代码质量检查通过"

# ==================== 部署确认 ====================

log_info "准备部署到生产环境"
log_info "当前版本: $(git describe --tags --always)"
log_info "提交信息: $(git log -1 --pretty=%B)"

confirm "确认部署到生产环境？"

# ==================== 停止服务 ====================

log_info "停止当前服务..."

# 检查服务是否运行
if pm2 list | grep -q "mcp-knot-api"; then
    pm2 stop mcp-knot-api
    log_info "服务已停止"
else
    log_warn "服务未运行"
fi

# ==================== 更新配置 ====================

log_info "更新配置文件..."

# 创建配置目录
sudo mkdir -p /etc/mcp-knot/config
sudo mkdir -p /var/log/mcp-knot

# 复制配置文件（如果不存在）
if [ ! -f "/etc/mcp-knot/config/system.json" ]; then
    sudo cp backend/config/system.json /etc/mcp-knot/config/
    log_info "已复制系统配置"
fi

if [ ! -f "/etc/mcp-knot/config/mcp_server.json" ]; then
    sudo cp backend/config/mcp_server.json /etc/mcp-knot/config/
    log_info "已复制 MCP 服务器配置"
fi

if [ ! -f "/etc/mcp-knot/config/group.json" ]; then
    sudo cp backend/config/group.json /etc/mcp-knot/config/
    log_info "已复制组配置"
fi

# 设置权限
sudo chown -R $USER:$USER /etc/mcp-knot
sudo chown -R $USER:$USER /var/log/mcp-knot

log_info "配置更新完成"

# ==================== 启动服务 ====================

log_info "启动服务..."

cd backend

# 启动服务
if pm2 list | grep -q "mcp-knot-api"; then
    pm2 restart mcp-knot-api
else
    pm2 start dist/index.js --name mcp-knot-api
fi

# 保存 PM2 配置
pm2 save

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
    pm2 logs mcp-knot-api --lines 50
    exit 1
fi

# 检查 HTTP 端点
if curl -f http://localhost:3000/health > /dev/null 2>&1; then
    log_info "健康检查通过"
else
    log_error "健康检查失败"
    pm2 logs mcp-knot-api --lines 50
    exit 1
fi

# ==================== 部署完成 ====================

log_info "========================================="
log_info "部署成功完成！"
log_info "========================================="
log_info "版本: $(git describe --tags --always)"
log_info "时间: $(date)"
log_info ""
log_info "后续步骤:"
log_info "1. 检查服务状态: pm2 status"
log_info "2. 查看日志: pm2 logs mcp-knot-api"
log_info "3. 监控服务: pm2 monit"
log_info "4. 访问 Web 界面: http://your-domain.com"
log_info ""
log_info "如有问题，可以从备份恢复:"
log_info "  ./scripts/restore-backup.sh $BACKUP_DIR/config_$DATE.tar.gz"
log_info "========================================="
