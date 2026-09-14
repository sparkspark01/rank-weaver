# RankWeaver

> 番茄小说自动化运营控制台：**榜单题材分析 → 大纲 → 章节 → 定时发布** 一条流水线跑通。

RankWeaver 把一个本地 Web 控制台、一个番茄作家后台 MCP 服务端，以及 DeepSeek Harness 的
持久化调度能力（dsh-cron + dsh-automation）串在一起：你只管点按钮、填剧情、确认内容，
剩下的选题分析、章节撰写与到点发布全部自动完成。

---

## 目录

- [快速开始](#快速开始)
- [功能与工作流](#功能与工作流)
- [架构](#架构)
- [目录结构](#目录结构)
- [配置](#配置)
- [定时发布链路](#定时发布链路)
- [自检与验收脚本](#自检与验收脚本)
- [常见问题](#常见问题)
- [已知限制](#已知限制)

---

## 快速开始

前置：**Node.js 18+**（推荐 24）、Windows PowerShell。

```powershell
# 1. 启动控制台（零依赖，无需安装任何包）
cd D:\RankWeaver\tomato-auto-web
node server.mjs
```

或者直接**双击** `tomato-auto-web\启动控制台.bat`（会自动打开浏览器）。

浏览器访问 <http://127.0.0.1:3210>，然后按页面顶部的**引导步骤条**依次完成 6 步即可。

> 控制台本身零依赖，只读取 `tomato-writer-mcp/dist/`（不依赖其 `node_modules`）。
> 仅当需要独立运行 tomato-writer-mcp 的 MCP 服务端（例如接到 Claude Code / DSH MCP 桥）时，
> 才需要先执行 `cd D:\RankWeaver\tomato-writer-mcp; pnpm install; pnpm run build`。

---

## 功能与工作流

页面顶部有 6 步引导条，当前该做哪一步会高亮；首次打开会按依赖顺序自动弹出对应配置弹窗。

| 步骤 | 功能 | 使用的技能/组件 |
|---|---|---|
| 1 | 配置 **Agent API**（OpenAI 兼容 `/chat/completions`） | — |
| 2 | 配置**番茄作家后台鉴权**并选择目标小说 | tomato-writer-mcp |
| 3 | **推荐**：生成番茄热门题材分析与新书指南 | `fenxi` skill |
| 4 | **生成**：按你的剧情做榜单匹配评估并产出大纲（不匹配则给疑问清单），确认大纲 | `fenxi` skill |
| 5 | **章节**：按大纲逐章生成正文，查看/编辑/确认 | `du-nai` skill |
| 6 | **定时发布**：设置每天发布时刻与章数，写入 dsh-cron 计划，到点自动发布 | dsh-cron + tomato-writer-mcp |

三点说明：

- **技能由 Agent API 执行**：`fenxi` / `du-nai` 的完整技能指令随应用分发在 `tomato-auto-web/skills/`，
  控制台把它们组装成请求发给你自己配置的模型接口，不依赖任何固定厂商。
- **榜单数据由控制台自己抓**：请求番茄连载榜接口（`creation_status=1&sort=0`，前 20 本），
  接口不可用时降级抓榜单 HTML；书名出现字体混淆（私有区字符）时逐本打开书籍页还原，
  报告里会注明数据来源与缺口。
- **发布前必须人工确认**：章节生成后处于「待确认」，只有你确认过的章节才会进入发布队列。

---

## 架构

```
┌──────────────────────────── 浏览器 ────────────────────────────┐
│  RankWeaver 控制台（原生 HTML/CSS/JS，6 步引导 + 三张功能卡）    │
└───────────────────────────────┬────────────────────────────────┘
                                │  REST（127.0.0.1:3210）
┌───────────────────────────────▼────────────────────────────────┐
│  tomato-auto-web 后端（Node 零依赖 http 服务）                  │
│  ├─ lib/agent.mjs     Agent API 适配（OpenAI 兼容）            │
│  ├─ lib/fanqie.mjs    番茄榜单取数 + 字体混淆还原               │
│  ├─ lib/prompts.mjs   fenxi / du-nai 技能提示词与结果解析       │
│  ├─ lib/cron-store.mjs  dsh-cron store v2 直写（锁 + seq 侧车） │
│  ├─ lib/cron-next.mjs   五段 cron + IANA 时区下次触发计算       │
│  ├─ lib/tomato.mjs   桥接 tomato-writer-mcp 的 dist 模块        │
│  ├─ lib/publish.mjs  发布执行器（幂等闸门 + 看门狗兜底）        │
│  └─ lib/state.mjs    状态存储（对外脱敏）                      │
└───────┬───────────────────────┬────────────────────┬──────────┘
        │ 写入 jobs.json        │ 调用 dist 模块      │ 读写 state/
┌───────▼───────────────┐ ┌─────▼──────────────────┐ ┌▼──────────────┐
│ dsh-cron（DSH 插件）  │ │ tomato-writer-mcp      │ │ state/        │
│ + dsh-automation      │ │ （番茄作家后台 HTTP）  │ │ 配置/鉴权/手稿 │
│ 每天到点 → fresh 会话 │ └─────┬──────────────────┘ └───────────────┘
└───────┬───────────────┘       │
        │ 定时会话回调           │ 发布章节
        │ POST /api/publish/fire │
        └────────────────────────┴──────────► fanqienovel.com 作家后台
```

关键设计：**发布入口只有一个**。dsh-cron 定时会话、看门狗兜底、页面「立即发布」三条路径
都汇聚到 `POST /api/publish/fire`，由同一个幂等闸门（按天 + 按章节状态）决定实际发布内容，
因此不会重复发布。

---

## 目录结构

```
D:\RankWeaver
├── README.md                    ← 本文件（项目级说明）
├── DISCLAIMER.md                ← 开源免责声明（使用前必读）
├── .gitattributes               ← 行尾规则：Windows 脚本（.bat/.cmd/.ps1）强制 CRLF
├── tomato-auto-web/             ← RankWeaver 控制台（主体）
│   ├── server.mjs               后端：路由 + 编排 + 看门狗
│   ├── lib/                     后端模块（见上方架构图）
│   ├── public/                  前端：index.html / app.js / style.css
│   ├── skills/                  fenxi、du-nai 技能指令副本（随应用分发）
│   ├── scripts/                 启动与自检脚本
│   ├── state/                   运行时状态（含鉴权与 API Key，已 gitignore，不进版本库）
│   ├── 启动控制台.bat           双击启动
│   └── README.md                控制台组件级文档（含前端约定）
└── tomato-writer-mcp/           ← 番茄作家后台 MCP 服务端
    ├── src/                     源码（client / config / content / service / tools）
    ├── dist/                    构建产物（**已收录进版本库**，27 个文件 / 约 46 KB）
    └── README.md                上游组件文档
```

> **关于 `dist/`：clone 后无需构建即可运行。**
> 编译产物被有意提交进版本库——控制台运行时由 `lib/tomato.mjs` 直接 `import` `dist/tomato/*.js`，
> 因此拉取仓库后直接 `node server.mjs` 就能用，不需要 `pnpm install`，也不需要 `pnpm build`。
> 只有需要**独立启动 MCP 服务端**（`node dist/index.js`，依赖 `@modelcontextprotocol/sdk`）时，
> 才需要在该目录安装依赖并重新构建。若你不想提交构建产物，可按
> `tomato-writer-mcp/.gitignore` 中的注释还原忽略规则，并执行 `git rm -r --cached tomato-writer-mcp/dist`。

---

## 配置

### Agent API（第 1 步）

任意 OpenAI 兼容接口，页面弹窗填写并「测试并保存」：

| 字段 | 示例 | 说明 |
|---|---|---|
| baseUrl | `https://api.deepseek.com` | 可带或不带 `/v1`，会自动补 `/chat/completions` |
| apiKey | `sk-...` | 仅存本机 `state/config.json`，接口返回时始终掩码 |
| model | `deepseek-chat` | 建议选长上下文模型（章节生成会带完整文风画像） |

### 番茄作家后台鉴权（第 2 步）

浏览器登录 `fanqienovel.com` 作家后台 → F12 → Network → 任选一个 `/api/author/...` 请求 →
复制完整 `Cookie` 头与 `X-Secsdk-Csrf-Token` 头，粘贴进弹窗验证。验证通过后会：

- 保存到 `state/auth.json`（明文仅存本机，接口只回掩码）
- 镜像写入 `tomato-writer-mcp/.env`，方便独立的 MCP 服务端复用
- 自动加载书单，选择发布目标（账号只有一本时自动选中）

Cookie 有效期约 1–2 个月，失效后在弹窗重新粘贴即可，**不需要重启服务**。

### 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `3210` | 监听端口 |
| `HOST` | `127.0.0.1` | 监听地址（建议保持本机回环） |
| `CRON_DATA_DIR` | `$DSH_HOME/cron` | dsh-cron 任务库目录；**生产环境不要设置**，保持默认才能被 dsh-cron 插件读取 |
| `TOMATO_WRITER_MCP_ROOT` | `../tomato-writer-mcp` | tomato-writer-mcp 项目根 |
| `TOMATO_AUTO_STATE_DIR` | `./state` | 状态目录（含敏感信息） |

---

## 定时发布链路

```
① 页面创建计划（每天 HH:MM、每天 N 章）
    └─ 控制台按 dsh-cron store v2 格式写入 <CRON_DATA_DIR>/jobs.json
       （跨进程写锁 + seq 侧车，插件通过轮询热重载外部变更）
② 到点：dsh-cron 把 occurrence 提交给 dsh-automation
    └─ 拉起一个 fresh DSH 会话，按 job prompt 执行
③ 定时会话回调 POST http://127.0.0.1:3210/api/publish/fire {"trigger":"cron"}
    └─ 控制台校验幂等闸门（当天是否已触发 / 章节状态）
④ 控制台用 tomato-writer-mcp 的 publishChapter（建草稿 + publish_article）逐章发布
    └─ 成功后章节标记为「已发布」，写入运行日志
```

- **看门狗兜底**：若某天定时会话没能触达控制台，看门狗会在触发时间 +5 分钟后补发，
  同样经过幂等闸门，不会重复发布。
- **失败即停**：某一章发布失败会立刻停止当天批次并记日志，避免连环脏数据。
- **取消计划**会把对应 job 从 dsh-cron store 中移除。

### dsh-cron 安装状态

已按官方方式装进 DSH 的 web profile：

```powershell
dsh plugin --profile web add dsh-automation@next     # 0.2.0-alpha.1
dsh plugin --profile web add @cofy-x/dsh-cron        # 0.8.0-alpha.4
```

⚠️ 插件生命周期是 restart-profile，**改动后需要重启一次 DSH Web 才生效**：

```powershell
# 关闭当前 dsh web 进程后重新启动
dsh web
```

---

## 自检与验收脚本

```powershell
cd D:\RankWeaver\tomato-auto-web

node scripts/check-frontend.mjs    # 前端静态检查：DOM id 交叉核对、阻塞式 API 残留、弹窗显示机制
node scripts/test-prompts.mjs      # 技能提示词组装与结果解析器自测
node scripts/smoke.mjs             # 调度链路冒烟（需先启动服务）
node scripts/verify-ui.mjs <dom>   # 渲染后 DOM 验收：首屏弹窗数量、引导顺序、步骤条状态
```

`verify-ui.mjs` 需要一份渲染后的 DOM，可用无头浏览器导出：

```powershell
& "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --headless --disable-gpu `
  --user-data-dir="$PWD\state\edge-profile" --virtual-time-budget=6000 `
  --dump-dom "http://127.0.0.1:3210" | Out-File -Encoding utf8 state\dom.html
```

---

## 常见问题

| 现象 | 原因与处理 |
|---|---|
| 双击 `.bat` 窗口一闪而过 | 用命令行 `node server.mjs` 启动可看到具体报错；常见为 Node 未加入 PATH |
| 提示端口被占用 | 换端口：`$env:PORT=3211; node server.mjs`，然后访问 `http://127.0.0.1:3211` |
| 页面显示「无法连接控制台后端服务」 | 启动窗口已关闭，重新双击 `启动控制台.bat` |
| 番茄鉴权验证失败 | Cookie/CSRF 复制不全或已过期，重新抓一次；两者必须同时填 |
| 到点没有自动发布 | 依次检查：dsh-cron 是否已随 `dsh web` 重启激活 → 控制台服务是否在运行 → 日志里是否有「看门狗」记录 |
| 想手动补发 | 页面「立即发布已确认章节」，或 `curl -X POST http://127.0.0.1:3210/api/publish/fire` |
| 榜单抓取报错 | 接口被反爬拦截时会自动降级抓 HTML；仍失败则检查网络，或在日志中查看具体原因 |

---

## 已知限制

- 章节生成一次最多 5 章（逐章串行生成以保证与前文连贯）；**已发布章节不可编辑或删除**。
- 发布走番茄真实接口，正式发布仍受平台内容审核；请遵守番茄平台规则。
- dsh-cron 仍为 alpha 版本；其浏览器任务中心声明 peer `react@^18`，而当前 profile 是 react 19，
  安装时有 peer 警告，可能影响该面板渲染（不影响调度链路本身）。
- 控制台默认只监听回环地址、无鉴权，**请勿暴露到公网**；`state/` 内含明文鉴权与 API Key。
- 榜单与热度数据随时间变化，报告中的日期与来源会一并标注，不具备长期有效性。

---

## 免责声明

本项目是**非官方的技术学习与个人自动化研究项目**，与番茄小说及其关联公司不存在任何隶属、合作或授权关系。
使用前请务必阅读 **[`DISCLAIMER.md`](DISCLAIMER.md)**：其中包含使用者义务、账号与内容风险、
凭据与数据安全、第三方服务说明，以及无担保与责任限制条款。**不同意者请勿使用。**

## 相关文档

- 使用风险与法律免责声明：`DISCLAIMER.md`
- 控制台组件细节与前端约定：`tomato-auto-web/README.md`
- 番茄作家后台接口封装与 MCP 工具：`tomato-writer-mcp/README.md`
- dsh-cron 上游仓库：<https://github.com/cofy-x/dsh-cron>

## 许可证

MIT（若仓库根目录尚无 `LICENSE` 文件，请按 MIT 全文补充后再分发）
