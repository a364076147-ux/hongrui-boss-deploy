# hongrui-boss-deploy

宏瑞BOSS 门店管理系统 —— **后端唯一发布源**。

- 发布链路：本仓库 → GitHub（main）→ Render
- 线上地址：https://hongrui-boss-erp-api.onrender.com
- 数据库：Supabase Postgres（transaction pooler，端口 6543）
- 前端：https://hongrui.site.accio.ai （Accio 托管，与本仓库无关）

---

## ⚠️ 改前必读

1. **本仓库是后端唯一发布源。**
   `BUSINESSES/HONGRUI/hongrui-boss/server-supabase.ts` 是**开发源副本，无 git，且已与线上分叉**，
   它的成本 SQL 把「毛利」当成「成本」、且未排除作废单。
   **从那里重新部署会把线上已正确的利润模块改坏。** 该文件已在头部加了醒目警示。

2. **任何后端改动一律在本仓库修改并提交**，不要改 `hongrui-boss/`。

3. **凭据只走 Render 环境变量。**
   本仓库是**公开仓库** —— 不仅禁止硬编码真实凭据，**连"示例值 / 历史旧值 / 待轮换值"也不得出现在任何文件里（含文档）**。
   需要记录轮换状态时，写"已轮换 / 未轮换"，不要写值。

4. **不要提交 `.env`、`.token`、`*.secret`、`verify.sh`、`push.sh`**（已在 `.gitignore`）。

---

## 发布流程

> ⚠️ **推送成功 ≠ 部署完成。** 平台侧的 Auto-Deploy 可能处于关闭状态，
> 此时 `git push` **不会**产生任何部署，而线上不会有任何提示。

正确链路：

```bash
git add -A && git commit -m "..."
git push origin main
node _localtest/trigger-render-deploy.cjs     # 显式触发 Render 部署（免费层构建 8~20 分钟）
# 然后轮询目标端点，直到它从 404 变为非 404，才算真正上线
```

**唯一判据是「线上目标路由/产物真的变了」**，而不是"推送命令没报错"。超时即判失败。

---

## 环境变量（在 Render 控制台注入）

| 变量 | 必需 | 说明 |
|---|---|---|
| `JWT_SECRET` | ✅ | JWT 签名密钥。**缺失则后端拒绝启动。** |
| `PG_PASSWORD` | ✅ | Supabase 数据库密码。**缺失则后端拒绝启动。** |
| `PG_HOST` | 可选 | 默认 `aws-0-ap-southeast-1.pooler.supabase.com` |
| `PG_PORT` | 可选 | 默认 `6543`（transaction pooler） |
| `PG_DB` | 可选 | 默认 `postgres` |
| `PG_USER` | 可选 | 默认 `postgres.<项目ref>` |
| `PORT` | 可选 | 默认 3001 |

> 具体取值只在 Render 控制台与本机 `.env` 中维护，**不写入本仓库**。

---

## 部署与回滚

- 推送 `main` 后按上面的「发布流程」显式触发部署
- 回滚：Render 控制台 → Deploys → 选择上一个正常版本 → Redeploy
- 数据库备份：见 `BUSINESSES/HONGRUI/_governance/backup/`（全量数据 + schema + 策略 + ACL + 一键恢复脚本）
- 自动备份：`_governance/daily-backup.cjs`（每日运行、30 份滚动保留、失败写告警文件）
