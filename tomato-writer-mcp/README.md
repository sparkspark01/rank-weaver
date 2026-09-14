# 番茄小说 MCP

番茄小说作家后台的 MCP 服务：**多本小说管理 · 阅读数据分析 · 章节发布/定时发布**。

直接调用番茄作家后台的真实 HTTP 接口（Cookie 鉴权，无浏览器、无风控签名逆向），相比早期的 Puppeteer 方案稳定可靠。

## 工具

| 工具 | 作用 |
|------|------|
| `list_novels` | 列出账号下所有小说（book_id、书名、字数、阅读数、连载状态） |
| `switch_novel` | 切换当前操作的小说（多本时使用） |
| `get_current_novel` | 查看当前选中的小说 |
| `get_novel_stats` | 阅读数据：书级概览 + 各章读完率/追读率/字数 |
| `list_chapters` | 列出各分卷的章节（含定时待发 / 已发布状态） |
| `publish_chapter` | 发布 / 定时发布一章（直接传内容，或从 Markdown 稿件按章节号提取） |

## 配置

复制 `.env.example` 为 `.env`，填入番茄作家后台鉴权：

```
TOMATO_COOKIE=...        # 登录后任意 /api/author 请求的完整 Cookie 头
TOMATO_CSRF_TOKEN=...    # 同一请求头里的 X-Secsdk-Csrf-Token（会话级固定）
```

获取方法：浏览器登录 <https://fanqienovel.com> 作家后台 → F12 → Network → 任选一个 `/api/author/...` 请求 → 复制其 `Cookie` 和 `X-Secsdk-Csrf-Token`。Cookie 有失效期（约一两个月），失效后重新抓一次更新即可。

## 构建与接入

```bash
pnpm install
pnpm build
```

在支持 MCP 的客户端（Claude Code / Claude Desktop / Cursor 等）的 MCP 配置里加入：

```json
{
  "mcpServers": {
    "tomato-writer-mcp": {
      "command": "node",
      "args": ["/绝对路径/tomato-writer-mcp/dist/index.js"],
      "env": {
        "TOMATO_COOKIE": "...",
        "TOMATO_CSRF_TOKEN": "..."
      }
    }
  }
}
```

（若已配置好 `.env`，`env` 字段可省略。）

## 使用示例

- “列出我的小说” → `list_novels`
- “切换到《重生：从掠夺气运之子开始》” → `switch_novel`
- “看看这本书的阅读数据” → `get_novel_stats`
- “把 `/path/正文_第11-20章.md` 的第 19 章定时到 2026-06-20 15:00 发布” → `publish_chapter`

## 项目结构

```
src/
├── index.ts              # MCP 入口，注册工具
├── tomato/
│   ├── client.ts         # HTTP 客户端（Cookie + CSRF，统一 GET/POST，code≠0 抛错）
│   ├── config.ts         # 鉴权加载 + 当前小说状态（data/state.json）
│   ├── content.ts        # 正文转 <p> HTML / 从 Markdown 提取指定章节
│   └── service.ts        # 业务封装（书单 / 数据 / 建草稿 / 发布）
└── tools/
    ├── novels.ts         # list_novels / switch_novel / get_current_novel
    ├── stats.ts          # get_novel_stats / list_chapters
    └── publishing.ts     # publish_chapter
```

## 说明

- 定时发布：`publish_time` 给未来时间即预约，到点由番茄服务端自动发出，本机无需常驻；预约成功不代表一定过审，番茄正式发布时仍会做内容审核。
- 请遵守番茄平台规则与内容合规要求。

## 许可证

MIT
