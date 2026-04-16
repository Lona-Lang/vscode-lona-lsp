# Lona Language Support

`Lona Language Support` 是 Lona 语言的 VS Code 扩展仓库。

主要能力如下：

- 代码补全
- 语法与语义诊断
- 转到定义与速览定义

## 概述

本仓库使用 `lona-query` 作为主要语义后端。

职责划分如下：

- `lona-query`
  - 提供模块加载、作用域、成员查询、类型查询和结构化诊断
- LSP server
  - 负责协议处理、文档状态、请求调度、错误拦截和恢复
- VS Code client
  - 负责扩展激活、文档同步和 UI 对接

当 `lona-query` 不可用或请求失败时，LSP 会回退到本地轻量索引，以提供基础补全和基础定义跳转。

## 功能

### 补全

- 顶层符号
- 当前作用域局部变量与参数
- `moduleAlias.` 模块成员
- `value.` 结构体字段与方法
- tuple 成员，例如 `_1`、`_2`

### 诊断

- 已保存文件上的 `lona-query` 语法与语义诊断
- 文档修改后的自动刷新
- `lona-query` 崩溃时保留上一次成功诊断

### 定义跳转

- 局部变量与参数
- import alias
- 当前模块或导入模块中的 type / func / global
- 基础字段定义

## 行为

### Query 会话

- `lona-query` 按 `rootPaths + entry module` 维持长驻会话
- 当前活动文档即 query entry module
- 导入模块查询通过 `open`、`pv`、`pt` 完成

### 刷新策略

- 文件换行数变化时标记模块为 dirty
- 停止输入 500ms 后自动刷新一次诊断
- 文件保存时立即刷新一次诊断

### 容错策略

- query 成功时，优先使用 query 结果
- query 失败时，补全与定义跳转回退到本地索引
- query 在诊断阶段崩溃时，LSP 记录错误并保留已有诊断

## 安装

### 依赖

- VS Code `^1.90.0`
- Node.js
- `lona-query`

### 安装 VSIX

```bash
code --install-extension /path/to/lona-lsp-<version>.vsix --force
```

### 调试扩展

将仓库目录作为 VS Code extension project 打开即可。

## 配置

配置项位于 `lona.lsp.*` 命名空间下。

### `lona.lsp.queryPath`

- 类型：`string`
- 默认值：`lona-query`
- 说明：`lona-query` 可执行文件路径

### `lona.lsp.rootPaths`

- 类型：`string[]`
- 默认值：`[]`
- 说明：
  - 传给 `lona-query` 的 root 路径列表
  - 相对路径按第一个 workspace folder 解析
  - 为空时使用当前文件所在目录

### `lona.lsp.enableDiagnostics`

- 类型：`boolean`
- 默认值：`true`
- 说明：是否发布诊断

### `lona.lsp.preferQueryBackend`

- 类型：`boolean`
- 默认值：`true`
- 说明：是否优先使用 `lona-query`

## 开发

### 目录结构

```text
client/
  extension.js
server/
  lsp-server.js
  lona-query.js
  lona-index.js
  module-roots.js
test/
  *.test.js
  query-latency.js
```

### 常用命令

```bash
npm test
npm run bench:query-latency
```

### 打包

```bash
npx @vscode/vsce package
```

## 限制

- `lona-query` 当前主要服务于磁盘已保存且内容一致的文件
- 未保存缓冲区仍主要依赖本地索引回退
- imported 模块中的错误不会自动汇总到导入方文件
- 复杂链式表达式、更深类型推断和更完整语义导航仍较保守
- `lona-query` 的部分 `reload` 场景仍可能崩溃；LSP 会拦截并恢复，但不会替代 query 修复底层问题
