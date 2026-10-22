# vue-json-ui-editor 试接入包

此目录固定保存编辑器 PR #99 的 npm 构建产物，避免依赖工作区外的源码路径或尚未发布的 npm 版本。

- 上游：https://github.com/yourtion/vue-json-ui-editor/pull/99
- 源码提交：`78031e68343eb4b1894daa53f3a07c9303c43dd2`
- 包文件：`vue-json-ui-editor-3.1.0-pr99.tgz`
- SHA-256：`c18ec73c2b9f866615296ee8a343feea3a7e0e65e7069e30a88c7ddf7a4642b3`
- 上游许可证：MIT（包含在 tarball 中）
- 包内版本保留上游 3.1.0；此文件是 PR 构建，**不是 npm 上已发布的 3.1.0**。

从上述提交检出源码并安装依赖后，执行 `npm run test:package`、`npm pack` 可重建。
原包没有安装生命周期脚本；mcp-knot 的安装过程只解包，不构建或访问临时工作目录。
`pnpm-lock.yaml` 同时固定 tarball 的完整性。上游发布包含这些更改的版本后，替换 frontend 的
`file:vendor/...` 依赖为对应精确 npm 版本，删除该试用包，并重跑参数编辑器和页面集成测试。
