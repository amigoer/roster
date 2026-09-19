# Roster 设计文档

按主题分册。每册开头一行写它属于哪一轮、最近一次改在什么时候；决定和理由写在一起，改主意时改原文，不另开「变更记录」。

| 文档 | 讲什么 |
|---|---|
| [总体设计](design.md) | 定位、IM 形态、bot = 联系人、群 = agent team、三列布局、界面语言、技术选型、核心原则、第一版不做 |
| [底层执行器](harness.md) | harness / agent / 模型来源的层级，适配器作为扩展，设置页，两个后端的控制面，事件模型 |
| [接入更多 ACP agent](acp-agents.md) | 下一批 harness：Cursor、Kimi Code、DeepSeek Harness、ZCode 的现状，ACP 通道要补的几件事，先后与接入清单 |
| [移动端](mobile.md) | 手机作为 core 的第二个客户端：窄屏布局、原生壳、只验 iPhone、直连与中继、配对与鉴权、推送、账号与订阅 |
| [路线图](roadmap.md) | 里程碑和每个的「做完的标志」；不排日期 |

## 轮次

- **第一轮** · 2026-09-12 —— 桌面本体：总体设计、底层执行器
- **第二轮** · 2026-09-17 —— 移动端：直连、中继、官方 app、订阅、推送（路线图 M1 到 M7）；补上已定的事件模型
- **第三轮** · 2026-09-19 —— 更多 agent：接入 Grok Build，规划 Cursor、Kimi Code、DeepSeek Harness、ZCode（路线图 A1 到 A4）
