# MCP Knot Web Interface

Vue.js 前端界面，为 MCP Knot 提供完整的 Web 管理功能。

## 功能特性

- **JWT 认证系统**: 安全的登录和会话管理
- **服务器管理**: 可视化的 MCP 服务器配置和监控
- **工具管理**: 浏览和测试可用的 MCP 工具
- **Schema 参数编辑器**: 执行/测试页共用 vue-json-ui-editor，支持 TDesign 表单、JSON 回退和提交前校验
- **组管理**: 配置和管理服务器组
- **实时监控**: 系统状态的实时更新
- **响应式设计**: 适配不同屏幕尺寸的设备

## 工具参数配置

“执行工具”和“测试工具”使用同一个 `ToolParameterEditor`。标准标量、枚举、嵌套对象、
对象数组使用 TDesign 表单；基本类型数组、动态键对象、组合和引用等复杂 Schema 自动使用 JSON 模式。
用户也可以主动切到 JSON 模式，精确控制所有键和值。

提交前使用原始 Schema 做 Ajv 校验，支持默认 2020-12、显式 draft-07 / 2019-09。
校验不会强制转换类型、删除未知键或自动补默认值；语法错误、Schema 编译失败、参数不合法时不请求执行/测试 API。
远端 Schema 的 attrs/component 等 UI 扩展不会交给渲染器。后台仍是执行权限和最终参数校验的权威。

可选顶层参数通过勾选控制是否传入，默认值会预填；嵌套表单保留编辑器初始化子字段的行为，
需要省略嵌套可选字段时使用 JSON 模式。JSON 中的空字符串、false、0、null 和额外键不会被静默丢弃。
切换工具会重置草稿并忽略旧请求返回；执行页“重置”恢复该工具的初始默认参数。

组件 API：`:schema`、`v-model`、`:disabled`；`change` 事件清理旧结果；
通过 ref 的 `getArguments()` 返回已校验的独立参数对象，失败时返回 null 并显示错误。

编辑器固定使用 npm 正式版本 `vue-json-ui-editor@3.2.1`，由 `pnpm-lock.yaml` 锁定完整性；
安装和 CI 无需本地源码或 vendored 试用包。

```bash
# 仓库根目录
pnpm install --frozen-lockfile
pnpm build:share
pnpm typecheck:fe
pnpm --filter @mcp-core/mcp-knot-web test
pnpm build:fe
```

## 技术栈

- **Vue 3** - 响应式前端框架
- **TDesign Vue Next** - 企业级 UI 组件库
- **Pinia** - 状态管理
- **Vue Router** - 路由管理
- **Axios** - HTTP 客户端
- **TypeScript** - 类型安全
- **Rsbuild** - 构建工具

## 开发环境

### 安装依赖

```bash
pnpm install
```

### 启动开发服务器

```bash
pnpm dev
```

### 构建生产版本

```bash
pnpm build
```

### 运行测试

```bash
pnpm test
```

### 代码检查和格式化

```bash
pnpm check
```

### TypeScript 与 Vue 模板检查

```bash
# 在 frontend 目录执行，检查 TypeScript、Vue 脚本与模板（含测试）
pnpm typecheck

# 在仓库根目录执行前端检查
pnpm typecheck:fe
```

仓库根目录的 `pnpm typecheck` 也包含上述 Vue 模板检查。

## 项目结构

```
src/
├── components/          # 通用组件
├── views/              # 页面组件
│   ├── Login.vue       # 登录页面
│   ├── Dashboard.vue   # 仪表板
│   └── NotFound.vue    # 404页面
├── stores/             # Pinia 状态管理
│   └── auth.ts         # 认证状态
├── services/           # API 服务层
│   ├── api.ts          # HTTP 客户端配置
│   └── auth.ts         # 认证服务
├── types/              # TypeScript 类型定义
│   ├── auth.ts         # 认证相关类型
│   └── api.ts          # API 响应类型
├── router/             # 路由配置
│   └── index.ts        # 路由定义和守卫
└── App.vue             # 主应用组件
```

## 认证系统

### 登录流程

1. 用户在登录页面输入凭据
2. 前端调用 `/api/auth/login` 接口
3. 后端验证凭据并返回 JWT token
4. 前端存储 token 并跳转到仪表板
5. 后续请求自动携带 token

### Token 管理

- **访问 Token**: 短期有效，用于 API 请求认证
- **刷新 Token**: 长期有效，用于自动刷新访问 token
- **自动刷新**: HTTP 拦截器自动处理 token 过期和刷新
- **持久化存储**: Token 存储在 localStorage 中

### 路由守卫

- 未认证用户自动跳转到登录页面
- 已认证用户访问登录页面时跳转到仪表板
- Token 过期时自动尝试刷新或跳转登录

## API 集成

### HTTP 客户端配置

```typescript
// 自动添加认证头
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('auth_token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// 自动处理 token 刷新
api.interceptors.response.use(
  (response) => response,
  async (error) => {
    if (error.response?.status === 401) {
      // 尝试刷新 token
      await refreshToken();
      // 重试原始请求
    }
  },
);
```

### 状态管理

使用 Pinia 管理应用状态：

```typescript
const authStore = useAuthStore();

// 登录
await authStore.login({ username, password });

// 登出
await authStore.logout();

// 检查认证状态
if (authStore.isAuthenticated) {
  // 用户已登录
}
```

## 开发指南

### 添加新页面

1. 在 `src/views/` 创建 Vue 组件
2. 在 `src/router/index.ts` 添加路由配置
3. 设置适当的 `meta.requiresAuth` 属性

### 添加新的 API 服务

1. 在 `src/types/` 定义相关类型
2. 在 `src/services/` 创建服务函数
3. 在组件中使用服务函数

### 状态管理

1. 在 `src/stores/` 创建新的 store
2. 使用 Pinia 的 Composition API 风格
3. 在组件中通过 `useXxxStore()` 使用

## 部署

### 环境变量

在生产环境中，确保正确配置：

- API 基础 URL
- 认证相关配置
- 其他环境特定设置

### 构建优化

- 代码分割和懒加载
- 静态资源压缩
- CDN 配置

### 安全考虑

- HTTPS 强制使用
- CSP 头部设置
- XSS 防护
- CSRF 保护
