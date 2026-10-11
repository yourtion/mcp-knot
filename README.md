# MCP Knot

English | [中文版](README.zh.md)

> _Knot_ —— 纽带、交织点。多个 MCP server 像散落的线，MCP Knot 把它们打成一个结，成为所有工具交汇的轻量枢纽。

**Tie your MCP servers together.**

A centralized hub server engineered to consolidate multiple MCP servers into dedicated Streamable HTTP or SSE endpoints, each tailored to specific use scenarios — lightweight, zero-config, and leading on the 2026-07-28 stateless MCP protocol.

## Features

- **Multi-server MCP Integration**: Support for multiple MCP servers with centralized management
- **Group-based Routing**: Access MCP services through group-specific endpoints (`/:group/mcp`)
- **CLI MCP Server**: Standalone command-line MCP server for tool aggregation
- **Streamable Endpoints**: Support for both HTTP and SSE endpoints
- **Tool Filtering**: Groups support tool filtering and screening capabilities
- **Validation Support**: Groups can set separate validation keys for security
- **Modular Architecture**: Clean separation between core logic, API, and CLI packages

## Architecture

MCP Knot follows a modular monorepo architecture with the following packages:

### Core Packages

- **`@mcp-core/mcp-knot-core`** - Core MCP service management, connection handling, and tool execution
- **`@mcp-core/mcp-knot-api`** - Web API server with group-based routing and HTTP endpoints
- **`@mcp-core/mcp-knot-cli`** - Command-line MCP server for standalone tool aggregation
- **`@mcp-core/mcp-knot-protocol`** - Protocol compatibility layer: dual-era (modern/legacy) translation, normalized models, unified errors
- **`@mcp-core/mcp-knot-share`** - Shared types and utilities across packages
- **`@mcp-core/mcp-knot-web`** - Vue.js frontend interface (optional)

### Package Structure

```
├── backend/              # API server (@mcp-core/mcp-knot-api)
├── frontend/             # Vue.js web interface
├── packages/
│   ├── core/            # Core MCP logic (@mcp-core/mcp-knot-core)
│   ├── cli/             # CLI package (@mcp-core/mcp-knot-cli)
│   ├── protocol/        # Protocol compatibility layer (@mcp-core/mcp-knot-protocol)
│   └── share/           # Shared types (@mcp-core/mcp-knot-share)
└── docs/                # Documentation
```

## Installation

### Prerequisites

- Node.js 20.19+ (Node 22/24 recommended)
- pnpm package manager

### Install Dependencies

```bash
# Install all dependencies
pnpm install

# Build all packages
pnpm build
```

## Quick Start

### 1. API Server (Web Interface)

Start the API server for web-based MCP hub functionality:

```bash
# Development mode
pnpm dev:api

# Production build and start
pnpm build
cd backend && pnpm start
```

The API server will be available at `http://localhost:8181` with the following endpoints:

- `/mcp` - Global MCP endpoint (legacy, for management)
- `/:group/mcp` - Group-specific MCP endpoints
- `/api/groups` - Group management API
- `/api/config` - System configuration management API
- `/api/servers` - MCP server management API
- `/api/tools` - Tool management and execution API
- `/api/debug` - Debugging and monitoring API

### 2. CLI MCP Server

Use the CLI package as a standalone MCP server:

```bash
# Install CLI globally (optional)
npm install -g @mcp-core/mcp-knot-cli

# Or run directly from workspace
cd packages/cli
pnpm build
node dist/cli.js

# Or use the executable
./bin/mcp-knot.js
```

#### Quick Configuration Initialization

MCP Knot CLI provides quick configuration initialization to help you get started quickly:

```bash
# View all available commands
mcp-knot --help

# Initialize default configuration (includes common server examples)
mcp-knot --init

# Initialize all configurations (includes group configuration)
mcp-knot --init-all

# List all available server presets
mcp-knot --list-presets

# Overwrite existing configuration files
mcp-knot --init-all --overwrite
```

The default configuration includes these commonly used MCP servers:

- **fetch**: Web fetching and HTTP requests
- **time**: Time and date functionality
- **sequential-thinking**: Sequential thinking capabilities

More available server presets:

- **filesystem**: File system operations
- **memory**: Persistent memory storage
- **brave-search**: Brave search engine
- **github**: GitHub repository management

The CLI server communicates via stdin/stdout using the MCP protocol, perfect for integration with MCP clients like Claude Desktop.

### 3. Frontend Interface (Optional)

Start the web interface for visual management:

```bash
# Development mode
pnpm dev:fe

# Production build
pnpm build:fe
```

The frontend will be available at `http://localhost:8180` (development) or served through the backend in production.

#### Web Interface Features

The frontend provides a comprehensive web-based management interface with the following features:

##### 1. Authentication & Security

- **JWT Authentication**: Secure login system with token-based authentication
- **Automatic Token Refresh**: Seamless session management without interruption
- **Route Guards**: Protected pages requiring authentication
- **Persistent Sessions**: Remember user login state across browser sessions
- **Default Credentials**: Username: `admin`, Password: `admin` (change in production!)

##### 2. Dashboard & Monitoring

- **System Overview**: Real-time statistics of servers, tools, and groups
- **Live Status Updates**: Server-Sent Events (SSE) for real-time monitoring
- **Performance Metrics**: Request rates, response times, and error rates
- **Activity Feed**: Recent system activities and events
- **Health Monitoring**: System health checks and alerts

##### 3. Server Management

- **Server List**: View all configured MCP servers with status indicators
- **Add/Edit Servers**: Visual forms for server configuration
- **Connection Control**: Connect, disconnect, and test server connections
- **Status Monitoring**: Real-time server connection status
- **Configuration Validation**: Test server configurations before saving

##### 4. Tool Management

- **Tool Browser**: Browse all available MCP tools across servers
- **Tool Search & Filter**: Find tools by name, server, or group
- **Tool Testing**: Interactive tool execution with parameter input
- **Execution History**: View past tool executions and results
- **Tool Details**: Complete tool documentation and schema information

##### 5. Group Management

- **Group Configuration**: Create and manage server groups
- **Member Management**: Assign servers to groups
- **Tool Filtering**: Configure which tools are available per group
- **Validation Keys**: Set and manage group-level authentication
- **Group Statistics**: Usage statistics and performance metrics

##### 6. API to MCP Integration

- **API Configuration**: Convert REST APIs to MCP tools
- **Parameter Mapping**: Visual editor for API-to-MCP parameter mapping
- **API Testing**: Test API configurations before deployment
- **Import/Export**: Share API configurations across environments
- **Auto-generation**: Automatically generate MCP tools from API specs

##### 7. Debug & Development Tools

- **MCP Protocol Monitor**: View raw MCP protocol messages
- **Tool Debugger**: Test tools with detailed execution logs
- **Performance Analyzer**: Analyze tool performance and bottlenecks
- **Error Analysis**: Intelligent error diagnosis and fix suggestions
- **Message Inspector**: Inspect request/response payloads

##### 8. Configuration Management

- **System Settings**: Configure system-wide settings
- **Configuration Editor**: Edit configurations with validation
- **Backup & Restore**: Create and restore configuration backups
- **Configuration History**: Track configuration changes over time
- **Validation**: Real-time configuration validation

#### Authentication Setup

The frontend uses JWT-based authentication. To configure authentication:

1. **Default Credentials** (Development):
   - Username: `admin`
   - Password: `admin`

2. **Production Setup**:
   - Configure credentials, JWT secret, and server port in `system.json` (see
     `backend/config/system.json.example` and the schema at
     `packages/share/src/config/schemas/system.schema.ts`).
   - Set strong passwords using bcrypt hashing in the `auth.users` block.
   - JWT secret/expiry come from the `auth.jwt` block in `system.json`, **not**
     environment variables.

3. **Environment Variables**:
   ```bash
   # Backend (.env) — only env vars the code actually reads; see .env.production.example
   NODE_ENV=production
   CONFIG_PATH=/path/to/config      # directory containing system.json, mcp_server.json, group.json
   VALIDATION_KEY_SECRET=<>=32 chars>  # required when group validation is enabled
   ```

#### Accessing the Web Interface

1. **Start the Backend**:

   ```bash
   pnpm dev:api
   # Backend runs on http://localhost:8181
   ```

2. **Start the Frontend** (Development):

   ```bash
   pnpm dev:fe
   # Frontend runs on http://localhost:8180
   ```

3. **Login**:
   - Navigate to `http://localhost:8180`
   - Enter credentials (default: admin/admin)
   - You'll be redirected to the dashboard

4. **Production Deployment**:

   ```bash
   # Build frontend
   pnpm build:fe

   # Frontend static files will be in frontend/dist
   # Serve through backend or separate web server
   ```

   The canonical production topology is a **two-container stack** defined in
   `docker-compose.yml`:
   - `mcp-knot-web` (nginx, host port **8180**) — serves the SPA and reverse-proxies
     `/api/`, `/mcp`, `/:group/mcp` to the backend. SPA fallback (`try_files ... /index.html`)
     is configured in `frontend/nginx.conf`, so refreshing any frontend route works.
   - `mcp-knot-api` (Node, internal **8181**) — the API + MCP endpoint, **not** a SPA host.

   Always access the app via the nginx port (**8180**). Hitting the backend port (8181)
   directly with a frontend path returns `404 Not Found` because the backend only serves
   `/api/*` and `/:group/mcp` — this is expected, not a bug.

## Configuration

### MCP Server Configuration

Create a `mcp_server.json` file in the `backend/config/` directory:

```json
{
  "servers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/directory"],
      "env": {}
    },
    "brave-search": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-brave-search"],
      "env": {
        "BRAVE_API_KEY": "your-api-key"
      }
    }
  }
}
```

### Group Configuration

Configure groups in `backend/config/group.json`:

```json
{
  "groups": {
    "development": {
      "name": "Development Tools",
      "description": "Tools for software development",
      "servers": ["filesystem", "git"],
      "allowedTools": ["read_file", "write_file", "git_status"],
      "validationKey": "dev-key-123"
    },
    "research": {
      "name": "Research Tools",
      "description": "Tools for research and information gathering",
      "servers": ["brave-search", "wikipedia"],
      "allowedTools": ["search", "lookup"],
      "validationKey": "research-key-456"
    }
  }
}
```

## Usage Examples

### Group-based MCP Access

Access tools through group-specific endpoints:

```bash
# List tools for development group（MCP 2026-07-28 JSON-RPC）
curl -X POST http://localhost:8181/development/mcp \
  -H "Content-Type: application/json" \
  -H "Mcp-Method: tools/list" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/list",
    "params": {}
  }'

# Call a tool in the research group
curl -X POST http://localhost:8181/research/mcp \
  -H "Content-Type: application/json" \
  -H "Mcp-Method: tools/call" \
  -d '{
    "jsonrpc": "2.0",
    "id": 2,
    "method": "tools/call",
    "params": {
      "name": "search",
      "arguments": {
        "query": "MCP protocol documentation"
      }
    }
  }'
```

#### Connecting with the official MCP SDK (Node)

The `/:group/mcp` endpoint serves the modern **2026-07-28** protocol by default,
and — since the protocol compatibility layer (P7) — **also accepts legacy 2025-era
clients**. Inbound compatibility defaults to **全开 (modern + legacy)**: a modern
client negotiates via `server/discover`, while a legacy client's bare `initialize`
handshake is still served. This is configurable (see
[Protocol Compatibility](#protocol-compatibility)).

For a modern client, the official `@modelcontextprotocol/client` should use
**`versionNegotiation: { mode: 'auto' }`** so the SDK probes and adopts the
server's 2026-07-28 version.

```ts
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const transport = new StreamableHTTPClientTransport(new URL('http://localhost:8181/default/mcp'));
const client = new Client(
  { name: 'my-client', version: '1.0.0' },
  {
    capabilities: { tools: {} },
    // Recommended: lets the SDK probe and adopt the server's 2026-07-28 version.
    versionNegotiation: { mode: 'auto' },
  },
);

await client.connect(transport); // initialize
const { tools } = await client.listTools(); // tools/list
await client.callTool({ name: 'fetch_fetch', arguments: { url: 'https://example.com' } });
```

Tools are namespaced as `<serverId>_<toolName>` (e.g. `fetch_fetch`,
`context7_query-docs`) to avoid collisions across servers. Two built-in meta-tools
(`group_status`, `list_group_tools`) are also exposed on every group endpoint.

##### Protocol Compatibility

Hub ships a protocol compatibility layer (`@mcp-core/mcp-knot-protocol`) that
bridges the modern **2026-07-28** era and legacy 2025-era MCP on both directions:

- **Inbound** (client → Hub): defaults to **modern + legacy** simultaneously — a
  modern client negotiates via `server/discover`, a legacy client's bare
  `initialize` is still served. Set `compatibility.inbound.enabled: false` (or CLI
  `--no-legacy-inbound`) to reject legacy clients and accept only modern.
- **Outbound** (Hub → upstream server): era is auto-probed per server; Hub
  transparently bridges modern requests to legacy upstreams. Set
  `compatibility.outbound.modernOnly: true` (or CLI `--modern-only-upstream`) to
  connect only to modern upstreams in the backend. The CLI flag is reserved:
  its core service currently simulates upstream connections and does not enforce it.
- **MRTR & errors**: cross-era `InputRequiredResult` (MRTR) state and protocol
  errors are normalized into a unified shape regardless of upstream era. A
  legacy upstream that cannot honor `input_required` degrades to a clear
  `-32601` error rather than failing silently.

Defaults are intentionally permissive so existing clients keep working. The
`compatibility` block in `system.json` is optional and partially overridable;
omit it entirely for the default all-open behavior.

**Testing coverage**: cross-era bridging is covered by project-owned e2e
(`protocol-compliance.test.ts`: outbound modern→legacy, inbound legacy→modern)
plus unit tests for the adapter/codec/normalizer layers. The official
`@modelcontextprotocol/conformance` TCK is wired as a regression gate
(`pnpm test:conformance`) but, as of TCK v0.1.16, only covers the legacy
(2025-11-25) era in server mode — modern-era (2026-07-28) conformance is
pending upstream TCK support.

### CLI MCP Server Integration

Configure the CLI server in your MCP client (e.g., Claude Desktop):

```json
{
  "mcpServers": {
    "mcp-knot": {
      "command": "/path/to/mcp-knot/packages/cli/bin/mcp-knot.js",
      "args": ["--config", "/path/to/mcp_server.json"]
    }
  }
}
```

## Development

### Available Scripts

```bash
# Development
pnpm dev:api          # Start API server in development mode
pnpm dev:fe           # Start frontend in development mode

# Building
pnpm build            # Build all packages
pnpm check            # Run linting and formatting

# Testing
pnpm test             # Run all tests
pnpm test:coverage    # Run tests with coverage
pnpm test:e2e         # Run end-to-end tests

# Utilities
pnpm inspector        # Launch MCP inspector for debugging
```

### Package Development

Each package can be developed independently:

```bash
# Core package
cd packages/core
pnpm dev              # Watch mode compilation
pnpm test:watch       # Watch mode testing

# CLI package
cd packages/cli
pnpm dev              # Watch mode compilation
pnpm test:e2e         # End-to-end testing

# API package
cd backend
pnpm dev              # Development server
pnpm test:mcp         # MCP protocol tests
```

## Documentation

### User Guides

- [Web UI Guide](docs/WEB_UI_GUIDE.md) - Complete web interface usage guide
- [CLI Usage Guide](docs/CLI_USAGE.md) - Detailed CLI usage and configuration
- [Troubleshooting](docs/TROUBLESHOOTING.md) - Frequently asked questions and troubleshooting

### Technical Documentation

- [API Reference](docs/API_REFERENCE.md) - Complete API documentation
- [Group Routing Guide](docs/GROUP_ROUTING.md) - Group-based routing documentation

### Development & Deployment

- [Development Guide](docs/DEVELOPMENT.md) - Development environment setup and contribution guide
- [Release Process](#release-process) - Version management and publishing with Changesets
- [Deployment Guide](docs/DEPLOYMENT.md) - Production deployment instructions
- [Troubleshooting](docs/TROUBLESHOOTING.md) - Common issues and solutions

### Release Process

MCP Knot uses [Changesets](https://github.com/changesets/changesets) for version management and publishing.

#### Daily Development Workflow

1. **Complete feature development**:

   ```bash
   git checkout -b feature/my-feature
   # Develop and test...
   pnpm test
   pnpm check:all
   ```

2. **Create a Changeset**:

   ```bash
   pnpm changeset
   ```

   - Select affected packages
   - Choose version type (major/minor/patch)
   - Add change description

3. **Commit code**:

   ```bash
   git add .
   git commit -m "feat: add new feature"
   git push origin feature/my-feature
   ```

4. **Create Pull Request** to `main` branch

#### Automated Release Process

The project uses GitHub Actions for automated publishing:

1. **PR merged to main**: CI detects changesets
2. **Version Packages PR created**: Contains version updates and CHANGELOG
3. **Version Packages PR merged**: Triggers automatic publishing
   - Publish to npm
   - Create GitHub Release
   - Optionally publish Docker images (`DOCKER_PUBLISH=true`)

Publishing uses **npm Trusted Publishing (OIDC)** with Node 24, npm 11, and
`id-token: write`; no npm token is used. Only successful main **push** CI runs can
release the current main commit. Changesets creates a version PR first; merging
that PR and passing CI publishes built tarballs, package tags, and GitHub Releases.

Before the first release, create any missing npm packages using an interactive
`npm login`, then configure each package's Trusted Publisher with user `yourtion`,
repository `mcp-knot`, workflow **`publish.yml`**, no environment, and permission
for **`npm publish`**. See [the release setup guide](docs/RELEASING.md) for commands,
package names, and retry instructions. Automated version PRs may require approving
their CI runs in GitHub when created with `GITHUB_TOKEN`.

#### Version Type Selection

- **major**: Breaking changes (API changes, removed features)
- **minor**: New features (new APIs, backward-compatible enhancements)
- **patch**: Bug fixes, small improvements

#### Related Commands

```bash
# Create changeset
pnpm changeset

# Consume changesets (update versions)
pnpm version

# Check changesets status
pnpm changeset:check

# Publish to npm (usually automated by CI)
pnpm release
```

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes with tests
4. Run `pnpm check` to ensure code quality
5. Submit a pull request

## License

ISC License - see LICENSE file for details.
