# hongrui-boss-deploy

宏瑞BOSS 门店管理系统 —— **后端唯一发布源**。

- 发布链路：本仓库 → GitHub（main）→ Render 自动部署
- 线上地址：https://hongrui-boss-erp-api.onrender.com
- 数据库：Supabase Postgres（项目 `uithwozfgkcotophscuu`，pooler 6543）
- 前端：https://hongrui.site.accio.ai （Accio 托管，与本仓库无关）

---

## ⚠️ 改前必读（2026-09-23 加固后新增）

1. **本仓库是后端唯一发布源。**
   `BUSINESSES/HONGRUI/hongrui-boss/server-supabase.ts` 是**开发源副本，无 git，且已与线上分叉**，
   它的成本 SQL 把「毛利」当成「成本」、且未排除作废单。
   **从那里重新部署会把线上已正确的利润模块改坏。** 该文件已在头部加了醒目警示。

2. **任何后端改动一律在本仓库修改并提交**，不要改 `hongrui-boss/`。

3. **凭据只走 Render 环境变量，禁止硬编码**（历史曾明文落入 git 记录，已判定为泄露，
   详见下面的「安全基线」）。

4. **不要提交 `.env`、`.token`、`*.secret`、`verify.sh`、`push.sh`、`JWT_SECRET*.md`**（已在 .gitignore）。

---

## 环境变量（在 Render 控制台注入）

| 变量 | 必需 | 说明 |
|---|---|---|
| `JWT_SECRET` | ✅ | JWT 签名密钥。**缺失则后端拒绝启动。** |
| `PG_PASSWORD` | ✅ | Supabase 数据库密码。**缺失则后端拒绝启动。** |
| `PG_HOST` | 可选 | 默认 `aws-0-ap-southeast-1.pooler.supabase.com` |
| `PG_PORT` | 可选 | 默认 `6543`（transaction pooler） |
| `PG_DB` | 可选 | 默认 `postgres` |
| `PG_USER` | 可选 | 默认 `postgres.uithwozfgkcotophscuu` |
| `PORT` | 可选 | 默认 3001 |

---

## 安全基线（2026-09-23 加固）

**数据库侧（已在 Supabase 执行）**
- 删除 23 张表上的 `FOR ALL TO PUBLIC USING(true) WITH CHECK(true)` 策略
  —— 该策略使**匿名可读、可写、可删**（实测匿名 `DELETE users` 曾返回 204）
- `REVOKE ALL ON ALL TABLES/SEQUENCES/FUNCTIONS IN SCHEMA public FROM anon, authenticated`
- 清理 `pg_default_acl`（postgres 角色的未来对象默认授权）
- 保留 8 条具名只读角色策略（`fanco3b3_ro`）
- **后端以 `postgres` 直连（`rolbypassrls=true`），因此收紧 RLS 不影响线上读写**

**代码侧**
- 移除 `JWT_SECRET` / `PG_PASSWORD` 的明文 fallback，改为缺失即拒绝启动
- 清除 20+ 个脚本与文档中的明文凭据，统一收敛到 `.env`（已 gitignore）
- 前端**不直连** Supabase，只走本后端 API

**遗留待办（需人工在控制台操作）**
- 🔴 轮换 Supabase `anon` / `service_role` key（旧 key 曾硬编码于本地脚本）
- 🔴 轮换 Postgres 密码（旧密码存在于本仓库 git 历史中）
- 🔴 轮换 `JWT_SECRET`（默认值 `hongrui-boss-secret-key-2024` 曾存在于 git 历史）
- 🔴 更换后台管理员账号 `13213857001` 的弱密码
- ⚠️ 清理 git 历史中的明文凭据（历史提交含旧密码，需 `git filter-repo` 或按泄露处置）

---

## 部署与回滚

- 推送 `main` 即触发 Render 自动部署
- 回滚：Render 控制台 → Deploys → 选择上一个正常版本 → Redeploy
- 数据库备份：见 `BUSINESSES/HONGRUI/_governance/backup/`（含全量数据 + schema + 策略 + ACL + 恢复脚本）