# 免责声明 / Disclaimer

**最后更新：2026-09-14**

> 本文档是使用 RankWeaver（下称"本项目"）的前提条件。**开始使用即表示你已完整阅读、理解并同意以下全部条款；若不同意任何一条，请立即停止使用并删除本项目的全部副本。**

---

## 1. 项目性质

本项目是一个**非官方的、开源的技术学习与个人自动化研究项目**，用于演示"榜单题材分析 → 大纲 → 章节 → 定时发布"这条流水线的工程实现方式：

- 本项目**不是**番茄小说（fanqienovel.com）的官方产品，与番茄小说及其运营方、关联公司**不存在任何隶属、合作、赞助、代理或授权关系**。
- 本项目**不提供、不代管、不收集**任何番茄账号、Cookie、API Key、稿件或读者数据。
- 本项目**不包含**任何风控绕过、签名逆向、验证码破解或批量注册能力；它使用的是浏览器登录后自身可见的公开页面与作家后台自身的接口，鉴权凭据由使用者自行从自己的浏览器中获取。
- 本项目中的"定时发布""自动生成"等能力，均由使用者在自己机器上运行，并由使用者自行决定是否实际使用。

---

## 2. 使用者的责任与义务

使用本项目，即表示你确认并同意：

1. 你已阅读并遵守**番茄小说平台**的用户协议、平台规则、作者合约与内容规范，以及你所在司法辖区的法律法规；
2. 你对所发布的内容拥有合法权利或已获得充分授权；**不得抄袭、洗稿、复制他人作品**——本项目在生成大纲时也明确要求仅借鉴题材规律，不复刻他人作品的具体人物、世界观、桥段、台词与专有名词，请你同样遵守；
3. 若你发布的内容由 AI 生成或经 AI 辅助生成，你应按照平台要求与当地法律履行**人工智能生成内容标识**等合规义务；
4. 你自行承担所发布内容引发的全部责任（包括但不限于内容合规、著作权、名誉权等纠纷）；
5. 你**不得**将本项目用于批量注册、垃圾内容、刷量、虚假数据、恶意占用平台资源、规避平台风控或其他违反平台规则与法律法规的用途；
6. 你自行负责账号安全与凭据保管，并自行承担由此产生的一切后果。

---

## 3. 数据与隐私

- 所有敏感数据——番茄 `Cookie` 与 `X-Secsdk-Csrf-Token`、你配置的 Agent API Key、生成的大纲与章节手稿、运行状态——**仅保存在你本机**（默认位于 `tomato-auto-web/state/` 与 `tomato-writer-mcp/.env`）。
- 本项目**不含任何遥测、上报或云端存储逻辑**，作者无法、也不会获取上述数据。
- 上述文件已在 `.gitignore` 中排除。**请勿将其提交到任何公开仓库或分享给他人**：`Cookie` 等价于登录态，一旦泄露即等同于账号被他人控制，后果由你自行承担。
- 控制台默认仅监听 `127.0.0.1`。**请勿将其暴露到公网**，本项目未内置任何身份认证。

---

## 4. 第三方服务与组件

- **番茄作家后台接口**：属于非公开、非承诺稳定的接口。平台可能随时调整、限流、校验或封禁相关调用；由此导致的功能失效、数据异常或账号影响，本项目不承担责任。
- **模型接口（Agent API）**：由你自行选择与配置。其可用性、内容政策、数据使用方式与费用，均取决于你与该服务提供方之间的约定，与本项目无关。
- **第三方开源组件**：本项目包含或依赖的第三方组件（如 `tomato-writer-mcp`、`@cofy-x/dsh-cron`、`dsh-automation` 等）版权归各自作者所有，遵循其各自的许可证。
- **技能指令文件**：`tomato-auto-web/skills/` 下的技能指令来自其各自来源，版权归原作者所有。

---

## 5. 风险提示（请务必阅读）

| 风险 | 说明 |
|---|---|
| **账号风险** | 自动化调用平台接口可能触发风控，导致限流、内容下架、功能限制、账号处罚乃至封禁。 |
| **内容风险** | AI 生成内容可能存在事实错误、逻辑矛盾、设定前后不一致，甚至与他人作品雷同；**发布前必须由你自行审核**。 |
| **凭据风险** | `Cookie` / `Csrf-Token` 等价于账号登录态，泄露即等于账号失守。 |
| **数据风险** | 本地状态文件损坏、误删或磁盘故障可能导致大纲与手稿丢失，请自行备份。 |
| **成本风险** | 模型调用按量计费，长篇生成可能产生可观费用，请自行留意用量。 |
| **合规风险** | 不同司法辖区对 AI 生成内容、自动化发布、数据抓取的规定不同，请自行确认并遵守当地法律。 |

---

## 6. 无担保与责任限制

本项目按**"现状"（AS IS）**提供，不附带任何明示或暗示的担保，包括但不限于对适销性、特定用途适用性、不侵权以及无中断、无错误的担保。

在适用法律允许的最大范围内，本项目的作者与贡献者**不对你或任何第三方**因使用或无法使用本项目而产生的任何直接、间接、附带、特殊、惩罚性或后果性损失承担责任，包括但不限于：账号封禁或处罚、内容下架、收益损失、数据丢失、凭据泄露、名誉损害及第三方索赔。

你是否使用本项目、以及如何使用，完全由你自行判断并承担全部风险。

---

## 7. 许可

本项目以 **MIT** 许可证开源。本免责声明是使用本项目的前提条件，其效力不因许可证的宽松性而减弱：**如你不同意本文档的任何条款，请立即停止使用并删除本项目的全部副本。**

---

## 8. 变更

本免责声明可能随项目演进而更新，最新版本以仓库中的本文件为准。继续使用即视为接受更新后的条款。

## 9. 其他

本文档**不构成法律意见**。如涉及具体法律问题，请咨询具备相应资质的专业律师。

---

## English Summary

This is a condensed summary for convenience only; **the Chinese text above prevails**.

RankWeaver is an **unofficial, open-source project for technical study and personal automation**. It is **not affiliated with, endorsed by, or connected to Fanqie Novel (fanqienovel.com)** or its operators.

- **You are solely responsible** for complying with the Fanqie platform's terms, rules and content policies, with applicable AI-generated-content labeling requirements, and with the laws of your jurisdiction.
- Do not use it for plagiarism, bulk registration, spam, artificial traffic, or any attempt to circumvent platform risk controls.
- All credentials (cookies, API keys) and generated manuscripts stay **on your own machine**; the project collects nothing. Never commit them to a public repository — a leaked cookie equals a hijacked account.
- Fanqie's backend APIs are **unofficial and may change or block access at any time**; account penalties, content takedown, data loss and model costs are **your** risk.
- The software is provided **"AS IS", without warranty of any kind**. To the maximum extent permitted by law, the authors accept **no liability** for any damages arising from its use.
- Using this project means you accept this disclaimer in full. If you disagree, stop using it and delete all copies.
