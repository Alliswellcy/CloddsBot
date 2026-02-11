# 中转 API 配置指南

本项目已支持使用中转 API（代理 API）来访问 Claude 服务。

## 配置步骤

### 1. 创建 .env 文件

如果还没有 `.env` 文件，复制示例文件：

```bash
cp .env.example .env
```

### 2. 配置 API 密钥和基础 URL

在 `.env` 文件中添加以下配置：

```env
# 你的中转 API 密钥
ANTHROPIC_API_KEY=sk-your-relay-api-key

# 你的中转 API 基础 URL（必须配置）
ANTHROPIC_BASE_URL=https://your-relay-api.com
```

### 3. 常见中转 API 示例

根据你使用的中转服务，配置相应的 URL：

```env
# 示例 1: 某中转服务
ANTHROPIC_BASE_URL=https://api.example-relay.com

# 示例 2: 自建代理
ANTHROPIC_BASE_URL=https://your-proxy.com/v1

# 示例 3: 其他中转服务
ANTHROPIC_BASE_URL=https://api.another-relay.cn
```

**注意事项：**
- 确保 URL 不包含尾部斜杠
- 大多数中转 API 会保持与官方 API 相同的接口格式
- API 密钥格式可能因中转服务而异

### 4. 验证配置

启动项目后，系统会自动使用配置的中转 API：

```bash
npm start
```

如果配置正确，你应该能看到正常的启动日志，没有 API 连接错误。

## 技术说明

修改涉及以下文件：
- `src/agents/index.ts` - 主 Agent 客户端
- `src/agents/subagents.ts` - 子 Agent 客户端
- `src/memory/summarizer.ts` - 摘要服务客户端
- `src/tools/image.ts` - 图像分析工具客户端
- `src/providers/index.ts` - Provider 管理器
- `src/config/index.ts` - 配置管理

所有 Anthropic SDK 客户端实例都已更新为支持自定义 `baseURL`。

## 故障排查

### 连接失败
- 检查 `ANTHROPIC_BASE_URL` 是否正确
- 确认中转服务是否正常运行
- 验证 API 密钥是否有效

### 认证错误
- 确认 API 密钥格式正确
- 检查中转服务的认证方式是否与官方 API 一致

### 功能异常
- 某些中转服务可能不支持所有 Claude API 功能
- 检查中转服务的文档了解支持的功能列表

## 恢复官方 API

如果需要切换回官方 API，只需：

1. 删除或注释掉 `ANTHROPIC_BASE_URL` 配置
2. 使用官方 API 密钥更新 `ANTHROPIC_API_KEY`

```env
ANTHROPIC_API_KEY=sk-ant-your-official-key
# ANTHROPIC_BASE_URL=  # 注释掉或删除此行
```

系统会自动使用默认的官方 API 地址 `https://api.anthropic.com`。
