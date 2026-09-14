# 🍅 番茄自动化控制台

一个把 **番茄榜单分析 → 大纲 → 章节 → 定时发布** 串成一条流水线的本地 Web 应用：

| 功能 | 使用的技能/项目 | 说明 |
|---|---|---|
| **推荐功能** | `fenxi` skill | 抓取番茄小说连载中热门榜前二十，生成「热门题材分析 + 新书指南」 |
| **生成功能** | `fenxi` skill | 输入剧情 → 对照榜单做匹配评估 → 匹配则生成原创大纲，不匹配则给出疑问清单 → 用户确认 |
| **定时发布** | `du-nai` skill + `dsh-cron` + `tomato-writer-mcp` | 生成章节（du-nai 毒奶文风）→ 用户确认 → 写入 dsh-cron 计划 → DSH Automation 每天定时触发 → 经 tomato-writer-mcp 发布到番茄作家后台 |

技能由 **Agent API 执行**：fenxi / du-nai 的完整技能指令随应用分发（`skills/`），网页通过一个
OpenAI 兼容的 `/chat/completions` 接口（弹窗配置，如 DeepSeek API）调用模型执行技能流程。

## 快速开始

```powershell
# 1. 构建 tomato-writer-mcp（首次，或 node_modules 被删除后恢复）
cd D:\RankWeaver\tomato-writer-mcp
pnpm install
pnpm run build

# 2. 启动控制台（Node 18+，推荐 24）
cd D:\RankWeaver\tomato-auto-web
node server.mjs
# 或：powershell -ExecutionPolicy Bypass -File scripts/start.ps1
```

> 注：控制台本身**零依赖**，只读取 `tomato-writer-mcp/dist/`（不依赖其 `node_modules`），
> 所以不装依赖也能启动；只有需要独立运行 tomato-writer-mcp 的 MCP 服务端时才必须执行第 1 步。

浏览器打开 <http://127.0.0.1:3210>。

## 使用流程

页面顶部有一条**引导步骤条**（1 配置 Agent API → 2 番茄鉴权并选书 → 3 推荐/生成大纲 → 4 确认大纲 → 5 生成章节并确认 → 6 创建发布计划），
当前该做哪一步会高亮显示；首次打开页面会按顺序自动弹出对应的配置弹窗（先「Agent API」，配好后自动推进到「番茄鉴权」），同一时刻只会有一个弹窗。

1. **配置 Agent API**：弹窗填接口地址（如 `https://api.deepseek.com`）、API Key、模型 → 测试并保存（保存后自动进入第 2 步）。
2. **配置番茄鉴权**：粘贴 Cookie 与 X-Secsdk-Csrf-Token → 验证通过后选择目标小说（账号只有一本时自动选中）。
3. **推荐**：点「生成热门题材分析与新书指南」。
4. **生成**：输入剧情 → 生成匹配评估与大纲 → 确认大纲。
5. **定时发布**：设置每天发布时刻 / 章数 → 「用 du-nai 生成章节」→ 查看并确认章节 → 「创建发布计划」。
   - 每天到点后，dsh-cron 的定时会话会回调本服务 `POST /api/publish/fire` 完成发布；
   - 本服务内置幂等看门狗兜底（dsh-cron 未触达时到点后 5 分钟补发，不会重复发布）；
   - 「立即发布」可随时手动发布全部已确认章节。

缺前置条件时不会再弹出浏览器原生 alert（会冻结页面渲染），而是右下角轻提示 + 直接跳到该做的步骤。

## 前端约定（避免回归）

- 弹窗显隐**只用 `.modal-mask.open` 类**控制：`.modal-mask` 默认 `display:none`。
  历史 bug：`.modal-mask { display:flex }` 属作者样式，优先级高于浏览器默认的 `[hidden]{display:none}`，
  于是首屏三个全屏遮罩同时展开、页面看起来"卡死"。因此弹窗元素**不要**再加 `hidden` 属性。
- 交互反馈一律用页内 `toast()` / `askConfirm()`，不要用 `alert()` / `confirm()`（原生对话框会阻塞渲染）。
- 状态轮询（5 秒）走 `stateSig()` 去重，只有真正变化才重建 DOM。

### 前端自检脚本

```powershell
node scripts/check-frontend.mjs                  # 静态检查：id 交叉核对、阻塞式 API 残留、弹窗 CSS 机制
node scripts/verify-ui.mjs <dump出来的dom.html>  # 渲染后检查：首屏弹窗数量与引导顺序、步骤条、连接状态
```

`verify-ui.mjs` 需要一份渲染后的 DOM。无头浏览器导出方式（Edge 示例）：

```powershell
& "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --headless --disable-gpu `
  --user-data-dir="$PWD\state\edge-profile" --virtual-time-budget=6000 `
  --dump-dom "http://127.0.0.1:3210" | Out-File -Encoding utf8 state\dom.html
```

## dsh-cron 集成

已按真实方式安装进 DSH：

```powershell
dsh plugin --profile web add dsh-automation@next     # 0.2.0-alpha.1 ✓ 已装
dsh plugin --profile web add @cofy-x/dsh-cron        # 0.8.0-alpha.4 ✓ 已装
```

组合树（`dsh --profile web --dump-config`）中已出现 `dsh-automation` 与 `dsh-cron` 两个插件行。

⚠️ **需要重启 DSH Web 才会激活**（插件生命周期为 restart-profile）：

```powershell
# 关闭当前 dsh web 进程后重新启动
dsh web
```

控制台默认把定时任务写入 dsh-cron 的持久化 store：`$DSH_HOME/cron/jobs.json`
（与 `@cofy-x/dsh-cron` 的 v2 文件格式、seq sidecar、写锁协议对齐，插件热重载外部变更）。
控制台重启后：先取消旧计划再重建（`POST /api/schedule/cancel` 会把旧 job 从 store 移除）。

### 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `3210` | 监听端口 |
| `HOST` | `127.0.0.1` | 监听地址（建议保持本机回环） |
| `CRON_DATA_DIR` | `$DSH_HOME/cron` | dsh-cron store 目录；**生产环境不要设置**，保持默认让 dsh-cron 插件读取 |
| `TOMATO_WRITER_MCP_ROOT` | `../tomato-writer-mcp` | tomato-writer-mcp 项目根 |
| `TOMATO_AUTO_STATE_DIR` | `./state` | 应用状态目录（含 Cookie 与 API Key，勿外传） |

### 定时任务的工作方式

- 计划创建时，控制台向 dsh-cron store 写入一个每日 cron job（表达式 `m H * * *`，IANA 时区）；
- dsh-cron 到点把 occurrence 提交给 dsh-automation，生成一个 fresh DSH Session；
- 该会话按 job prompt 回调 `POST http://127.0.0.1:3210/api/publish/fire`（`{"trigger":"cron"}`）；
- 控制台用 tomato-writer-mcp 的 `publishChapter`（建草稿 + publish_article）逐章发布，并记录日志。
- 番茄侧为**到点立即发布**（不使用预约）；每天至多触发一次（`lastFireAt` 幂等闸门）。

## 目录结构

```
tomato-auto-web/
├── server.mjs            # 零依赖 HTTP 后端（路由 + 编排 + 看门狗）
├── lib/
│   ├── agent.mjs         # Agent API 适配器（OpenAI 兼容）
│   ├── fanqie.mjs        # 番茄热门榜取数（fenxi 工作流第 1-6 步 + 字体混淆还原）
│   ├── prompts.mjs       # fenxi / du-nai 技能提示词组装与结果解析
│   ├── cron-store.mjs    # dsh-cron store v2 外部写入器（锁 + sidecar + 合并）
│   ├── cron-next.mjs     # 五段 cron 解析 + IANA 时区下次触发（与 dsh-cron 语义对齐）
│   ├── tomato.mjs        # tomato-writer-mcp dist 模块桥（热读鉴权）
│   ├── publish.mjs       # 发布执行器（幂等闸门 + 看门狗）
│   ├── tasks.mjs         # 异步任务队列
│   └── state.mjs         # 状态存储（脱敏对外）
├── public/               # 前端（index.html / app.js / style.css）
├── skills/               # fenxi / du-nai 技能指令副本（随应用分发）
├── scripts/
│   ├── start.ps1         # 启动脚本
│   └── smoke.mjs         # 不依赖 LLM/番茄的链路冒烟测试
└── state/                # 运行时状态（.gitignore，含敏感信息）
```

## 注意事项

- 番茄鉴权 Cookie 约 1-2 个月失效，失效后在弹窗里重新粘贴即可（不重启服务立即生效）。
- 榜单接口为公开接口，若被反爬拦截会自动降级抓 HTML；字体混淆的书名会逐本打开书籍页还原，报告中注明数据来源与缺口。
- 发布走番茄真实接口，正式发布仍受平台内容审核；请遵守番茄平台规则。
- `skills/` 下的技能指令来自本地 skill 目录副本，若上游 skill 更新可重新复制同步。
- 已知限制：章节生成依赖 Agent API 质量；一次最多生成 5 章；已发布章节不可编辑/删除。
