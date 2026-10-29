# MAP — Volcano Separator 的工程地图

系统活动的观察者与保管者。它看得见进程与持久化的变化，能冻结、能保管，并按策略决定要不要动手。

文件职责按名字可读，下面的描述以代码结构与文档为准；凡标注「按名字」的，是对该文件用途的直读，不是对它内部实现细节的断言。

## 顶层目录

```
bin/                入口与 PowerShell 端点
  cli.mjs           命令行总入口（status / heal / doctor / mcp / activity / …）
  panel.json        窗口用面板定义
  activity-watch.ps1 · activity-task.vbs   活动记录器与它的计划任务包装
  guard-task.vbs    任务包装
  detaain/isolate/keyprotect/reveal/chamber/livestate/procinfo/redact/resolve-path/pixelfont.ps1
                    各动作的系统端实现
lib/                运行时模块（22 个 .mjs）
test/               smoke.mjs · syntax.mjs · commands.mjs
.github/workflows/  CI（push 与 pull request 触发）
CHANGELOG.md · DESIGN-enforcement.md · HANDOVER.md · RULES.md · TODO.md · README.md
package.json        零 dependencies；engines.node >= 20.12
```

## 模块职责（按名字直读）

```
core.mjs         核心装配
service.mjs      服务描述符：一个服务是可以被读取、被质疑、被替换的值
supervisor.mjs   守护端：启动、监视、恢复
activity.mjs     全系统活动记录（进程起止、窗口标题、持久化面变更）
live.mjs         活动面（按名字）
entity.mjs       「关于一个 pid / 路径 / 端口所知道的一切」
signals.mjs      信号判定与 promotion gate 的测量
policy.mjs       策略加载与模式（默认 observe）
rules.mjs        规则集
enforce.mjs      执行层（当前接线未完成，见 TODO 第 118 行）
custody.mjs      保管：冻结与解冻的记账
vault.mjs        手工保管（会移动文件的那一类动作）
crypt.mjs        临时加密
lock.mjs         并发保护
database.mjs     持久化
commandline.mjs  命令行解析
resources.mjs    资源状况
redline.mjs      用户可写空间的扫描
uvcache.mjs      uv 缓存的清理计划
platform.mjs     平台差异
chamber.mjs      窗口（「寝宫」）—— 承载可视化的那一个
mcp.mjs          MCP 表面（只读工具集）
```

## 数据流

```
系统事件（进程/窗口/持久化面）
  -> activity.mjs 记录 -> 持久化
  -> signals.mjs 判读 -> 信号（含 promotion gate 的四项测量）
  -> policy.mjs 决定姿态（默认 observe）
  -> enforce.mjs 若接线完成则动手；当前未接线
  -> vault / custody / chamber：保管、冻结、可视化
```

## 入口与命令

```
node bin/cli.mjs status | doctor | heal | reconcile
node bin/cli.mjs mcp            # MCP 表面
npm run test / syntax / status / heal / doctor / mcp
```

## 测试与验证

`test/` 三个文件：`smoke.mjs`（冒烟）、`syntax.mjs`（语法与结构）、`commands.mjs`（命令解析）。它们用 `node` 直接跑，不依赖任何 npm 包 —— 这也是零依赖承诺的一部分。

本机纪律：**在会话里不要启动它、不要调用它的工具、不要跑它的脚本**。改完之后由人决定何时启用。

## 边界

只读优先：`mcp` 暴露的是只读工具集。默认 `observe` 模式，任何动作都需要经过 promotion gate。**执行能力（enforce）尚未接线** —— TODO 第 118 行记着它不卡在代码，卡在真实样本从未触发过 `ask`。

## 发布

GitHub 仓库 `Nesarf/volcano-separator`，tag 与 CHANGELOG 记录版本（当前 1.5.0）。没有 PyPI 包；它是本机工具，随仓库使用。
