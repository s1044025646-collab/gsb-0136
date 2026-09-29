# 零件寿命试验：Kaplan–Meier 生存曲线与删失分析后端

仅包含 **API、CLI、合成零件寿命数据生成器和自动化测试** 的本地后端。不提供网页、不做医疗诊断、不连接真实试验设备。

适用范围刻意收窄：**无延迟入组、独立、单次事件** 的右删失数据（不支持竞争风险 / 复发事件，导入时会被拒绝）。

## 统计方法（公开一致的规则）

- **Kaplan–Meier 乘积极限**：`S(t)=∏(1−dᵢ/nᵢ)`。
- **并列时刻规则**：同一时刻既有事件又有删失时，**先计事件**；删失个体在该时刻仍在风险集中，事件步之后才离开。**删失永不计为失败**。
- **Greenwood 方差**：`G=Σ dᵢ/(nᵢ(nᵢ−dᵢ))`，`SE(S)=S·√G`。
- **置信区间（两种显式方法）**：`log-log`（默认，对 `log(−log S)` 变换后 95% 区间）或 `linear`（`S±1.96·SE`，裁剪到 [0,1]）。
- **中位生存期**：取满足 `S(t)≤0.5` 的最小事件时刻；**曲线未降到一半时报告“未达到”，绝不用最大观察时间冒充**。
- **RMST（限制平均寿命）**：`[0,τ]` 上阶梯曲线下面积；`τ` 超过最大观察时间直接报 `TAU_TOO_LARGE`，不外推。
- **两组 log-rank**：逐事件时刻给出风险数 `n1,n2`、事件数 `d1,d2`、期望数 `E=d·n1/n` 与超几何方差项；明确处理零方差（`ZERO_VARIANCE`）、全删失（`ALL_CENSORED`）、缺失分组（`GROUP_MISSING`）。
- 组间比较只允许在**同一冻结快照**内进行，因此不可能混用时间单位或观察口径；跨数据集拼接会被服务层拒绝（`UNIT_MISMATCH`）。

## 数据版本与冻结报告

- 数据集每次导入生成不可变版本（`dataset_versions`），分析与比较只读取冻结快照；
  修订终点 / 更正事件状态 → 提交新版本，旧版本与旧报告保持不变。
- 重复提交相同内容是**幂等**的（内容 SHA-256 命中即返回同一版本；相同分析参数复用分析行并追加冻结报告）。
- 所有写操作包在 `BEGIN IMMEDIATE` 事务中，失败回滚。

## 依赖

- Node.js **>= 22.5**（使用内置 `node:sqlite`，无需原生编译；本仓库在 Node 25 上验证）
- TypeScript + `tsx`（devDependency），安装：

```powershell
npm install
```

## 测试

```powershell
npm test
```

覆盖：无删失 / 全删失 / 事件删失并列 / 零时刻事件 / 曲线交叉与不交叉 / 极小样本的夹具；
手算小例核对阶梯值、Greenwood、RMST 面积、log-rank 统计量；
风险集递减、区间边界、重复导入幂等、事务回滚、重启复现；
API 分页、错误码、失败路径；CLI 完整工作流；生成器可重复性。

类型检查：`npm run build`。

## 启动（仅绑定本机，自动端口）

```powershell
npm start
```

输出形如 `{"status":"listening","host":"127.0.0.1","port":54824,...}`，端口写入 `data/server.port`。
只监听 `127.0.0.1`，端口由操作系统自动分配（`listen(0)`）。数据库默认 `data/lifetable.sqlite`，
可用环境变量 `LIFETABLE_DB` 指定其它**本项目内**路径。

停止：在运行窗口按 `Ctrl+C`（收到 SIGINT/SIGTERM 会关闭数据库并退出）。
可用 PowerShell 停止本项目启动的进程：

```powershell
Get-Content data/server.port | ForEach-Object { Get-NetTCPConnection -LocalPort $_ -State Listen } |
  Select-Object -ExpandProperty OwningProcess -Unique | Stop-Process
```

## 可复现端到端演示

```powershell
npm run demo
```

演示在进程内启动临时本机服务、用固定种子 `2026` 生成合成轴承寿命、导入为冻结 v1、
做 KM + RMST、做两组 log-rank、更正一个终点生成 v2，并展示一个预期失败码（`TAU_TOO_LARGE`）。
所有产物落在 `data/demo/`，重复运行数值完全一致，结束后服务自动关闭。

## CLI

```powershell
# 生成合成数据（名称:数量:事件率[:删失概率]），固定种子保证可重复
npm run cli -- generate control:12:0.08:0.2 treated:12:0.03:0.2 --seed 7 --out data/parts.csv

# 导入并校验（操作前后均打印状态；重复导入幂等）
npm run cli -- import --file data/parts.csv --name bearings --unit hours

# 生存曲线 + Greenwood + 95% CI + 中位数 + RMST，导出冻结报告 JSON
npm run cli -- curve --dataset bearings --group control --ci log-log --tau 10 --out data/km.json

# 逐时刻风险表（风险数/事件数/删失数）
npm run cli -- risk-table --dataset bearings

# 两组 log-rank（观察数/期望数/方差/卡方/p 值）
npm run cli -- compare --dataset bearings --group1 control --group2 treated

# 解释删失影响（删失比例、尾部删失、原因分布、非信息性删失假设）
npm run cli -- censoring --dataset bearings --group treated
```

CSV 表头：`subjectId,group,time,event,censorReason`，其中 `event` 取 `1/0`（或 `true/false`）。
也可用 `--version <id>` 直接针对任意冻结快照。

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查 |
| GET | `/datasets?limit=&offset=` | 分页列出数据集 |
| POST | `/datasets` | 创建（请求体校验，重名 → `CONFLICT`） |
| GET | `/datasets/{id}` | 数据集与最新版本 |
| GET | `/datasets/{id}/versions?limit=&offset=` | 分页列版本 |
| POST | `/datasets/{id}/versions` | 修订 → 新冻结版本 |
| GET | `/versions/{id}/rows?limit=&offset=` | 分页查看快照行 |
| POST | `/versions/{id}/analyses` | `{group, ci?, tau?}` KM 分析并冻结报告 |
| POST | `/versions/{id}/comparisons` | `{group1, group2}` log-rank 并冻结报告 |
| GET | `/reports?limit=&offset=` | 分页列冻结报告 |
| GET | `/reports/{id}` | 读取冻结报告 |

错误响应统一为 `{"error":{"code","message","details"}}`，错误码：
`VALIDATION`、`NOT_FOUND`、`CONFLICT`、`EMPTY_GROUP`、`ALL_CENSORED`、`ZERO_VARIANCE`、
`GROUP_MISSING`、`TAU_TOO_LARGE`、`MEDIAN_NOT_REACHED`、`UNIT_MISMATCH`、`INTERNAL`。

## 清理

只删除本项目自身产物：`data/`（SQLite、WAL、导出报告、端口文件）与 `node_modules/`、`dist/`。
停止命令如上，只针对 `data/server.port` 记录的本项目监听端口。
