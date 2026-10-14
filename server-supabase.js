import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import pg from 'pg';
import path from 'path';
import fs from 'fs';
import multer from 'multer';
import XLSX from 'xlsx';
import crypto from 'crypto';   // ★ R15 幂等：请求体指纹（req_hash）
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const PORT = Number(process.env.PORT || 3001);
// ===== 安全加固：凭据必须来自环境变量（Render 控制台 Secret 注入），禁止明文 fallback =====
const JWT_SECRET = process.env.JWT_SECRET;
const PROJECT_ROOT = path.join(path.dirname(path.resolve(process.argv[1])), "..");
const DIST_PATH = path.join(PROJECT_ROOT, 'dist').replace(/\\\\/g, '/');
const PG_HOST = process.env.PG_HOST || 'aws-0-ap-southeast-1.pooler.supabase.com';
const PG_PORT = Number(process.env.PG_PORT || 6543);
const PG_DB = process.env.PG_DB || 'postgres';
const PG_USER = process.env.PG_USER || 'postgres.uithwozfgkcotophscuu';
const PG_PASSWORD = process.env.PG_PASSWORD;
// 启动校验：缺失关键凭据立即退出（避免用弱配置运行线上服务）
const _missing = [];
if (!JWT_SECRET) _missing.push('JWT_SECRET');
if (!PG_PASSWORD) _missing.push('PG_PASSWORD');
if (_missing.length) {
    console.error('[FATAL] 缺少必需环境变量: ' + _missing.join(', '));
    console.error('请在 Render 控制台 → Environment → 添加 Secret 环境变量后重新部署。');
    process.exit(1);
}
let pool = null;
function getPool() {
    if (!pool) {
        pool = new pg.Pool({
            host: PG_HOST, port: PG_PORT, database: PG_DB,
            user: PG_USER, password: PG_PASSWORD,
            ssl: { rejectUnauthorized: false },
            max: 20,
            /* ★ 性能铁律（2026-10-04 实测）：idleTimeoutMillis 原为 30000ms ⇒ 只要 30 秒没请求，
             * 池里所有连接被关掉，下一个请求就要重付「TCP+TLS+认证」成本（本机实测 533ms，
             * 线上同区约 150~300ms）。老板是「隔几分钟开一次」的用法，等于每次都付。
             * 实测证据：_probe-db-latency.cjs「B. Pool 连续 5 次」第 1 次 614ms、第 2~5 次 84ms。
             * 改为 10 分钟 + TCP keepAlive，把这份成本从「每次请求」变成「每 10 分钟一次」。 */
            idleTimeoutMillis: 600000,
            connectionTimeoutMillis: 15000,
            keepAlive: true,
        });
        console.log('Supabase Postgres pool initialized');
    }
    return pool;
}
/* ==== SQL-PREP BEGIN（唯一真源 · 装置按标记抽取求值，2026-10-11 P5）==== */
/* 本标记块**只为可测性而存在**：块内代码零改动（纯注释包裹），
 * 让 `_diag/sprint/p5-tx-test.cjs` 能断言"真实发布的这段 SQL 预处理"而不是副本。 */
function translateSQL(sql) {
    return sql
        .replace(/datetime\('now','localtime'\)/g, "to_char(now() AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI:SS')")
        .replace(/datetime\('now'\)/g, "to_char(now() AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI:SS')")
        .replace(/last_insert_rowid\(\)/g, 'lastval()')
        .replace(/date\('now'(\s*,\s*'([^']+)')?\)/g, (m, _g1, g2) => {
        // created_at 是 TEXT(YYYY-MM-DD)，date('now',...) 必须输出文本格式才能比较
        if (!g2)
            return "to_char(CURRENT_DATE, 'YYYY-MM-DD')";
        const plus = g2.match(/\+(\d+)\s+days/);
        if (plus)
            return `to_char((CURRENT_DATE + ${plus[1]} * INTERVAL '1 day'), 'YYYY-MM-DD')`;
        const minus = g2.match(/-(\d+)\s+days/);
        if (minus)
            return `to_char((CURRENT_DATE - ${minus[1]} * INTERVAL '1 day'), 'YYYY-MM-DD')`;
        return "to_char(CURRENT_DATE, 'YYYY-MM-DD')";
    });
}
function convertPlaceholders(sql) {
    let count = 0;
    return { sql: sql.replace(/\?/g, () => `$${++count}`), count };
}
/* ==== SQL-PREP END ==== */
/* ==== WRITE-LEDGER BEGIN（唯一真源 · 2026-10-11 48h 冲刺 P5-2「写失败必须可见」）==== */
/* 【治什么病】修复前 `run()` / `runLastId()` / `safeExec()` 三个执行器的 catch 只
 *   `console.error` 后照常返回（run 返 undefined、safeExec 返空结果集）⇒ 写库失败被**静默吞掉**，
 *   而路由紧接着 `res.json({ ok: true })` ⇒ 前端拿到"成功"、库里什么都没写。这就是 P3-02 / P1-04。
 * 【实测到的两个真实后果（隔离库，2026-10-11）】
 *   ① `POST /finance/transactions/income {amount:null}` ⇒ 200 `{ok:true, order_number:"SKD…001"}`
 *      而 `transactions` 一行没写（amount 是 NOT NULL）；
 *   ② 同一请求里 `UPDATE accounts SET balance = balance + NULL` ⇒ **该账户余额被写成 NULL**
 *      （accounts.balance 列可空，`x + NULL = NULL` 不报错）⇒ 一条非法请求静默抹掉账户余额。
 * 【为什么不把 run() 直接改成 throw】`run()` 有 96 个调用点，而本服务**没有 async 错误边界**
 *   （Express 4 不接管 async handler 的 rejection）⇒ 一抛就变成「请求挂死、客户端一直转圈」，
 *   比"假成功"更难排查。故采用**请求级记账 + 响应出口守卫**：既不挂死，也绝不撒谎。
 * 【为什么用 AsyncLocalStorage】零调用点改动即可做到**按请求隔离**：用模块级变量会让并发请求串味。
 * 【能力边界·必须说清】只能捕获经 run / runLastId / **写型** safeExec 的失败；
 *   直接 `pool.query()` 且自行 catch 的写路径不受保护（本文件当前无此类路径，已 grep 核过）。
 * ★ 本块被 `_diag/sprint/p5extract.cjs` 的 `loadLedger()` 按标记抽取后求值 ⇒ 断言**真实发布的**这段代码。
 * ======================================================================================== */
import { AsyncLocalStorage } from 'async_hooks';
const WRITE_LEDGER = new AsyncLocalStorage();
/** 写语句判据：**只**给写语句记账 —— safeExec 同时服务读（含能力探测），
 *  若读失败也记账，那些「刻意探测某列是否存在」的调用会把正常请求误判成写失败。 */
function isWriteSQL(sql) {
    return /^\s*(insert|update|delete|alter|create|drop|truncate|grant|revoke)\b/i.test(String(sql || ''));
}
function noteWriteFailure(sql, e) {
    const box = WRITE_LEDGER.getStore();
    if (!box) return;                       // 非请求上下文（启动期建表、脚本）不记
    box.push({
        sql: String(sql || '').replace(/\s+/g, ' ').slice(0, 220),
        error: String((e && e.message) || e).slice(0, 300),
    });
}
/* ==== WRITE-LEDGER END ==== */
async function safeExec(sql, params = []) {
    try {
        const translated = translateSQL(sql);
        const { sql: finalSql } = convertPlaceholders(translated);
        const client = await getPool().connect();
        try {
            /* ⚠️ 必须用 rowMode:'array'（位置数组），不能用默认的行对象。
             * 原因：Postgres 里多个未加别名的聚合列（如两次 COALESCE(SUM(x),0)）
             * 列名都叫 "coalesce"；默认行对象按列名赋值 → 后面的列覆盖前面的，
             * 再 map(columns) 取值时所有重名列都会拿到「最后一列」的值。
             * 历史 bug：/store/sales-orders?withTotal=1 的 sum_final/sum_owe/sum_received
             * 三个金额曾全部返回同一个数（¥3,184,331.69），采购单同样。
             * rowMode:'array' 让每行就是按 SELECT 顺序的位置数组，重名列不再塌缩。 */
            const result = await client.query({ text: finalSql, values: params, rowMode: 'array' });
            const columns = result.fields.map((f) => f.name);
            const values = result.rows;
            return { columns, values };
        }
        finally {
            client.release();
        }
    }
    catch (e) {
        console.error('SQL Error:', e.message, 'SQL:', sql);
        /* ★ P5-2：读失败可以降级成空结果（历史行为保留），**写失败必须记账**
         *   —— 记进本次请求的台账，由响应出口守卫拒绝返回 ok:true。 */
        if (isWriteSQL(sql)) noteWriteFailure(sql, e);
        return { columns: [], values: [] };
    }
}
async function run(sql, params = []) {
    try {
        const translated = translateSQL(sql);
        const { sql: finalSql } = convertPlaceholders(translated);
        const client = await getPool().connect();
        try {
            await client.query(finalSql, params);
        }
        finally {
            client.release();
        }
    }
    catch (e) {
        console.error('Run Error:', e.message, 'SQL:', sql);
        noteWriteFailure(sql, e);   // ★ P5-2：写失败必须可见（响应出口守卫据此拦截"假成功"）
    }
}
/* ★★ 2026-10-09 新增：`runLastId(sql, params)` —— 执行 INSERT 并返回新行 id。
 *
 * 【为什么必须有它 —— 这是一个真缺陷，不是洁癖】
 *   原写法是**两步**：`await run("INSERT ...")` 然后 `await safeExec("SELECT last_insert_rowid()")`。
 *   `last_insert_rowid()` 由 translateSQL 转成 PG 的 `lastval()`，而 **`lastval()` 是会话级状态**
 *   （每个连接各自维护一份）。偏偏 `run()` 与 `safeExec()` 各自独立地
 *   `getPool().connect() → client.release()`（池 `max: 20`）⇒ 两次调用**可能落在不同连接上**：
 *     · 落在别的连接  ⇒ lastval() 返回**那条连接上一次 nextval 的值**（可能是另一个请求刚插入的 id）
 *     · 该连接从未 nextval ⇒ 直接报 `lastval is not yet defined in this session`
 *   雪上加霜的是 safeExec 的 catch 会把错误**静默**吞成 `{columns:[],values:[]}`
 *   ⇒ 调用方拿到 undefined，表现为「主单插入成功、明细却没挂上 / 挂到别的单上」——
 *   静默错数据，是查起来最痛苦的一类。
 *
 * 【修法】用 PG 原生的 `INSERT ... RETURNING id`，把「插入」与「取 id」并成
 *   **同一条语句、同一个连接**，从根上消除对会话状态的依赖（无需事务、无需额外往返）。
 *   失败/取不到时返回 null（调用方一律以 `if (id)` 判定，与旧行为兼容），并打印日志（绝不静默）。
 */
async function runLastId(sql, params = []) {
    try {
        const translated = translateSQL(sql);
        const { sql: finalSql } = convertPlaceholders(translated);
        const client = await getPool().connect();
        try {
            const result = await client.query({ text: finalSql + ' RETURNING id', values: params });
            const row = result.rows && result.rows[0];
            if (!row) return null;
            // 正常情况下列名就是 id；兜底取第一个值，避免列名大小写/别名差异导致拿到 undefined
            return row.id === undefined ? (Object.values(row)[0] ?? null) : row.id;
        }
        finally {
            client.release();
        }
    }
    catch (e) {
        console.error('RunLastId Error:', e.message, 'SQL:', sql);
        noteWriteFailure(sql, e);   // ★ P5-2：INSERT 取 id 失败不再静默返 null
        return null;
    }
}
/* ==== WITH-TX BEGIN（唯一真源 · 装置按标记抽取求值，2026-10-11 P5）==== */
/* ==================== B0 公共前置：事务助手 withTx（2026-10-11 · 48h 冲刺 P5）====================
 * 【为什么必须有 —— 这是两个真缺陷的同一个根，不是洁癖】
 *   · P1-06 的病灶：POST /store/sales-returns 先 INSERT 主单、再 INSERT 明细，两次调用各自
 *     getPool().connect() → release()（池 max:20）⇒ **两条语句落在不同连接、各自自动提交**。
 *     明细 INSERT 因缺 product_id 违反 NOT NULL 抛错，被 run() 的 catch 吞成一行日志，
 *     路由仍 res.json({ok:true}) ⇒ 造出「零明细销售退货单」，且用户看到"成功"。（假成功）
 *   · P1-01/P1-02 的病灶："读-算-写"跨语句无锁 ⇒ 并发收付款互相覆盖（丢失更新）。
 *   ⇒ 两者是同一类病：**单请求内非原子**。用同一把工具根治，而不是各修各的。
 *
 * 【纪律】
 *   · q / run / lastId 与 safeExec / run / runLastId **同签名、同返回形状**（rowMode:'array'）
 *     ⇒ 路由代码可原地替换，**不需要改取值方式**（否则会造出"取到 undefined"的新缺陷）。
 *   · **与 safeExec 的关键差别：不吞异常**。q 抛错 ⇒ 调用方 await 直接 reject ⇒ withTx
 *     ROLLBACK 后**继续上抛** ⇒ 由路由转成明确错误码。绝不静默，绝不假成功。
 *   · 凡「改金额 / 改库存 / 建单据+明细 / 读-算-写」的写路径，一律走本函数；
 *     只读查询与真正单语句的写不需要（省一次 BEGIN/COMMIT 往返）。
 *
 * 【rowMode:'array' 不可省】原因见 safeExec 上方注释（不别名聚合列重名会塌缩）。
 *   若这里改用默认行对象，取值形状会与既有 r[0] 位置索引不一致。
 * ============================================================================================== */
async function withTx(fn) {
    const client = await getPool().connect();
    const prep = (sql, params) => {
        const { sql: finalSql } = convertPlaceholders(translateSQL(sql));
        return { finalSql, params: Array.isArray(params) ? params : (params === undefined ? [] : [params]) };
    };
    const tx = {
        async q(sql, params = []) {
            const { finalSql, params: p } = prep(sql, params);
            const r = await client.query({ text: finalSql, values: p, rowMode: 'array' });
            return { columns: r.fields.map((f) => f.name), values: r.rows, rowCount: r.rowCount };
        },
        async run(sql, params = []) {
            const { finalSql, params: p } = prep(sql, params);
            const r = await client.query({ text: finalSql, values: p });
            return { rowCount: r.rowCount };
        },
        async lastId(sql, params = []) {
            const { finalSql, params: p } = prep(sql, params);
            const r = await client.query({ text: finalSql + ' RETURNING id', values: p });
            const row = r.rows && r.rows[0];
            if (!row) return null;
            return row.id === undefined ? (Object.values(row)[0] ?? null) : row.id;
        },
    };
    try {
        await client.query('BEGIN');
        const out = await fn(tx);
        await client.query('COMMIT');
        return out;
    }
    catch (e) {
        try { await client.query('ROLLBACK'); }
        catch (e2) { console.error('ROLLBACK 失败:', e2.message); }
        console.error('withTx 已回滚:', e.message, '| SQL:', e.sql || '(未提供)');
        throw e;                    // ★ 必须上抛：静默吞掉就会重演 P1-06 的"假成功"
    }
    finally {
        client.release();
    }
}
/* ==== WITH-TX END ==== */
/* ==================== 性能：把 N 次顺序往返压成 1 次 ====================
 * 实测（2026-10-04，_governance/_probe-db-profile.cjs + _probe-platform-floor.cjs）：
 *   · Postgres 侧执行时间 0.1~4.6ms（sales_orders 4517 行全表扫也只 2.3ms）
 *   · 单次 safeExec 的网络往返 wall ≈ 45~80ms（本机→Supabase 直连）
 * ⇒ 减少往返次数确实能省钱，但**它不是线上的主因**，这一点必须说清楚，不能拿它当解释：
 *   · Render 平台上「纯 32 字节 404」（不碰库、不鉴权）中位就要 425~519ms ⇒ 平台地板是大头；
 *   · /store/suppliers 只做 1 次查询仍要 2471ms ⇒ 往返次数解释不了它；
 *   · 极差 380~1931ms（甚至出现 25s/30s 超时）⇒ 链路抖动占比很高。
 * 所以本装置的正确定位是：**把「我们自己能控的那部分」从 N 次压到 1 次**，
 * 拿回 400ms 上下里属于我们的那几十到一两百毫秒；平台地板与链路抖动需另想办法（保活/降冷启动）。
 * ==================================================================== */

/** 把 N 个互相独立的「单值」子查询合并成 1 次往返。
 *  ⚠️ 只允许传互相独立的子查询（不能有先后依赖）。
 *  ⚠️ 合并失败时自动回退逐条执行，绝不静默返回 0（否则会重演「金额全 ¥0.00」那类事故）。 */
async function scalars(specs) {
    const out = {};
    if (!specs || !specs.length) return out;
    const sql = 'SELECT ' + specs.map((s) => `(${s.sql})`).join(', ');
    const r = await safeExec(sql);
    if (r.values && r.values.length === 1) {
        specs.forEach((s, i) => { out[s.key] = r.values[0][i]; });
        return out;
    }
    console.error('[scalars] 合并查询失败，回退逐条执行；keys=' + specs.map((s) => s.key).join(','));
    for (const s of specs) out[s.key] = (await safeExec(s.sql)).values?.[0]?.[0];
    return out;
}

/* ==================== 传输压缩：**不自己压**（2026-10-04 实测结论） ====================
 * 曾有 `gzipMiddleware`（用 node:zlib 压 ≥1KB 的 JSON），实测后**已移除**。理由（_probe-gzip-reality.cjs）：
 *   Render 的响应头是 `server: cloudflare` —— 边缘代理**本来就在压缩**，而且比我还积极：
 *     · /analysis/dashboard           231B → 159B（我压它也是这个量级）
 *     · /store/settings                75B →  88B ← **平台连 75 字节都压**（此时压缩是负收益）
 *     · /inventory/products?pageSize=50  17,919B → 1,731B（9.7%）
 *   拿这些数在**部署前**测的 ⇒ 压缩与我的代码无关。
 *   自建中间件的后果只有：多一层要维护的代码、多一个出错面、**收益为 0**。
 * ⚠️ 后来者勿再加：除非换了不带边缘压缩的托管，否则这里不需要压缩层。
 * ==================================================================================== */

/* ==================== 传输层：只读参考数据的短缓存 ====================
 * 这些数据一天之内几乎不变，但每次进页面都要拉一次。
 * 加私有缓存头（private 防止中间层缓存带权限的内容），前端命中缓存后**根本不发请求**。 */
const CACHEABLE_GET = [
    '/api/store/settings', '/api/store/roles', '/api/store/employees',
    '/api/inventory/specs', '/api/inventory/units',
    '/api/finance/accounts', '/api/finance/accounts/options', '/api/store/info',
];
function cacheHeaderMiddleware(req, res, next) {
    if (req.method === 'GET') {
        const p = req.path;
        if (CACHEABLE_GET.some((c) => p === c || p === c + '/')) {
            res.setHeader('Cache-Control', 'private, max-age=60, stale-while-revalidate=300');
        } else if (p.startsWith('/api/auth/')) {
            res.setHeader('Cache-Control', 'no-store');
        }
    }
    next();
}

async function _runMigrations() {
    const client = await getPool().connect();
    try {
        await client.query('SELECT 1');
        // 迁移：users 表增加 permissions 列（幂等）
        try { await client.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS permissions TEXT DEFAULT '[]'"); } catch (e) { /* 已存在或不可用则忽略 */ }
        // ===== 新增功能建表（幂等）：销售预订 / 进货退货 / 报价单 / 规格 / 单位 =====
        const ddl = [
            `ALTER TABLE users ADD COLUMN IF NOT EXISTS commission_rate DOUBLE PRECISION DEFAULT 0`,
            `ALTER TABLE products ADD COLUMN IF NOT EXISTS wholesale_price DOUBLE PRECISION DEFAULT 0`,
            `ALTER TABLE customers ADD COLUMN IF NOT EXISTS price_level TEXT DEFAULT 'retail'`,
            `ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS commission_amount DOUBLE PRECISION DEFAULT 0`,
            // ===== 财务口径补全（对齐智慧记）：业务日期 / 应收 / 已收 / 欠款 / 抹零 / 运费 / 税额 / 备注 / 单据类型 =====
            `ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS bill_date TEXT`,
            `ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS receivable_amount DOUBLE PRECISION DEFAULT 0`,
            `ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS received_amount DOUBLE PRECISION DEFAULT 0`,
            `ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS owe_amount DOUBLE PRECISION DEFAULT 0`,
            `ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS small_change_amount DOUBLE PRECISION DEFAULT 0`,
            `ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS express_amount DOUBLE PRECISION DEFAULT 0`,
            `ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS tax_amount DOUBLE PRECISION DEFAULT 0`,
            `ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS remark TEXT`,
            `ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS biz_type TEXT DEFAULT 'sale'`,
            /* ★ 2026-10-08 补「制单人」：智慧记单据里「业务员」与「制单人」是**两个不同的人**，
             *   实测销售单 4527 条：制单人 曹怡航 3202 / 老板 1325；业务员 曹怡航 2464 / 老板 2063
             *   —— 两者对不上 738 条。宏瑞此前只有 operator_name（=业务员/业绩归属），
             *   没有「谁录的这张单」⇒ 单据详情无法与智慧记逐字对齐。
             *   历史行留 NULL（老数据没有这个信息，不回填、不猜测），展示层显「—」。 */
            `ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS maker_name TEXT`,
            `ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS maker_name TEXT`,
            `ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS bill_date TEXT`,
            `ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS paid_amount DOUBLE PRECISION DEFAULT 0`,
            `ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS owe_amount DOUBLE PRECISION DEFAULT 0`,
            `ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS remark TEXT`,
            `CREATE INDEX IF NOT EXISTS idx_sales_orders_number ON sales_orders(order_number)`,
            `CREATE INDEX IF NOT EXISTS idx_sales_orders_bill_date ON sales_orders(bill_date)`,
            `CREATE INDEX IF NOT EXISTS idx_sales_orders_biz_type ON sales_orders(biz_type)`,
            `CREATE INDEX IF NOT EXISTS idx_purchase_orders_number ON purchase_orders(order_number)`,
            `CREATE TABLE IF NOT EXISTS sales_reservations (id BIGSERIAL PRIMARY KEY, reservation_number TEXT, customer_id BIGINT, customer_name TEXT, total_amount DOUBLE PRECISION DEFAULT 0, status TEXT DEFAULT 'pending', remark TEXT, operator_id BIGINT, operator_name TEXT, created_at TEXT DEFAULT to_char(now() AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI:SS'))`,
            `CREATE TABLE IF NOT EXISTS sales_reservation_items (id BIGSERIAL PRIMARY KEY, reservation_id BIGINT, product_id BIGINT, product_name TEXT, sku TEXT, quantity DOUBLE PRECISION DEFAULT 0, unit_price DOUBLE PRECISION DEFAULT 0, amount DOUBLE PRECISION DEFAULT 0)`,
            `CREATE TABLE IF NOT EXISTS purchase_returns (id BIGSERIAL PRIMARY KEY, return_number TEXT, purchase_order_id BIGINT, supplier_id BIGINT, supplier_name TEXT, total_amount DOUBLE PRECISION DEFAULT 0, reason TEXT, operator_id BIGINT, operator_name TEXT, created_at TEXT DEFAULT to_char(now() AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI:SS'))`,
            `CREATE TABLE IF NOT EXISTS purchase_return_items (id BIGSERIAL PRIMARY KEY, return_id BIGINT, product_id BIGINT, product_name TEXT, quantity DOUBLE PRECISION DEFAULT 0, unit_price DOUBLE PRECISION DEFAULT 0, amount DOUBLE PRECISION DEFAULT 0)`,
            `CREATE TABLE IF NOT EXISTS quotes (id BIGSERIAL PRIMARY KEY, quote_number TEXT, customer_id BIGINT, customer_name TEXT, total_amount DOUBLE PRECISION DEFAULT 0, status TEXT DEFAULT 'draft', remark TEXT, operator_id BIGINT, operator_name TEXT, created_at TEXT DEFAULT to_char(now() AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI:SS'))`,
            `CREATE TABLE IF NOT EXISTS quote_items (id BIGSERIAL PRIMARY KEY, quote_id BIGINT, product_id BIGINT, product_name TEXT, sku TEXT, quantity DOUBLE PRECISION DEFAULT 0, unit_price DOUBLE PRECISION DEFAULT 0, amount DOUBLE PRECISION DEFAULT 0)`,
            `CREATE TABLE IF NOT EXISTS product_specs (id BIGSERIAL PRIMARY KEY, name TEXT, remark TEXT, created_at TEXT DEFAULT to_char(now() AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI:SS'))`,
            `CREATE TABLE IF NOT EXISTS units (id BIGSERIAL PRIMARY KEY, name TEXT, remark TEXT, created_at TEXT DEFAULT to_char(now() AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI:SS'))`,
            // 往来单位调整科目（对齐智慧记）：优惠 preferential / 抹零 trim
            // 智慧记口径：期末 = 期初 + 应收合计 − 回款 − 优惠 + 抹零（73 家客户 + 5 家供应商真源数据反解，100% 命中）
            `CREATE TABLE IF NOT EXISTS party_adjustments (id SERIAL PRIMARY KEY, party_name TEXT NOT NULL, party_type TEXT NOT NULL DEFAULT 'customer', adj_type TEXT NOT NULL, amount DOUBLE PRECISION DEFAULT 0, source TEXT, note TEXT, created_at TEXT DEFAULT to_char(now() AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI:SS'))`,
            `CREATE UNIQUE INDEX IF NOT EXISTS uq_party_adj ON party_adjustments (party_name, party_type, adj_type, source)`,
            /* ============ 索引补齐（2026-10-04，老板拍板第 3 项） ============
             * 诚实前提：实测本库 DB 侧执行只要 0.1~4.6ms（sales_orders 4517 行全表扫 2.3ms），
             *   所以这批索引**不是为了救现在的慢**（慢的真因是往返次数，见 scalars()）。
             *   它们的价值是「数据长大以后不退化」，且建造成本极低、写入放大可忽略（日均新增个位数单）。
             * 关键设计：表达式索引必须与查询**逐字符同形**，否则规划器不会用。
             *   列表页/日期筛选用的是 COALESCE(bill_date, substr(created_at,1,10))
             *   （不是 substr(COALESCE(...))！两者在 PG 眼里是两个不同表达式）。 */
            `CREATE INDEX IF NOT EXISTS idx_sales_orders_bd_id ON sales_orders ((COALESCE(bill_date, substr(created_at,1,10))) DESC, id DESC)`,
            `CREATE INDEX IF NOT EXISTS idx_purchase_orders_bd_id ON purchase_orders ((COALESCE(bill_date, substr(created_at,1,10))) DESC, id DESC)`,
            `CREATE INDEX IF NOT EXISTS idx_sales_orders_customer ON sales_orders (customer_id)`,
            `CREATE INDEX IF NOT EXISTS idx_sales_orders_customer_name ON sales_orders (customer_name)`,
            `CREATE INDEX IF NOT EXISTS idx_purchase_orders_supplier ON purchase_orders (supplier_id)`,
            `CREATE INDEX IF NOT EXISTS idx_purchase_orders_supplier_name ON purchase_orders (supplier_name)`,
            `CREATE INDEX IF NOT EXISTS idx_sales_items_product ON sales_order_items (product_id)`,
            `CREATE INDEX IF NOT EXISTS idx_purchase_items_product ON purchase_order_items (product_id)`,
            `CREATE INDEX IF NOT EXISTS idx_transactions_type_created ON transactions (type, created_at)`,
            `CREATE INDEX IF NOT EXISTS idx_transactions_account ON transactions (account_id)`,
            `CREATE INDEX IF NOT EXISTS idx_sales_orders_owe ON sales_orders (owe_amount) WHERE owe_amount > 0`,
            `CREATE INDEX IF NOT EXISTS idx_purchase_orders_owe ON purchase_orders (owe_amount) WHERE owe_amount > 0`,
            `CREATE INDEX IF NOT EXISTS idx_customers_name ON customers (name)`,
            `CREATE INDEX IF NOT EXISTS idx_suppliers_name ON suppliers (name)`,
            `CREATE INDEX IF NOT EXISTS idx_products_name ON products (name)`,
            /* ============ 单据号对齐智慧记（2026-10-05，2026-10-08 修订）============
             * 智慧记全站单据都有号：销售 XSD / 进货 JHD / 收款 SKD / 付款 FKD / 其他收支 SZD。
             * 宏瑞原本只有销售/进货有号，**收付款完全没有单据号** ⇒ 客户拿收款单来对账时
             * 无法指认（只能靠金额+日期猜），这是对账环节的真实断点。
             *
             * ★ 2026-10-08 事实更正：原注释写「历史单据号已不可复原」**是错的**。
             *   智慧记 `fund_flow.code` 就是每条资金流水对应的真实单据号（实测 3435 条里
             *   只有 1 条为空），已由 import-zhj-to-supabase.cjs 按 reference_id 逐条回填。
             *   这是「从权威源回填」，不是伪造：值就是智慧记自己的 code。 */
            `ALTER TABLE transactions ADD COLUMN IF NOT EXISTS order_number TEXT`,
            `ALTER TABLE transactions ADD COLUMN IF NOT EXISTS party_type TEXT`,
            `ALTER TABLE transactions ADD COLUMN IF NOT EXISTS party_id BIGINT`,
            `ALTER TABLE transactions ADD COLUMN IF NOT EXISTS party_name TEXT`,
            /* ★ 2026-10-08 口径修正：撤掉「单据号全局唯一」。
             *   根因（实测）：智慧记**一张收付款单可以对应多条资金流水** ——
             *   `SZD202503180001` 对应 2 笔（¥2100 / ¥2000）、`SKD202505090001` 对应 2 笔。
             *   原索引 `uq_transactions_number (order_number)` 会让第 2 笔撞键，而
             *   PostgREST 返回 409 被导入器静默吞掉 ⇒ 单号只补上一半（3434/3435）。
             *   改为 (order_number, reference_id) 复合唯一：同一单据号**允许**出现在多条
             *   流水上（与智慧记一致），但同一来源流水（reference_id）不可能重复入账。 */
            `DROP INDEX IF EXISTS uq_transactions_number`,
            `CREATE UNIQUE INDEX IF NOT EXISTS uq_transactions_number_ref ON transactions (order_number, reference_id) WHERE order_number IS NOT NULL AND reference_id IS NOT NULL`,
            `CREATE INDEX IF NOT EXISTS idx_transactions_number ON transactions (order_number)`,
            `CREATE INDEX IF NOT EXISTS idx_transactions_party ON transactions (party_type, party_id)`,
            /* ============ 资金流水「冲销删除 / 冲销重记」（2026-10-09 补）============
             * 两列都是**审计指针**，只增不改：
             *   reverse_of   —— 本行是「冲销」行，指向被冲销的原流水 id
             *   revised_from —— 本行是「编辑重记」产生的新行，指向被改的原流水 id
             * 用途：① 防重复冲销（反查 reverse_of 即可，不用模糊 LIKE）
             *      ② 前端/报告可把「原行 + 冲销行 + 重记行」整链串起来展示
             * 历史行全部为 NULL（老数据没有这个信息，不回填、不猜测）。 */
            `ALTER TABLE transactions ADD COLUMN IF NOT EXISTS reverse_of BIGINT`,
            `ALTER TABLE transactions ADD COLUMN IF NOT EXISTS revised_from BIGINT`,
            `CREATE INDEX IF NOT EXISTS idx_transactions_reverse_of ON transactions (reverse_of)`,
            /* ============ P2（2026-10-11）：明细行级「开单当时进价」与源ID ============
             *   背景：成本口径从「商品档案当前价」改为「行级历史价」（详见 COST_UNIT_SQL 注释）。
             *   这四列全部**只为补历史价服务**，对既有查询零影响（都是可空附加列）：
             *     cost_price     —— 开单当时的进价（源智慧记明细 pur_prc），NULL = 无历史价 ⇒ 回退档案价
             *     spec / unit    —— 源明细的规格与单位，供单据详情/打印逐字对齐
             *     src_item_id    —— 智慧记明细雪花ID，**幂等键**（重复回填靠它去重）
             *     src_product_id —— 智慧记商品雪花ID，供跨系统逐商品对账（不靠名字猜）
             *   ⚠ 历史行天然为 NULL：没有源明细的单（本地自建/源侧已删）不回填、不猜测。 */
            `ALTER TABLE sales_order_items ADD COLUMN IF NOT EXISTS cost_price DOUBLE PRECISION`,
            `ALTER TABLE sales_order_items ADD COLUMN IF NOT EXISTS spec TEXT`,
            `ALTER TABLE sales_order_items ADD COLUMN IF NOT EXISTS unit TEXT`,
            `ALTER TABLE sales_order_items ADD COLUMN IF NOT EXISTS src_item_id BIGINT`,
            `ALTER TABLE sales_order_items ADD COLUMN IF NOT EXISTS src_product_id BIGINT`,
            `ALTER TABLE purchase_order_items ADD COLUMN IF NOT EXISTS cost_price DOUBLE PRECISION`,
            `ALTER TABLE purchase_order_items ADD COLUMN IF NOT EXISTS spec TEXT`,
            `ALTER TABLE purchase_order_items ADD COLUMN IF NOT EXISTS unit TEXT`,
            `ALTER TABLE purchase_order_items ADD COLUMN IF NOT EXISTS src_item_id BIGINT`,
            `ALTER TABLE purchase_order_items ADD COLUMN IF NOT EXISTS src_product_id BIGINT`,
            /* 幂等键：同一源明细只能回填一次（重复跑回填脚本不会写第二遍）。
             * 用部分唯一索引（WHERE NOT NULL）以兼容历史 NULL 行。 */
            `CREATE UNIQUE INDEX IF NOT EXISTS uq_soi_src_item ON sales_order_items (src_item_id) WHERE src_item_id IS NOT NULL`,
            `CREATE UNIQUE INDEX IF NOT EXISTS uq_poi_src_item ON purchase_order_items (src_item_id) WHERE src_item_id IS NOT NULL`,
            `CREATE INDEX IF NOT EXISTS idx_sales_items_order ON sales_order_items (order_id)`,
            `CREATE INDEX IF NOT EXISTS idx_sales_items_cost ON sales_order_items (cost_price) WHERE cost_price IS NULL`,
            /* ============ ★★ 2026-10-12 冲刺 R15（P2-01）写接口幂等保护 ============
             * 见下方 IDEM 块的设计说明。此处只建**载体表**（幂等键 + 请求体指纹 + 响应回放）。
             * 三键列全部 NOT NULL ⇒ 从根上不涉及 PG 的 NULL 唯一语义（第六轮 §1.3 实测：UNIQUE 允许多 NULL）。
             * 唯一索引用 (user_id, endpoint, client_request_id) —— 第六轮 §1.6 实测结论：
             *   **禁全局唯一**（会跨用户拦 23505，命中即回放 ⇒ 跨用户信息泄露）。 */
            `CREATE TABLE IF NOT EXISTS idempotency_keys (
                id BIGSERIAL PRIMARY KEY,
                user_id BIGINT NOT NULL,
                endpoint TEXT NOT NULL,
                client_request_id TEXT NOT NULL,
                req_hash TEXT NOT NULL,
                status_code INTEGER DEFAULT 0,
                response_body TEXT,
                created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                completed_at TIMESTAMPTZ
            )`,
            `CREATE UNIQUE INDEX IF NOT EXISTS uq_idem_user_endpoint_crid ON idempotency_keys (user_id, endpoint, client_request_id)`,
            `CREATE INDEX IF NOT EXISTS idx_idem_stale ON idempotency_keys (created_at) WHERE response_body IS NULL`,
        ];
        for (const sql of ddl) {
            try { await client.query(sql); } catch (e) { console.log('DDL skip:', e.message); }
        }
        /* ============ [[IDEM-SELFCHECK]] 幂等载体表可用性自检（2026-10-12） ============
         * 背景：幂等中间件已改为 **fail-closed**（见 IDEM 块）。若 `idempotency_keys` 不可用，
         *   所有**带幂等键**的写请求都会 503 —— 这是刻意的取舍：可用性让位于「不得重复记账」。
         * 隐患：上面的 DDL 循环把失败降级成一行 `DDL skip:` 日志，极易被淹掉
         *   ⇒ 出现最坏组合「全站写不了、却看不出原因」。
         * 做法：DDL 之后**主动探一次表**（真实 INSERT→DELETE 往返，不依赖 information_schema，
         *   因为"表存在但无权限"也必须能被发现）；成功静默，失败打醒目告警并留状态供 /api/health 查询。
         * ★ 刻意**不阻断启动**：不带幂等键的老客户端行为必须逐字不变，
         *   阻断启动会把「部分写请求不可用」放大成「整套系统不可用」。 */
        try {
            await client.query('BEGIN');
            await client.query(
                "INSERT INTO idempotency_keys (user_id, endpoint, client_request_id, req_hash, status_code) VALUES (0, '__selfcheck__', '__selfcheck__', 'x', 0)");
            await client.query("DELETE FROM idempotency_keys WHERE endpoint = '__selfcheck__'");
            await client.query('COMMIT');
            globalThis.__IDEM_SELFCHECK = { ok: true, at: new Date().toISOString(), error: null };
        }
        catch (e) {
            try { await client.query('ROLLBACK'); } catch (e2) { /* 连接可能已废，忽略 */ }
            globalThis.__IDEM_SELFCHECK = { ok: false, at: new Date().toISOString(), error: String(e.message || e).slice(0, 300) };
            console.error('\n' + '='.repeat(78));
            console.error('!!! [IDEM-SELFCHECK] 幂等载体表不可用 —— 带幂等键的写请求将全部返回 503');
            console.error('!!! 原因:', globalThis.__IDEM_SELFCHECK.error);
            console.error('!!! 影响: 前端新版本所有写操作（开单/收款/退货/库存）会被拒绝，且**不会静默放行**。');
            console.error('!!! 处置: 检查 idempotency_keys 建表权限与磁盘；恢复后重启后端即可。');
            console.error('='.repeat(78) + '\n');
        }
        /* ★★ 2026-10-11 P5-4（P3-09）：盘点明细的数量列建表时落成 bigint，
         *   而 `products.stock_quantity` 是 double precision ⇒ 只要有**一个**商品库存带小数
         *   （磨具按米/卷计量，本库实测 **22 个**：砂布卷 1.93 / 国产红色拉丝带 29.78…），
         *   `POST /inventory/checks` 就会在插明细时**整批失败**：
         *     实测 HTTP 500 ／ fail_count=22 ／ first_error="无效的类型 bigint 输入语法: \"29.78\""
         *   ⇒ **盘点功能整体不可用**（不是数据问题，是列型与业务不一致）。
         *   【修法】三列放宽为 double precision（与 products.stock_quantity 同型）。
         *     bigint → double precision 是**加宽转换、零数据丢失**；
         *     不采用「四舍五入成整数」——那会把 29.78 的盘亏算错（静默丢精度）。
         *   【幂等 + 锁粒度】只在**当前仍是整数型**时才 ALTER，避免每次启动都取一次 ACCESS EXCLUSIVE 锁。
         *   【影响面】该表本库 119 行 ⇒ 迁移代价可忽略。 */
        try {
            const t = await client.query(
                "SELECT data_type FROM information_schema.columns WHERE table_schema='public' " +
                "AND table_name='inventory_check_items' AND column_name='system_quantity'");
            const dt = String(t.rows?.[0]?.data_type || '');
            if (dt && dt !== 'double precision' && dt !== 'real' && dt !== 'numeric') {
                await client.query(
                    "ALTER TABLE inventory_check_items " +
                    "ALTER COLUMN system_quantity TYPE double precision, " +
                    "ALTER COLUMN actual_quantity TYPE double precision, " +
                    "ALTER COLUMN difference      TYPE double precision");
                console.log('[migrate] inventory_check_items 数量列已放宽为 double precision（P3-09）');
            }
        } catch (e) { console.error('[migrate] inventory_check_items 列放宽失败（盘点会不可用）:', e.message); }
        // P2（2026-10-11）：DDL 之后再探测成本口径列 —— 本进程内一次性定死，
        // 保证同一进程里所有成本查询用同一套口径（不会"一半新一半旧"）。
        await probeCostUnitColumn((m) => console.log(m));
        console.log('Database connected (Supabase)');
    }
    finally {
        client.release();
    }
    return true;
}

/* ⚠️ initDB 被 90+ 个路由在入口处调用（用于「表结构自愈」）。
 * 但迁移本身是 1 条 SELECT 1 + 1 条 ALTER + 29 条 DDL = 每个请求 31 次数据库往返：
 *   线上（同区域）≈ 0.5s/请求 —— 与查询量无关，所有接口耗时都卡在同一水位；
 *   本地（跨境 RTT ~75ms）≈ 2.3s/请求，若中间件与处理器各调一次就是 4.6s。
 * 这不是慢查询，是「每请求重跑建表语句」。改为进程内只执行一次：
 * 首次调用真正执行，其余调用复用同一个 Promise；失败则清空以便下次重试。 */
let _migrationsPromise = null;
function initDB() {
    if (!_migrationsPromise) {
        _migrationsPromise = _runMigrations().catch((e) => {
            _migrationsPromise = null; // 允许下一次请求重试
            console.error('initDB 迁移失败（将在下次请求重试）:', e.message);
            return false;
        });
    }
    return _migrationsPromise;
}
function saveDB() { }
/* ==== BJ-TIME BEGIN（唯一真源 · 2026-10-11 48h 冲刺 P4「时区统一」）====================
 * 【为什么】服务端跑 UTC（Render），本机跑 GMT+8 ⇒ 同一份数据算出不同的「今天 / 本月」：
 *   · 本机 GMT+8：`new Date(y, m, 1).toISOString().slice(0,10)` ⇒ **2026-09-30**（应为 10-01）
 *       —— 本地 10-01 00:00 = UTC 09-30 16:00，被 toISOString 拉回上一天；
 *   · 任何主机  ：`new Date().toISOString().slice(0,10)` ⇒ **UTC 日期**
 *       —— 北京时间 00:00~08:00 期间，「今天」会算成昨天。
 *   ⇒ 实测影响（隔离库同一份数据）：本月销售额多算 ¥16,177.50、收入多算 ¥41,783.50。
 *
 * 【做法】一律用**显式 Asia/Shanghai** 求日期，结果**与本进程 TZ 无关**。
 *
 * ★ 铁律：本块**只算日期边界，绝不读取或改写任何历史时间戳**。
 *   P4 的修复面＝「拿哪个日期去查」，不是「把库里的时间改成什么」。
 * ★ 本块被 `_diag/sprint/p4-tz-test.cjs` **按标记抽取后求值** ⇒ 断言的是真实发布的这段代码。
 * ★ 内联而非独立模块：Dockerfile 只 `COPY server-supabase.js`（单文件部署），
 *   新增模块文件不会进镜像 ⇒ 内联是「部署零改动 + 最小增量」的唯一解。
 * ================================================================================== */
const BJ_TZ = 'Asia/Shanghai';
const _bjDate = (v) => {
    const d = (v === undefined || v === null) ? new Date() : (v instanceof Date ? v : new Date(v));
    if (Number.isNaN(d.getTime())) throw new Error('bj-time: 非法时间 ' + String(v));
    return d;
};
/** 北京时区 YYYY-MM-DD（en-CA 天然输出 ISO 形式，免手工拼装） */
function bjYmd(v) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: BJ_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(_bjDate(v));
}
/** 北京时区「今天」 */
function bjToday(v) { return bjYmd(v); }
/** 纯日期加减（只走 UTC 算术，避免二次时区偏移） */
function bjShift(ymd, days) {
    const [y, m, d] = String(ymd).split('-').map(Number);
    const u = new Date(Date.UTC(y, m - 1, d) + Number(days) * 86400000);
    return `${u.getUTCFullYear()}-${String(u.getUTCMonth() + 1).padStart(2, '0')}-${String(u.getUTCDate()).padStart(2, '0')}`;
}
/** 北京时区下、相对 v 偏移 offset 个月的**首日**（offset 可为负） */
function bjMonthStart(offset, v) {
    const [y, m] = bjYmd(v).split('-').map(Number);
    const k = m - 1 + (Number(offset) || 0);
    const yy = y + Math.floor(k / 12);
    const mm = ((k % 12) + 12) % 12;
    return `${yy}-${String(mm + 1).padStart(2, '0')}-01`;
}
/** 北京时区下、相对 v 偏移 offset 个月的**末日** */
function bjMonthEnd(offset, v) { return bjShift(bjMonthStart((Number(offset) || 0) + 1, v), -1); }
/** 北京时区下**往前 n 天**（n 为负 ⇒ 往后） */
function bjDaysAgo(n, v) { return bjShift(bjYmd(v), -(Number(n) || 0)); }
/** 北京时区「现在」的 YYYY-MM-DD HH:mm:ss（与库内 created_at 同口径，便于对拍） */
function bjNowString(v) {
    const p = new Intl.DateTimeFormat('en-GB', {
        timeZone: BJ_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).formatToParts(_bjDate(v));
    const g = (t) => p.find((x) => x.type === t).value;
    return `${g('year')}-${g('month')}-${g('day')} ${g('hour')}:${g('minute')}:${g('second')}`;
}
/* ==== BJ-TIME END ==== */
/** 业务日期（东八区），格式 YYYY-MM-DD —— 与智慧记 bill_date 口径一致 */
function todayCST() {
    // P4：改为复用上面唯一真源（原实现 `Date.now()+8h → toISOString` 结果本就正确，此处统一入口）
    return bjToday();
}
/* ==================== 销售单统一口径（2026-10-03 抽取，唯一真源） ====================
 * 背景（实测缺陷）：创建销售单原有三条路径 —— ①手工开单 ②报价转单 ③预订出库。
 *   ②③ 原先手写了一套残缺的 INSERT，只写 final_amount，漏写
 *   receivable_amount / received_amount / owe_amount / payment_status / bill_date
 *   ⇒ 列取默认值 0 ⇒ 造出「金额≠0 但应收=0」的不自洽单，直接打破恒等式「应收 = 实收 + 欠款」
 *   （线上体检：全库该类不自洽单当时 0 张，属未爆的雷）。
 * 铁律：今后任何「生成销售单」的入口都必须调用 salesOrderMoney() 取金额字段，
 *       任何「写入 sales_order_items」的入口都必须先经 resolveProductIdForOrder() 解析商品。
 * 判据：`_governance/_verify-sales-insert.cjs` 扫描本文件，缺字段即报错。
 * ==================================================================================== */

/**
 * 销售单金额口径（与手工开单完全一致）
 * @param {number} finalAmount 应收金额（= 明细合计 − 折扣 + 运费 + 税额 − 抹零）
 * @param {*} receivedAmount 显式实收；未传（undefined/null/''）时有支付方式视为全额收讫，无支付方式（赊账）视为 0
 * @param {string|null} paymentMethod 支付方式
 * @param {string} [billDateIn] 显式业务日期（如前端传入）；不传则取今天（东八区）
 * @returns {{receivable_amount:number, received_amount:number, owe_amount:number, payment_status:string, bill_date:string}}
 */
function salesOrderMoney(finalAmount, receivedAmount, paymentMethod, billDateIn) {
    const fa = Math.round((Number(finalAmount) || 0) * 100) / 100;
    const received = (receivedAmount !== undefined && receivedAmount !== null && receivedAmount !== '')
        ? (Number(receivedAmount) || 0)
        : (paymentMethod ? fa : 0);
    const owe = Math.round((fa - received) * 100) / 100;
    return {
        receivable_amount: fa,
        received_amount: received,
        owe_amount: owe,
        payment_status: owe > 0.005 ? '未结清' : '已结清',
        bill_date: billDateIn || todayCST()
    };
}

/* ==================== 采购侧结算判据（2026-10-04 老板拍板，唯一真源） ====================
 * 判据：**已结清 ⇔ owe_amount ≤ 0**（即「无待付款项」）。
 * 为什么是 ≤0 而不是 =0：库里有 8 张红冲/负数采购单（如 JHD202607090002 郑州赵明义
 *   total=−29,645.50、paid=0、owe=−29,645.50），它们不产生任何待付款项，必须算已结清。
 *   智慧记的采购单表没有结算状态字段（只有 status/invoice_status），只能由 owe 推断；
 *   智慧记口径是「owe ≠ 0 即未结清」⇒ 这 8 张在两边归类不同。老板拍板：**按 owe ≤ 0**，
 *   并把「供应商欠我方」这一层单独看（不混进「待付款」）。
 * ⚠️ 为什么不能只信 payment_status 字符串：旧代码 `o[9] || '已结清'` 会把**空值静默当已结清**，
 *   哪怕它其实还欠着钱。现在：有值就与 owe 交叉校验（不一致以 owe 为准，保证列表状态与金额自洽），
 *   空值一律按 owe 现算。绝不无条件兜底。
 * 存量影响（2026-10-04 全表审计 _probe-settled-field.cjs）：
 *   采购单 515 张 = 已结清 306（其中 8 张 owe<0）+ 未结清 209，**无 NULL**；
 *   「说已结清但 owe>0」的行数 = 0 ⇒ 本改动对现有指标**零回退**。
 * ==================================================================================== */
const SETTLED_EPS = 0.005;
function purchasePaymentStatus(storedStatus, owe) {
    const s = String(storedStatus == null ? '' : storedStatus).trim();
    if (s === '作废') return '作废';
    const byOwe = Number(owe || 0) > SETTLED_EPS ? '未结清' : '已结清';
    if (s === '已结清' || s === '未结清') return s === byOwe ? s : byOwe;
    return byOwe;
}

/**
 * 商品解析：sales_order_items.product_id 是 NOT NULL，缺失会直接违反约束。
 * 先认来源明细的 product_id；没有则按「归一化商品名」在 products 档案里找（不间断空格/全角/大小写均容忍）。
 * @returns {Promise<number|null>} 命中的商品 id，找不到返回 null（调用方必须据此**在写库之前**拦截）
 */
async function resolveProductIdForOrder(productId, productName) {
    if (productId) return Number(productId);
    const norm = (s) => String(s == null ? '' : s).replace(/[\s\u00A0\u3000]+/g, '').toLowerCase();
    const target = norm(productName);
    if (!target) return null;
    try {
        const rows = (await safeExec('SELECT id, name FROM products')).values || [];
        const hit = rows.find((r) => norm(r[1]) === target);
        return hit ? Number(hit[0]) : null;
    } catch (e) {
        return null;
    }
}
/**
 * 成本符号修正（关键）：智慧记里「红字冲销单」以负数销售单形式存在（实测 348 张），
 * 其单据金额为负、但明细数量与成本仍记正 → 直接 SUM(qty×cost) 会把成本虚增。
 * 同理销售退货单。故成本必须按「单据符号」取反，否则成本率 >100%（实测 105.83%）。
 * 修正后全期间毛利率 = 6.76%（原为 -5.83%）。
 */
const COST_SIGN_SQL = "CASE WHEN so.final_amount < 0 OR COALESCE(so.biz_type,'sale')='sale_return' THEN -1 ELSE 1 END";
/* ==================== 成本计价口径：「历史成本优先」（2026-10-11 P2） ====================
 * 【为什么要改】旧口径一律用 `p.cost_price`（商品档案的**当前**成本）去乘**历史**销售量：
 *     · 与业务事实不符 —— 商品进价会变（实测同一商品：石墨布 480→96、钢丸 237.5→190、
 *       诺顿拉丝带红 260→130），拿今天的进价算三个月前的单，毛利是假的；
 *     · 一旦档案成本被改成 0（未录/停用），历史毛利会被**整体虚高**，且无处察觉。
 *   ⇒ 正确口径：**用开单当时的进价**（智慧记明细自带 `pur_prc`），档案成本只做兜底。
 *
 * 【落库位置】源 `pur_prc` 存到 `sales_order_items.cost_price`（行级，一行一个价）。
 *
 * 【发布顺序无关（硬要求）】生产库可能**还没有**这一列。若 SQL 直接引用 `oi.cost_price`，
 *   未迁移即 500。故此处做**运行期列探测**：
 *     · 列存在 → `COALESCE(oi.cost_price, p.cost_price)`（行级历史价优先，缺则回退档案价）
 *     · 列缺失 → `p.cost_price`（**逐字等于旧口径**，行为零变化）
 *   两个变量只在探测后取值，任何顺序发布都安全。
 *
 * ★ 判据：`GET /api/analysis/dashboard` 的 `costBasis` 字段应为 `historical`（列可用时）。
 * ★ 注意：库存存货成本（`stock_quantity × cost_price`，商品档案维度）**不走此口径**，
 *   那是「现在仓库里的货值多少」，本就该用当前成本，不属本次改造范围。
 * ==================================================================================== */
let COST_UNIT_SQL = 'p.cost_price';          // 单件成本表达式（默认＝旧口径）
let COST_UNIT_IS_HISTORICAL = false;         // 是否已切到行级历史成本
/* 行级历史价表达式：`NULLIF(...,0)` 把 **0 视为"没记录"**。
 *   理由：源 `pur_prc = 0` 表示智慧记当时也没录进价（实测 2 行），
 *   此时用 0 当成本 ⇒ 该行毛利被整额虚高；退回档案价是**更接近事实的估计**，
 *   且档案价是真实数据、不是凭空造的。是否"回退"会在响应里如实标注。 */
const COST_ITEM_EXPR = 'NULLIF(CAST(oi.cost_price AS DOUBLE PRECISION), 0)';

/* ★ 三个行级判据构成**严格划分**（互斥且完备）：每一条明细行必落入且仅落入一类。
 *   这是"可验证"的前提 —— 若分类有交叠，三数相加会大于总行数，结论就没法自证。
 *   （初版曾用 `oi.cost_price IS NOT NULL` 判 historic ⇒ 行级价=0 的行同时落进
 *     historic 与 missing 两类，划分被破坏；单元测试 T2.6 为此增设并在修正后转正。） */
/** ① 用了「开单当时进价」且该价有效 */
const COST_ROW_HISTORIC_SQL = () => (COST_UNIT_IS_HISTORICAL
    ? `COALESCE(${COST_ITEM_EXPR},0) <> 0`
    : 'FALSE');
/** ② 当时进价不可用 ⇒ 回退商品档案当前成本；旧口径下**每一行都属此类**（本就没有历史价） */
const COST_ROW_FALLBACK_SQL = () => (COST_UNIT_IS_HISTORICAL
    ? `COALESCE(${COST_ITEM_EXPR},0) = 0 AND COALESCE(p.cost_price,0) <> 0`
    : 'COALESCE(p.cost_price,0) <> 0');
/** ③ 两种价都拿不到 ⇒ **毛利被高估的行**（本次修复要报出来的对象） */
const COST_ROW_MISSING_SQL = () => (COST_UNIT_IS_HISTORICAL
    ? `COALESCE(${COST_ITEM_EXPR},0) = 0 AND COALESCE(p.cost_price,0) = 0`
    : 'COALESCE(p.cost_price,0) = 0');
/**
 * 探测 `sales_order_items.cost_price` 是否存在，据此切换成本口径。
 * 幂等、只读、失败不阻断启动（保持旧口径）。
 */
async function probeCostUnitColumn(log = () => { }) {
    try {
        const r = await safeExec(`SELECT COUNT(*)::int FROM information_schema.columns WHERE table_name='sales_order_items' AND column_name='cost_price'`);
        const n = Number((r && r.values && r.values[0] && r.values[0][0]) || 0);
        COST_UNIT_IS_HISTORICAL = n > 0;
        COST_UNIT_SQL = n > 0 ? `COALESCE(${COST_ITEM_EXPR}, p.cost_price)` : 'p.cost_price';
        log(`[cost] sales_order_items.cost_price ${n > 0 ? '可用' : '缺失'} ⇒ 成本口径 = ${COST_UNIT_SQL}`);
    } catch (e) {
        COST_UNIT_IS_HISTORICAL = false;
        COST_UNIT_SQL = 'p.cost_price';
        log('[cost] 列探测失败，保持旧口径 p.cost_price：' + e.message);
    }
    return COST_UNIT_IS_HISTORICAL;
}
/**
 * 成本完整性指标（P2，2026-10-11）——回答「这个毛利能不能信」。
 *
 * 【为什么必须有】旧前端用 `!todayCost`（今日成本为 0）当「未录成本价」的判据，有两个洞：
 *   ① 今日**没有销售**时 todayCost 恒为 0 ⇒ 误报「未录成本价」（无销售≠没录成本）；
 *   ② 今日**有销售但只部分商品缺成本**时 todayCost > 0 ⇒ **漏报**，毛利被静默高估。
 *   老板明确要求：**不得只采用 `todaySales > 0` 的简单条件**。
 *   ⇒ 唯一正确判据是「**逐明细行**问：这一行有没有成本价」。
 *
 * 返回 5 个标量（对给定时间窗）：
 *   costItemRows     用「开单当时进价」的行数
 *   costFallbackRows 历史价缺失、**回退用商品档案当前成本**的行数（毛利近似，需提示）
 *   costMissingRows  两种价都拿不到（空或 0）的行数 ⇒ **毛利被高估的行**
 *   costMissingQty   这些行的净数量（含退货符号）
 *   costMissingAmount 这些行的净销售额 ＝ 毛利**虚高**的金额上界
 *
 * @param {string} dateCond 施加在 `so` 上的日期谓词（不含 AND 前缀）
 * @param {string} extra `scopeSql + VOID_SO` 之类的附加条件（含 AND 前缀）
 */
function costIntegritySql(dateCond, extra = '') {
    const J = `FROM sales_order_items oi JOIN sales_orders so ON oi.order_id=so.id JOIN products p ON oi.product_id=p.id WHERE ${dateCond}${extra}`;
    return [
        /* 先取窗口内**不加任何成本条件**的总行数 —— 它是后面三分类的对照基准。
         * 独立算一次（而不是把三数相加）才能真校验划分：三数之和 ≠ 总数 ⇒ 判据有交叠/漏项。 */
        { key: 'costTotalRows', sql: `SELECT COUNT(*) ${J}` },
        { key: 'costItemRows', sql: `SELECT COUNT(*) ${J} AND ${COST_ROW_HISTORIC_SQL()}` },
        { key: 'costFallbackRows', sql: `SELECT COUNT(*) ${J} AND ${COST_ROW_FALLBACK_SQL()}` },
        { key: 'costMissingRows', sql: `SELECT COUNT(*) ${J} AND ${COST_ROW_MISSING_SQL()}` },
        { key: 'costMissingQty', sql: `SELECT COALESCE(SUM(${COST_SIGN_SQL} * oi.quantity),0) ${J} AND ${COST_ROW_MISSING_SQL()}` },
        { key: 'costMissingAmount', sql: `SELECT COALESCE(SUM(${COST_SIGN_SQL} * oi.amount),0) ${J} AND ${COST_ROW_MISSING_SQL()}` },
    ];
}
/** 把 5 个成本完整性标量整理成响应体（两端点共用，字段命名 snake_case）
 * @param {object} S scalars 结果
 * @param {Function} N 数值转换
 * @param {boolean} isHist 当前成本口径是否已切到行级历史价（决定 basis 的诚实标注）
 */
function costIntegrityOut(S, N = Number, isHist = COST_UNIT_IS_HISTORICAL) {
    const hist = N(S.costItemRows), fb = N(S.costFallbackRows), miss = N(S.costMissingRows);
    const declared = N(S.costTotalRows);
    const total = hist + fb + miss;
    let basis;
    if (declared === 0) basis = 'none';                  // 窗口内没有成本明细行
    else if (!isHist) basis = miss === 0 ? 'current' : 'current_partial';
    else if (hist === 0) basis = 'all_fallback';         // 有行但历史价全不可用
    else if (fb === 0 && miss === 0) basis = 'historical';// 全部用开单当时进价（最可信）
    else basis = 'mixed';
    return {
        total_rows: declared,
        historic_rows: hist,
        fallback_rows: fb,
        missing_rows: miss,
        missing_qty: N(S.costMissingQty),
        missing_amount: Math.round(N(S.costMissingAmount) * 100) / 100,
        complete: miss === 0,
        /* 划分自证：三分类之和必须等于**独立统计**的窗口总行数。
         * 若为 false ⇒ 判据出现交叠或漏项 ⇒ 本窗口任何毛利结论都不可用（前端须拒信）。 */
        partitioned: total === declared,
        basis,
    };
}
/* ================= 单据号：对齐智慧记口径（2026-10-05） =================
 * 智慧记实测格式：`前缀(3位大写字母) + YYYYMMDD + 4位当日序号`
 *   销售 XSD ｜ 进货 JHD ｜ 收款 SKD ｜ 付款 FKD
 * 旧实现的两个缺陷（本次修复）：
 *   ① 前缀 2 位（XS/JH/TH/HS/YD/BJ/PD）⇒ 与智慧记对不上，跨系统核对时无法按前缀归类；
 *   ② 序号用 `Math.random()` ⇒ **同日可能撞号**（1万空间、当日 100 单时碰撞概率≈39%），
 *      且单据号不连续，人工核对时无法判断"是否漏单"。
 * 新实现：按「前缀 + 当日」取历史最大序号 +1，序号从 0001 开始连续递增。
 *   · 兼容读取：同时扫 sales_orders / purchase_orders / transactions 三张表（收款付款记在 transactions）
 *   · 不依赖 DB 序列：本库是 Supabase（PG），单条 SELECT MAX + 单条 INSERT 之间的竞态窗口
 *     在「日均个位数单」的体量下可忽略；且保留随机后缀兜底，撞号时退化为「序号+随机」仍唯一。
 *   · 兜底：整个取号失败时回退旧随机逻辑，绝不因取号失败而阻断开单（可用性优先）。
 * ★ 判据：`SELECT order_number FROM sales_orders ORDER BY id DESC LIMIT 5` 应为
 *   `XSD202610050001 / XSD202610050002 ...` 连续形态，而非 `XSD202610057341` 随机形态。
 * ======================================================================= */
const ORDER_PREFIX = {
    sale: 'XSD',            // 销售单
    purchase: 'JHD',        // 进货单
    income: 'SKD',          // 收款单
    expense: 'FKD',         // 付款单
    sale_return: 'THD',     // 销售退货
    purchase_return: 'JHD', // 进货退货（沿用进货号段，智记亦如此）
    recycle: 'HSD',         // 回收
    reservation: 'YDD',     // 销售预订
    quote: 'BJD',           // 报价单
    check: 'PDD',           // 盘点单
    transfer: 'DBD',        // 转账/调拨
    assembly: 'ZZD',        // 组装单（2026-10-08 补：原为 TODO 空壳，无单号可发）
    split: 'CFD',           // 拆分单（同上）
    XS: 'XSD', JH: 'JHD', SK: 'SKD', FK: 'FKD', TH: 'THD', HS: 'HSD',
    YD: 'YDD', BJ: 'BJD', PD: 'PDD', DB: 'DBD', ZZ: 'ZZD', CF: 'CFD',
    XSD: 'XSD', JHD: 'JHD', SKD: 'SKD', FKD: 'FKD', THD: 'THD', HSD: 'HSD',
    YDD: 'YDD', BJD: 'BJD', PDD: 'PDD', DBD: 'DBD', ZZD: 'ZZD', CFD: 'CFD',
};
/** 把各种写法的前缀归一化成 3 位大写口径。
 *
 *  ★ 2026-10-05 记录——这个函数被自己写的单测连打回两次，两次都是真 bug：
 *    第 1 次：`ORDER_PREFIX[s]` 里 s 已 toUpperCase()，而表的键是小写 'sale'/'income'
 *            ⇒ 语义名全部落进兜底分支被截断（income→INC、expense→EXP、transfer→TRA）。
 *    第 2 次：第 1 次"修"的时候只在表里补了 2 位码和 3 位码的大写键，
 *            **忘了语义名的大写键**（'sale'.toUpperCase() === 'SALE'，表里没有 'SALE'）
 *            ⇒ 同一个 bug 换个样子又回来，单测 21 例仍挂 11 例。
 *    两次都不是"看代码看出来"的，是单测判红的。教训：
 *      · 查表前统一大写 ⇒ 表里就必须**同时登记大写形式**，或查表时**双向兜底**；
 *      · "修 bug" 后必须**重跑同一个单测**，不能凭推理认为已修好。
 *    最终方案：查表时先按原样、再按大写、最后按小写各查一次（三向兜底），
 *            这样无论表里登记的是哪种写法、调用方传的是哪种写法，都能命中。 */
function normPrefix(prefix) {
    const raw = String(prefix || '').trim();
    if (!raw) return 'XSD';
    // 三向兜底查表：原样 → 大写 → 小写
    const hit = ORDER_PREFIX[raw] || ORDER_PREFIX[raw.toUpperCase()] || ORDER_PREFIX[raw.toLowerCase()];
    if (hit) return hit;
    const s = raw.toUpperCase();
    if (s.length === 3) return s;
    return (s + 'D').slice(0, 3);
}
/* 取号实现（2026-10-05 实测驱动重构）：
 *   v1 随机数 → 撞号且不连续；
 *   v2 MAX(...)+1 → 单线程下连续正确，但**并发实测 5 次全部拿到同一个号**
 *      （"JHD202610050001" × 5）—— 因为 SELECT MAX 与 INSERT 之间存在竞态窗口。
 *      这不是理论风险：手机端连点两次提交、两个店员同时开单都会命中。
 *   v3（本版）用 **Postgres 序列**：nextval 是原子的，且同一序列天然单调递增、
 *      无缺口、无竞态。每个「前缀+日期」一个独立序列（如 seq_ord_XSD20261005），
 *      首次使用当天自动创建（IF NOT EXISTS，并发安全）。
 *   ⚠️ 序列的已知特性：ROLLBACK 不会回退 nextval ⇒ 事务失败会**跳号**。
 *      这是可接受的：跳号远好于撞号，且智记导入数据本身就按天从 0001 起。
 *   兜底：序列不可用（权限/非 PG）时回退到 MAX+1 快照逻辑，再兜底到时间戳末 4 位，
 *      三层降级，**任何一层都不会让开单失败**。 */
async function generateOrderNumber(prefix) {
    const pre = normPrefix(prefix);
    // 业务日期取**北京时间**（与 created_at 的 Asia/Shanghai 保持一致）。
    // ★ 旧实现用 toISOString()（UTC）⇒ 北京时间 00:00~08:00 开的单会落到前一天号段，
    //   与「单据日期」显示不一致。这是实测发现的真实缺陷，一并修掉。
    const date = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date()).replace(/-/g, '');

    /* ---------- 主路径：Postgres 序列（原子、无竞态） ---------- */
    const seqName = `seq_ord_${pre}${date}`;
    try {
        /* ⚠️ 关键：序列必须从「当日历史最大序号」之后起步。
         *   新建序列默认从 1 开始 ⇒ 若当天已有 XSD...0008（可能是从智记导入的），
         *   新序列会产出 0001 与历史单**撞号**，而被唯一索引拒绝、开单直接失败。
         *   所以先查当日三表的最大序号，把序列的 START 设在 max+1；
         *   序列已存在时（当天第二次开单）不再需要这一步。 */
        /* 判断序列是否已存在：用 to_regclass 而非查 pg_class ——
         * to_regclass 接受文本名并正确解析 search_path，比手写 relname 匹配更稳。 */
        const seqExists = String((await safeExec(
            `SELECT to_regclass(?)`, [seqName]
        ))?.values?.[0]?.[0] || '') !== '';
        if (!seqExists) {
            let maxSeq = 0;
            for (const r of await Promise.all([
                safeExec(`SELECT COALESCE(MAX(order_number),'') FROM sales_orders WHERE order_number LIKE ?`, [`${pre}${date}%`]),
                safeExec(`SELECT COALESCE(MAX(order_number),'') FROM purchase_orders WHERE order_number LIKE ?`, [`${pre}${date}%`]),
                safeExec(`SELECT COALESCE(MAX(order_number),'') FROM transactions WHERE order_number LIKE ?`, [`${pre}${date}%`]),
            ])) {
                const v = String(r?.values?.[0]?.[0] || '');
                if (v.length > pre.length + 8) {
                    const n = parseInt(v.slice(pre.length + 8, pre.length + 12), 10);
                    if (Number.isFinite(n) && n > maxSeq) maxSeq = n;
                }
            }
            const startAt = maxSeq + 1;
            // CREATE SEQUENCE 不支持参数占位符（DDL），故拼接；seqName 与 startAt 均已数值化/白名单化
            await run(`CREATE SEQUENCE IF NOT EXISTS ${seqName} START WITH ${startAt}`);
        }
        const r = await safeExec(`SELECT nextval('${seqName}')`);
        const seqNo = Number(r?.values?.[0]?.[0] || 0);
        if (Number.isFinite(seqNo) && seqNo > 0) {
            return `${pre}${date}${String(seqNo).padStart(4, '0')}`;
        }
    } catch (e) {
        console.error('generateOrderNumber 序列取号失败，降级到 MAX+1:', e.message);
    }

    /* ---------- 降级 1：MAX+1（单线程安全；并发下可能撞号，但有唯一索引兜底） ---------- */
    try {
        const [inS, inP, inT] = await Promise.all([
            safeExec(`SELECT COALESCE(MAX(order_number),'') FROM sales_orders WHERE order_number LIKE ?`, [`${pre}${date}%`]),
            safeExec(`SELECT COALESCE(MAX(order_number),'') FROM purchase_orders WHERE order_number LIKE ?`, [`${pre}${date}%`]),
            safeExec(`SELECT COALESCE(MAX(order_number),'') FROM transactions WHERE order_number LIKE ?`, [`${pre}${date}%`]),
        ]);
        let maxSeq = 0;
        for (const r of [inS, inP, inT]) {
            const v = String(r?.values?.[0]?.[0] || '');
            if (v.length > pre.length + 8) {
                const n = parseInt(v.slice(pre.length + 8, pre.length + 12), 10);
                if (Number.isFinite(n) && n > maxSeq) maxSeq = n;
            }
        }
        return `${pre}${date}${String(maxSeq + 1).padStart(4, '0')}`;
    } catch (e) {
        console.error('generateOrderNumber MAX+1 取号失败，降级到时间戳:', e.message);
    }

    /* ---------- 降级 2：时间戳末 4 位（可能撞号，但绝不返回空/undefined） ---------- */
    return `${pre}${date}${String(Date.now() % 10000).padStart(4, '0')}`;
}
const app = express();
app.use(helmet());
app.use(cors({ exposedHeaders: ['X-Sensitive-Filtered', 'X-Idempotent-Replay'] }));
app.use(morgan('dev'));
app.use(cacheHeaderMiddleware); // 只读参考数据的私有短缓存
app.use(express.json());
/* ==== WRITE-GUARD BEGIN（唯一真源 · 2026-10-11 48h 冲刺 P5-2）==== */
/* 与上方 WRITE-LEDGER 配对。本中间件做两件事：
 *   ① 给**每个请求**开一个台账（ALS 上下文），用 `WRITE_LEDGER.run(...)` 包住整条后续处理链
 *      ⇒ 该请求内所有经 run/runLastId/写型 safeExec 的失败都会落到这个数组里，互不串味；
 *   ② 改写**本请求**的 `res.json`：若这次请求发生过写失败，则**不允许**返回 `ok === true`，
 *      一律降级为 500 + `code:'WRITE_FAILED'`（附首条失败原因，前端可直接展示）。
 * 【判据边界（防误伤）】只对 `body.ok === true` 且 `res.statusCode < 400` 的响应降级；
 *   本来就是错误响应（ok 缺省/非 true）或已有 >=400 状态码的**不动** ⇒ 不做二次改写、不覆盖更精确的错误。
 * 【顺序证明】必须注册在**第一条路由之前**，否则拦不到任何东西；`p5-b02-test.cjs` 的 C8 断言了这一点。
 * ===================================================================================== */
app.use((req, res, next) => {
    const fails = [];
    WRITE_LEDGER.run(fails, () => {
        const origJson = res.json.bind(res);
        res.json = (body) => {
            if (fails.length && body && body.ok === true && res.statusCode < 400) {
                console.error(`[WRITE-GUARD] 拦截"假成功": ${req.method} ${req.originalUrl} | ${fails.length} 条写失败 | ${fails[0].error}`);
                res.status(500);
                return origJson({
                    ok: false,
                    code: 'WRITE_FAILED',
                    error: '数据库写入失败，本次操作未生效',
                    fail_count: fails.length,
                    first_error: fails[0].error,
                });
            }
            return origJson(body);
        };
        next();
    });
});
/* ==== WRITE-GUARD END ==== */
/* 健康探针（免鉴权）—— 保活脚本与前端「唤醒」都用它：
 *   · 只做 1 次极轻查询，不碰业务表，成本 ≈ 1 次往返
 *   · 刻意不缓存，CDN/代理必须回源，否则保活打不到源站
 *   · 返回 db 字段用于区分「进程活着」与「进程活着但连不上库」
 * ★ 2026-10-04 增补 commit/bootAt：起因是一次「部署验证通过」其实是**假通过** ——
 *   我拿「/api/health 存在」「有 cache-control」当判据，可这两个标记在**上一个 commit 里也有**，
 *   于是无法区分「新代码上线」还是「旧代码还在」。教训：判据必须能唯一指认被部署的那份代码。
 *   Render 会注入 RENDER_GIT_COMMIT ⇒ 直接把它读出来，commit 号即可判定，不再靠推理。
 *   bootAt = 进程启动时刻，作为 commit 取不到时的兜底（比对是否晚于触发部署的时间）。 */
const BOOT_AT = new Date().toISOString();
const BUILD_COMMIT = process.env.RENDER_GIT_COMMIT || null;
app.get('/api/health', async (_req, res) => {
    const t0 = Date.now();
    let db = false;
    try {
        const r = await safeExec('SELECT 1');
        db = !!(r.values && r.values.length);
    } catch (e) { db = false; }
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    /* ★ 2026-10-12：暴露幂等载体自检结果（[[IDEM-SELFCHECK]]）。
     *   幂等中间件已 fail-closed ⇒ 本表不可用时带键写请求全 503；
     *   把状态放在健康端点，运维**一眼可见**，不必去翻启动日志。
     *   ⚠️ `ok:true` 的语义**不变**（仍是"进程活着"），不要拿 idem 去改 ok —— 发布判据依赖 ok。 */
    const idem = globalThis.__IDEM_SELFCHECK || { ok: null, at: null, error: null };
    res.json({ ok: true, db, ms: Date.now() - t0, at: new Date().toISOString(), commit: BUILD_COMMIT, bootAt: BOOT_AT, idem });
});
// ==================== 权限体系 ====================
// 细粒度功能权限：管理员/店长默认拥有全部；店员按 permissions 数组控制
const ALL_PERMS = [
    'sales', 'return', 'recycle', 'purchase', 'orders', 'customers', 'suppliers',
    'inventory_view', 'inventory_full', 'income', 'expense', 'finance_view',
    'reconciliation', 'performance', 'sales_stats', 'employees', 'settings',
    /* ★ 2026-10-09 新增（老板拍板 2-C）：
     *   欠款可见性从「全店可见」收为**可勾选项**。原因是白天按智慧记口径放开后，
     *   老板真机反馈「子账户看到欠款代收/欠款待付，这个不是子账户的权限」——
     *   老板口径优先于对标 ⇒ 独立权限位，由管理员按账号授予。
     *   ⚠️ 只管「欠款汇总」：/finance/arap、应收应付页、首页两块欠款 KPI。
     *      客户详情里的「往来记录」不受此门限制（老板要求子账户能点开看详情）。 */
    'debt_view',
    /* ★ 2026-10-14 新增（老板反馈「客户管理的停用子账户不能有」）：
     *   把「客户停用/启用」从 `customers` 里拆出来独立授权 —— 原先一个权限位同时含
     *   「查看/新增/编辑/停用」四种动作，子账号（默认带 customers）因此能停用客户。
     *   ⚠️ 必须同时加进 ALL_PERMS，否则连管理员都会 403（管理员权限池就是它）。
     *   ⚠️ 存量账号：若将来要给某个子账号开这个权限，用 PermissionEditor 勾选即可。 */
    'customer_disable',
];
/* 新店员默认权限（开单必需的基础功能）
 * ★ 2026-10-13 老板拍板：默认**加上 `inventory_view`** —— 原话「子账号需要能看到每个商品的库存」。
 *   此前默认不含它，新建子账号进不了「库存查询」。**存量账号仍需补**（见交付说明里的补数据 SQL）。
 * ★ 刻意**不含** `sales_stats`：老板要求「不能看到月销售额，只显示每个商品的销售数量」；
 *   金额由 AMOUNT_SCOPE 金额门按角色统一挡掉，而"每个商品的库存量"本来就在库存查询里，
 *   不需要打开分析模块。 */
const DEFAULT_EMPLOYEE_PERMS = ['sales', 'return', 'customers', 'income', 'expense', 'performance', 'inventory_view'];
function parsePerms(user) {
    if (!user) return [];
    if (user.role === 'admin' || user.role === 'manager') return ALL_PERMS;
    const p = user.permissions;
    if (Array.isArray(p)) return p;
    try { const arr = JSON.parse(p || '[]'); return Array.isArray(arr) ? arr : []; }
    catch { return []; }
}
function hasPerm(perm) {
    return (req, res, next) => {
        if (!req.user) return res.status(401).json({ error: '未授权' });
        if (parsePerms(req.user).includes(perm)) return next();
        return res.status(403).json({ error: '无权限：该功能未开放给当前账号' });
    };
}
async function authMiddleware(req, res, next) {
    const auth = req.headers.authorization;
    if (!auth?.startsWith('Bearer '))
        return res.status(401).json({ error: '未授权' });
    const token = auth.slice(7);
    try {
        req.user = jwt.verify(token, JWT_SECRET);
        // 每次请求从数据库刷新角色/权限/状态：管理员修改权限或停用后即时生效（无需重新登录）
        try {
            await initDB();
            const r = await safeExec("SELECT role, status, permissions, COALESCE(sensitive_permissions,'{}') FROM users WHERE id = ?", [req.user.id]);
            const row = r.values?.[0];
            if (!row)
                return res.status(401).json({ error: '账号不存在' });
            if (parseInt(row[1]) !== 1)
                return res.status(403).json({ error: '账户已被禁用' });
            req.user.role = row[0];
            req.user.status = row[1]; // 补充：/api/auth/me 返回完整 status（前端刷新后状态一致）
            req.user.permissions = row[2];
            req.user.sensitive_permissions = row[3];
        } catch (e) { /* 数据库不可用时降级使用 token 内的数据 */ }
        next();
    }
    catch {
        return res.status(401).json({ error: 'token已过期' });
    }
}
// 管理员/店长中间件：店员（子账户）只能开单/收款，看不到进价与利润
function adminOnly(req, res, next) {
    if (req.user && (req.user.role === 'admin' || req.user.role === 'manager'))
        return next();
    return res.status(403).json({ error: '无权限：该功能仅管理员可用' });
}
// 敏感数据权限检查中间件
const isAdminUser = (role) => role === 'admin' || role === 'manager';
const checkSensitivePerm = (category, permId) => {
    return (req, res, next) => {
        if (isAdminUser(req.user.role)) return next(); // 管理员跳过
        const sensitivePerms = JSON.parse(req.user.sensitive_permissions || '{}');
        if (sensitivePerms[category]?.includes(permId)) {
            return next();
        }
        res.status(403).json({ error: '无敏感数据访问权限' });
    };
};

/* ==== IDEM BEGIN（唯一真源 · 2026-10-12 冲刺 R15 / P2-01「写接口无幂等键」）====
 * 【问题】写接口无幂等键 ⇒ **双击「保存」/ 超时后重试 / 网络重放**，都会重复建单。
 * 【设计依据】《宏瑞BOSS_B0B1补强与打印双方案_20261011.md》§4.3 三重幂等中的第 ① 层，
 *   并已吸收《第六轮遗漏项与施工准入审计_20261011.md》§1 的**实测修正**（勿再引用旧理由）：
 *     ① **作用域禁全局唯一** —— 全局唯一会跨用户拦 23505；若命中即回放原结果，
 *        用户 B 提交与 A 相同的 crid 就会拿到 **A 的响应体**（恶意构造 `"1"`/`"test"` 可精确命中）
 *        ⇒ 跨用户信息泄露。故用 UNIQUE(user_id, endpoint, client_request_id)。
 *     ② **必须存 req_hash** —— 唯一索引**分不清**「同请求重放」与「不同请求撞码」（都报 23505）。
 *        命中后比对指纹：一致 → 回放原结果；不一致 → **409 显式报错**。
 *        若不比对而一律回放，用户「改了金额重发」会**静默拿到旧结果、以为改成功了** —— 比报错更危险。
 *     ③ **NULL 语义** —— PG 实测（§1.3/§1.4）UNIQUE 默认允许多个 NULL，普通唯一索引与部分唯一索引
 *        对老客户端**都兼容**（旧结论"必须用部分索引否则老客户端集体失败"已被推翻）。
 *        本表三键列全 NOT NULL ⇒ 根本不涉及该问题；老客户端不发 key ⇒ 根本不进本表。
 * 【为什么用独立幂等表，而不是「给 5 张业务表加列」】
 *   a) 业务表加列**无法回放响应**（命中后还得重新推导响应体）；独立表直接存响应原文。
 *   b) 各写路由**只挂一行中间件**，零改各路由业务逻辑 ⇒ 符合「最小增量补丁、禁重构已验收功能」。
 *   c) `safeExec` **吞错**（catch 后返空结果集）⇒ 判不了唯一冲突；必须借 `withTx` 的 `tx.run` 拿真 23505。
 *   d) 遵守工程纪律「同功能只留 1 个当前版」，不做两套半接线的机制。
 *   ⇒ 这是**实现载体的选择**，不改变 §4.3 三层设计的任何判据。
 * 【失败语义（对齐第六轮 §1.9 E1 实测：回滚会释放 crid）】业务失败（非 2xx）时**必须删除本行**，
 *   否则「第一次提交失败 → 用户改对了再提交」会被**自己的幂等键**挡住（自己挡自己）。
 * 【捕获点为何是 `res.end` 而不是 `res.json`】P5-2 的响应出口守卫（WRITE-GUARD）也在包 `res.json`，
 *   且它是 app 级中间件、**先于路由注册** ⇒ 若我在路由里包 `res.json`，捕获到的是守卫**改写前**的体
 *   （可能含 `ok:true`）⇒ 重放会**绕过守卫**、回放一个本该被拦的"假成功"。
 *   `res.end` 是所有响应（含守卫改写后）的唯一终点 ⇒ 此处捕获的才是**用户真正收到的字节**。
 * 【残留自愈】进程崩溃会留下 response 为空的行 ⇒ 超过 IDEM_STALE_SEC 视为放弃并释放，可重新提交。
 * 【已知能力边界】响应落库是**异步**的 ⇒ 紧随其后（毫秒级窗口）到达的重放可能撞到「处理中」并得 409；
 *   它是**诚实**的（明说正在处理、可重试），**绝不会重复执行**。
 * ==================================================================================== */
const IDEM_STALE_SEC = 600;

/** 稳定序列化（键名排序）＋ 剔除幂等键字段本身 —— 保证「同一请求」的指纹稳定可复现 */
function _idemCanon(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
    if (Array.isArray(v)) return '[' + v.map(_idemCanon).join(',') + ']';
    return '{' + Object.keys(v).sort()
        .filter((k) => k !== 'client_request_id' && k !== 'idemKey')
        .map((k) => JSON.stringify(k) + ':' + _idemCanon(v[k])).join(',') + '}';
}
/** 请求体指纹：并入 `method + url`，避免「同 body 不同目标」被误判成同一请求 */
function idemHash(req) {
    return crypto.createHash('sha256')
        .update(String(req.method || '') + ' ' + String(req.originalUrl || ''))
        .update('\u0000')
        .update(_idemCanon(req.body || {}))
        .digest('hex')
        .slice(0, 32);
}
/* ★★★ 必须用 `err.code`（SQLSTATE）判定「唯一冲突」，**禁只按错误消息文本** —— 这条是实测踩出来的：
 *   本机 PG 的 `lc_messages` 是中文 ⇒ 实测错误消息为
 *     「重复键违反唯一约束"uq_idem_user_endpoint_crid"」
 *   —— `duplicate key` 与 `23505` 两个英文特征**一个都不出现** ⇒ 首版判据**全部漏判**，
 *   中间件于是**静默 fail-open**：同键重发照样建第二行、同键不同体也不报 409。
 *   实测证据：`_diag/sprint/p5-b14-r15-test.cjs` 首跑 A3/A4/A5/B1b/B3/B4 六条失败，
 *   后端日志出现 `[err] idem 前置失败（放行，不影响业务）: 重复键违反唯一约束…`。
 *   SQLSTATE（`23505`）与语言环境**无关**，是唯一可靠判据；消息文本只作兜底（并补上中文与约束名）。 */
const isUniqueViolation = (e) => {
    if (String((e && e.code) || '') === '23505') return true;
    const msg = String((e && e.message) || e) + '|' + String((e && e.constraint) || '');
    return /23505|duplicate key|重复键|唯一约束|uq_idem_user_endpoint_crid/i.test(msg);
};

/** ★★★ 幂等专用直连执行器：**出错必须抛**（不像 safeExec 会降级成空结果）。
 *  为什么不能用 `safeExec`：它 catch 后返回 `{ columns: [], values: [] }`，
 *  与「真的查不到这一行」**完全无法区分** ⇒ 幂等中间件会把「查询失败」误当成
 *  「幂等键已被释放」，从而 silent fail-open（同键重发照样执行 ⇒ **重复记账 / 重复扣减库存**）。
 *  P5-2 的写失败台账也不适用：这里要的不是"先记账、再由出口守卫拦截"，
 *  而是**在业务处理器之前就拒绝执行**（守卫拦的是 `ok:true`，而重复记账那次是"真成功"）。
 *  ⇒ 本助手只做一件事：把真实错误原样抛出，由调用方决定 fail-closed。 */
async function idemExec(sql, params = []) {
    const { sql: finalSql } = convertPlaceholders(translateSQL(sql));
    const client = await getPool().connect();
    try {
        const r = await client.query({ text: finalSql, values: Array.isArray(params) ? params : [params], rowMode: 'array' });
        return { values: r.rows, rowCount: r.rowCount };
    }
    finally {
        client.release();
    }
}

/**
 * 幂等中间件。**必须挂在 authMiddleware 之后**（要读 req.user.id）、业务处理器之前。
 * 未携带幂等键（`X-Client-Request-Id` 或 body.client_request_id）时直接放行 ⇒ 老客户端行为逐字不变。
 */
function idem(endpoint) {
    return async function idemMiddleware(req, res, next) {
        const crid = String(req.get('x-client-request-id')
            || (req.body && req.body.client_request_id) || '').trim();
        if (!crid) return next();
        const uid = req.user && req.user.id;
        if (!uid) return next();
        const hash = idemHash(req);
        const where = ' WHERE user_id = ? AND endpoint = ? AND client_request_id = ?';
        const args = [uid, endpoint, crid];

        /* ② 在**响应终点**捕获用户真正收到的字节：成功落库（供后续回放）、失败释放键。
         * ★ 捕获点为何是 `res.end` 而不是 `res.json`：P5-2 的响应出口守卫（WRITE-GUARD）也包
         *   `res.json`，且它是 app 级中间件、**先于路由注册** ⇒ 若在路由里包 `res.json`，
         *   捕获到的是守卫**改写前**的体（可能含 `ok:true`）⇒ 重放会**绕过守卫**、
         *   回放一个本该被拦的"假成功"。`res.end` 是所有响应（含守卫改写后）的唯一终点。
         *
         * ★★★ 2026-10-12（P5-B25，实测新增缺陷 —— 这条是**真问题，不是重构**）：
         *   这段原先是**直落**在函数尾部的顺序代码，于是**只有「INSERT 抢占成功」那一条路**
         *   会执行到它；而「键已存在」的 catch 分支一律 `return next()` ⇒ **直接跳出中间件**、
         *   **从不安装捕获钩子**。后果（已实测复现，非推断）：
         *     · 残留自愈路径（陈旧 pending 行被抢占后执行成功）⇒ 本次响应**无处落库**
         *       ⇒ 该键**永远停在 pending**（status_code=0、response_body 为 NULL）；
         *     · 同键重试 ⇒ 被判"处理中" 409（安全）；
         *     · 但**再等满 IDEM_STALE_SEC（600s）后**重试 ⇒ 又判为"崩溃残留"⇒ **再执行一次**
         *       ⇒ 重复记账 / 重复扣减库存，且响应是 200、无任何回放标记。
         *   即：**幂等保护在"超时残留"这条路径上会静默放行重复记账**，正是明令禁止的那一类。
         *   ⇒ 改为具名 `armCapture()`，并在**每一条「已取得本键所有权后继续执行」的路径**
         *     都挂上它（① 新鲜抢占成功 ② 残留抢占成功 ③ 冲突但行已消失），与响应出口一一对应。
         *   ★ `res.__idemArmed` 幂等护栏：多条路径可能都调用，只允许真正挂一次。 */
        const armCapture = () => {
            if (res.__idemArmed) return;
            res.__idemArmed = true;
            const origEnd = res.end.bind(res);
            res.end = function (chunk, encoding, cb) {
                if (!res.__idemDone) {
                    res.__idemDone = true;                 // 只捕获一次（res.end 可能被重入）
                    try {
                        const sc = res.statusCode || 200;
                        const ctype = String(res.getHeader('content-type') || '');
                        const isJson = /json/i.test(ctype);
                        if (sc >= 200 && sc < 300 && isJson && chunk) {
                            const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
                            JSON.parse(text);              // 只回放合法 JSON；解析失败则走释放分支
                            run('UPDATE idempotency_keys SET status_code = ?, response_body = ?, completed_at = now()'
                                + where, [sc, text, ...args])
                                .catch((e2) => console.error('idem 落响应失败（不影响业务）:', e2.message));
                        }
                        else {
                            run('DELETE FROM idempotency_keys' + where, args)
                                .catch((e2) => console.error('idem 释放失败（不影响业务）:', e2.message));
                        }
                    }
                    catch (e) {
                        console.error('idem 捕获失败（不影响业务）:', e.message);
                        run('DELETE FROM idempotency_keys' + where, args).catch(() => { });
                    }
                }
                return origEnd(chunk, encoding, cb);
            };
        };

        /* ① 抢占幂等键：借真实唯一索引做并发闸门（真实 23505 只能从驱动错误对象上拿）
         * ★★★ 2026-10-12（R16-A，老板「不得静默放行可能重复记账的操作」）：
         *   原实现对**非唯一冲突**的失败是 **fail-open** —— `return next()`，即
         *   「幂等表缺失 / 权限不足 / 连接池耗尽 / 锁等待超时 / DB 抖动」时**静默放行**。
         *   后果：用户双击两次 ⇒ 建两张单、扣两次库存，而两次都返回 `ok:true`，
         *   前端与守卫**都看不出异常**（守卫只看写失败台账，这两次写是"真成功"）。
         *   ⇒ 现改为 **fail-closed**：返回 503 且**不进入业务处理器**（一个字节都不写库）。
         *   ★ 代价与配套：若幂等表本身不可用，带幂等键的写请求会全部 503（可用性让位于数据安全）。
         *     为避免"全站写不了却查不出原因"，启动时另有 [[IDEM-SELFCHECK]] 显式自检告警。*/
        try {
            await idemExec(
                'INSERT INTO idempotency_keys (user_id, endpoint, client_request_id, req_hash, status_code) VALUES (?, ?, ?, ?, 0)',
                [uid, endpoint, crid, hash]);
        }
        catch (e) {
            if (!isUniqueViolation(e)) {
                console.error('[idem] 抢占失败 ⇒ 拒绝执行（fail-closed）:', e.message);
                return res.status(503).json({
                    ok: false, code: 'IDEM_UNAVAILABLE',
                    error: '提交保护暂时不可用，本次未执行任何写入，请稍后重试。',
                });
            }
            /* ★ 查已存在行也必须走 idemExec（抛错）——原用 safeExec，出错时返回 `{values: []}`，
             *   与「真的没有这一行」无法区分 ⇒ 会把「查询失败」当成「键已被释放」，
             *   于是**在唯一冲突这条路径上再次 fail-open**。 */
            let row;
            try {
                const r = await idemExec(
                    'SELECT req_hash, status_code, response_body, EXTRACT(EPOCH FROM (now() - created_at))::int FROM idempotency_keys'
                    + where, args);
                row = r.values && r.values[0];
            }
            catch (e2) {
                console.error('[idem] 状态查询失败 ⇒ 拒绝执行（fail-closed）:', e2.message);
                return res.status(503).json({
                    ok: false, code: 'IDEM_UNAVAILABLE',
                    error: '提交保护暂时不可用，本次未执行任何写入，请稍后重试。',
                });
            }
            if (!row) {
                /* 走到这里 = INSERT 撞了 23505、但行随后消失。释放只发生在「响应非 2xx 或非 JSON」
                 *   ⇒ 那一次并未成功 ⇒ 本次按新请求处理是安全的（等同改动前语义）。
                 * ⚠️ 这**不是**"异常放行"：真正的查询异常已被上面的 catch 拦死并 503。
                 *    留一条证据，便于日后核对这条罕见路径确实发生过。
                 * ★★★ 2026-10-12（P5-B25）：但**必须先把键重新立起来**再继续 ——
                 *   否则本次执行完，响应落库的 UPDATE 找不到行（影响 0 行）⇒ 键永久缺失
                 *   ⇒ 同键重试会 INSERT 成功并**再执行一次**（与残留路径同一类缺口）。
                 *   重建若撞唯一约束 = 并发方已立好那行 ⇒ 直接用它的即可，不报错。 */
                console.warn('[idem] 键在抢占后被释放（前一次未成功）⇒ 重建键并按新请求执行:', endpoint, crid);
                try {
                    await idemExec(
                        'INSERT INTO idempotency_keys (user_id, endpoint, client_request_id, req_hash, status_code) VALUES (?, ?, ?, ?, 0)',
                        [uid, endpoint, crid, hash]);
                }
                catch (e5) {
                    if (!isUniqueViolation(e5)) {
                        console.error('[idem] 重建键失败 ⇒ 拒绝执行（fail-closed）:', e5.message);
                        return res.status(503).json({
                            ok: false, code: 'IDEM_UNAVAILABLE',
                            error: '提交保护暂时不可用，本次未执行任何写入，请稍后重试。',
                        });
                    }
                    /* 并发方已立好 ⇒ 不作处理，继续（它会把响应落库） */
                }
                armCapture();
                return next();
            }
            const [h, sc, body, age] = row;
            if (String(h) !== hash)
                return res.status(409).json({
                    ok: false, code: 'IDEM_KEY_REUSED',
                    error: '同一次请求标识已用于内容不同的提交，本次未执行。请重新发起。',
                });
            if (Number(sc) > 0 && body) {                  // 真重放 ⇒ 原样回放，并显式标注
                res.set('X-Idempotent-Replay', '1');
                return res.status(Number(sc)).json(JSON.parse(body));
            }
            if (Number(age) > IDEM_STALE_SEC) {
                /* 崩溃残留 ⇒ 抢占后按新请求处理。
                 * ★ 必须**原子抢占并以 rowCount 为准**：原实现用 `run()`（吞错）后无条件 `next()`
                 *   ⇒ 若清理因 DB 抖动失败，行仍在，本次却照样执行 ⇒ 又一个 fail-open 窗口。
                 *   ⇒ 改为带条件的原子抢占（只有确实抢到了才继续，否则 409）。
                 *
                 * ★★★ 2026-10-12（P5-B25，实测新增缺陷）：抢占动作**原本是 DELETE** ⇒
                 *   行被删掉后，本次响应落库走的是
                 *     `UPDATE idempotency_keys SET status_code=?, response_body=? WHERE 同键`
                 *   —— 行已不存在 ⇒ **UPDATE 影响 0 行** ⇒ 这次成功执行**没留下任何记录**。
                 *   后果（实测复现，非推断）：同键再发一次 ⇒ INSERT 不再撞唯一约束 ⇒
                 *     **再执行一遍**（实测同一个客户被建了 2 行、HTTP 200 且无回放标记）。
                 *   即：**残留自愈这条路径会静默放行重复记账 / 重复扣减库存**，
                 *   正是老板明令禁止的那一类（"幂等机制发生异常时不得静默放行"）。
                 *
                 * ⇒ 改为**带条件的原子 UPDATE 抢占**（不再 DELETE）：
                 *     · 单条语句 ⇒ 与 DELETE 版同样原子，rowCount 仍是唯一判据；
                 *     · 行**留在库里**（status_code 复位为 0）⇒ 后续 res.end 的 UPDATE 能命中它，
                 *       把这次的真实响应落进 status_code / response_body ⇒ 同键重试得到**回放**；
                 *     · 业务失败时 res.end 会 DELETE 该行 ⇒ 键被释放，可重提（语义与新鲜路径一致）；
                 *     · 再崩一次也只是重新等满 IDEM_STALE_SEC **一次**（因 created_at 已刷新）。
                 *   净效果：残留路径与新鲜路径的幂等语义**完全一致**，不再有"键凭空消失"的窗口。 */
                let claimed = 0;
                try {
                    const d = await idemExec(
                        'UPDATE idempotency_keys SET created_at = now(), status_code = 0,'
                        + ' response_body = NULL, completed_at = NULL'
                        + where
                        + " AND status_code = 0 AND created_at < now() - interval '" + IDEM_STALE_SEC + " seconds'",
                        args);
                    claimed = Number(d.rowCount) || 0;
                }
                catch (e3) {
                    console.error('[idem] 抢占崩溃残留失败 ⇒ 拒绝执行（fail-closed）:', e3.message);
                    return res.status(503).json({
                        ok: false, code: 'IDEM_UNAVAILABLE',
                        error: '提交保护暂时不可用，本次未执行任何写入，请稍后重试。',
                    });
                }
                if (!claimed) {
                    console.warn('[idem] 抢占未取得独占权（并发或状态已变）⇒ 拒绝执行:', endpoint, crid);
                    return res.status(409).json({
                        ok: false, code: 'IDEM_IN_PROGRESS',
                        error: '同一请求正在处理中，请勿重复提交。',
                    });
                }
                /* ★★★ 必须挂捕获钩子后再 next()（P5-B25 缺陷修法）：
                 *   本路径是"我抢到了这枚陈旧键、马上要真正执行"，
                 *   与"INSERT 抢占成功"在语义上**完全等价** ⇒ 响应落库/失败释放的处置也必须一致。
                 *   原先直接 `return next()` 跳过了捕获安装 ⇒ 本次响应永不落库 ⇒
                 *   键永远 pending ⇒ 满 600s 后重试会被再次判为残留并**再执行一次**。 */
                armCapture();
                return next();
            }
            return res.status(409).json({
                ok: false, code: 'IDEM_IN_PROGRESS',
                error: '同一请求正在处理中，请勿重复提交。',
            });
        }

        armCapture();
        next();
    };
}
/* ==== IDEM-END ==== */

// 过滤敏感数据（根据权限返回 null 或脱敏值）—— 单字段版（保留，供逐字段调用）
const filterSensitiveData = (data, user, category, field) => {
    if (isAdminUser(user.role)) return data;
    const sensitivePerms = JSON.parse(user.sensitive_permissions || '{}');
    if (sensitivePerms[category]?.includes(field)) return data;
    return null;
};

/* ==================== 敏感字段统一脱敏：成本 / 毛利 ====================
 * 【可见性规则】（与前端 src/utils/perms.ts 的 canSeeCost / canSeeProfit 同源，两端一致）
 *   · 成本类字段 → admin / manager，或 sensitive_permissions.price 含 'cost_price'
 *   · 利润类字段 → admin / manager，或 sensitive_permissions.price 含 'profit'
 *   · 销售额 / 单数 / 欠款 / 库存数量 / 零售额 → 全店可见（沿用既有"数据全店可见"决策）
 *
 * 【为什么用全局响应脱敏，而不是逐个 handler 过滤】
 *   本项目历史上的真实缺陷正是"同一条规则只有部分接口落实"（/analysis/purchase|demand|performance
 *   做了过滤，另外 6 个接口漏了）。全局出口脱敏 ⇒ 新增接口 / 新增字段自动受保护，不会再漏。
 *
 * 【为什么置 null 而不是删键】
 *   老前端拿到 undefined 会抛错或渲染成 ¥0.00；置 null + 前端按权限隐藏，才既安全又不会误导。
 *   页面必须用 canSeeCost/canSeeProfit 判断后隐藏，否则会显示成"看起来是真的 0"。
 */
const KEY_COST = /cost/i;
const KEY_PROFIT = /(profit|margin)/i;
/* ★ 成本"派生字段"：名字里没有 cost，但值 = 数量 × 成本价，同样会泄露成本。
 * 例：/analysis/demand 的 est_amount = 建议补货 × (cost_price || sell_price)
 *     /analysis/demand 的 suggested_purchase_amount 同理
 *     /analysis/profit 的 net / today_net / month_net
 *       = 净销售额 − 成本 + 其他收入 − 其他支出
 *       虽然叫"净利润"看起来像另一回事，但它 = 毛利润 +（其他收入 − 其他支出），
 *       而其他收入/其他支出/净销售额三个字段**都是可见的** ⇒ 子账户可用
 *       profit = net − other_income + other_expense、cost = sales − profit 精确还原成本。
 *       （线上实测：子账户拿到 month_net=23212.09，与老板侧 month_profit 一字不差；
 *         net=17317.94 反推出 cost=318963.06，与老板侧完全一致。）
 * 用**精确键名白名单**而不是正则：正则 "est_amount" 会误伤 month_est_amount（销售折算，非成本）。
 * ⚠️ 新增任何"成本×数量"或"含成本加减"的派生字段时，必须同步登记到这里（或改名带上 cost）。
 * ⚠️ 注意 `net_amount`（= 销售额 + 退货额，**不含成本**）刻意不在本名单内，勿加。 */
const COST_DERIVED_KEYS = new Set(['est_amount', 'suggested_purchase_amount', 'net', 'today_net', 'month_net']);

function sensitiveFlags(user) {
    if (!user) return { cost: false, profit: false };
    const admin = isAdminUser(user.role);
    let price = [];
    try {
        const sp = typeof user.sensitive_permissions === 'string'
            ? JSON.parse(user.sensitive_permissions || '{}')
            : (user.sensitive_permissions || {});
        price = Array.isArray(sp?.price) ? sp.price : [];
    } catch { price = []; }
    return {
        cost: admin || price.includes('cost_price'),
        profit: admin || price.includes('profit'),
    };
}

/* ==================== 金额可见性：子账号只看数量、不看金额（2026-10-13 老板拍板）====================
 * 【老板需求】子账号：① 能看每个商品的**库存**；② 不能看**进货**信息；
 *   ③ 不能看**月销售额**，只显示每个商品的**销售数量**；④ 能看**自己的业绩**（此条原本已满足）。
 *
 * 【为什么用「作用域收窄 + 键名脱敏」而不是全局正则】
 *   全局把 `amount|sales` 一律置 null 会**误伤业务接口**：子账号开单、收款、看订单列表
 *   都必须看到金额（看不到就没法干活）。所以作用域**只圈定分析/财务报表类接口**，
 *   开单/订单/收款/付款等业务接口一律不碰。
 *
 * 【为什么键名正则里**不含** `qty|quantity|count`】
 *   老板明确要「只显示每个商品的销售数量」⇒ `total_qty / total_quantity / order_count /
 *   stock_quantity` 必须原样保留。反过来 `total_amount / final_amount / actual_sales /
 *   avg_price` 一律置 null ⇒ 正好得到「有量无额」。
 *
 * 【为什么置 null 而不是删键】
 *   与 scrubSensitive 同一理由：删键会让老前端渲染成 `undefined` / `NaN`，
 *   置 null + 前端按权限隐藏，才既安全又不会显示成"看起来是真的 0"。
 *   前端判据：src/utils/perms.ts 的 canSeeAmount()，两端必须同源。
 */
const AMOUNT_SCOPE = /^\/api\/(analysis\/(dashboard|sales|inventory|demand)|finance\/(summary|overview|supplier-reconciliation))/;
const KEY_AMOUNT = /amount|sales|money|revenue|price/i;

function scrubAmount(payload, seen) {
    if (payload === null || payload === undefined) return payload;
    if (typeof payload !== 'object') return payload;
    if (payload instanceof Date) return payload;
    if (seen.has(payload)) return payload;
    seen.add(payload);
    if (Array.isArray(payload)) return payload.map((v) => scrubAmount(v, seen));
    const out = {};
    for (const k of Object.keys(payload)) {
        if (KEY_AMOUNT.test(k)) { out[k] = null; continue; }   // ★ 只抹金额，不动 qty/count
        out[k] = scrubAmount(payload[k], seen);
    }
    return out;
}

function scrubSensitive(payload, flags, seen) {
    if (payload === null || payload === undefined) return payload;
    if (typeof payload !== 'object') return payload;
    if (payload instanceof Date) return payload;
    if (seen.has(payload)) return payload; // 防循环引用
    seen.add(payload);
    if (Array.isArray(payload)) return payload.map((v) => scrubSensitive(v, flags, seen));
    const out = {};
    for (const k of Object.keys(payload)) {
        if (!flags.cost && (KEY_COST.test(k) || COST_DERIVED_KEYS.has(k))) { out[k] = null; continue; }
        if (!flags.profit && KEY_PROFIT.test(k)) { out[k] = null; continue; }
        out[k] = scrubSensitive(payload[k], flags, seen);
    }
    return out;
}

// 全局出口脱敏器：注册在业务路由之前，覆盖全部接口（含未来新增）
// 同时写 X-Sensitive-Filtered 响应头：数组形态的响应没法带 body 标记，前端靠这个头判断
// （配合 cors({ exposedHeaders }) 才能在跨域下被前端读到）
app.use((req, res, next) => {
    const orig = res.json.bind(res);
    res.json = (payload) => {
        try {
            if (req.user) { // 未登录请求（login/verify）没有敏感数据，不加工、不加标记
                const flags = sensitiveFlags(req.user);
                const hidden = [
                    ...(flags.cost ? [] : ['cost']),
                    ...(flags.profit ? [] : ['profit']),
                ];
                /* ★ 金额门（2026-10-13）：子账号在分析/报表类接口上看不到金额，只看数量。
                 * 与 cost/profit **是两条独立的门**：
                 *   · cost / profit —— 由 sensitive_permissions 逐项授予，**全接口生效**（防成本泄露）；
                 *   · amount —— 只认角色（子账号一律无），且**只在 AMOUNT_SCOPE 圈定的路径生效**
                 *     （开单/订单/收款等业务接口不碰，否则子账号没法干活）。
                 * 两条门都不需要动时直接原样返回，省掉一次深拷贝（大响应体上有实测意义）。 */
                const hideAmount = !isAdminUser(req.user.role) && AMOUNT_SCOPE.test(req.path);
                if (!hideAmount && !hidden.length) {
                    res.setHeader('X-Sensitive-Filtered', '');
                    return orig(payload);
                }
                // 头只在"确实做了脱敏"时出现 → 前端语义：有头=已脱敏(隐藏)，无头=未脱敏(可见)
                const tags = hidden.length ? [...hidden] : [];
                if (hideAmount) tags.push('amount');
                res.setHeader('X-Sensitive-Filtered', tags.join(','));
                {
                    let out = payload;
                    if (hidden.length) out = scrubSensitive(out, flags, new WeakSet());
                    if (hideAmount) out = scrubAmount(out, new WeakSet());
                    if (out && typeof out === 'object' && !Array.isArray(out)) {
                        out._sensitive_filtered = tags;
                    }
                    return orig(out);
                }
            }
        } catch (e) {
            console.error('[sensitive] 脱敏失败，已按原样返回并在前端隐藏:', req.path, e?.message);
        }
        return orig(payload);
    };
    next();
});

// 允许「任一权限命中」的守卫：用于跨模块共用的只读接口
// 例：打印小票/进货单需要店铺名称，开单页(sales) 与 系统设置(settings) 都得能取到
function requireAnyPerm(perms) {
    return (req, res, next) => {
        if (!req.user) return res.status(401).json({ error: '未授权' });
        const p = parsePerms(req.user);
        if (perms.some((x) => p.includes(x))) return next();
        return res.status(403).json({ error: '无权限：该功能未开放给当前账号' });
    };
}

// ==================== AUTH ====================
app.get('/api/auth/verify', async (_req, res) => {
    try {
        await initDB();
    }
    catch { }
    saveDB();
    res.json({ ok: true });
});
app.post('/api/auth/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        /* ★ 2026-10-13 P6-01 / P6-02 修复（老板授权「依次进行」后新增，最小增量）
         *
         * ① **入参硬校验**（P6-01）
         *    原先畸形体（`{}` / 非字符串 / 空串）会一路走到下面的
         *    `username.replace(...)` 抛 `TypeError` ⇒ 被本路由的 catch 兜成 **HTTP 500**。
         *    但这是**客户端错误**，语义应为 **400**；且该路由**免鉴权**（登录前）
         *    ⇒ 任何人都能刷出 500（日志噪音 / 告警疲劳 / 掩盖真实 5xx）。
         *    ★ 实测（生产 `p6-prod-verify` B2/B3）：`POST {}`、`POST {username:{a:1}}`
         *      都返回 500 且 Content-Type 为 JSON（**不泄漏堆栈**——错误出口修复仍生效）。
         *
         * ② **字符串拼接 SQL → 参数化查询**（P6-02）
         *    原写法 `'${username.replace(/'/g, "''")}'` 手动转义单引号：
         *    **实测转义正确、无实际注入**，但属危险模式（漏一处转义即注入，
         *    且审查时无法一眼判断安全性）。本文件 `safeExec(sql, params)` 原生支持传参 ⇒ 改用它。
         *
         * ★ 反向对照（判据有牙齿）：修复前 `POST /api/auth/login {}` ⇒ 500；
         *   修复后必须 **400 且 code=LOGIN_BAD_INPUT**。由 `p6-prod-verify.cjs` 持续覆盖。 */
        if (typeof username !== 'string' || typeof password !== 'string' || username === '' || password === '') {
            return res.status(400).json({ ok: false, code: 'LOGIN_BAD_INPUT', error: '请输入用户名与密码' });
        }
        await initDB();
        const result = await safeExec('SELECT * FROM users WHERE username = ?', [username]);
        const user = result.values?.[0];
        if (!user)
            return res.status(401).json({ error: '用户名或密码错误' });
        const id = user[0];
        const storedHash = user[2];
        const realName = user[3];
        const role = user[4];
        const status = parseInt(user[7]);
        if (status !== 1)
            return res.status(403).json({ error: '账户已被禁用' });
        // [安全] 移除历史硬编码万能密码后门，仅允许 bcrypt 校验
        const isValid = bcrypt.compareSync(password, storedHash);
        if (!isValid)
            return res.status(401).json({ error: '用户名或密码错误' });
        await run("UPDATE users SET last_login = datetime('now','localtime') WHERE id = ?", [id]);
        saveDB();
        // [修复 2026-09-27] permissions 统一为数组形态。
        // 原实现把 DB 里的 JSON 字符串原样放进 token 与响应体，而 /api/auth/me 返回的是数组
        // （parsePerms）⇒ 同一字段两种类型，前端两处消费行为不一致。
        let permissions = [];
        try { const _p = JSON.parse(user[10] || '[]'); permissions = Array.isArray(_p) ? _p : []; } catch { permissions = []; }
        const payload = { id, username, real_name: realName, role, permissions };
        const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
        res.json({ token, user: { ...payload, status } });
    }
    catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ error: '服务器错误' });
    }
});
app.get('/api/auth/me', authMiddleware, (req, res) => res.json({ ...req.user, permissions: parsePerms(req.user) }));
// Users management
app.get('/api/auth/users', authMiddleware, adminOnly, async (req, res) => {
    await initDB();
    const result = await safeExec("SELECT id, username, real_name, role, phone, email, status, created_at, last_login, permissions, COALESCE(commission_rate,0), sensitive_permissions FROM users ORDER BY id");
    const users = (result.values || []).map((u) => ({
        id: u[0], username: u[1], real_name: u[2], role: u[3], phone: u[4], email: u[5], status: parseInt(u[6]) || 0, created_at: u[7], last_login: u[8], permissions: parsePerms({ role: u[3], permissions: u[9] }), commission_rate: Number(u[10]) || 0, sensitive_permissions: JSON.parse(u[11] || '{}')
    }));
    res.json(users);
});
app.post('/api/auth/users', authMiddleware, adminOnly, async (req, res) => {
    await initDB();
    const { username, password, real_name, role, phone, email, permissions } = req.body;
    // [安全] 创建用户必须显式提供密码，不再回退到默认密码
    if (!password) return res.status(400).json({ error: '必须提供初始密码' });
    const hashedPassword = await bcrypt.hash(password, 10);
    const perms = JSON.stringify(Array.isArray(permissions) ? permissions : (role === 'employee' ? DEFAULT_EMPLOYEE_PERMS : ALL_PERMS));
    await run("INSERT INTO users (username, password, real_name, role, phone, email, permissions, status) VALUES (?, ?, ?, ?, ?, ?, ?, 1)", [username, hashedPassword, real_name, role || 'employee', phone, email, perms]);
    saveDB();
    saveDB();
    res.json({ ok: true });
});
app.put('/api/auth/users/:id', authMiddleware, adminOnly, async (req, res) => {
    await initDB();
    const { id } = req.params;
    const { status, permissions, commission_rate, sensitive_permissions } = req.body;
    if (status !== undefined) {
        await run("UPDATE users SET status = ? WHERE id = ?", [status, id]);
    }
    if (Array.isArray(permissions)) {
        await run("UPDATE users SET permissions = ? WHERE id = ?", [JSON.stringify(permissions), id]);
    }
    if (commission_rate !== undefined) {
        await run("UPDATE users SET commission_rate = ? WHERE id = ?", [commission_rate, id]);
    }
    if (sensitive_permissions !== undefined) {
        await run("UPDATE users SET sensitive_permissions = ? WHERE id = ?", [JSON.stringify(sensitive_permissions), id]);
    }
    saveDB();
    res.json({ ok: true });
});
// 删除员工账号（不能删自己、不能删 admin 主账号）
app.delete('/api/auth/users/:id', authMiddleware, adminOnly, async (req, res) => {
    await initDB();
    const id = Number(req.params.id);
    if (id === Number(req.user.id))
        return res.status(400).json({ error: '不能删除当前登录账号' });
    const target = (await safeExec("SELECT username, role FROM users WHERE id = ?", [id])).values?.[0];
    if (!target)
        return res.status(404).json({ error: '用户不存在' });
    if (String(target[0]) === 'admin')
        return res.status(400).json({ error: '不能删除主管理员账号' });
    await run("UPDATE sales_orders SET operator_id = NULL, operator_name = NULL WHERE operator_id = ?", [id]);
    await run("UPDATE purchase_orders SET operator_id = NULL, operator_name = NULL WHERE operator_id = ?", [id]);
    await run("UPDATE transactions SET operator_id = NULL, operator_name = NULL WHERE operator_id = ?", [id]);
    await run("DELETE FROM users WHERE id = ?", [id]);
    saveDB();
    saveDB();
    res.json({ ok: true });
});
app.put('/api/auth/password', authMiddleware, async (req, res) => {
    await initDB();
    const { oldPassword, newPassword } = req.body;
    /* ★ B0-5（P1-05）：入参硬校验。修复前字段缺失 ⇒ `bcrypt.compareSync(undefined, hash)` 抛
     *   「Illegal arguments: undefined, string」⇒ 本路由无 try/catch ⇒ Express 默认错误页把
     *   **完整调用栈 ＋ 绝对路径**回给了客户端（实测 HTTP 500 ＋ text/html）。
     *   ⚠️ 刻意**不加口令长度/复杂度规则**（属行为变更，会打断现有弱口令用户自助改密）
     *   ⇒ 已登记为待拍板 D6（见冲刺报告 §12）。本条只做「必填 ＋ 类型」。*/
    if (typeof oldPassword !== 'string' || typeof newPassword !== 'string' || oldPassword === '' || newPassword === '')
        return res.status(400).json({ ok: false, error: '原密码与新密码必填，且必须为字符串' });
    const result = await safeExec("SELECT password FROM users WHERE id = ?", [req.user.id]);
    const user = result.values?.[0];
    if (!user)
        return res.status(404).json({ error: '用户不存在' });
    const isValid = bcrypt.compareSync(oldPassword, user[0]);
    if (!isValid)
        return res.status(400).json({ error: '原密码错误' });
    const newHash = await bcrypt.hash(newPassword, 10);
    await run("UPDATE users SET password = ? WHERE id = ?", [newHash, req.user.id]);
    saveDB();
    saveDB();
    res.json({ ok: true });
});
// ==================== INVENTORY ====================
/**
 * ★ 2026-10-14 新增（老板录屏对标智慧记「商品详情」）：
 *   商品**库存流水 + 成本明细**。
 *
 * 为什么要它：老板反馈「商品…无法查看历史成本不一致，只有收起没有每笔的详情」——
 *   智慧记的商品详情有「库存分布 / 库存流水 / 成本明细」三个 tab，
 *   其中**成本明细**逐笔列出「数量 / 单价 / 结余 / 单位成本」，能看出加权平均是怎么滚出来的。
 *
 * 口径（与智慧记成本明细一致）：
 *   · 入库（进货）：移动加权平均 —— 新单位成本 = (结余金额 + 本次金额) / (结余数量 + 本次数量)
 *   · 出库（销售）：单位成本不变，结余数量与金额同减（沿用当时成本）
 *   · 退货（销售退货→入库 / 进货退货→出库）分别按同向处理
 *   · 结余 = 逐笔滚动累计，最后一行即当前库存与当前成本
 *
 * 参数：:id 商品 id ｜ 可选 limit（默认 200，最近的）
 * 返回：{ product, rows:[{date, order_number, type, qty, price, cost_unit, balance_qty, balance_amount}], summary }
 */
/**
 * ★ 2026-10-14 新增（老板录屏对标智慧记「商品详情」）—— v2
 *   商品**库存流水 + 成本明细**。
 *
 * 为什么要有它：老板反馈「商品…无法查看历史成本不一致，只有收起没有每笔的详情」。
 *   智慧记的商品详情有「库存分布 / 库存流水 / 成本明细」三个 tab，
 *   其中**成本明细**逐笔列出「数量 / 单价 / 结余 / 单位成本」，看得出加权平均怎么滚出来。
 *
 * 口径（与智慧记一致）：
 *   · 入库（进货 / 销售退货 / 盘点盘盈）：移动加权平均 —— 新单位成本 = (结余金额 + 本次金额) / (结余数量 + 本次数量)
 *   · 出库（销售 / 盘点盘亏）：单位成本不变，结余数量与金额同减
 *   · **锚定**：流水结余必须等于商品表 `stock_quantity`；不符时差额记为「其他调整」
 *     （装配 / 拆分 / 回收等 —— `split_items` 无母件子件标记，无法单独判方向，
 *       用差额配平既守住"结余 == 库存"这个硬判据，也不虚构明细）
 *   · 负库存：单位成本沿用**最近一次有效成本**，不归零（v1 的缺陷）
 *
 * 参数：:id 商品 id ｜ 可选 limit（默认 200，取最近若干笔）
 * 返回：{ product, rows:[{date,order_number,type,qty,price,cost_unit,balance_qty,balance_amount}],
 *         summary, reconciled }
 */
app.get('/api/inventory/products/:id/ledger', authMiddleware, hasPerm('inventory_view'), async (req, res) => {
    await initDB();
    const pid = Number(req.params.id);
    if (!Number.isFinite(pid) || pid <= 0) return res.status(400).json({ error: '商品 id 不合法' });
    const limit = Math.min(2000, Math.max(10, Number(req.query.limit) || 200));

    try {
        const prods = await safeExec(
            "SELECT id, sku, name, spec, unit, stock_quantity, cost_price, sell_price FROM products WHERE id = ?", [pid]);
        const p = (prods.values || [])[0];
        if (!p) return res.status(404).json({ error: '商品不存在' });
        const product = {
            id: p[0], sku: p[1], name: p[2], spec: p[3], unit: p[4],
            stock_quantity: Number(p[5] || 0),
            cost_price: p[6] === null ? null : Number(p[6] || 0),
            sell_price: Number(p[7] || 0),
        };

        const pull = async (sql) => ((await safeExec(sql, [pid])).values || []).map((r) => ({
            d: String(r[0] || '').slice(0, 10), ts: String(r[1] || ''),
            no: r[2] || '', kind: r[3], qty: Number(r[4] || 0), price: Number(r[5] || 0),
        }));

        /* ① 采购入库 */
        const buys = await pull(
            "SELECT COALESCE(po.bill_date, substr(po.created_at,1,10)), po.created_at, po.order_number, 'purchase', poi.quantity, poi.unit_price " +
            "FROM purchase_order_items poi JOIN purchase_orders po ON po.id = poi.order_id " +
            "WHERE poi.product_id = ? AND COALESCE(po.payment_status,'') <> '作废'");

        /* ② 销售出库（销售退货单在 sales_orders.biz_type='sale_return'，单独走 ③） */
        const sells = await pull(
            "SELECT COALESCE(so.bill_date, substr(so.created_at,1,10)), so.created_at, so.order_number, 'sale', -soi.quantity, soi.unit_price " +
            "FROM sales_order_items soi JOIN sales_orders so ON so.id = soi.order_id " +
            "WHERE soi.product_id = ? AND COALESCE(so.payment_status,'') <> '作废' AND COALESCE(so.biz_type,'sale') <> 'sale_return'");

        /* ③ 销售退货（退回入库；成本按原成本回补，这里用当时成本价） */
        const backIn = await pull(
            "SELECT COALESCE(so.bill_date, substr(so.created_at,1,10)), so.created_at, so.order_number, 'return_in', ABS(soi.quantity), COALESCE(soi.cost_price, soi.unit_price) " +
            "FROM sales_order_items soi JOIN sales_orders so ON so.id = soi.order_id " +
            "WHERE soi.product_id = ? AND COALESCE(so.payment_status,'') <> '作废' AND COALESCE(so.biz_type,'sale') = 'sale_return'");

        /* ④ 盘点调整：difference = 实际 − 系统（正数为盘盈） */
        let checks = [];
        try {
            checks = await pull(
                "SELECT substr(COALESCE(ic.completed_at, ic.created_at),1,10), COALESCE(ic.completed_at, ic.created_at), ic.check_number, 'check', ici.difference, 0 " +
                "FROM inventory_check_items ici JOIN inventory_checks ic ON ic.id = ici.check_id " +
                "WHERE ici.product_id = ? AND COALESCE(ici.difference,0) <> 0");
        } catch (e) { checks = []; }

        const all = [...buys, ...sells, ...backIn, ...checks]
            .filter((r) => r.qty !== 0)
            .sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1
                           : a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));

        let bQty = 0, bAmt = 0, costUnit = product.cost_price || 0;
        const rows = all.map((r) => {
            const inbound = r.qty > 0;
            if (inbound) {
                if (r.price > 0) {
                    const nq = bQty + r.qty;
                    const na = bAmt + r.qty * r.price;
                    if (nq > 0) { bQty = nq; bAmt = na; costUnit = bAmt / bQty; }
                    else { bQty = nq; bAmt = na; }          // 负数库存：金额跟随，成本沿用上一次有效值
                } else { bQty += r.qty; }                    // 无价入库（盘点盘盈）：只加数量
            } else {
                const out = Math.abs(r.qty);
                bQty -= out;
                bAmt -= out * costUnit;
                if (bQty < 0) bAmt = bQty * costUnit;        // 负库存：金额与数量同向，不强行归零
            }
            return {
                date: r.d || '—', order_number: r.no || '—', type: r.kind,
                qty: Math.round(r.qty * 100) / 100,
                price: Math.round(r.price * 10000) / 10000,
                cost_unit: Math.round(costUnit * 10000) / 10000,
                balance_qty: Math.round(bQty * 100) / 100,
                balance_amount: Math.round(bAmt * 100) / 100,
            };
        });

        /* ⑤ 锚定商品表库存：差额记为「其他调整」，保证结余 == 库存 */
        let gapQty = Math.round((product.stock_quantity - bQty) * 100) / 100;
        if (Math.abs(gapQty) > 0.005) {
            bQty += gapQty;
            bAmt = bQty * costUnit;
            rows.push({
                date: '—', order_number: '—', type: 'other_adjust',
                qty: gapQty, price: 0,
                cost_unit: Math.round(costUnit * 10000) / 10000,
                balance_qty: Math.round(bQty * 100) / 100,
                balance_amount: Math.round(bAmt * 100) / 100,
            });
        }

        const last = rows.length ? rows[rows.length - 1] : null;
        res.json({
            product,
            rows: rows.slice(-limit),
            total: rows.length,
            reconciled: last ? Math.abs(last.balance_qty - product.stock_quantity) < 0.005 : true,
            summary: {
                in_qty: rows.filter((x) => x.qty > 0).reduce((s, x) => s + x.qty, 0),
                out_qty: rows.filter((x) => x.qty < 0).reduce((s, x) => s + Math.abs(x.qty), 0),
                balance_qty: last ? last.balance_qty : 0,
                balance_amount: last ? last.balance_amount : 0,
                unit_cost: last ? last.cost_unit : 0,
            },
        });
    } catch (e) {
        res.status(500).json({ error: '查询流水失败：' + (e && e.message ? e.message : '未知错误') });
    }
});

/* ==================== 库存流水（库存历史）2026-10-14 新增 ====================
 * 老板反馈原话：「库存怎么没有库存历史」—— 在库存模块里找不到「这个商品/这段时间
 * 货都怎么进出的」。智慧记对应能力：库存模块 → 库存统计（期初/库存新增/库存减少/期末结存）。
 *
 * 本接口是**跨商品**的流水台账，与 /api/inventory/products/:id/ledger 互补：
 *   · 那个回答「这个商品的成本是怎么滚出来的」（移动加权 + 锚定商品表库存）；
 *   · 本接口回答「这段时间所有货的进出明细」（可按商品/方向/日期筛）。
 *
 * ★★ 方向归一必须按**单据性质**，不能只看 quantity 正负 —— 实测库内：
 *     · 采购退货在 purchase_orders 里以 total_amount < 0 标记（9 张，非独立表）；
 *     · 销售退货在 sales_orders.biz_type='sale_return'（22 张，final_amount 为负）。
 *   若直接 SUM(quantity)，退货方向会反过来，看上去"退货也在进货"。
 *     purchase        → +|qty|   采购入库
 *     purchase_return → −|qty|   采购退货出库
 *     sale            → −|qty|   销售出库
 *     sale_return     → +|qty|   销售退货入库
 *     check           →  difference（盘盈为正、盘亏为负，保留原符号）
 *
 * 口径与既有页面一致：作废单排除（payment_status<>'作废'）、软删单排除（PO_ALIVE 同义）。
 * ========================================================================= */
app.get('/api/inventory/ledger', authMiddleware, hasPerm('inventory_view'), async (req, res) => {
    await initDB();
    const start = String(req.query.start_date || '').trim();
    const end = String(req.query.end_date || '').trim();
    const pid = Number(req.query.product_id) || 0;
    const kw = String(req.query.q || '').trim();
    const type = String(req.query.type || 'all').trim();
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(500, Math.max(10, Number(req.query.page_size) || 50));
    const lit = (s) => "'" + String(s).replace(/'/g, "''") + "'";

    /* 五源合并成统一流水（signed_qty = 带方向的库存变动量） */
    const flowSql = `
    WITH flow AS (
        SELECT COALESCE(po.bill_date, substr(po.created_at,1,10)) AS d,
               COALESCE(po.bill_date, substr(po.created_at,1,10)) || ' ' || COALESCE(po.created_at,'') AS ts,
               po.order_number AS no, poi.product_id AS pid, poi.product_name AS pname,
               COALESCE(poi.spec,'') AS spec, COALESCE(NULLIF(poi.unit,''), pu.unit, '') AS unit,
               CASE WHEN COALESCE(po.total_amount,0) < 0 THEN 'purchase_return' ELSE 'purchase' END AS kind,
               poi.quantity AS raw_qty, poi.unit_price AS price, poi.amount AS amt,
               COALESCE(po.supplier_name,'') AS party
        FROM purchase_order_items poi
        JOIN purchase_orders po ON po.id = poi.order_id
        LEFT JOIN products pu ON pu.id = poi.product_id
        WHERE COALESCE(po.payment_status,'') <> '作废'
          AND (po.status IS NULL OR po.status NOT IN ('cancelled','void'))
        UNION ALL
        SELECT COALESCE(so.bill_date, substr(so.created_at,1,10)),
               COALESCE(so.bill_date, substr(so.created_at,1,10)) || ' ' || COALESCE(so.created_at,''),
               so.order_number, soi.product_id, soi.product_name,
               COALESCE(soi.spec,''), COALESCE(NULLIF(soi.unit,''), su.unit, ''),
               CASE WHEN COALESCE(so.biz_type,'sale') = 'sale_return' THEN 'sale_return' ELSE 'sale' END,
               soi.quantity, soi.unit_price, soi.amount,
               COALESCE(so.customer_name,'')
        FROM sales_order_items soi
        JOIN sales_orders so ON so.id = soi.order_id
        LEFT JOIN products su ON su.id = soi.product_id
        WHERE COALESCE(so.payment_status,'') <> '作废'
        UNION ALL
        SELECT substr(COALESCE(ic.completed_at, ic.created_at),1,10),
               COALESCE(ic.completed_at, ic.created_at),
               COALESCE(ic.check_number,''), ici.product_id, ici.product_name,
               '', '', 'check', ici.difference, 0, 0, ''
        FROM inventory_check_items ici
        JOIN inventory_checks ic ON ic.id = ici.check_id
        WHERE COALESCE(ici.difference,0) <> 0
    ), norm AS (
        /* ★★ 方向归一（2026-10-14 现场纠正，首版写错过）：
         *   首版用 ABS(qty) 再按 kind 定符号 ⇒ 出库算成 309,598.90，而销售明细实际只有
         *   199,390.18 —— 因为**销售单明细里本来就有 862 行是负数**（单内退货/红冲行）。
         *   一概 ABS 会把"单内退货"强行掰成"正常出库"，方向就反了。
         *
         *   ✅ 正确规则（用实测数据反推，不靠猜）：
         *      · 单据明细的 quantity **已自带正确方向**（相对该单据主方向）；
         *      · ⇒ 采购类（purchase / purchase_return）直接用 raw_qty；
         *        销售类（sale / sale_return）取 **−raw_qty**（销售是减库存）。
         *      自证：purchase 730 行 = +195,824.26；purchase_return 19 行 = −4,930.78；
         *            sale 6408 行 = +199,390.18（→出库）；sale_return 25 行 = −825.79（→入库）。
         *      负库存方向由符号自然表达，无需特判。 */
        SELECT d, ts, no, pid, pname, spec, unit, kind, party, price, amt,
               CASE WHEN kind IN ('sale', 'sale_return')
                    THEN -COALESCE(raw_qty, 0)
                    ELSE  COALESCE(raw_qty, 0)
               END AS signed_qty
        FROM flow
    )`;

    const cond = ['1=1'];
    if (start) cond.push(`d >= ${lit(start)}`);
    if (end) cond.push(`d <= ${lit(end)}`);
    if (pid > 0) cond.push(`pid = ${pid}`);
    if (kw) cond.push(`(pname LIKE ${lit('%' + kw + '%')} OR no LIKE ${lit('%' + kw + '%')})`);
    if (type === 'in') cond.push('signed_qty > 0');
    else if (type === 'out') cond.push('signed_qty < 0');
    else if (['purchase', 'purchase_return', 'sale', 'sale_return', 'check'].includes(type))
        cond.push(`kind = ${lit(type)}`);
    const W = cond.join(' AND ');

    try {
        const [aggRes, rowRes] = await Promise.all([
            safeExec(`${flowSql}
            SELECT COUNT(*),
                   COALESCE(SUM(CASE WHEN signed_qty > 0 THEN signed_qty ELSE 0 END),0),
                   COALESCE(SUM(CASE WHEN signed_qty < 0 THEN -signed_qty ELSE 0 END),0),
                   COALESCE(SUM(CASE WHEN signed_qty > 0 THEN signed_qty * COALESCE(price,0) ELSE 0 END),0),
                   COALESCE(SUM(CASE WHEN signed_qty < 0 THEN -signed_qty * COALESCE(price,0) ELSE 0 END),0),
                   COUNT(DISTINCT pid)
            FROM norm WHERE ${W}`),
            safeExec(`${flowSql}
            SELECT d, no, pid, pname, spec, unit, kind, party, signed_qty, price, amt
            FROM norm WHERE ${W}
            ORDER BY d DESC, ts DESC, no DESC
            LIMIT ? OFFSET ?`, [pageSize, (page - 1) * pageSize]),
        ]);
        const a = (aggRes.values || [])[0] || [];
        const R2 = (n) => Math.round(Number(n || 0) * 100) / 100;
        const KIND_LABEL = {
            purchase: '采购入库', purchase_return: '采购退货', sale: '销售出库',
            sale_return: '销售退货', check: '盘点调整',
        };
        res.json({
            rows: (rowRes.values || []).map((r) => ({
                date: r[0] || '—',
                order_number: r[1] || '—',
                product_id: Number(r[2]) || 0,
                product_name: r[3] || '',
                spec: r[4] || '', unit: r[5] || '',
                type: r[6], type_label: KIND_LABEL[r[6]] || r[6],
                party: r[7] || '',
                qty: R2(r[8]),
                direction: Number(r[8]) > 0 ? 'in' : 'out',
                price: R2(r[9]),
                /* 金额取明细自带的 amount（退货单为负）⇒ 展示只取绝对值，
                   方向由 direction 表达，避免「−×−」在界面上出现双重否定 */
                amount: R2(Math.abs(Number(r[10]) || 0)),
            })),
            summary: {
                total_rows: Number(a[0]) || 0,
                in_qty: R2(a[1]), out_qty: R2(a[2]),
                in_amount: R2(a[3]), out_amount: R2(a[4]),
                product_count: Number(a[5]) || 0,
            },
            total: Number(a[0]) || 0,
            page, page_size: pageSize,
            filter: { start_date: start, end_date: end, product_id: pid, q: kw, type },
        });
    } catch (e) {
        res.status(500).json({ error: '查询库存流水失败：' + (e && e.message ? e.message : '未知错误') });
    }
});

app.get('/api/inventory/products', authMiddleware, hasPerm('inventory_view'), async (req, res) => {
    await initDB();
    const { category, keyword, page = 1, pageSize = 50, withTotal, include_stopped } = req.query;
    // ★ 与智慧记同口径（2026-10-08）：默认隐藏已停用档（智慧记接口参数名 hide_stop）。
    //   宏瑞 status 取值：1=在用，2=停用（对齐智慧记），0=历史软删除标记（旧版「删除商品」遗留）。
    //   显式 include_stopped=1 时不叠加状态过滤，全部返回，由前端标注「已停用」并给「启用」入口。
    let where = include_stopped === '1' ? " WHERE 1=1" : " WHERE status = 1";
    if (category) {
        where += " AND category = '" + String(category).replace(/'/g, "''") + "'";
    }
    if (keyword) {
        const kw = String(keyword).replace(/'/g, "''");
        where += " AND (name LIKE '%" + kw + "%' OR sku LIKE '%" + kw + "%')";
    }
    const pg = Math.max(1, Number(page) || 1);
    const ps = Math.min(2000, Math.max(1, Number(pageSize) || 50));
    const result = await safeExec("SELECT * FROM products" + where + " ORDER BY id DESC LIMIT ? OFFSET ?", [ps, (pg - 1) * ps]);
    // 转换为对象格式
    const products = (result.values || []).map((p) => ({
        id: p[0], sku: p[1], name: p[2], category: p[3], spec: p[4], unit: p[5],
        cost_price: Number(p[6]), sell_price: Number(p[7]), stock_quantity: Number(p[8]),
        warning_quantity: Number(p[9]), batch_number: p[10], production_date: p[11],
        expiry_date: p[12], supplier_id: p[13], status: p[14], created_at: p[15], updated_at: p[16],
        wholesale_price: Number(p[17] || 0)
    }));
    // 追加式：带 withTotal=1 时返回 { rows, total, page, pageSize }；否则保持原数组返回（老调用不受影响）
    if (withTotal) {
        // ★ 性能（2026-10-04）：合并为 1 次往返
        const A = await scalars([{ key: 'total', sql: "SELECT COUNT(*) FROM products" + where }]);
        return res.json({ rows: products, total: Number(A.total || 0), page: pg, pageSize: ps });
    }
    res.json(products);
});
app.get('/api/inventory/products/warning', authMiddleware, hasPerm('inventory_view'), async (_req, res) => {
    await initDB();
    const result = await safeExec("SELECT * FROM products WHERE stock_quantity <= warning_quantity AND status = 1 ORDER BY stock_quantity ASC");
    const products = (result.values || []).map((p) => ({
        id: p[0], sku: p[1], name: p[2], category: p[3], spec: p[4], unit: p[5],
        cost_price: Number(p[6]), sell_price: Number(p[7]), stock_quantity: Number(p[8]),
        warning_quantity: Number(p[9]), batch_number: p[10], production_date: p[11],
        expiry_date: p[12], supplier_id: p[13], status: p[14], created_at: p[15], updated_at: p[16],
        wholesale_price: Number(p[17] || 0)
    }));
    res.json(products);
});
app.get('/api/inventory/products/batch', authMiddleware, hasPerm('inventory_view'), async (req, res) => {
    await initDB();
    const { keyword } = req.query;
    let sql = "SELECT * FROM products WHERE status = 1 AND batch_number IS NOT NULL";
    const params = [];
    if (keyword) {
        sql += " AND (batch_number LIKE '%" + String(keyword).replace(/'/g, "''") + "%' OR name LIKE '%" + String(keyword).replace(/'/g, "''") + "%')";
    }
    sql += " ORDER BY id DESC";
    const result = await safeExec(sql, params);
    const products = (result.values || []).map((p) => ({
        id: p[0], sku: p[1], name: p[2], category: p[3], spec: p[4], unit: p[5],
        cost_price: Number(p[6]), sell_price: Number(p[7]), stock_quantity: Number(p[8]),
        warning_quantity: Number(p[9]), batch_number: p[10], production_date: p[11],
        expiry_date: p[12], supplier_id: p[13], status: p[14], created_at: p[15], updated_at: p[16],
        wholesale_price: Number(p[17] || 0)
    }));
    res.json(products);
});
app.get('/api/inventory/products/expiry', authMiddleware, hasPerm('inventory_view'), async (req, res) => {
    await initDB();
    const { days = 30 } = req.query;
    // P4：保质期截止日 = 北京今天 + days（原走 UTC ⇒ 早 8 点前差一天）
    const endDate = bjDaysAgo(-(Number(days) || 30));
    const result = await safeExec("SELECT * FROM products WHERE status = 1 AND expiry_date IS NOT NULL AND expiry_date <= ? ORDER BY expiry_date ASC", [endDate]);
    const products = (result.values || []).map((p) => ({
        id: p[0], sku: p[1], name: p[2], category: p[3], spec: p[4], unit: p[5],
        cost_price: Number(p[6]), sell_price: Number(p[7]), stock_quantity: Number(p[8]),
        warning_quantity: Number(p[9]), batch_number: p[10], production_date: p[11],
        expiry_date: p[12], supplier_id: p[13], status: p[14], created_at: p[15], updated_at: p[16],
        wholesale_price: Number(p[17] || 0)
    }));
    res.json(products);
});
app.post('/api/inventory/products', authMiddleware, hasPerm('inventory_full'), async (req, res) => {
    await initDB();
    const { sku, name, category, spec, unit, cost_price, sell_price, stock_quantity, warning_quantity, batch_number, production_date, expiry_date, supplier_id, wholesale_price } = req.body;
    await run("INSERT INTO products (sku, name, category, spec, unit, cost_price, sell_price, stock_quantity, warning_quantity, batch_number, production_date, expiry_date, supplier_id, wholesale_price) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [sku, name, category, spec, unit, cost_price, sell_price, stock_quantity, warning_quantity, batch_number, production_date, expiry_date, supplier_id, wholesale_price || 0]);
    saveDB();
    saveDB();
    res.json({ ok: true });
});
app.put('/api/inventory/products/:id', authMiddleware, hasPerm('inventory_full'), async (req, res) => {
    await initDB();
    const { id } = req.params;
    const { sku, name, category, spec, unit, cost_price, sell_price, stock_quantity, warning_quantity, batch_number, production_date, expiry_date, supplier_id, wholesale_price } = req.body;
    /* ★★ 2026-10-11 P5-4（P3-05）：商品编辑盖库存 ⇒ 丢失更新。
     *   【缺陷实证】修复前该接口直接 `stock_quantity = ?` **绝对值覆盖**，而编辑页送上来的是
     *     **列表加载时的旧值** ⇒ 期间的开单/进货改动全被抹掉。
     *     实测：快照 100 → 期间真实开单卖 5（库存 95）→ 保存旧值 100 ⇒ 库存被写回 **100**（丢 5）。
     *   【修法（最小增量，不改任何字段口径）】整段进事务 + 行级排他锁 → 若客户端同时送了「打开时库存」
     *     `stock_quantity_baseline`，则在锁内比对：不一致 ⇒ 409 STOCK_CONFLICT 并回报当前值。
     *   【兼容】未送基线（旧 APK / 旧前端）一律保持旧行为，**不静默改契约**。
     *   【禁重构】字段列表与 `|| 0` 罚兑逐字保留。 */
    const hasNewStock = stock_quantity !== undefined && stock_quantity !== null && stock_quantity !== '';
    const hasBase = req.body.stock_quantity_baseline !== undefined && req.body.stock_quantity_baseline !== null && req.body.stock_quantity_baseline !== '';
    try {
        await withTx(async (tx) => {
            const cur = (await tx.q("SELECT stock_quantity FROM products WHERE id = ? FOR UPDATE", [id])).values?.[0];
            if (!cur) throw Object.assign(new Error('product not found'), { httpCode: 404, code: 'PRODUCT_NOT_FOUND', msg: '商品不存在' });
            const curStock = Number(cur[0]) || 0;
            if (hasNewStock && hasBase && Number(req.body.stock_quantity_baseline) !== curStock) {
                throw Object.assign(new Error('stock conflict'), {
                    httpCode: 409, code: 'STOCK_CONFLICT', current_stock: curStock,
                    msg: `库存已被其他操作改为 ${curStock}（你打开时是 ${Number(req.body.stock_quantity_baseline)}）⇒ 请刷新后重试`,
                });
            }
            await tx.run("UPDATE products SET sku=?, name=?, category=?, spec=?, unit=?, cost_price=?, sell_price=?, stock_quantity=?, warning_quantity=?, batch_number=?, production_date=?, expiry_date=?, supplier_id=?, wholesale_price=?, updated_at=datetime('now','localtime') WHERE id=?", [sku, name, category, spec, unit, cost_price, sell_price, stock_quantity, warning_quantity, batch_number, production_date, expiry_date, supplier_id, wholesale_price || 0, id]);
        });
    }
    catch (e) {
        if (e && e.httpCode) return res.status(e.httpCode).json({ ok: false, code: e.code, error: e.msg, current_stock: e.current_stock });
        console.error('[PRODUCTS-PUT] 保存失败，已整体回滚:', e.message);
        return res.status(500).json({ ok: false, code: 'PRODUCT_WRITE_FAILED', error: '保存失败，本次操作未生效（已整体回滚）' });
    }
    saveDB();
    saveDB();
    res.json({ ok: true });
});
// 商品 停用 / 启用（对齐智慧记的「停用商品」语义，2026-10-08）
//   · 智慧记：status 1=在用 / 2=停用，其商品列表接口默认 hide_stop=1（隐藏停用档）
//   · 宏瑞原「删除商品」实为软删除 status=0，但**没有任何界面能看到或恢复** ⇒ 误删即失联
//   · 本接口把「停用」变成可逆动作：1↔2；且历史 status=0 的档也一并在「显示已停用」视图出现并可用 1 恢复
app.put('/api/inventory/products/:id/status', authMiddleware, hasPerm('inventory_full'), async (req, res) => {
    await initDB();
    const { id } = req.params;
    const next = Number((req.body || {}).status);
    // ★ 只接受 1（在用）/ 2（停用）。0 是历史软删除标记，不作为可写值对外暴露。
    if (![1, 2].includes(next)) {
        return res.status(400).json({ error: 'status 只允许 1（在用）或 2（停用）' });
    }
    const row = (await safeExec("SELECT id FROM products WHERE id = ?", [id])).values?.[0];
    if (!row) {
        return res.status(404).json({ error: '商品不存在' });
    }
    await run("UPDATE products SET status = ?, updated_at = datetime('now','localtime') WHERE id = ?", [next, id]);
    saveDB();
    res.json({ ok: true, id: Number(id), status: next });
});
// 删除商品（软删除：status=0，保留历史订单引用）
app.delete('/api/inventory/products/:id', authMiddleware, hasPerm('inventory_full'), async (req, res) => {
    await initDB();
    const { id } = req.params;
    const target = (await safeExec("SELECT id FROM products WHERE id = ? AND status = 1", [id])).values?.[0];
    if (!target)
        return res.status(404).json({ error: '商品不存在' });
    await run("UPDATE products SET status = 0, updated_at = datetime('now','localtime') WHERE id = ?", [id]);
    saveDB();
    saveDB();
    res.json({ ok: true });
});
// Inventory checks
app.get('/api/inventory/checks', authMiddleware, hasPerm('inventory_view'), async (req, res) => {
    await initDB();
    const result = await safeExec("SELECT * FROM inventory_checks ORDER BY id DESC");
    res.json(result.values || []);
});
app.post('/api/inventory/checks', authMiddleware, adminOnly, idem('checks'), async (req, res) => {
    await initDB();
    const checkNumber = await generateOrderNumber('PD');
    // 获取刚插入的盘点单 ID（见 runLastId 注释：必须与 INSERT 同一条语句，避免连接池会话漂移）
    const checkId = await runLastId("INSERT INTO inventory_checks (check_number, operator_id) VALUES (?, ?)", [checkNumber, req.user.id]);
    // Get all products for the check
    const products = await safeExec("SELECT id, name, sku, stock_quantity FROM products WHERE status = 1");
    if (products.values) {
        for (const p of products.values) {
            await run("INSERT INTO inventory_check_items (check_id, product_id, product_name, sku, system_quantity) VALUES (?, ?, ?, ?, ?)", [checkId, p[0], p[1], p[2], p[3]]);
        }
    }
    saveDB();
    res.json({ ok: true, check_id: checkId });
});
app.get('/api/inventory/checks/:id/items', authMiddleware, hasPerm('inventory_view'), async (req, res) => {
    await initDB();
    const { id } = req.params;
    const result = await safeExec("SELECT * FROM inventory_check_items WHERE check_id = ? ORDER BY id", [id]);
    res.json(result.values || []);
});
app.post('/api/inventory/checks/:checkId/items', authMiddleware, adminOnly, async (req, res) => {
    await initDB();
    const { checkId } = req.params;
    const { product_id, actual_quantity, remark } = req.body;
    // [修复 2026-09-27] system_quantity 以数据库为准。
    // 原实现取 req.body.system_quantity：前端不传时为 undefined → NaN → `|| 0` ⇒ 差异恒为 0（错误）。
    // 改为缺省时从库里读该项的 system_quantity；实际数量未录入时差异存 NULL（配合 complete 的跳过逻辑）。
    let sysQty = req.body.system_quantity;
    if (sysQty === undefined || sysQty === null) {
        const row = await safeExec("SELECT system_quantity FROM inventory_check_items WHERE check_id = ? AND product_id = ?", [checkId, product_id]);
        sysQty = row.values?.[0]?.[0];
    }
    const diff = (actual_quantity === null || actual_quantity === undefined || sysQty === null || sysQty === undefined)
        ? null
        : (Number(actual_quantity) - Number(sysQty));
    await run("UPDATE inventory_check_items SET actual_quantity=?, difference=?, remark=? WHERE check_id=? AND product_id=?", [actual_quantity, diff, remark, checkId, product_id]);
    saveDB();
    res.json({ ok: true });
});
app.put('/api/inventory/checks/:id/complete', authMiddleware, adminOnly, async (req, res) => {
    await initDB();
    const { id } = req.params;
    /* ★★ 2026-10-11 P5-4（P3-06）：盘点完成**可重入** ⇒ 会把盘点之后发生的开单抹掉。
     *   【缺陷实证】修复前对同一张盘点单可反复 complete，每次都把
     *     `stock_quantity = actual_quantity`（绝对值）再写一遍 ⇒
     *     盘点完成后真实开单卖 5（库存 50→45）再点一次「完成」，库存被拉回 **50**（那 5 件凭空回来）。
     *   【语义】盘点是**快照**，只能应用一次；重复应用不是「幂等」（库存会随之后的业务变动而变）。
     *   【修法】① 锁定盘点单并校验状态：已 completed ⇒ 409（说清楚已完成时间与当时应用数）
     *     ② 明细取数与回写同事务，中途失败整体回滚（不留「半盘」库存）
     *     ③ **不改字段口径**：仍只回写 actual_quantity 非空的项（2026-09-27 的 NULL 保护逐字保留） */
    // [修复 2026-09-27] 只回写「已录入实际数量」的项。
    // 原实现 SELECT 全部明细后无条件 UPDATE：未录入项(actual_quantity IS NULL)会把
    // products.stock_quantity 直接写成 NULL = 清空库存。
    // 实测本库盘点单 #2（PD202609271812）有 119 项全部未录入 ⇒ 一点「完成」即清空 119 个商品库存。
    let applied = 0, skipped = 0;
    try {
        const out = await withTx(async (tx) => {
            const chk = (await tx.q("SELECT status, completed_at FROM inventory_checks WHERE id = ? FOR UPDATE", [id])).values?.[0];
            if (!chk) throw Object.assign(new Error('check not found'), { httpCode: 404, code: 'CHECK_NOT_FOUND', msg: '盘点单不存在' });
            if (String(chk[0] || '') === 'completed')
                throw Object.assign(new Error('already completed'), { httpCode: 409, code: 'CHECK_ALREADY_COMPLETED', msg: `该盘点单已于 ${chk[1] || '更早'} 完成过，不能重复完成（重复应用会抹掉盘点后发生的开单改动）。如需重盘，请新建一张盘点单。` });
            const items = (await tx.q("SELECT product_id, actual_quantity FROM inventory_check_items WHERE check_id = ? AND actual_quantity IS NOT NULL", [id])).values || [];
            let n = 0;
            for (const item of items) {
                await tx.run("UPDATE products SET stock_quantity = ?, updated_at=datetime('now','localtime') WHERE id = ?", [item[1], item[0]]);
                n++;
            }
            const sk = (await tx.q("SELECT count(*) FROM inventory_check_items WHERE check_id = ? AND actual_quantity IS NULL", [id])).values?.[0]?.[0];
            await tx.run("UPDATE inventory_checks SET status='completed', completed_at=datetime('now','localtime') WHERE id=?", [id]);
            return { n, sk: Number(sk || 0) };
        });
        applied = out.n; skipped = out.sk;
    }
    catch (e) {
        if (e && e.httpCode) return res.status(e.httpCode).json({ ok: false, code: e.code, error: e.msg });
        console.error('[CHECKS-COMPLETE] 盘点完成失败，已整体回滚:', e.message);
        return res.status(500).json({ ok: false, code: 'CHECK_WRITE_FAILED', error: '盘点完成失败，本次操作未生效（已整体回滚）' });
    }
    saveDB();
    res.json({ ok: true, applied, skipped });
});
/* ══════════════ 组装 / 拆分（2026-10-08 补实现；此前是 TODO 空壳） ══════════════
 * 旧实现（两个端点一模一样）：
 *     const { items, operator_id } = req.body;
 *     // TODO: implement assembly logic
 *     saveDB();  res.json({ ok: true });
 *   ⇒ 只回成功、**不扣组件、不加成品、不落表**。
 *   前端靠「提交后回读库存前后对比」自检并把缺口实情说出来（不说假成功），
 *   但对任何直接调接口的调用方（脚本 / 自动化 / 以后的导入器）仍是**假成功**。
 *
 * 三条必须守住的点：
 *   ① **先全量校验、再写库**：校验不过一律 400 且一行都不写 ⇒ 不留半成品；
 *   ② **写库禁use run()**：run() 会把异常吞掉（只打日志，接口照样回 200）——
 *      这正是本项目反复踩过的「静默失败」。这里统一用 safeExec + RETURNING
 *      显式确认落库；返回 0 行即视为写入失败。
 *   ③ **中途失败补偿回滚**：把已改过的库存按反向量改回去再回 500；宁可全退，
 *      也不留「组件扣了、成品没加」的半截状态。
 *
 * 库存增减一律写 `stock_quantity = stock_quantity ± ?`（Postgres 原子读改写），
 * 不用「先 SELECT 再 UPDATE」，避免并发下丢更新。
 * 扣减用条件更新 `WHERE id = ? AND stock_quantity >= ?` 并校验影响行数：
 * 0 行即库存不足 ⇒ 中止。判据与前端 problems 完全一致，两端不各说各话。
 * ============================================================================ */

/** 库存表统一时间戳（translateSQL 会转成 PG 的 to_char(now() AT TIME ZONE 'Asia/Shanghai'...)） */
const STOCK_TS = "datetime('now','localtime')";

/** 读若干商品的名称与当前库存 ⇒ Map<id, { name, stock }> */
async function loadStockMap(ids) {
    const uniq = [...new Set(ids.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0))];
    if (!uniq.length) return new Map();
    const r = await safeExec(
        `SELECT id, name, stock_quantity FROM products WHERE id IN (${uniq.map(() => '?').join(',')})`,
        uniq
    );
    const m = new Map();
    for (const row of (r.values || [])) {
        m.set(Number(row[0]), { name: row[1], stock: Number(row[2]) || 0 });
    }
    return m;
}
/* 返回值的三种含义必须分清（本项目「假通过」教训）：
 *   number  = 成功，列为改后的库存
 *   null    = **业务性失败**（库存不足 / 商品不存在）⇒ 中止并回 400，不要重试
 *   抛异常  = 基础设施失败（连不上库等）⇒ 走补偿回滚并回 500
 * safeExec 自身吞异常返回空数组，所以这里把「空结果」也当成异常抛出，
 * 否则基础设施故障会被误判成「库存不足」，给出一个错误的业务解释。 */
async function decStock(productId, qty) {
    const r = await safeExec(
        `UPDATE products SET stock_quantity = stock_quantity - ?, updated_at = ${STOCK_TS} WHERE id = ? AND stock_quantity >= ? RETURNING stock_quantity`,
        [qty, productId, qty]
    );
    if (!r.values) throw new Error('库存更新未返回结果（疑似数据库连接失败）');
    if (!r.values.length) return null;
    return Number(r.values[0][0]);
}
async function incStock(productId, qty) {
    const r = await safeExec(
        `UPDATE products SET stock_quantity = stock_quantity + ?, updated_at = ${STOCK_TS} WHERE id = ? RETURNING stock_quantity`,
        [qty, productId]
    );
    if (!r.values) throw new Error('库存更新未返回结果（疑似数据库连接失败）');
    if (!r.values.length) return null;
    return Number(r.values[0][0]);
}
/** 把已生效的库存改动按反向量改回去（回滚）。返回未能复原的条数。 */
async function rollbackStocks(applied) {
    let failed = 0;
    for (const a of applied.slice().reverse()) {
        try {
            const r = await safeExec(
                `UPDATE products SET stock_quantity = stock_quantity + ?, updated_at = ${STOCK_TS} WHERE id = ? RETURNING stock_quantity`,
                [-a.delta, a.product_id]     // delta 为负⇒反向加回去
            );
            if (!r.values || !r.values.length) failed++;
        } catch { failed++; }
    }
    return failed;
}
/** 明细数量：必须是大于 0 的整数。
 *  quantity 列在 assemblies/assembly_items/splits/split_items 里都是 bigint，
 *  小数会被 Postgres 直接拒绝（500）⇒ 在校验阶段就说清楚，而不是让它变成数据库报错。 */
function parseQtyIn(raw, label, errs) {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) { errs.push(`${label}数量必须为大于 0 的数字`); return null; }
    if (!Number.isInteger(n)) { errs.push(`${label}数量必须为整数（数量列为整数列，小数会被数据库拒绝）`); return null; }
    return n;
}
/** 按 product_id 合并重复行（同商品多行相加），保持首次出现顺序 */
function mergeByPid(rows) {
    const idx = new Map(), out = [];
    for (const r of rows) {
        if (idx.has(r.product_id)) out[idx.get(r.product_id)].quantity += r.quantity;
        else { idx.set(r.product_id, out.length); out.push({ ...r }); }
    }
    return out;
}

/* ★ 2026-10-09 权限放开（老板拍板第 3 项）：adminOnly → hasPerm('inventory_full')
 *   为什么：菜单里「组装操作 / 拆分操作」两项的可见性一直由 **inventory_full** 控制，
 *   而后端两条 POST 是 **adminOnly** —— 两层判据不同源。后果是：
 *     配了 inventory_full 的子账号**看得见菜单、点得进页面、填得完表单**，
 *     点「确认组装」却收到 403 「该功能仅管理员可用」。用户拿到的解释是"没权限"，
 *     而菜单明明给了他这个入口 —— 这是**界面在骗人**，不是权限设计。
 *   两条路由的写库逻辑本身就带「先全量校验 + 中途失败补偿回滚」，放开给 inventory_full
 *   不降低安全性（仍是登录态 + 权限位），且与盘点（inventory_full）同档。
 *   反向对照：DELETE/PUT 类危险动作仍全在 adminOnly，不受本次影响。 */
app.post('/api/inventory/assemblies', authMiddleware, hasPerm('inventory_full'), async (req, res) => {
    await initDB();
    const operatorId = Number(req.body?.operator_id) || req.user.id;
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    const errs = [];
    if (!items.length) errs.push('items 不能为空');

    const compsRaw = [], prodsRaw = [];
    for (const it of items) {
        const pid = Number(it?.product_id);
        if (!Number.isInteger(pid) || pid <= 0) { errs.push('明细中存在无效的 product_id'); continue; }
        const isComp = Number(it?.is_component) === 1;
        const q = parseQtyIn(it?.quantity, isComp ? '组件' : '成品', errs);
        if (q === null) continue;
        (isComp ? compsRaw : prodsRaw).push({ product_id: pid, quantity: q, is_component: isComp ? 1 : 0 });
    }
    const comps = mergeByPid(compsRaw);
    const prods = mergeByPid(prodsRaw);
    if (!prods.length) errs.push('必须指定一个成品（is_component=0）');
    if (!comps.length) errs.push('至少需要一个组件（is_component=1）');
    const compIds = new Set(comps.map((c) => c.product_id));
    for (const p of prods) {
        if (compIds.has(p.product_id)) errs.push(`商品 #${p.product_id} 不能同时作为成品和组件`);
    }

    const stock = await loadStockMap([...comps, ...prods].map((x) => x.product_id));
    for (const x of [...comps, ...prods]) {
        if (!stock.has(x.product_id)) errs.push(`商品 #${x.product_id} 不存在或已停用`);
    }
    // 组件库存必须充足（与前端 problems 同一判据）
    for (const c of comps) {
        const s = stock.get(c.product_id);
        if (s && s.stock < c.quantity) {
            errs.push(`组件「${s.name}」库存不足（需 ${c.quantity}，现有 ${s.stock}）`);
        }
    }
    if (errs.length) return res.status(400).json({ error: errs.join('；'), errors: errs });

    // ── 落库（先写头、再写明细、最后动库存；任何一步失败都回滚） ──
    const number = await generateOrderNumber('ZZD');
    const insHead = await safeExec(
        `INSERT INTO assemblies (assembly_number, operator_id, created_at) VALUES (?, ?, ${STOCK_TS}) RETURNING id`,
        [number, operatorId]
    );
    const assemblyId = insHead.values?.[0]?.[0];
    if (!assemblyId) return res.status(500).json({ error: '组装单头写入失败' });

    const applied = [];
    try {
        for (const x of [...comps, ...prods]) {
            const r = await safeExec(
                "INSERT INTO assembly_items (assembly_id, product_id, quantity, is_component) VALUES (?, ?, ?, ?) RETURNING id",
                [assemblyId, x.product_id, x.quantity, x.is_component]
            );
            if (!r.values || !r.values.length) throw new Error(`明细写入失败（商品 #${x.product_id}）`);
        }
        const changes = [];
        for (const c of comps) {
            const after = await decStock(c.product_id, c.quantity);
            if (after === null) {
                const s = stock.get(c.product_id);
                throw Object.assign(new Error(`组件「${s ? s.name : '#' + c.product_id}」库存不足（需 ${c.quantity}，现有 ${s ? s.stock : 0}）`), { biz: true });
            }
            applied.push({ product_id: c.product_id, delta: -c.quantity });
            changes.push({ product_id: c.product_id, name: stock.get(c.product_id)?.name, before: stock.get(c.product_id)?.stock, after });
        }
        for (const p of prods) {
            const after = await incStock(p.product_id, p.quantity);
            if (after === null) throw new Error(`成品写入库存失败（商品 #${p.product_id}）`);
            applied.push({ product_id: p.product_id, delta: p.quantity });
            changes.push({ product_id: p.product_id, name: stock.get(p.product_id)?.name, before: stock.get(p.product_id)?.stock, after });
        }
        saveDB();
        return res.json({ ok: true, assembly_id: assemblyId, assembly_number: number, changes });
    } catch (e) {
        const failed = await rollbackStocks(applied);
        // 明细行也清掉，避免留下「有明细没库存变动」的孤儿单据
        await safeExec("DELETE FROM assembly_items WHERE assembly_id = ?", [assemblyId]);
        await safeExec("DELETE FROM assemblies WHERE id = ?", [assemblyId]);
        const code = e.biz ? 400 : 500;
        return res.status(code).json({
            error: e.message + (applied.length ? `（已回滚 ${applied.length - failed} 项库存改动${failed ? `，${failed} 项复原失败，请人工核对` : ''}）` : ''),
        });
    }
});
// ★ 2026-10-09 权限放开（第 3 项，与组装同一条理由）：adminOnly → hasPerm('inventory_full')
app.post('/api/inventory/splits', authMiddleware, hasPerm('inventory_full'), async (req, res) => {
    await initDB();
    const operatorId = Number(req.body?.operator_id) || req.user.id;
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    const errs = [];
    /* 契约（由前端 Split.tsx 明确给出，split_items 表无 role 列，故按数组顺序定角色）：
     *   items[0]    = 母件（扣库存）
     *   items[1..n] = 子件（加库存，可带 batch_number / expiry_date）
     * 兼容写法：若调用方每条都带 role='source'|'child' 亦识别（显式优先）。 */
    if (items.length < 2) errs.push('至少需要 1 个母件和 1 个子件');

    let srcItem = null;
    const explicitRole = items.some((it) => it && (it.role === 'source' || it.role === 'child'));
    const childRaw = [];
    if (explicitRole) {
        for (const it of items) {
            const pid = Number(it?.product_id);
            if (!Number.isInteger(pid) || pid <= 0) { errs.push('明细中存在无效的 product_id'); continue; }
            const q = parseQtyIn(it?.quantity, it.role === 'source' ? '母件' : '子件', errs);
            if (q === null) continue;
            if (it.role === 'source') {
                if (srcItem) errs.push('只能有一个母件');
                else srcItem = { product_id: pid, quantity: q };
            } else childRaw.push({ product_id: pid, quantity: q, batch_number: it?.batch_number ?? null, expiry_date: it?.expiry_date ?? null });
        }
        if (!srcItem) errs.push('未指定母件（role=source）');
    } else {
        const head = items[0] || {};
        const pid = Number(head.product_id);
        if (!Number.isInteger(pid) || pid <= 0) errs.push('母件的 product_id 无效');
        else {
            const q = parseQtyIn(head.quantity, '母件', errs);
            if (q !== null) srcItem = { product_id: pid, quantity: q };
        }
        for (const it of items.slice(1)) {
            const cid = Number(it?.product_id);
            if (!Number.isInteger(cid) || cid <= 0) { errs.push('明细中存在无效的 product_id'); continue; }
            const q = parseQtyIn(it?.quantity, '子件', errs);
            if (q === null) continue;
            childRaw.push({ product_id: cid, quantity: q, batch_number: it?.batch_number ?? null, expiry_date: it?.expiry_date ?? null });
        }
    }
    const children = mergeByPid(childRaw);
    if (!children.length) errs.push('至少需要一个子件');
    if (srcItem) {
        const childIds = new Set(children.map((c) => c.product_id));
        if (childIds.has(srcItem.product_id)) errs.push('子件不能与母件相同（如需拆成同商品的不同批次，请把母子件拆到两张单）');
        /* 数量守恒：母件扣多少、子件就必须加多少。
         * 不守恒会**凭空增减库存**，是这类单据最容易造成的静默数据损坏 ⇒ 直接拒绝，
         * 并把两侧数字都写进报错，便于当场核对。 */
        const totalChild = children.reduce((s, c) => s + c.quantity, 0);
        if (totalChild !== srcItem.quantity) {
            errs.push(`拆分的数量不守恒：母件 ${srcItem.quantity}，子件合计 ${totalChild}（两者必须相等，否则会凭空增减库存）`);
        }
    }

    const allIds = [...(srcItem ? [srcItem.product_id] : []), ...children.map((c) => c.product_id)];
    const stock = await loadStockMap(allIds);
    for (const id of new Set(allIds)) if (!stock.has(id)) errs.push(`商品 #${id} 不存在或已停用`);
    if (srcItem) {
        const s = stock.get(srcItem.product_id);
        if (s && s.stock < srcItem.quantity) errs.push(`母件「${s.name}」库存不足（需 ${srcItem.quantity}，现有 ${s.stock}）`);
    }
    if (errs.length) return res.status(400).json({ error: errs.join('；'), errors: errs });

    const number = await generateOrderNumber('CFD');
    const insHead = await safeExec(
        `INSERT INTO splits (split_number, operator_id, created_at) VALUES (?, ?, ${STOCK_TS}) RETURNING id`,
        [number, operatorId]
    );
    const splitId = insHead.values?.[0]?.[0];
    if (!splitId) return res.status(500).json({ error: '拆分单头写入失败' });

    const applied = [];
    try {
        for (const row of [{ ...srcItem, batch_number: null, expiry_date: null }, ...children]) {
            const r = await safeExec(
                "INSERT INTO split_items (split_id, product_id, quantity, batch_number, expiry_date) VALUES (?, ?, ?, ?, ?) RETURNING id",
                [splitId, row.product_id, row.quantity, row.batch_number ?? null, row.expiry_date ?? null]
            );
            if (!r.values || !r.values.length) throw new Error(`明细写入失败（商品 #${row.product_id}）`);
        }
        const changes = [];
        const afterSrc = await decStock(srcItem.product_id, srcItem.quantity);
        if (afterSrc === null) {
            const s = stock.get(srcItem.product_id);
            throw Object.assign(new Error(`母件「${s ? s.name : '#' + srcItem.product_id}」库存不足（需 ${srcItem.quantity}，现有 ${s ? s.stock : 0}）`), { biz: true });
        }
        applied.push({ product_id: srcItem.product_id, delta: -srcItem.quantity });
        changes.push({ product_id: srcItem.product_id, name: stock.get(srcItem.product_id)?.name, before: stock.get(srcItem.product_id)?.stock, after: afterSrc });
        for (const c of children) {
            const after = await incStock(c.product_id, c.quantity);
            if (after === null) throw new Error(`子件写入库存失败（商品 #${c.product_id}）`);
            applied.push({ product_id: c.product_id, delta: c.quantity });
            changes.push({ product_id: c.product_id, name: stock.get(c.product_id)?.name, before: stock.get(c.product_id)?.stock, after });
        }
        saveDB();
        return res.json({ ok: true, split_id: splitId, split_number: number, changes });
    } catch (e) {
        const failed = await rollbackStocks(applied);
        await safeExec("DELETE FROM split_items WHERE split_id = ?", [splitId]);
        await safeExec("DELETE FROM splits WHERE id = ?", [splitId]);
        const code = e.biz ? 400 : 500;
        return res.status(code).json({
            error: e.message + (applied.length ? `（已回滚 ${applied.length - failed} 项库存改动${failed ? `，${failed} 项复原失败，请人工核对` : ''}）` : ''),
        });
    }
});
/* ══════════════ 组装单 / 拆分单 列表与详情（2026-10-09 补，老板拍板第 4 项） ══════════════
 * 缺口：组装/拆分提交后**单号发了（ZZD… / CFD…）、库存也真的动了**，但界面上
 *   没有任何入口能看到这两张表 ⇒ 开完即失忆：想复核"上周那把货是怎么拼的 /
 *   拆成了什么、谁做的"，只能连数据库。智慧记把组装单/拆分单当**正式单据**列在
 *   单据列表里，本轮对齐。
 *
 * 两条必须守的口径：
 *   ① **只读**。两张表没有 status 列，落表即生效（库存已经动过）。列表/详情不提供
 *      原地改与删 —— 改错的正确做法是**反向再开一张**（组装开错→用拆分还原，
 *      拆分开错→用组装还原）。原地改数字会让库存与单据对不上，且不留审计痕迹。
 *      这与「单据已落库后只允许反向冲销」的既有范式一致。
 *   ② **角色按契约判定，并把"推断"标出来**：
 *      · assembly_items.is_component：0=成品（产出）/ 其他=组件（消耗）—— 表里有这一列，是事实。
 *      · split_items **没有 role 列** ⇒ 只能按 `ORDER BY id` 的顺序推断：
 *        第 1 条=母件（消耗）、其余=子件（产出）。这与 POST 的
 *        「items[0]=母件 / items[1..n]=子件」逐字同源，历史数据也按这个顺序落库。
 *        但它是**推断不是事实** ⇒ 回执里显式带 `role_inferred: true`，不假装是库里的字段。
 *
 * 权限：列表/详情用 `inventory_view`（看），组装/拆分提交用 `inventory_full`（做）。
 *   分开的理由：子账号应当能看到"我做过什么"，但能不能做由 inventory_full 决定。
 */
async function loadBillItemRows(table, fk, extras, ids) {
    if (!ids.length) return new Map();
    const ph = ids.map(() => '?').join(',');
    const r = await safeExec(`SELECT ${fk}, product_id, quantity${extras} FROM ${table} WHERE ${fk} IN (${ph}) ORDER BY id`, ids);
    const m = new Map();
    for (const row of (r.values || [])) {
        const k = Number(row[0]);
        if (!m.has(k)) m.set(k, []);
        m.get(k).push({ product_id: Number(row[1]), quantity: Number(row[2]), extra: Array.from(row).slice(3) });
    }
    return m;
}
async function loadRefMap(ids) {
    const uniq = [...new Set(ids.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0))];
    if (!uniq.length) return new Map();
    const ph = uniq.map(() => '?').join(',');
    const [pr, ur] = await Promise.all([
        safeExec(`SELECT id, name, sku, unit FROM products WHERE id IN (${ph})`, uniq),
        safeExec(`SELECT id, real_name FROM users WHERE id IN (${ph})`, uniq),
    ]);
    const m = new Map();
    for (const row of (pr.values || [])) m.set(Number(row[0]), { name: row[1], sku: row[2], unit: row[3] });
    for (const row of (ur.values || [])) m.set('u' + row[0], row[1]);
    return m;
}
/** 把一条明细行变成带商品名的对象；role 由调用方给定 */
function billLine(it, refMap, role) {
    const p = refMap.get(it.product_id);
    const line = {
        product_id: it.product_id,
        name: (p && p.name) || ('#' + it.product_id),
        sku: (p && p.sku) || '', unit: (p && p.unit) || '',
        quantity: it.quantity, role,
    };
    if (it.extra && it.extra.length >= 2) { line.batch_number = it.extra[0] ?? null; line.expiry_date = it.extra[1] ?? null; }
    return line;
}
const sumQty = (arr) => Math.round(arr.reduce((s, x) => s + Number(x.quantity || 0), 0) * 100) / 100;

/** 两个列表接口共用的取数（差别只有表名/单号列/角色规则） */
async function queryBills(kind, req) {
    const cfg = kind === 'assembly'
        ? { head: 'assemblies', numCol: 'assembly_number', item: 'assembly_items', fk: 'assembly_id', extras: ', is_component' }
        : { head: 'splits', numCol: 'split_number', item: 'split_items', fk: 'split_id', extras: ', batch_number, expiry_date' };
    const { page = 1, pageSize = 100, keyword, startDate, endDate, withTotal } = req.query || {};
    let where = ' WHERE 1=1';
    if (keyword) { const kw = String(keyword).replace(/'/g, "''"); where += ` AND ${cfg.numCol} LIKE '%${kw}%'`; }
    if (startDate) where += ` AND substr(created_at,1,10) >= '${String(startDate).replace(/'/g, "''")}'`;
    if (endDate) where += ` AND substr(created_at,1,10) <= '${String(endDate).replace(/'/g, "''")}'`;
    const pg = Math.max(1, Number(page) || 1);
    const ps = Math.min(2000, Math.max(1, Number(pageSize) || 100));
    const heads = ((await safeExec(`SELECT id, ${cfg.numCol}, operator_id, created_at FROM ${cfg.head}${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`, [ps, (pg - 1) * ps])).values || [])
        .map((r) => ({ id: Number(r[0]), number: r[1], operator_id: r[2] == null ? null : Number(r[2]), created_at: r[3] }));
    const ids = heads.map((h) => h.id);
    const itemsMap = await loadBillItemRows(cfg.item, cfg.fk, cfg.extras, ids);
    const refMap = await loadRefMap([].concat(...[...itemsMap.values()].map((arr) => arr.map((x) => x.product_id)), heads.map((h) => h.operator_id).filter(Boolean)));
    const rows = heads.map((h) => {
        const items = itemsMap.get(h.id) || [];
        let outputs = [], components = [], source = null, children = [];
        if (kind === 'assembly') {
            // is_component：0=成品（产出）；其余（含历史 NULL）一律当组件（消耗）——与 POST 写值口径一致
            outputs = items.filter((x) => Number(x.extra[0]) === 0).map((x) => billLine(x, refMap, 'output'));
            components = items.filter((x) => Number(x.extra[0]) !== 0).map((x) => billLine(x, refMap, 'component'));
        } else {
            source = items.length ? billLine(items[0], refMap, 'source') : null;
            children = items.slice(1).map((x) => billLine(x, refMap, 'child'));
        }
        return {
            ...h, operator_name: refMap.get('u' + h.operator_id) || null,
            outputs, components, source, children,
            total_output_qty: sumQty(kind === 'assembly' ? outputs : children),
            total_component_qty: sumQty(kind === 'assembly' ? components : (source ? [source] : [])),
            // ★ 拆分单的角色是**推断**（表里没有 role 列）⇒ 显式声明，不冒充库中事实
            role_inferred: kind === 'split',
        };
    });
    let total = null;
    if (withTotal) {
        const A = await scalars([{ key: 'total', sql: `SELECT COUNT(*) FROM ${cfg.head}${where}` }]);
        total = Number(A.total || 0);
    }
    return { rows, total, page: pg, pageSize: ps };
}
app.get('/api/inventory/assemblies', authMiddleware, hasPerm('inventory_view'), async (req, res) => {
    await initDB();
    const r = await queryBills('assembly', req);
    if (req.query.withTotal) return res.json(r);
    res.json(r.rows);
});
app.get('/api/inventory/splits', authMiddleware, hasPerm('inventory_view'), async (req, res) => {
    await initDB();
    const r = await queryBills('split', req);
    if (req.query.withTotal) return res.json(r);
    res.json(r.rows);
});
/** 单张单据详情（复用同一取数：先按 id 过滤再展开，保证列表与详情**同一个映射函数**） */
async function getBillById(kind, id) {
    const cfg = kind === 'assembly'
        ? { head: 'assemblies', numCol: 'assembly_number', item: 'assembly_items', fk: 'assembly_id', extras: ', is_component' }
        : { head: 'splits', numCol: 'split_number', item: 'split_items', fk: 'split_id', extras: ', batch_number, expiry_date' };
    const head = (await safeExec(`SELECT id, ${cfg.numCol}, operator_id, created_at FROM ${cfg.head} WHERE id = ?`, [id])).values?.[0];
    if (!head) return null;
    const itemsMap = await loadBillItemRows(cfg.item, cfg.fk, cfg.extras, [id]);
    const items = itemsMap.get(Number(id)) || [];
    const refMap = await loadRefMap([...items.map((x) => x.product_id), head[2]].filter(Boolean));
    let outputs = [], components = [], source = null, children = [];
    if (kind === 'assembly') {
        outputs = items.filter((x) => Number(x.extra[0]) === 0).map((x) => billLine(x, refMap, 'output'));
        components = items.filter((x) => Number(x.extra[0]) !== 0).map((x) => billLine(x, refMap, 'component'));
    } else {
        source = items.length ? billLine(items[0], refMap, 'source') : null;
        children = items.slice(1).map((x) => billLine(x, refMap, 'child'));
    }
    return {
        id: Number(head[0]), number: head[1], operator_id: head[2] == null ? null : Number(head[2]),
        created_at: head[3], operator_name: refMap.get('u' + head[2]) || null,
        outputs, components, source, children,
        total_output_qty: sumQty(kind === 'assembly' ? outputs : children),
        total_component_qty: sumQty(kind === 'assembly' ? components : (source ? [source] : [])),
        role_inferred: kind === 'split',
    };
}
app.get('/api/inventory/assemblies/:id', authMiddleware, hasPerm('inventory_view'), async (req, res) => {
    await initDB();
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '组装单 id 不合法' });
    const b = await getBillById('assembly', id);
    if (!b) return res.status(404).json({ error: '组装单不存在' });
    res.json(b);
});
app.get('/api/inventory/splits/:id', authMiddleware, hasPerm('inventory_view'), async (req, res) => {
    await initDB();
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '拆分单 id 不合法' });
    const b = await getBillById('split', id);
    if (!b) return res.status(404).json({ error: '拆分单不存在' });
    res.json(b);
});
// ==================== FINANCE ====================
app.get('/api/finance/accounts', authMiddleware, adminOnly, async (_req, res) => {
    await initDB();
    const result = await safeExec("SELECT * FROM accounts WHERE status = 1 ORDER BY id");
    const accounts = (result.values || []).map((a) => ({
        id: a[0], name: a[1], type: a[2], balance: Number(a[3]), currency: a[4], status: a[5], created_at: a[6]
    }));
    res.json(accounts);
});
// 账户下拉选项：店员开单/收款/付款时需要选择账户，但不能看到余额与账户管理
app.get('/api/finance/accounts/options', authMiddleware, async (_req, res) => {
    await initDB();
    const result = await safeExec("SELECT id, name, type FROM accounts WHERE status = 1 ORDER BY id");
    const accounts = (result.values || []).map((a) => ({ id: a[0], name: a[1], type: a[2] }));
    res.json(accounts);
});
app.post('/api/finance/accounts', authMiddleware, adminOnly, idem('accounts'), async (req, res) => {
    await initDB();
    const { name, type, balance } = req.body || {};
    /* ★ 2026-10-11 P5-2：`accounts.name` 是 NOT NULL 且无默认值 ⇒ 修复前传 name=null
     *   会 INSERT 失败被 run() 吞掉，接口仍回 ok:true（"建了但其实没建"）。
     *   期初余额同样必须先是数字再落库（原 `balance || 0` 会把 'abc' 原样送进 double precision）。 */
    if (!name || !String(name).trim()) {
        return res.status(400).json({ ok: false, code: 'ACCOUNT_BAD_NAME', error: '账户名称不能为空' });
    }
    let bal = 0;
    if (balance != null && balance !== '') {
        bal = Number(balance);
        if (!Number.isFinite(bal)) {
            return res.status(400).json({ ok: false, code: 'ACCOUNT_BAD_BALANCE', error: '期初余额必须是数字' });
        }
    }
    let newId = null;
    try {
        newId = await withTx((tx) => tx.lastId("INSERT INTO accounts (name, type, balance) VALUES (?, ?, ?)", [String(name).trim(), type || 'cash', bal]));
    }
    catch (e) {
        console.error('[FIN-ACCOUNT] 新增账户失败，已回滚:', e.message);
        return res.status(500).json({
            ok: false, code: 'ACCOUNT_WRITE_FAILED',
            error: '新增账户失败，本次操作未生效',
            detail: String(e.message).slice(0, 200),
        });
    }
    saveDB();
    saveDB();
    res.json({ ok: true, id: newId == null ? null : Number(newId) });
});
app.post('/api/finance/transactions/income', authMiddleware, hasPerm('income'), idem('tx-income'), async (req, res) => {
    await initDB();
    const { account_id, amount, category, description, customer_id, customer_name } = req.body || {};
    /* ★★ 2026-10-11 P5-2 入口硬校验（修复前**一处校验都没有**）：
     *   实测缺陷（隔离库 hongrui_ws48，见 _diag/sprint/p5-b02-test.cjs）：
     *     `POST {amount:null}` ⇒ HTTP 200 `{ok:true, order_number:"SKD202610110001"}`，但
     *       ① `transactions` 一行没写（amount 列 NOT NULL，INSERT 报错被 run() 静默吞掉）；
     *       ② 紧接着 `UPDATE accounts SET balance = balance + NULL` ⇒ **账户 #1 余额
     *          2,444,840.23 被写成 NULL**（accounts.balance 可空，`x + NULL = NULL` 不报错）
     *          ⇒ 一条非法请求静默抹掉账户余额，而接口报"成功"。
     *   故：金额必须「有限且 > 0」；账户若显式指定则必须真实存在且未停用（不得静默换账户）。 */
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) {
        return res.status(400).json({ ok: false, code: 'INCOME_BAD_AMOUNT', error: '收款金额必须是大于 0 的数字' });
    }
    // 客户收款：记录往来对象，冲减该客户欠款
    let pid = customer_id ? Number(customer_id) : null, pname = customer_name || null, ptype = null;
    if (!pid && pname) {
        const r = await safeExec("SELECT id FROM customers WHERE name = ? ORDER BY id LIMIT 1", [pname]);
        if (r.values?.[0]?.[0]) pid = Number(r.values[0][0]);
    }
    if (pid) { ptype = 'customer'; }
    else if (pname) { ptype = 'customer'; }
    // 账户：显式指定 ⇒ 必须存在且未停用（400）；未指定 ⇒ 兜底（现金 → 任意 → 自动建现金账户）
    let accId = (account_id != null && account_id !== '') ? Number(account_id) : null;
    if (accId != null) {
        const okAcc = (await safeExec("SELECT id FROM accounts WHERE id = ? AND COALESCE(status,1) = 1", [accId])).values?.[0]?.[0];
        if (!okAcc) return res.status(400).json({ ok: false, code: 'INCOME_BAD_ACCOUNT', error: `账户 #${accId} 不存在或已停用` });
    }
    const cat = category || (pname ? '收欠款' : '直接收款');
    // 收款单号 SKD+YYYYMMDD+4位当日序号（对齐智慧记）；取号失败不阻断开单
    const orderNumber = await generateOrderNumber('income');
    /* ★ 2026-10-11 P5-2 事务化：修复前「INSERT 流水 / 改账户余额 / 逐单抵扣欠款」三条语句
     *   各走一次连接、无事务 ⇒ 任一条失败都留半截账（流水记了余额没加、余额加了欠款没冲），
     *   且因 run() 吞异常而回 ok:true ⇒ 账实不符且**看不见**。现整段进同一事务，失败整体回滚。 */
    let usedAcc = accId;
    try {
        usedAcc = await withTx(async (tx) => {
            let aid = accId;
            if (!aid) {
                aid = (await tx.q("SELECT id FROM accounts WHERE type = 'cash' LIMIT 1")).values?.[0]?.[0] || null;
            }
            if (!aid) {
                aid = (await tx.q("SELECT id FROM accounts ORDER BY id LIMIT 1")).values?.[0]?.[0] || null;
            }
            if (!aid) {
                // 见 runLastId 注释：INSERT 与「取刚插入的 id」必须同一条语句，否则连接池会话漂移会取到别的 id
                aid = await tx.lastId("INSERT INTO accounts (name, type, balance) VALUES ('现金', 'cash', 0)");
            }
            aid = Number(aid);
            /* ★★ 2026-10-11 P5-3（B0-3）两处改动，只为消除并发丢失更新与死锁，抵扣口径零改动：
             *   ① 候选欠单查询加**行级排他锁**：并发"收欠款"在数据库侧排队，后到者读到的是
             *      前一笔提交后的 rec/owe，而不是各自基于同一快照各写一遍。
             *      实测（hongrui_ws48，5 笔并发各 ¥600 收同一客户的 3 张 ¥1000 欠单，跨 5 个账户）：
             *        修复前 账户 +3000 而单据只核销 600（差额 2400、0 张结清）；
             *        修复后 3000/3000 全结清（见 _diag/sprint/p5-b03-test.cjs）。
             *   ② 把该语句**移到账户 UPDATE 之前**：全局加锁顺序统一为「先锁单据、后动账户」，
             *      与销售单收款 / 付款登记同序 ⇒ 三条路径交叉并发不成环、不死锁。
             *   【为什么"同账户"时不报错】实测同账户并发恰好正确：账户行的写锁把整个事务
             *   串了起来。但这是**副作用**、不是设计 ⇒ 一旦并发落到不同账户（现金/微信/支付宝
             *   各记一笔，很常见）就立刻丢账，故不能依赖它。 */
            const unpaid = (pid && category !== '直接收款') ? (await tx.q(`SELECT id, COALESCE(receivable_amount, final_amount, 0) due,
                    COALESCE(received_amount, 0) rec
                FROM sales_orders
                WHERE customer_id = ? AND COALESCE(payment_status,'') NOT IN ('已结清','作废')
                ORDER BY id LIMIT 20 FOR UPDATE`, [pid])).values || [] : null;
            await tx.run("INSERT INTO transactions (type, account_id, amount, category, description, operator_id, operator_name, party_type, party_id, party_name, order_number) VALUES ('income', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [aid, amt, cat, description, req.user.id, req.user.real_name, ptype, pid, pname, orderNumber]);
            await tx.run("UPDATE accounts SET balance = balance + ? WHERE id = ?", [amt, aid]);
            // 冲减该客户欠款（2026-10-04 修复）：按金额逐单抵扣，并【同步三个金额字段】。
            //   原实现只改 payment_status，不动 received_amount / owe_amount ⇒ 造出「已结清但欠款仍在」的
            //   不自洽单；而界面状态只看 owe_amount（OrderManagement 的 isUnpaid = owe > 0.005）
            //   ⇒ 少收的钱会被前台显示成「已收款」。故必须三字段一起改。
            if (unpaid) {                 // 候选集已在锁内取好（见上方 FOR-UPDATE 段），此处只做分配
                let remain = amt;
                for (const row of unpaid) {
                    if (remain <= 0.005) break;
                    const due = Number(row[1]) || 0;
                    const rec0 = Number(row[2]) || 0;
                    const gap = Math.round((due - rec0) * 100) / 100;
                    if (gap <= 0.005) {
                        // 金额其实已够、只是状态没更新 ⇒ 仅补状态，避免重复加钱
                        await tx.run("UPDATE sales_orders SET payment_status = '已结清' WHERE id = ?", [row[0]]);
                        continue;
                    }
                    const pay = Math.min(remain, gap);
                    const newRec = Math.round((rec0 + pay) * 100) / 100;
                    const newOwe = Math.round(Math.max(0, due - newRec) * 100) / 100;
                    await tx.run("UPDATE sales_orders SET received_amount = ?, owe_amount = ?, payment_status = ? WHERE id = ?",
                        [newRec, newOwe, newOwe <= 0.005 ? '已结清' : '未结清', row[0]]);
                    remain = Math.round((remain - pay) * 100) / 100;
                }
            }
            return aid;
        });
    }
    catch (e) {
        console.error('[FIN-INCOME] 收款记账失败，已整体回滚:', e.message);
        return res.status(500).json({
            ok: false, code: 'INCOME_WRITE_FAILED',
            error: '收款记账失败，本次操作未生效（已整体回滚）',
            detail: String(e.message).slice(0, 200),
        });
    }
    saveDB(); saveDB();
    res.json({ ok: true, order_number: orderNumber, account_id: usedAcc });
});
app.post('/api/finance/transactions/expense', authMiddleware, hasPerm('expense'), idem('tx-expense'), async (req, res) => {
    await initDB();
    const { account_id, amount, category, description, supplier_id, supplier_name } = req.body || {};
    /* ★ 2026-10-11 P5-2：与收款同型加固（金额有限且 > 0；显式账户必须真实存在）。
     *   修复前同样无校验 ⇒ `amount:null` 会把账户余额写成 NULL 且回 ok:true。 */
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) {
        return res.status(400).json({ ok: false, code: 'EXPENSE_BAD_AMOUNT', error: '付款金额必须是大于 0 的数字' });
    }
    let pid = supplier_id ? Number(supplier_id) : null, pname = supplier_name || null, ptype = null;
    if (!pid && pname) {
        const r = await safeExec("SELECT id FROM suppliers WHERE name = ? ORDER BY id LIMIT 1", [pname]);
        if (r.values?.[0]?.[0]) pid = Number(r.values[0][0]);
    }
    if (pid) { ptype = 'supplier'; }
    else if (pname) { ptype = 'supplier'; }
    // 账户：显式指定 ⇒ 必须存在且未停用（400）；未指定 ⇒ 兜底（现金 → 任意 → 自动建现金账户）
    let accId = (account_id != null && account_id !== '') ? Number(account_id) : null;
    if (accId != null) {
        const okAcc = (await safeExec("SELECT id FROM accounts WHERE id = ? AND COALESCE(status,1) = 1", [accId])).values?.[0]?.[0];
        if (!okAcc) return res.status(400).json({ ok: false, code: 'EXPENSE_BAD_ACCOUNT', error: `账户 #${accId} 不存在或已停用` });
    }
    const cat = category || (pname ? '付欠款' : '直接付款');
    // 付款单号 FKD+YYYYMMDD+4位当日序号（对齐智慧记）
    const orderNumber = await generateOrderNumber('expense');
    /* ★ 2026-10-11 P5-2 事务化：INSERT 流水 / 扣账户余额 / 逐单抵扣应付 必须同生共死。 */
    let usedAcc = accId;
    try {
        usedAcc = await withTx(async (tx) => {
            let aid = accId;
            if (!aid) {
                aid = (await tx.q("SELECT id FROM accounts WHERE type = 'cash' LIMIT 1")).values?.[0]?.[0] || null;
            }
            if (!aid) {
                aid = (await tx.q("SELECT id FROM accounts ORDER BY id LIMIT 1")).values?.[0]?.[0] || null;
            }
            if (!aid) {
                // 见 runLastId 注释：INSERT 与「取刚插入的 id」必须同一条语句，否则连接池会话漂移会取到别的 id
                aid = await tx.lastId("INSERT INTO accounts (name, type, balance) VALUES ('现金', 'cash', 0)");
            }
            aid = Number(aid);
            /* ★★ 2026-10-11 P5-3（B0-3）：与收款侧完全同型的加固（候选欠单加行级排他锁，
             *   并把取候选集挪到账户写之前，统一「先锁单据、后动账户」的加锁顺序）。
             *   实测（hongrui_ws48，5 笔并发各 ¥600 付同一供应商的 3 张 ¥1000 欠单）：
             *     修复前 账户 −3000 而单据只核销 1200（差额 1800、仅 1/3 结清）⇒
             *     付出去的钱在账上走了、应付却不减 ⇒ 供应商被重复付款。 */
            const unpaid = (pid && category !== '直接付款') ? (await tx.q(`SELECT id, COALESCE(total_amount,0) due, COALESCE(paid_amount,0) paid
                FROM purchase_orders
                WHERE supplier_id = ? AND COALESCE(payment_status,'') NOT IN ('已结清','作废') AND ${PO_ALIVE}
                ORDER BY COALESCE(bill_date, substr(created_at,1,10)), id LIMIT 20 FOR UPDATE`, [pid])).values || [] : null;
            await tx.run("INSERT INTO transactions (type, account_id, amount, category, description, operator_id, operator_name, party_type, party_id, party_name, order_number) VALUES ('expense', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [aid, amt, cat, description, req.user.id, req.user.real_name, ptype, pid, pname, orderNumber]);
            await tx.run("UPDATE accounts SET balance = balance - ? WHERE id = ?", [amt, aid]);
            if (unpaid) {                 // 候选集已在锁内取好（见上方段），此处只做分配
                /* 冲减该供应商欠款（2026-10-04 修复，与销售侧「收欠款」同范式）：
                 * ① 判据统一：候选单改用「状态 + 业务日期」，结算由 owe 派生（老板拍板：欠款 ≤ 0 即已结清）；
                 * ② **抵扣基数改为实际欠款**：原实现拿 `total_amount`（单据全额）当应抵金额
                 *    ⇒ 一张 10,000 已付 8,000 的单，再付 2,000 也抵不掉，永久赖在「未结清」；
                 * ③ **同步 paid_amount / owe_amount**：原实现只写 payment_status ⇒ 造出「已结清但欠款仍在」
                 *    的不自洽单（与销售侧修复前的缺陷同型）。
                 * ④ 不变量：newPaid + newOwe 恒等于 due(=total_amount)，全库 515 张此式 0 违反，必须保住。
                 * 存量影响：0（见上，该路径此前从未真正落写过）。 */

                // 按金额逐单抵扣：付款金额先抵最早的欠单，不足部分保持未结清
                let remain = amt;
                for (const row of unpaid) {
                    if (remain <= 0.005) break;
                    const due = Number(row[1]) || 0;
                    const paid0 = Number(row[2]) || 0;
                    const gap = Math.round((due - paid0) * 100) / 100;
                    if (gap <= 0.005) {
                        // 金额其实已够、只是状态没更新 ⇒ 仅补状态，避免重复加钱
                        await tx.run("UPDATE purchase_orders SET payment_status = '已结清' WHERE id = ?", [row[0]]);
                        continue;
                    }
                    const pay = Math.min(remain, gap);
                    const newPaid = Math.round((paid0 + pay) * 100) / 100;
                    const newOwe = Math.round(Math.max(0, due - newPaid) * 100) / 100;
                    await tx.run("UPDATE purchase_orders SET paid_amount = ?, owe_amount = ?, payment_status = ? WHERE id = ?",
                        [newPaid, newOwe, newOwe <= 0.005 ? '已结清' : '未结清', row[0]]);
                    remain = Math.round((remain - pay) * 100) / 100;
                }
            }
            return aid;
        });
    }
    catch (e) {
        console.error('[FIN-EXPENSE] 付款记账失败，已整体回滚:', e.message);
        return res.status(500).json({
            ok: false, code: 'EXPENSE_WRITE_FAILED',
            error: '付款记账失败，本次操作未生效（已整体回滚）',
            detail: String(e.message).slice(0, 200),
        });
    }
    saveDB(); saveDB();
    res.json({ ok: true, order_number: orderNumber, account_id: usedAcc });
});
app.post('/api/finance/transactions/transfer', authMiddleware, adminOnly, idem('tx-transfer'), async (req, res) => {
    await initDB();
    const { from_account_id, to_account_id, amount, description } = req.body || {};
    /* ★★ 2026-10-11 P5-2 入口硬校验：修复前**一条校验都没有**，而四条语句又是"扣款在前、入账在后"：
     *   实测缺陷（隔离库）：`to_account_id:999999`（不存在）⇒ HTTP 200 `{ok:true}`，而
     *     · `UPDATE accounts SET balance = balance - ? WHERE id = from` **照常扣款**；
     *     · `UPDATE accounts SET balance = balance + ? WHERE id = 999999` 影响 **0 行**、不报错
     *   ⇒ **钱从转出账户消失、没有任何入账**，且接口报"成功" ⇒ 直接造成账面资金不平。
     *   故：金额必须「有限且 > 0」；两个账户都必须真实存在且未停用；转出 ≠ 转入。 */
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) {
        return res.status(400).json({ ok: false, code: 'TRANSFER_BAD_AMOUNT', error: '转账金额必须是大于 0 的数字' });
    }
    const fromId = Number(from_account_id), toId = Number(to_account_id);
    if (!Number.isInteger(fromId) || fromId <= 0 || !Number.isInteger(toId) || toId <= 0) {
        return res.status(400).json({ ok: false, code: 'TRANSFER_BAD_ACCOUNT', error: '转出/转入账户必须都是合法的账户 id' });
    }
    if (fromId === toId) {
        return res.status(400).json({ ok: false, code: 'TRANSFER_SAME_ACCOUNT', error: '转出与转入账户不能是同一个' });
    }
    const pair = (await safeExec("SELECT id FROM accounts WHERE id IN (?, ?) AND COALESCE(status,1) = 1", [fromId, toId])).values || [];
    const found = new Set(pair.map((r) => Number(r[0])));
    const missing = [fromId, toId].filter((x) => !found.has(x));
    if (missing.length) {
        return res.status(400).json({ ok: false, code: 'TRANSFER_BAD_ACCOUNT', error: `账户不存在或已停用：#${missing.join(', #')}` });
    }
    // 转账单号 DBD：一次转账产生两条流水（转出/转入），共用同一单号便于成对核对
    const transferNumber = await generateOrderNumber('transfer');
    /* ★ 2026-10-11 P5-2 事务化：4 条语句（2 记流水 + 2 改余额）必须同生共死。
     *   修复前逐条 run() ⇒ 中途失败会留下"只扣不加"的半截转账（与上方的账户校验合并后，
     *   这类残局此前只能靠人工对账发现）。 */
    try {
        await withTx(async (tx) => {
            /* ★★ 2026-10-11 P5-3（B0-3）确定性加锁，消除反向并发死锁。
             * 【缺陷实证】隔离库 hongrui_ws48：10 笔 A→B 与 10 笔 B→A 并发 ⇒ **19/20 失败**，
             *   服务端 detail = "检测到死锁"，请求耗时呈 1s/2s/…/10s 阶梯（PG deadlock_timeout 1s 逐个级联）。
             *   根因：下方 4 条语句是「转出账户 → 转入账户」，**加锁顺序随方向反转** ⇒
             *     A→B 持 A 等 B、B→A 持 B 等 A ⇒ 循环等待成立。
             *   （这是 P5-2 把转账事务化后**暴露**出来的：此前逐条 autocommit 不跨语句持锁、不会死锁，
             *    代价却是"只扣不加"的半截转账 —— 两者都不对，故必须根治而不是回退事务。）
             * 【修法】先用**单条语句 + ORDER BY id** 把两端账户按同一顺序锁住 ⇒ 两侧同序，
             *   循环等待不可能成立。之后 4 条语句照旧执行（金额改动一字未变）。 */
            await tx.q("SELECT id FROM accounts WHERE id IN (?, ?) ORDER BY id FOR UPDATE", [fromId, toId]);
            await tx.run("INSERT INTO transactions (type, account_id, amount, description, operator_id, operator_name, order_number) VALUES ('transfer', ?, ?, ?, ?, ?, ?)", [fromId, amt, description, req.user.id, req.user.real_name, transferNumber]);
            await tx.run("UPDATE accounts SET balance = balance - ? WHERE id = ?", [amt, fromId]);
            await tx.run("INSERT INTO transactions (type, account_id, amount, description, operator_id, operator_name, order_number) VALUES ('transfer_in', ?, ?, ?, ?, ?, ?)", [toId, amt, description, req.user.id, req.user.real_name, transferNumber]);
            await tx.run("UPDATE accounts SET balance = balance + ? WHERE id = ?", [amt, toId]);
        });
    }
    catch (e) {
        console.error('[FIN-TRANSFER] 转账失败，已整体回滚:', e.message);
        return res.status(500).json({
            ok: false, code: 'TRANSFER_WRITE_FAILED',
            error: '转账失败，本次操作未生效（已整体回滚）',
            detail: String(e.message).slice(0, 200),
        });
    }
    saveDB();
    saveDB();
    res.json({ ok: true, order_number: transferNumber });
});
app.get('/api/finance/transactions', authMiddleware, (req, res, next) => {
    // 收款/付款列表：有 income 或 expense 或 finance_view 任一权限即可查看
    const perms = parsePerms(req.user);
    if (perms.includes('finance_view') || perms.includes('income') || perms.includes('expense')) return next();
    return res.status(403).json({ error: '无权限：该功能未开放给当前账号' });
}, async (req, res) => {
    await initDB();
    /* ★ 2026-10-08 改造：原来只回一个数组，且前端写死 pageSize=50 又无翻页控件
     *   ⇒「收款/付款记录」页**永远只能看到最近 50 笔**（线上流水 3435 条）。
     *   智慧记的同一页有日期筛选 + 完整翻页，这是实打实的功能不对齐。
     *   现按本仓库既有约定（/products、/store/*-orders 同款）追加 `withTotal=1`：
     *     带 withTotal ⇒ { rows, total, page, pageSize, sum_amount }
     *     不带      ⇒ 仍回数组（老调用方零影响）
     *   同时补上智慧记已有的 startDate / endDate / keyword 筛选（不传即不生效）。 */
    const { type, account_id, page = 1, pageSize = 50, startDate, endDate, keyword, withTotal } = req.query;
    // 显式列名（不用 SELECT *），保证下标稳定；新增列只追加在末尾
    const COLS = "id, type, account_id, amount, category, description, reference_id, operator_id, operator_name, created_at, order_number, party_type, party_id, party_name";
    /* ★ 2026-10-09：追加审计列 reverse_of / revised_from（前端据此显示「已冲销」并隐藏删除/编辑入口）。
     *   带**能力探测 + 降级**：探测不到就退回原列集，绝不让整页查询因为缺列而返回空
     *   （safeExec 会吞掉 SQL 报错 ⇒ 曾多次造成「页面没数据」这种看起来像业务问题的假故障）。 */
    const AUDIT = (await txAuditColsAvailable())
        ? ", reverse_of, revised_from, (SELECT COUNT(*) FROM transactions r WHERE r.reverse_of = t.id) AS rev_count"
        : "";
    let where = " WHERE 1=1";
    if (type) {
        where += " AND type = '" + String(type).replace(/'/g, "''") + "'";
    }
    if (account_id) {
        where += " AND account_id = " + Number(account_id);
    }
    // 日期口径与全站一致：transactions 无 bill_date，取 created_at 前 10 位
    if (startDate) where += " AND substr(created_at,1,10) >= '" + String(startDate).replace(/'/g, "''") + "'";
    if (endDate) where += " AND substr(created_at,1,10) <= '" + String(endDate).replace(/'/g, "''") + "'";
    if (keyword) {
        const kw = String(keyword).replace(/'/g, "''");
        where += " AND (COALESCE(order_number,'') LIKE '%" + kw + "%' OR COALESCE(description,'') LIKE '%" + kw + "%' OR COALESCE(category,'') LIKE '%" + kw + "%' OR COALESCE(party_name,'') LIKE '%" + kw + "%')";
    }
    const pg = Math.max(1, Number(page) || 1);
    const ps = Math.min(2000, Math.max(1, Number(pageSize) || 50));
    const params = [ps, (pg - 1) * ps];
    const sql = "SELECT " + COLS + AUDIT + " FROM transactions t" + where + " ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?";
    /* ★ 改用显式列名（2026-10-05）：原为 SELECT * + 下标取值，
     *   加一列就会让下标整体错位（t[9] 不再是 created_at）——是个定时炸弹。
     *   显式列名 + 具名取值后，后续再加列不会再影响已有字段。 */
    const result = await safeExec(sql, params);
    const transactions = (result.values || []).map((t) => ({
        id: t[0], type: t[1], account_id: t[2], amount: Number(t[3]), category: t[4],
        description: t[5], reference_id: t[6], operator_id: t[7], operator_name: t[8],
        created_at: t[9], order_number: t[10] || null,
        party_type: t[11] || null, party_id: t[12] || null, party_name: t[13] || null,
        // 审计指针（列不可用时为 undefined ⇒ 前端按「未知」处理，不禁用入口）
        reverse_of: t[14] == null ? null : Number(t[14]),
        revised_from: t[15] == null ? null : Number(t[15]),
        reversed: t[16] == null ? false : Number(t[16]) > 0,
    }));
    if (withTotal) {
        // COUNT 与 SUM 合并为 1 次往返（与本仓库 po/so 列表同款做法）
        const A = await scalars([
            { key: 'total', sql: "SELECT COUNT(*) FROM transactions" + where },
            { key: 'sum_amount', sql: "SELECT COALESCE(SUM(amount),0) FROM transactions" + where },
        ]);
        return res.json({
            rows: transactions, total: Number(A.total || 0), page: pg, pageSize: ps,
            sum_amount: Number(A.sum_amount || 0),
        });
    }
    res.json(transactions);
});
/* ==================== 资金流水「冲销删除 / 冲销重记」（2026-10-09 补） ====================
 * 缺口（老板 2026-10-09 拍板第 1 项）：流水此前只有 1 个 GET + 3 个 POST，
 *   **没有删除、没有修改** ⇒ 录错一笔收款/付款，业务侧无法自救。
 *
 * 铁律（与已落地的「销售单作废回冲」完全同一范式，不另造一套）：
 *   ① **不物理删除**。删除 = 写一条「同 type、同账户、金额取反」的冲销流水，
 *      账户余额按原方向回滚。原流水原样保留 ⇒ 资金变动永远可审计、可复算。
 *   ② **不原地改数**。编辑 = 先冲销原行、再按新值记一条新行（revised_from 指向原行）。
 *      若直接 UPDATE amount，账户余额与流水的对应关系就永久断了
 *      （谁也说不清差额那几百块去哪了），这是记账工具最不能犯的错。
 *   ③ **不变量**：账户余额 ≡ 该账户流水的带符号净额
 *      （income +1 / expense −1 / transfer −1 / transfer_in +1）。
 *      冲销行沿用原 type 且金额取反 ⇒ 净额天然归零；余额回滚额 = 原金额 ⇒ 恒等式全程保持。
 *   ④ **唯一指认 + 反向对照**：一律按 id 定位；防重复冲销靠 reverse_of 反查（不用模糊 LIKE）；
 *      跨账户的转账**必须成对冲销**（只冲一侧 ⇒ 钱凭空多出或蒸发）。
 *   ⑤ **拒绝而不是猜**：单据联动流水（销售单收款 / 进货单付款 / 已挂往来单位的流水）
 *      一旦冲销，单据欠款与往来对账立刻对不上 ⇒ 明确 409 + 指路，绝不静默做半截事。
 *
 * 权限：与「作废销售单」同级 —— adminOnly。删钱比记账更高危，不开放给子账号
 *      （若日后要下放，改这一处中间件即可，前后端同源改动）。
 * ==================================================================================== */
/** 流水符号表：账户余额变动 = NET_SIGN[type] × amount。新增 type 必须在此登记，否则拒绝冲销。 */
const TX_NET_SIGN = { income: +1, expense: -1, transfer: -1, transfer_in: +1 };
/** 审计列是否可用（进程内只探测一次）。探测失败时**降级**而不是让整页查询崩掉。 */
let _txAuditCols = null;
async function txAuditColsAvailable() {
    if (_txAuditCols !== null) return _txAuditCols;
    // 注意 safeExec 会吞掉异常返回空 values（假阴性风险）：这里靠 columns 判存在性，
    // 列不存在时 PG 直接报错 ⇒ columns 为空 ⇒ 判定不可用。
    const r = await safeExec("SELECT reverse_of, revised_from FROM transactions LIMIT 1");
    _txAuditCols = r.columns.length >= 2;
    if (!_txAuditCols) console.error('[tx-audit] transactions.reverse_of 探测失败 ⇒ 流水审计列不可用，删除/编辑入口将返回明确错误（不静默）');
    return _txAuditCols;
}
const TX_AUDIT_COLS = 'id, type, account_id, amount, category, description, order_number, party_type, reverse_of, revised_from';
/** 读一条流水（含审计列）。返回 null 表示不存在；抛 'NO_MIGRATION' 表示列缺失（不是"不存在"，必须区分）。 */
async function loadTxForAudit(id) {
    const t = (await safeExec(`SELECT ${TX_AUDIT_COLS} FROM transactions WHERE id = ?`, [id])).values?.[0];
    if (t) return row2tx(t);
    // 空结果有两种原因，必须区分：真不存在 vs 审计列缺失（safeExec 吞了报错）
    const ctrl = (await safeExec("SELECT id FROM transactions WHERE id = ?", [id])).values?.[0];
    if (ctrl) { const e = new Error('NO_MIGRATION'); throw e; }
    return null;
}
function row2tx(r) {
    return {
        // ⚠️ account_id 是 BIGINT ⇒ PG 驱动回字符串。必须在这里就转数字：
        //   否则「PUT 只改金额、不带 account_id」会走到 Number.isInteger('1') === false
        //   ⇒ 误报「新账户不合法」（本装置 d54 用例 T9.13 就是抓这个的）。
        id: Number(r[0]), type: r[1],
        account_id: r[2] == null ? null : Number(r[2]),
        amount: Number(r[3]) || 0,
        category: r[4], description: r[5], order_number: r[6], party_type: r[7],
        reverse_of: r[8] == null ? null : Number(r[8]),
        revised_from: r[9] == null ? null : Number(r[9]),
    };
}
/**
 * 可冲销性判定（每条拒绝理由都必须唯一指认原因，不用模糊匹配兜）。
 * 返回 { ok:true } 或 { ok:false, code, reason }
 */
async function txReversible(t) {
    if (!(t.type in TX_NET_SIGN)) return { ok: false, code: 409, reason: `未知流水类型「${t.type}」，符号表未登记 ⇒ 无法安全回滚余额，已拒绝。` };
    const amt = Number(t.amount);
    if (!Number.isFinite(amt) || amt === 0) return { ok: false, code: 400, reason: '该笔金额为 0，没有资金变动可冲销。' };
    if (!t.account_id) return { ok: false, code: 409, reason: '该笔没有账户指向（account_id 为空），无法回滚余额 ⇒ 已拒绝。' };
    if (t.reverse_of) return { ok: false, code: 409, reason: `该笔本身是流水 #${t.reverse_of} 的冲销行，不能再冲销（会把已作废的账又翻回来）。` };
    const already = (await safeExec("SELECT id FROM transactions WHERE reverse_of = ? ORDER BY id LIMIT 1", [t.id])).values?.[0]?.[0];
    if (already) return { ok: false, code: 409, reason: `该笔已被流水 #${already} 冲销过，不能重复冲销。` };
    if (t.party_type) return { ok: false, code: 409, reason: '该笔挂在往来单位上（已冲减客户/供应商欠款）。直接冲销会让往来欠款与流水对不上 ⇒ 请在对应客户/供应商的对账里处理。' };
    const desc = String(t.description || '');
    if (/^销售单\s*\S+\s*收款$/.test(desc)) return { ok: false, code: 409, reason: '该笔由销售单自动生成（销售单收款）⇒ 请到该销售单处理（修改单据或作废单据）。' };
    if (/^采购单\s*\S+\s*付款$/.test(desc)) return { ok: false, code: 409, reason: '该笔由进货单自动生成（进货单付款）⇒ 请到该进货单处理。' };
    if (t.order_number) {
        const so = (await safeExec("SELECT id FROM sales_orders WHERE order_number = ? LIMIT 1", [t.order_number])).values?.[0]?.[0];
        if (so) return { ok: false, code: 409, reason: `单号 ${t.order_number} 命中销售单 #${so}（该笔是这张单的收款/退货联动流水）⇒ 请到销售单处理。` };
        const po = (await safeExec("SELECT id FROM purchase_orders WHERE order_number = ? LIMIT 1", [t.order_number])).values?.[0]?.[0];
        if (po) return { ok: false, code: 409, reason: `单号 ${t.order_number} 命中进货单 #${po} ⇒ 请到进货单处理。` };
    }
    return { ok: true };
}
/** 取本次操作要冲销的全部行：普通流水 1 行；转账必须成对（同单号的两条） */
async function txReversalTargets(t) {
    if (t.type !== 'transfer' && t.type !== 'transfer_in') return [t];
    if (!t.order_number) return { error: '这张转账流水没有单号，无法成对冲销（单冲一侧会让钱凭空多出/蒸发）⇒ 已拒绝。' };
    const rows = (await safeExec("SELECT " + TX_AUDIT_COLS + " FROM transactions WHERE order_number = ? AND type IN ('transfer','transfer_in') ORDER BY id", [t.order_number])).values || [];
    const list = rows.map(row2tx);
    if (list.length !== 2) return { error: `单号 ${t.order_number} 的转账流水共 ${list.length} 条（应为 2 条：转出 + 转入）⇒ 数据本身不完整，不成对冲销，已拒绝。` };
    return list;
}
/** 写一条冲销流水 + 按原方向回滚账户余额。返回 { reversalId, delta } */
async function writeReversal(t, user, note) {
    const sign = TX_NET_SIGN[t.type];
    const delta = Math.round(sign * (-t.amount) * 100) / 100; // 账户余额的增量
    const rev = await safeExec(
        "INSERT INTO transactions (type, account_id, amount, category, description, operator_id, operator_name, order_number, reverse_of) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
        [t.type, t.account_id, -t.amount,
            ((t.category || '') + '冲销').slice(0, 40),
            `冲销 #${t.id}${note ? ' ' + note : ''}${t.description ? ' ' + t.description : ''}`.trim().slice(0, 200),
            user.id, user.real_name, t.order_number || null, t.id]
    );
    const revId = rev.values?.[0]?.[0] ?? null;
    /* ★★ 2026-10-11 P5-4（P3-08）：冲销必须**幂等**。
     *   【缺陷实证】修复前「先查是否已冲销」与「写冲销行」分属两次调用 ⇒ TOCTOU。
     *     实测两个并发 DELETE 同一笔：**冲销行 2 条、余额多回滚 200**（钱凭空多出来）。
     *   【修法】靠唯一索引 `uq_transactions_reverse_of`（reverse_of 非空时唯一）做互斥：
     *     抢不到位的那一次拿不到 revId ⇒ **直接跳过余额回滚**并向上声明「已被冲销」。
     *     不再依赖任何先读后写的检查。 */
    if (revId === null) return { reversalId: null, delta: 0, dup: true };
    await run("UPDATE accounts SET balance = balance + ? WHERE id = ?", [delta, t.account_id]);
    // PG 的 BIGINT 经驱动回来是**字符串** ⇒ 回执里统一成数字，避免前端 `id === 10031` 恒为 false
    return { reversalId: revId == null ? null : Number(revId), delta };
}
app.delete('/api/finance/transactions/:id', authMiddleware, adminOnly, async (req, res) => {
    await initDB();
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '流水 id 不合法' });
    if (!(await txAuditColsAvailable())) return res.status(500).json({ error: '数据库迁移未生效（transactions.reverse_of 缺失），为安全起见暂不允许冲销。' });
    let t;
    try { t = await loadTxForAudit(id); }
    catch (e) { if (e.message === 'NO_MIGRATION') return res.status(500).json({ error: '数据库迁移未生效（transactions.reverse_of 缺失），为安全起见暂不允许冲销。' }); throw e; }
    if (!t) return res.status(404).json({ error: '流水不存在' });
    const chk = await txReversible(t);
    if (!chk.ok) return res.status(chk.code).json({ error: chk.reason, rejected: true });
    const targets = await txReversalTargets(t);
    if (targets.error) return res.status(409).json({ error: targets.error, rejected: true });
    for (const x of targets) {
        const c = await txReversible(x);
        if (!c.ok) return res.status(c.code).json({ error: `转账成对冲销被拒：${c.reason}`, rejected: true });
    }
    let rolledBack = 0;
    const reversals = [];
    for (const x of targets) {
        const r = await writeReversal(x, req.user, '(删除)');
        /* ★★ P5-4（P3-08）：并发下抢不到冲销位的那一次，不能当成功。
         *   已完成的冲销不可回滚：若此前已有一欔落账，本次必须整体告知「已被冲销」而不是报成功。 */
        if (r.dup) return res.status(409).json({ ok: false, code: 'TX_ALREADY_REVERSED', rejected: true, error: `流水 #${x.id} 已被（并发的）另一次操作冲销过，本次未重复回滚余额。请刷新后查看当前状态。` });
        rolledBack = Math.round((rolledBack + Math.abs(x.amount)) * 100) / 100;
        reversals.push({ of: x.id, reversal_id: r.reversalId, account_id: Number(x.account_id), amount: -x.amount, balance_delta: r.delta });
    }
    saveDB();
    res.json({ ok: true, deleted: t.id, rolled_back: rolledBack, reversals });
});
app.put('/api/finance/transactions/:id', authMiddleware, adminOnly, async (req, res) => {
    await initDB();
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '流水 id 不合法' });
    if (!(await txAuditColsAvailable())) return res.status(500).json({ error: '数据库迁移未生效（transactions.reverse_of 缺失），为安全起见暂不允许冲销重记。' });
    let t;
    try { t = await loadTxForAudit(id); }
    catch (e) { if (e.message === 'NO_MIGRATION') return res.status(500).json({ error: '数据库迁移未生效（transactions.reverse_of 缺失），为安全起见暂不允许冲销重记。' }); throw e; }
    if (!t) return res.status(404).json({ error: '流水不存在' });
    /* 参数校验放在「可冲销性」之前：400 说的是**这次请求**的问题，与这行当前状态无关，
     * 先报更准确（否则一条已被冲销的行会把参数错误盖成 409，调用方看不懂）。 */
    // 允许改：账户 / 金额 / 类别 / 描述。类型不可改（改类型等于换了笔业务，请删了重记）。
    const body = req.body || {};
    const newAcc = body.account_id != null && body.account_id !== '' ? Number(body.account_id) : t.account_id;
    const newAmt = body.amount != null && body.amount !== '' ? Number(body.amount) : t.amount;
    const newCat = body.category != null ? String(body.category) : t.category;
    const newDesc = body.description != null ? String(body.description) : t.description;
    if (!Number.isFinite(newAmt) || newAmt === 0) return res.status(400).json({ error: '新金额必须是 0 以外的数字' });
    if (!Number.isInteger(newAcc) || newAcc <= 0) return res.status(400).json({ error: '新账户不合法' });
    const accOk = (await safeExec("SELECT id FROM accounts WHERE id = ? AND COALESCE(status,1) = 1", [newAcc])).values?.[0]?.[0];
    if (!accOk) return res.status(400).json({ error: `账户 #${newAcc} 不存在或已停用` });
    if (String(newCat || '').includes('冲销')) return res.status(400).json({ error: '类别不允许带「冲销」字样（那是系统自留的审计标识）' });
    // 转账涉及两个账户成对变动，原地编辑只会改到一侧 ⇒ 明确拒绝并指路
    if (t.type === 'transfer' || t.type === 'transfer_in') return res.status(409).json({ error: '转账不支持原地编辑（一次转账是「转出 + 转入」两条流水，改一侧会让两账户对不上）⇒ 请删除后重新转账。', rejected: true });
    const chk = await txReversible(t);
    if (!chk.ok) return res.status(chk.code).json({ error: chk.reason, rejected: true });
    const sign = TX_NET_SIGN[t.type];
    // ① 冲销原行
    const rv = await writeReversal(t, req.user, '(编辑重记)');
    /* ★ P5-4（P3-08）：同 DELETE 路径，抢不到冲销位则不得继续记新行（否则余额会只加不减）。 */
    if (rv.dup) return res.status(409).json({ ok: false, code: 'TX_ALREADY_REVERSED', rejected: true, error: `流水 #${t.id} 已被（并发的）另一次操作冲销过，本次编辑未生效。` });
    // ② 按新值记一条新行，原单号沿用（对账时同一单号可见完整改前/改后链）
    const ins = await safeExec(
        "INSERT INTO transactions (type, account_id, amount, category, description, operator_id, operator_name, order_number, party_type, party_id, party_name, revised_from) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
        [t.type, newAcc, newAmt, newCat, newDesc, req.user.id, req.user.real_name,
            t.order_number || null, t.party_type || null, null, null, t.id]
    );
    const newId = ins.values?.[0]?.[0] ?? null;
    // ② 的余额变动（新值落账到（可能是新的）账户）
    await run("UPDATE accounts SET balance = balance + ? WHERE id = ?", [Math.round(sign * newAmt * 100) / 100, newAcc]);
    saveDB();
    res.json({
        ok: true, revised: t.id, new_id: newId == null ? null : Number(newId),
        reversal: { reversal_id: rv.reversalId, account_id: Number(t.account_id), amount: -t.amount, balance_delta: rv.delta },
        applied: { account_id: newAcc, amount: newAmt, balance_delta: Math.round(sign * newAmt * 100) / 100 },
        net_effect: Math.round((sign * newAmt - sign * t.amount) * 100) / 100,
    });
});
app.get('/api/finance/overview', authMiddleware, hasPerm('finance_view'), async (_req, res) => {
    await initDB();
    // P4（2026-10-11 时区统一）：原 `toISOString()` 取 UTC 日 / `new Date(y,m,1).toISOString()` 在 GMT+8 下
    // 会退到上月最后一天（实测 2026-09-30 ≠ 10-01）⇒ 改走北京口径唯一真源。
    const today = bjToday();
    const monthStart = bjMonthStart(0);
    // ★ 性能（2026-10-04）：原 4 次聚合 + 1 次账户列表 = 5 次顺序往返 ⇒ 合并为 1 次
    const S = await scalars([
        { key: 'today_income', sql: `SELECT COALESCE(SUM(amount),0) FROM transactions WHERE type='income' AND date(created_at) = '${today}'` },
        { key: 'today_expense', sql: `SELECT COALESCE(SUM(amount),0) FROM transactions WHERE type='expense' AND date(created_at) = '${today}'` },
        { key: 'month_income', sql: `SELECT COALESCE(SUM(amount),0) FROM transactions WHERE type='income' AND date(created_at) >= '${monthStart}'` },
        { key: 'month_expense', sql: `SELECT COALESCE(SUM(amount),0) FROM transactions WHERE type='expense' AND date(created_at) >= '${monthStart}'` },
        { key: 'accounts', sql: `SELECT COALESCE(json_agg(json_build_object('id', id, 'name', name, 'type', type, 'balance', balance) ORDER BY id), '[]'::json) FROM accounts WHERE status=1` },
    ]);
    const accountList = (Array.isArray(S.accounts) ? S.accounts : []).map((a) => ({ id: a.id, name: a.name, type: a.type, balance: Number(a.balance) }));
    const totalBalance = accountList.reduce((sum, a) => sum + a.balance, 0);
    res.json({
        today_income: Number(S.today_income || 0), today_expense: Number(S.today_expense || 0),
        month_income: Number(S.month_income || 0), month_expense: Number(S.month_expense || 0),
        accounts: accountList, total_balance: totalBalance,
    });
});
app.get('/api/finance/reconciliation', authMiddleware, hasPerm('reconciliation'), async (req, res) => {
    await initDB();
    const { account_id, start_date, end_date } = req.query;
    let sql = "SELECT * FROM transactions WHERE 1=1";
    const params = [];
    if (account_id) {
        sql += " AND account_id = " + Number(account_id);
    }
    if (start_date) {
        sql += " AND date(created_at) >= '" + String(start_date).replace(/'/g, "''") + "'";
    }
    if (end_date) {
        sql += " AND date(created_at) <= '" + String(end_date).replace(/'/g, "''") + "'";
    }
    sql += " ORDER BY created_at DESC";
    const result = await safeExec(sql, params);
    // 按账户聚合数据
    const agg = {};
    for (const t of result.values || []) {
        const accountId = t[2];
        const type = t[1];
        const amount = Number(t[3]);
        if (!agg[accountId]) {
            agg[accountId] = { account_id: accountId, income: 0, expense: 0 };
        }
        if (type === 'income')
            agg[accountId].income += amount;
        else if (type === 'expense')
            agg[accountId].expense += amount;
    }
    const accounts = await safeExec("SELECT id, name, balance FROM accounts WHERE status=1");
    const reconciliations = (accounts.values || []).map((a) => {
        const accId = a[0];
        const data = agg[accId] || { income: 0, expense: 0 };
        return {
            id: accId,
            account_name: a[1],
            income: data.income,
            expense: data.expense,
            current_balance: Number(a[2]),
            diff: data.income - data.expense - Number(a[2])
        };
    });
    res.json(reconciliations);
});
// ==================== ANALYSIS ====================
app.get('/api/analysis/dashboard', authMiddleware, async (req, res) => {
    await initDB();
    // P4（2026-10-11 时区统一）：改走北京口径唯一真源（详见 BJ-TIME 块注释）。
    const today = bjToday();
    const monthStart = bjMonthStart(0);
    // 数据权限：所有账号统计全店数据（对齐智慧记云端默认，管理员开单成员也可查看）
    const scopeSql = '';
    // 排除作废单（对齐智慧记：作废单不计入统计）
    const VOID = " AND COALESCE(payment_status,'') <> '作废'";
    const VOID_SO = " AND COALESCE(so.payment_status,'') <> '作废'";
    /* ★ 性能（2026-10-04）：原先 9 个聚合各做一次 `await safeExec` = 9 次顺序往返
     *   ⇒ 线上实测地板 450ms（DB 执行本身合计不到 20ms）。合并成 1 条 SQL 后只 1 次往返。
     *   数值口径逐字未改：同样的 WHERE、同样的 COALESCE、同样的 COST_SIGN_SQL。 */
    const S = await scalars([
        { key: 'todaySales', sql: `SELECT COALESCE(SUM(final_amount),0) FROM sales_orders WHERE substr(COALESCE(bill_date, created_at),1,10)='${today}'${scopeSql}${VOID}` },
        { key: 'todayExpense', sql: `SELECT COALESCE(SUM(amount),0) FROM transactions WHERE type='expense' AND date(created_at)='${today}'${scopeSql}` },
        { key: 'todayCost', sql: `SELECT COALESCE(SUM(${COST_SIGN_SQL} * oi.quantity * ${COST_UNIT_SQL}),0) FROM sales_order_items oi JOIN sales_orders so ON oi.order_id=so.id JOIN products p ON oi.product_id=p.id WHERE substr(COALESCE(so.bill_date, so.created_at),1,10)='${today}'${scopeSql}${VOID_SO}` },
        { key: 'todayOrders', sql: `SELECT COUNT(*) FROM sales_orders WHERE substr(COALESCE(bill_date, created_at),1,10)='${today}'${scopeSql}${VOID}` },
        { key: 'warningCount', sql: `SELECT COUNT(*) FROM products WHERE stock_quantity <= warning_quantity AND status=1` },
        { key: 'monthSales', sql: `SELECT COALESCE(SUM(final_amount),0) FROM sales_orders WHERE substr(COALESCE(bill_date, created_at),1,10) >= '${monthStart}'${scopeSql}${VOID}` },
        { key: 'monthCost', sql: `SELECT COALESCE(SUM(${COST_SIGN_SQL} * oi.quantity * ${COST_UNIT_SQL}),0) FROM sales_order_items oi JOIN sales_orders so ON oi.order_id=so.id JOIN products p ON oi.product_id=p.id WHERE substr(COALESCE(so.bill_date, so.created_at),1,10) >= '${monthStart}'${scopeSql}${VOID_SO}` },
        /* ★ 原 arSum/arCnt/apSum/apCnt 四个标量已【移除】（2026-10-08）。
         *   它们算的是 `SUM(owe_amount)`＝「未结清单据合计」，不是应收：
         *     · 旧结果 ¥2,107,243.20（1103 单） vs 对账页 ¥487,404.60（186 家）
         *     · 智慧记自身旁证：单据 owe 合计 ¥1,961,049 vs 客户 cur_amt 合计 ¥460,668
         *   ⇒ 应收/应付的唯一真源改为下面的 computeArap()（与 /finance/arap 同一函数）。 */
        /* ★ P2（2026-10-11）成本完整性：逐明细行问「这一行有没有成本价」。
         *   与上面 todayCost/monthCost 同一次往返（合并进同一条 SQL），零额外 RTT。 */
        ...costIntegritySql(`substr(COALESCE(so.bill_date, so.created_at),1,10)='${today}'`, `${scopeSql}${VOID_SO}`),
        ...costIntegritySql(`substr(COALESCE(so.bill_date, so.created_at),1,10) >= '${monthStart}'`, `${scopeSql}${VOID_SO}`)
            .map((x) => ({ ...x, key: 'm_' + x.key })),
    ]);
    const N = (v) => Number(v || 0);
    const todaySales = N(S.todaySales), todayCost = N(S.todayCost), monthSales = N(S.monthSales), monthCost = N(S.monthCost);
    /* ★ 2026-10-09（老板拍板 2-C）欠款字段按 debt_view 门禁：
     *   未授权时**整个字段不出现**（不是 0）——0 会被前端渲染成"真的欠 0 元"，
     *   属于「看似真值的错」，比不返回更坏。顺带省掉一次 computeArap() 全表往返。 */
    const canDebt = parsePerms(req.user).includes('debt_view');
    const arap = canDebt ? await computeArap() : null;
    /* P2（2026-10-11）成本完整性：今日窗 + 本月窗，原样暴露给前端。
     * ★ 只加字段、不改任何旧字段（todayProfit 等一律保持原值），前端可独立发布。 */
    const ciToday = costIntegrityOut(S, N);
    const ciMonth = costIntegrityOut({
        costTotalRows: S.m_costTotalRows, costItemRows: S.m_costItemRows, costFallbackRows: S.m_costFallbackRows,
        costMissingRows: S.m_costMissingRows, costMissingQty: S.m_costMissingQty,
        costMissingAmount: S.m_costMissingAmount,
    }, N);
    res.json({
        todaySales, todayExpense: N(S.todayExpense), todayCost, todayProfit: todaySales - todayCost,
        todayOrders: N(S.todayOrders), warningCount: N(S.warningCount), monthSales,
        monthCost, monthProfit: monthSales - monthCost,
        /* —— 成本完整性（只加字段）——
         * costBasis: 'historical' 全部用开单当时进价（最可信）
         *            | 'mixed' 部分行回退档案价 | 'all_fallback' 历史价全不可用
         *            | 'current'/'current_partial' 旧口径（行级列尚未迁移）
         *            | 'none' 窗口内无成本明细行
         * 前端判据用 costMissingRows（**逐明细行**判定），
         * ★ 不要再用 `!todayCost`（无销售时误报）或 `todaySales>0`（部分缺失时漏报）。 */
        costBasis: ciToday.basis,
        costComplete: ciToday.complete,
        costPartitioned: ciToday.partitioned,
        costTotalRows: ciToday.total_rows,
        costHistoricRows: ciToday.historic_rows,
        costItemRows: ciToday.historic_rows,
        costFallbackRows: ciToday.fallback_rows,
        costMissingRows: ciToday.missing_rows,
        costMissingQty: ciToday.missing_qty,
        costMissingAmount: ciToday.missing_amount,
        monthCostBasis: ciMonth.basis,
        monthCostComplete: ciMonth.complete,
        monthCostMissingRows: ciMonth.missing_rows,
        monthCostMissingAmount: ciMonth.missing_amount,
        monthCostFallbackRows: ciMonth.fallback_rows,
        ...(canDebt ? {
            receivable: arap.summary.total_receivable,
            unpaidCount: arap.summary.receivable_parties,   // 语义修正：家数（原为"未结清单数"）
            payable: arap.summary.total_payable,
            payableCount: arap.summary.payable_parties,
        } : {}),
    });
});
/* 销售统计 —— 对齐智慧记「报表逐月归组」口径
 *
 * ★ 两种响应形态，靠 group_by 触发，保证「前端/后端两条独立发布链」任意先上线都不炸：
 *   不传 group_by  → 旧形态：裸数组 [{date, actual_sales, order_count}]（旧前端原样可用）
 *   传 group_by    → 新形态：信封 { group_by, rows:[...], sums:{...} }（新前端只走这条）
 *
 * ★ 口径说明（与仪表盘 / profit 端点保持同一套）：
 *   - 作废单不计入统计（COALESCE(payment_status,'') <> '作废'）
 *   - 正单与退货单分开算：sale_amount 只含正单，return_amount 只含退货单（金额本身为负）
 *   - order_count 只数正单，return_count 只数退货单 —— 与旧形态的 order_count 口径一致
 *   - 成本口径必须带 COST_SIGN_SQL 符号（退货单收入为负、成本同步取负），否则成本率被虚增
 */
app.get('/api/analysis/sales', authMiddleware, hasPerm('sales_stats'), async (req, res) => {
    await initDB();
    const { start_date, end_date } = req.query;
    const BD = "substr(COALESCE(bill_date, created_at),1,10)";
    const BDS = "substr(COALESCE(so.bill_date, so.created_at),1,10)";
    const gb = String(req.query.group_by || '').toLowerCase();
    const isMonthly = gb === 'month' || gb === 'year';
    const P_SO = gb === 'month' ? "substr(COALESCE(bill_date, created_at),1,7)"
        : gb === 'year' ? "substr(COALESCE(bill_date, created_at),1,4)" : BD;
    const P_IT = gb === 'month' ? "substr(COALESCE(so.bill_date, so.created_at),1,7)"
        : gb === 'year' ? "substr(COALESCE(so.bill_date, so.created_at),1,4)" : BDS;
    const cond = ["COALESCE(payment_status,'') <> '作废'"];
    if (start_date)
        cond.push(`${BD} >= '${String(start_date).replace(/'/g, "''")}'`);
    if (end_date)
        cond.push(`${BD} <= '${String(end_date).replace(/'/g, "''")}'`);
    const WHERE = ' WHERE ' + cond.join(' AND ');
    // 主表：正单销售额 / 退货额 / 单数 / 欠款
    const mainRows = (await safeExec(`
    SELECT ${P_SO} as period,
           COALESCE(SUM(CASE WHEN COALESCE(biz_type,'sale')='sale_return' THEN final_amount ELSE 0 END),0) as return_amount,
           COALESCE(SUM(CASE WHEN COALESCE(biz_type,'sale')='sale_return' THEN 0 ELSE final_amount END),0) as sale_amount,
           COALESCE(SUM(CASE WHEN COALESCE(biz_type,'sale')='sale_return' THEN 0 ELSE 1 END),0) as order_count,
           COALESCE(SUM(CASE WHEN COALESCE(biz_type,'sale')='sale_return' THEN 1 ELSE 0 END),0) as return_count,
           COALESCE(SUM(COALESCE(owe_amount,0)),0) as owe_amount
    FROM sales_orders${WHERE}
    GROUP BY ${P_SO} ORDER BY ${P_SO} ASC
  `)).values || [];
    // 成本：必须 JOIN 明细与商品，符号带 COST_SIGN_SQL（退货成本取负）
    const condIt = ["COALESCE(so.payment_status,'') <> '作废'"];
    if (start_date)
        condIt.push(`${BDS} >= '${String(start_date).replace(/'/g, "''")}'`);
    if (end_date)
        condIt.push(`${BDS} <= '${String(end_date).replace(/'/g, "''")}'`);
    const costRows = (await safeExec(`
    SELECT ${P_IT} as period,
           COALESCE(SUM(${COST_SIGN_SQL} * oi.quantity * ${COST_UNIT_SQL}),0) as cost,
           COALESCE(SUM(${COST_SIGN_SQL} * oi.quantity),0) as qty
    FROM sales_order_items oi
    JOIN sales_orders so ON oi.order_id = so.id
    JOIN products p ON oi.product_id = p.id
    WHERE ${condIt.join(' AND ')}
    GROUP BY ${P_IT}
  `)).values || [];
    const costMap = {};
    for (const c of costRows)
        costMap[String(c[0])] = { cost: Number(c[1] || 0), qty: Number(c[2] || 0) };
    const rows = mainRows.map((r) => {
        const period = String(r[0]);
        const saleAmount = Math.round(Number(r[2] || 0) * 100) / 100;
        const returnAmount = Math.round(Number(r[1] || 0) * 100) / 100;
        const orderCount = Number(r[3] || 0);
        const c = costMap[period] || { cost: 0, qty: 0 };
        const net = Math.round((saleAmount + returnAmount) * 100) / 100;
        return {
            period,
            date: period,
            sale_amount: saleAmount,
            actual_sales: saleAmount,
            return_amount: returnAmount,
            net_amount: net,
            order_count: orderCount,
            return_count: Number(r[4] || 0),
            owe_amount: Math.round(Number(r[5] || 0) * 100) / 100,
            cost: Math.round(c.cost * 100) / 100,
            gross_profit: Math.round((net - c.cost) * 100) / 100,
            qty: Math.round(c.qty * 100) / 100,
            avg_order: orderCount > 0 ? Math.round((saleAmount / orderCount) * 100) / 100 : 0,
        };
    });
    // 旧形态：只按日、只回三个字段 —— 一个字节都不改，旧前端照常
    if (!isMonthly && gb !== 'day') {
        return res.json(rows.map((r) => ({
            date: r.date, actual_sales: r.actual_sales, order_count: r.order_count
        })));
    }
    const sums = rows.reduce((s, r) => ({
        sale_amount: s.sale_amount + r.sale_amount,
        return_amount: s.return_amount + r.return_amount,
        net_amount: s.net_amount + r.net_amount,
        order_count: s.order_count + r.order_count,
        return_count: s.return_count + r.return_count,
        cost: s.cost + r.cost,
        qty: s.qty + r.qty,
        gross_profit: s.gross_profit + r.gross_profit,
        periods: s.periods + 1,
    }), { sale_amount: 0, return_amount: 0, net_amount: 0, order_count: 0, return_count: 0, cost: 0, qty: 0, gross_profit: 0, periods: 0 });
    for (const k of Object.keys(sums))
        sums[k] = Math.round(sums[k] * 100) / 100;
    sums.avg_order = sums.order_count > 0 ? Math.round((sums.sale_amount / sums.order_count) * 100) / 100 : 0;
    sums.gross_margin = sums.net_amount > 0 ? Math.round((sums.gross_profit / sums.net_amount) * 10000) / 100 : 0;
    res.json({ group_by: gb || 'day', rows, sums });
});
/* 热销排行 —— 对齐智慧记「热销排行」口径
 *
 * ⚠️ 历史 bug（本次修复）：旧版只返回 total_qty / total_amount 两个数量字段，
 *   而前端读的是 total_quantity → 表格「销售数量」列恒为 undefined。
 *   本次补 total_quantity 别名（值同 total_qty），旧前端不改也一起修好。
 *   同时补 cost / gross_profit / avg_price / rank，并支持 limit 与日期区间。
 * ★ 保持裸数组形态（只加字段、不改结构），发布顺序无关。
 * ★ 排除作废单；退货单数量为负（COST_SIGN_SQL），故热销榜天然是净销量。
 */
app.get('/api/analysis/sales/top-products', authMiddleware, hasPerm('sales_stats'), async (req, res) => {
    await initDB();
    const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 3650);
    const limit = Math.min(Math.max(Number(req.query.limit) || 10, 1), 200);
    // P4：近 N 天起始日改走北京口径（原 UTC ⇒ 早 8 点前窗口整体前移一天）
    const startDate = req.query.start_date
        ? String(req.query.start_date)
        : bjDaysAgo(days);
    const endDate = req.query.end_date ? String(req.query.end_date) : '';
    const cond = [
        "COALESCE(so.bill_date, substr(so.created_at,1,10)) >= '" + startDate.replace(/'/g, "''") + "'",
        "COALESCE(so.payment_status,'') <> '作废'",
    ];
    if (endDate)
        cond.push("COALESCE(so.bill_date, substr(so.created_at,1,10)) <= '" + endDate.replace(/'/g, "''") + "'");
    const result = (await safeExec(`
    SELECT p.name, p.sku,
           SUM(${COST_SIGN_SQL} * oi.quantity) as total_qty,
           SUM(${COST_SIGN_SQL} * oi.amount)   as total_amount,
           SUM(${COST_SIGN_SQL} * oi.quantity * ${COST_UNIT_SQL}) as total_cost,
           COUNT(DISTINCT so.id) as order_count
    FROM sales_order_items oi
    JOIN sales_orders so ON oi.order_id = so.id
    JOIN products p ON oi.product_id = p.id
    WHERE ${cond.join(' AND ')}
    GROUP BY p.id, p.name, p.sku ORDER BY total_amount DESC LIMIT ${limit}
  `)).values || [];
    const products = result.map((p, i) => {
        const qty = Math.round(Number(p[2] || 0) * 100) / 100;
        const amount = Math.round(Number(p[3] || 0) * 100) / 100;
        const cost = Math.round(Number(p[4] || 0) * 100) / 100;
        return {
            rank: i + 1,
            name: p[0], sku: p[1],
            total_qty: qty,
            total_quantity: qty,          // ← 前端实际读取的字段名
            total_amount: amount,
            total_cost: cost,
            gross_profit: Math.round((amount - cost) * 100) / 100,
            gross_margin: amount > 0 ? Math.round(((amount - cost) / amount) * 10000) / 100 : 0,
            avg_price: qty !== 0 ? Math.round((amount / qty) * 100) / 100 : 0,
            order_count: Number(p[5] || 0),
        };
    });
    res.json(products);
});
/* 进货统计 —— 对齐智慧记「采购统计逐月归组」口径
 * ★ 2026-10-13 老板拍板：**进货信息不对子账号开放** ⇒ hasPerm('sales_stats') → adminOnly。
 *   原挂 sales_stats 是漏洞：给子账号开「销售统计」权限时会连带看到进货金额/供应商欠款，
 *   而老板明确要求「不能看到进货信息」。前端路由 /analysis/purchase 同步加 '@admin' 门。
 * ★ 同 sales：不传 group_by → 旧形态裸数组 [{date,total,order_count}]；传 group_by → 信封。
 * ★ 口径（2026-10-09 修订）：原注释写「采购单表无作废状态字段，故不做状态过滤」**已过时** ——
 *   进货单删除走软删除 status='cancelled'（见 PO_ALIVE），故此处必须过滤，
 *   否则删掉的进货单还会被算进进货金额。今日 517 张全为 completed ⇒ 补过滤后数字逐分不变。
 */
app.get('/api/analysis/purchase', authMiddleware, adminOnly, async (req, res) => {
    await initDB();
    const { start_date, end_date } = req.query;
    const BD = "substr(COALESCE(bill_date, created_at),1,10)";
    const gb = String(req.query.group_by || '').toLowerCase();
    const isPeriodic = gb === 'month' || gb === 'year' || gb === 'day';
    const P = gb === 'month' ? "substr(COALESCE(bill_date, created_at),1,7)"
        : gb === 'year' ? "substr(COALESCE(bill_date, created_at),1,4)" : BD;
    const cond = ['1=1', PO_ALIVE];
    if (start_date)
        cond.push(`${BD} >= '${String(start_date).replace(/'/g, "''")}'`);
    if (end_date)
        cond.push(`${BD} <= '${String(end_date).replace(/'/g, "''")}'`);
    const result = await safeExec(`
    SELECT ${P} as period,
           COALESCE(SUM(total_amount),0) as total_amount,
           COALESCE(SUM(COALESCE(paid_amount,0)),0) as paid_amount,
           COALESCE(SUM(COALESCE(owe_amount,0)),0) as owe_amount,
           COUNT(*) as order_count,
           COUNT(DISTINCT NULLIF(supplier_name,'')) as supplier_count
    FROM purchase_orders
    WHERE ${cond.join(' AND ')}
    GROUP BY ${P} ORDER BY ${P} ASC
  `);
    /* ★★★ 2026-10-14 口径修正（老板反馈原文）：
     *   「这个怎么跟供应商欠款不一致 —— 有些付款没选单子，可自行扣除货款」
     *
     * 【老板说得对，实测坐实】宏瑞库内 `purchase_orders.paid_amount` 是**随单已付**：
     *   · 单据口径已付 ¥3,205,892.32（529 单），欠 ¥2,171,122.10
     *   · 而智慧记应付对账 back_tamt = ¥3,821,438.83、arrears = ¥214,754.60
     *   · 若只看单据口径，本页与《应收应付》永远差一截，用户会认为"系统不可信"。
     *
     * 【差额是什么】智慧记资金流水 fund_type 实测分布：
     *   SALE 2000 / SKD_WITH_SALE 600 / SKD 404 / FKD_WITH_PUR 206 / FKD 124 / PUR 111 ...
     *   其中 **FKD（直接付款）= 124 笔，不挂任何单据**，宏瑞导入后落在
     *   transactions.category='直接付款'（实测 126 笔 / ¥1,849,031.10）。
     *   这类钱**不体现在任何采购单上**，所以按 SUM(paid_amount) 永远算不出来。
     *
     * 【改法】已付金额改按**真实付款流水**归集（与 computeArap 的供应商 paid 同源：
     *   同一套 FOLD_SQL 空白折叠 + canonSQL 别名，按 supplier 名匹配 transactions），
     *   于是「付了钱但没选单」的那部分自动抵扣，本页与《应收应付》不再各说各话。
     *   同时**保留** `doc_paid_amount` / `doc_owe_amount`（单据口径），
     *   前端并列展示 —— 差异本身就是信息（有多少钱付了但没挂单），不是要抹掉的东西。 */
    const PT = gb === 'month' ? "substr(t.created_at,1,7)"
        : gb === 'year' ? "substr(t.created_at,1,4)" : "substr(t.created_at,1,10)";
    const payCond = [`COALESCE(t.party_name,'') <> ''`,
        `EXISTS (SELECT 1 FROM suppliers s WHERE s.status=1 AND ${FOLD_SQL('s.name')} = ${FOLD_SQL('t.party_name')})`];
    if (start_date) payCond.push(`substr(t.created_at,1,10) >= '${String(start_date).replace(/'/g, "''")}'`);
    if (end_date) payCond.push(`substr(t.created_at,1,10) <= '${String(end_date).replace(/'/g, "''")}'`);
    const payRes = await safeExec(`
    SELECT ${PT} as period,
           COALESCE(SUM(CASE WHEN t.type='expense' THEN t.amount ELSE -t.amount END),0) as net_paid,
           COALESCE(SUM(CASE WHEN t.type='expense' AND COALESCE(t.category,'')='直接付款' THEN t.amount ELSE 0 END),0) as direct_paid,
           COUNT(*) as pay_rows
    FROM transactions t
    WHERE ${payCond.join(' AND ')}
    GROUP BY 1`);
    const payByPeriod = {};
    for (const r of (payRes.values || [])) {
        payByPeriod[String(r[0])] = {
            net: Math.round(Number(r[1] || 0) * 100) / 100,
            direct: Math.round(Number(r[2] || 0) * 100) / 100,
            rows: Number(r[3] || 0),
        };
    }
    const rows = (result.values || []).map((r) => {
        const total = Math.round(Number(r[1] || 0) * 100) / 100;
        const orderCount = Number(r[4] || 0);
        const docPaid = Math.round(Number(r[2] || 0) * 100) / 100;
        const docOwe = Math.round(Number(r[3] || 0) * 100) / 100;
        const pay = payByPeriod[String(r[0])] || { net: 0, direct: 0, rows: 0 };
        return {
            period: String(r[0]),
            date: String(r[0]),
            total,
            total_amount: total,
            /* 主口径 = 真实付款流水（含未挂单的直接付款） */
            paid_amount: pay.net,
            owe_amount: Math.round((total - pay.net) * 100) / 100,
            /* 对照口径 = 单据随单已付 / 单据未结清（保留，用于解释差异） */
            doc_paid_amount: docPaid,
            doc_owe_amount: docOwe,
            /* 其中「付了钱但没挂单」的部分 —— 老板点名的那个数 */
            direct_paid_amount: pay.direct,
            pay_rows: pay.rows,
            order_count: orderCount,
            supplier_count: Number(r[5] || 0),
            avg_order: orderCount > 0 ? Math.round((total / orderCount) * 100) / 100 : 0,
        };
    });
    if (!isPeriodic) {
        return res.json(rows.map((r) => ({ date: r.date, total: r.total, order_count: r.order_count })));
    }
    /* 补齐「期间内只付了钱、没有采购单」的期间（还旧账）——
       否则本页合计会比真实付款少一块，又跟《应收应付》对不上。
       这类期间进货为 0、差额为负，是正确的会计表达（当期在还以前欠的账）。 */
    const seenPeriod = new Set(rows.map((r) => r.period));
    for (const [p, v] of Object.entries(payByPeriod)) {
        if (seenPeriod.has(p)) continue;
        rows.push({
            period: p, date: p, total: 0, total_amount: 0,
            paid_amount: v.net, owe_amount: Math.round(-v.net * 100) / 100,
            doc_paid_amount: 0, doc_owe_amount: 0, direct_paid_amount: v.direct,
            pay_rows: v.rows, order_count: 0, supplier_count: 0, avg_order: 0,
        });
    }
    rows.sort((a, b) => (a.period < b.period ? -1 : a.period > b.period ? 1 : 0));
    const sums = rows.reduce((s, r) => ({
        total_amount: s.total_amount + r.total_amount,
        paid_amount: s.paid_amount + r.paid_amount,
        owe_amount: s.owe_amount + r.owe_amount,
        doc_paid_amount: s.doc_paid_amount + (r.doc_paid_amount || 0),
        doc_owe_amount: s.doc_owe_amount + (r.doc_owe_amount || 0),
        direct_paid_amount: s.direct_paid_amount + (r.direct_paid_amount || 0),
        order_count: s.order_count + r.order_count,
        periods: s.periods + 1,
    }), {
        total_amount: 0, paid_amount: 0, owe_amount: 0,
        doc_paid_amount: 0, doc_owe_amount: 0, direct_paid_amount: 0,
        order_count: 0, periods: 0,
    });
    for (const k of Object.keys(sums))
        sums[k] = Math.round(sums[k] * 100) / 100;
    sums.avg_order = sums.order_count > 0 ? Math.round((sums.total_amount / sums.order_count) * 100) / 100 : 0;
    res.json({ group_by: gb || 'day', rows, sums });
});
/* 库存统计 —— 对齐智慧记「库存统计」口径
 *
 * ⚠️ 历史 bug（本次修复）：旧版只返回 total_products / total_stock / warning_count，
 *   而前端读的是 low_stock_count 与 total_value → 两处恒为 undefined，
 *   导致「库存金额」恒显示 ¥0.00，且饼图算出 NaN（warning_count - undefined）。
 *   本次补齐这两个字段 + 分类改为对象数组（旧版是位置数组，前端按名取值拿不到）。
 * ★ 作废口径：products.status=1 视为在售，与仪表盘 warningCount 完全同一条件，保证两页不打架。
 */
app.get('/api/analysis/inventory', authMiddleware, hasPerm('sales_stats'), async (_req, res) => {
    await initDB();
    // 分类聚合：一次查完（含金额与状态分档），避免多次往返
    const catRows = (await safeExec(`
    SELECT COALESCE(NULLIF(TRIM(COALESCE(category,'')),''),'未分类') as category,
           COUNT(*) as product_count,
           COALESCE(SUM(stock_quantity),0) as stock_qty,
           COALESCE(SUM(COALESCE(stock_quantity,0) * COALESCE(cost_price,0)),0) as cost_value,
           COALESCE(SUM(COALESCE(stock_quantity,0) * COALESCE(sell_price,0)),0) as retail_value,
           SUM(CASE WHEN COALESCE(stock_quantity,0) <= 0 THEN 1 ELSE 0 END) as out_of_stock,
           SUM(CASE WHEN COALESCE(stock_quantity,0) > 0 AND COALESCE(stock_quantity,0) <= COALESCE(warning_quantity,0) THEN 1 ELSE 0 END) as below_warning
    FROM products WHERE status=1
    GROUP BY 1 ORDER BY cost_value DESC
  `)).values || [];
    const categories = catRows.map((r) => ({
        category: String(r[0]),
        product_count: Number(r[1] || 0),
        stock_qty: Math.round(Number(r[2] || 0) * 100) / 100,
        cost_value: Math.round(Number(r[3] || 0) * 100) / 100,
        retail_value: Math.round(Number(r[4] || 0) * 100) / 100,
        out_of_stock: Number(r[5] || 0),
        below_warning: Number(r[6] || 0),
    }));
    const t = (await safeExec(`
    SELECT COUNT(*),
           COALESCE(SUM(stock_quantity),0),
           COALESCE(SUM(COALESCE(stock_quantity,0) * COALESCE(cost_price,0)),0),
           COALESCE(SUM(COALESCE(stock_quantity,0) * COALESCE(sell_price,0)),0),
           SUM(CASE WHEN COALESCE(stock_quantity,0) <= COALESCE(warning_quantity,0) THEN 1 ELSE 0 END),
           SUM(CASE WHEN COALESCE(stock_quantity,0) <= 0 THEN 1 ELSE 0 END),
           SUM(CASE WHEN COALESCE(stock_quantity,0) > 0 AND COALESCE(stock_quantity,0) <= COALESCE(warning_quantity,0) THEN 1 ELSE 0 END),
           SUM(CASE WHEN COALESCE(stock_quantity,0) < 0 THEN 1 ELSE 0 END),
           SUM(CASE WHEN COALESCE(batch_number,'') <> '' THEN 1 ELSE 0 END)
    FROM products WHERE status=1
  `)).values?.[0] || [];
    // 库存金额 TOP（给库存统计页做明细，按成本额倒序）
    const topRows = (await safeExec(`
    SELECT name, sku, COALESCE(NULLIF(TRIM(COALESCE(category,'')),''),'未分类') as category,
           stock_quantity, warning_quantity, cost_price, sell_price,
           COALESCE(stock_quantity,0) * COALESCE(cost_price,0) as cost_value
    FROM products WHERE status=1
    ORDER BY cost_value DESC LIMIT 20
  `)).values || [];
    const top_products = topRows.map((r) => ({
        name: String(r[0]), sku: String(r[1] || ''), category: String(r[2]),
        stock_quantity: Math.round(Number(r[3] || 0) * 100) / 100,
        warning_quantity: Math.round(Number(r[4] || 0) * 100) / 100,
        cost_price: Math.round(Number(r[5] || 0) * 100) / 100,
        sell_price: Math.round(Number(r[6] || 0) * 100) / 100,
        cost_value: Math.round(Number(r[7] || 0) * 100) / 100,
    }));
    const outOfStock = Number(t[5] || 0);
    res.json({
        categories,
        total_products: Number(t[0] || 0),
        total_stock: Math.round(Number(t[1] || 0) * 100) / 100,
        total_cost_value: Math.round(Number(t[2] || 0) * 100) / 100,
        total_value: Math.round(Number(t[3] || 0) * 100) / 100,
        warning_count: Number(t[4] || 0),
        low_stock_count: outOfStock,
        out_of_stock_count: outOfStock,
        below_warning_count: Number(t[6] || 0),
        negative_stock_count: Number(t[7] || 0),
        batch_tracked_count: Number(t[8] || 0),
        top_products,
    });
});
app.get('/api/analysis/profit', authMiddleware, adminOnly, async (req, res) => {
    await initDB();
    // P4（2026-10-11 时区统一）：改走北京口径唯一真源（详见 BJ-TIME 块注释）。
    const today = bjToday();
    const monthStart = bjMonthStart(0);
    // 数据权限：员工只统计自己的销售单（管理员/店长看全店）
    const isAdminUser = req.user.role === 'admin' || req.user.role === 'manager';
    const scopeSql = ''; // 全店可见
    // 排除作废单（作废单不计入统计）
    const VOID = " AND COALESCE(payment_status,'') <> '作废'";
    const VOID_SO = " AND COALESCE(so.payment_status,'') <> '作废'";
    // ★ 性能（2026-10-04）：原 8 次聚合各一次往返 ⇒ 合并为 1 次（口径逐字未改）
    const other = (t, from) => `SELECT COALESCE(SUM(amount),0) FROM transactions WHERE type='${t}' AND (category LIKE '其他%' OR category LIKE '%其他%') AND date(created_at) ${from}${scopeSql}`;
    const S = await scalars([
        { key: 'todaySales', sql: `SELECT COALESCE(SUM(final_amount),0) FROM sales_orders WHERE substr(COALESCE(bill_date, created_at),1,10)='${today}'${scopeSql}${VOID}` },
        // 成本口径修正：退货单（biz_type='sale_return'）收入为负、成本必须同步取负，否则成本率会被虚增
        { key: 'todayCost', sql: `SELECT COALESCE(SUM(${COST_SIGN_SQL} * oi.quantity * ${COST_UNIT_SQL}),0) FROM sales_order_items oi JOIN sales_orders so ON oi.order_id = so.id JOIN products p ON oi.product_id = p.id WHERE substr(COALESCE(so.bill_date, so.created_at),1,10)='${today}'${scopeSql}${VOID_SO}` },
        { key: 'monthSales', sql: `SELECT COALESCE(SUM(final_amount),0) FROM sales_orders WHERE substr(COALESCE(bill_date, created_at),1,10) >= '${monthStart}'${scopeSql}${VOID}` },
        { key: 'monthCost', sql: `SELECT COALESCE(SUM(${COST_SIGN_SQL} * oi.quantity * ${COST_UNIT_SQL}),0) FROM sales_order_items oi JOIN sales_orders so ON oi.order_id = so.id JOIN products p ON oi.product_id = p.id WHERE substr(COALESCE(so.bill_date, so.created_at),1,10) >= '${monthStart}'${scopeSql}${VOID_SO}` },
        { key: 'todayOtherIncome', sql: other('income', `='${today}'`) },
        { key: 'todayOtherExpense', sql: other('expense', `='${today}'`) },
        { key: 'monthOtherIncome', sql: other('income', `>= '${monthStart}'`) },
        { key: 'monthOtherExpense', sql: other('expense', `>= '${monthStart}'`) },
        // ★ P2（2026-10-11）成本完整性（今日窗 + 本月窗），零额外往返
        ...costIntegritySql(`substr(COALESCE(so.bill_date, so.created_at),1,10)='${today}'`, `${scopeSql}${VOID_SO}`),
        ...costIntegritySql(`substr(COALESCE(so.bill_date, so.created_at),1,10) >= '${monthStart}'`, `${scopeSql}${VOID_SO}`)
            .map((x) => ({ ...x, key: 'm_' + x.key })),
    ]);
    const todaySales = Number(S.todaySales || 0), todayCost = Number(S.todayCost || 0);
    const monthSales = Number(S.monthSales || 0), monthCost = Number(S.monthCost || 0);
    const todayOtherIncome = Number(S.todayOtherIncome || 0), todayOtherExpense = Number(S.todayOtherExpense || 0);
    const monthOtherIncome = Number(S.monthOtherIncome || 0), monthOtherExpense = Number(S.monthOtherExpense || 0);
    /* ---------- 以下为本次新增（全部为「只加字段」，不删不改旧字段，发布顺序无关） ---------- */
    // (1) 近 12 个月序列：销售额 / 成本 / 毛利 / 其他收支 / 净利润
    const BD = "substr(COALESCE(bill_date, created_at),1,7)";
    const BDS = "substr(COALESCE(so.bill_date, so.created_at),1,7)";
    // P4：近 12 个月序列改走北京口径（原用本机 getFullYear/getMonth ⇒ UTC 主机上跨月会错位一个月）
    const start12 = bjMonthStart(-11).slice(0, 7);
    const months12 = [];
    for (let i = 11; i >= 0; i--) {
        months12.push(bjMonthStart(-i).slice(0, 7));
    }
    // ★ 性能（2026-10-04）：三条 GROUP BY 互不依赖 ⇒ 并发（wall 从 3×RTT 降到 1×RTT）
    const [saleRes, costRes, otherRes] = await Promise.all([
        safeExec(`
      SELECT ${BD} ym,
             COALESCE(SUM(CASE WHEN COALESCE(biz_type,'sale')='sale_return' THEN final_amount ELSE 0 END),0) ret,
             COALESCE(SUM(CASE WHEN COALESCE(biz_type,'sale')='sale_return' THEN 0 ELSE final_amount END),0) sale
      FROM sales_orders
      WHERE COALESCE(payment_status,'') <> '作废' AND ${BD} >= '${start12}'
      GROUP BY ym`),
        safeExec(`
      SELECT ${BDS} ym, COALESCE(SUM(${COST_SIGN_SQL} * oi.quantity * ${COST_UNIT_SQL}),0) cost
      FROM sales_order_items oi
      JOIN sales_orders so ON oi.order_id = so.id
      JOIN products p ON oi.product_id = p.id
      WHERE COALESCE(so.payment_status,'') <> '作废' AND ${BDS} >= '${start12}'
      GROUP BY ym`),
        safeExec(`
      SELECT substr(created_at,1,7) ym, type, COALESCE(SUM(amount),0) amt
      FROM transactions
      WHERE (category LIKE '其他%' OR category LIKE '%其他%') AND substr(created_at,1,7) >= '${start12}'
      GROUP BY ym, type`),
    ]);
    const saleByM = {};
    for (const r of (saleRes.values || [])) {
        saleByM[String(r[0])] = { ret: Number(r[1] || 0), sale: Number(r[2] || 0) };
    }
    const costByM = {};
    for (const r of (costRes.values || [])) {
        costByM[String(r[0])] = Number(r[1] || 0);
    }
    const otherByM = {};
    for (const r of (otherRes.values || [])) {
        const ym2 = String(r[0]);
        if (!otherByM[ym2])
            otherByM[ym2] = { income: 0, expense: 0 };
        otherByM[ym2][String(r[1]) === 'income' ? 'income' : 'expense'] += Number(r[2] || 0);
    }
    const R2 = (n) => Math.round(Number(n || 0) * 100) / 100;
    const monthly = months12.map((ym) => {
        const s = saleByM[ym] || { ret: 0, sale: 0 };
        const cost = costByM[ym] || 0;
        const oi = otherByM[ym] || { income: 0, expense: 0 };
        const netSales = s.sale + s.ret;
        const gross = netSales - cost;
        return {
            month: ym,
            sales: R2(netSales), sale_amount: R2(s.sale), return_amount: R2(s.ret),
            cost: R2(cost), profit: R2(gross),
            gross_margin: netSales > 0 ? Math.round((gross / netSales) * 10000) / 100 : 0,
            other_income: R2(oi.income), other_expense: R2(oi.expense),
            net: R2(gross + oi.income - oi.expense),
        };
    });
    // (2) 亏损明细（对齐智慧记「亏损明细」报表）：按商品算 净销售额 − 成本 < 0
    const lpCond = ["COALESCE(so.payment_status,'') <> '作废'"];
    if (req.query.start_date)
        lpCond.push("substr(COALESCE(so.bill_date, so.created_at),1,10) >= '" + String(req.query.start_date).replace(/'/g, "''") + "'");
    if (req.query.end_date)
        lpCond.push("substr(COALESCE(so.bill_date, so.created_at),1,10) <= '" + String(req.query.end_date).replace(/'/g, "''") + "'");
    const loss_products = ((await safeExec(`
    SELECT p.name, p.sku,
           SUM(${COST_SIGN_SQL} * oi.quantity) as qty,
           SUM(${COST_SIGN_SQL} * oi.amount) as amount,
           SUM(${COST_SIGN_SQL} * oi.quantity * ${COST_UNIT_SQL}) as cost,
           SUM(${COST_SIGN_SQL} * oi.amount) - SUM(${COST_SIGN_SQL} * oi.quantity * ${COST_UNIT_SQL}) as profit
    FROM sales_order_items oi
    JOIN sales_orders so ON oi.order_id = so.id
    JOIN products p ON oi.product_id = p.id
    WHERE ${lpCond.join(' AND ')}
    GROUP BY p.id, p.name, p.sku
    HAVING SUM(${COST_SIGN_SQL} * oi.amount) - SUM(${COST_SIGN_SQL} * oi.quantity * ${COST_UNIT_SQL}) < 0
    ORDER BY profit ASC LIMIT 20`)).values || []).map((r) => {
        const amount = R2(r[3]), cost = R2(r[4]), profit = R2(r[5]);
        return {
            name: String(r[0]), sku: String(r[1] || ''),
            qty: R2(r[2]), amount, cost, profit,
            margin: amount > 0 ? Math.round((profit / amount) * 10000) / 100 : 0,
            avg_price: Number(r[2]) !== 0 ? R2(amount / Number(r[2])) : 0,
        };
    });
    // (3) 指定区间口径（前端切「自定义区间」时用；不传则为 0，前端自行忽略）
    let range = null;
    if (req.query.start_date || req.query.end_date) {
        const sd = req.query.start_date ? String(req.query.start_date) : '1970-01-01';
        const ed = req.query.end_date ? String(req.query.end_date) : '2999-12-31';
        const BDd = "substr(COALESCE(bill_date, created_at),1,10)";
        const BDSd = "substr(COALESCE(so.bill_date, so.created_at),1,10)";
        const rSale = Number((await safeExec(`SELECT COALESCE(SUM(final_amount),0) FROM sales_orders WHERE COALESCE(payment_status,'') <> '作废' AND ${BDd} >= '${sd}' AND ${BDd} <= '${ed}'`)).values?.[0]?.[0] || 0);
        const rCost = Number((await safeExec(`SELECT COALESCE(SUM(${COST_SIGN_SQL} * oi.quantity * ${COST_UNIT_SQL}),0) FROM sales_order_items oi JOIN sales_orders so ON oi.order_id = so.id JOIN products p ON oi.product_id = p.id WHERE COALESCE(so.payment_status,'') <> '作废' AND ${BDSd} >= '${sd}' AND ${BDSd} <= '${ed}'`)).values?.[0]?.[0] || 0);
        const rOther = (await safeExec(`SELECT type, COALESCE(SUM(amount),0) FROM transactions WHERE (category LIKE '其他%' OR category LIKE '%其他%') AND date(created_at) >= '${sd}' AND date(created_at) <= '${ed}' GROUP BY type`)).values || [];
        let rOi = 0, rOe = 0;
        for (const x of rOther) {
            if (String(x[0]) === 'income')
                rOi = Number(x[1] || 0);
            else
                rOe = Number(x[1] || 0);
        }
        range = {
            start: sd, end: ed,
            sales: R2(rSale), cost: R2(rCost), profit: R2(rSale - rCost),
            other_income: R2(rOi), other_expense: R2(rOe),
            net: R2(rSale - rCost + rOi - rOe),
            gross_margin: rSale > 0 ? Math.round(((rSale - rCost) / rSale) * 10000) / 100 : 0,
        };
    }
    const ciTodayP = costIntegrityOut(S, Number);
    const ciMonthP = costIntegrityOut({
        costTotalRows: S.m_costTotalRows, costItemRows: S.m_costItemRows, costFallbackRows: S.m_costFallbackRows,
        costMissingRows: S.m_costMissingRows, costMissingQty: S.m_costMissingQty,
        costMissingAmount: S.m_costMissingAmount,
    }, Number);
    res.json({
        today_sales: todaySales, today_cost: todayCost, today_profit: todaySales - todayCost,
        today_other_income: todayOtherIncome, today_other_expense: todayOtherExpense,
        today_net: todaySales - todayCost + todayOtherIncome - todayOtherExpense,
        month_sales: monthSales, month_cost: monthCost, month_profit: monthSales - monthCost,
        month_other_income: monthOtherIncome, month_other_expense: monthOtherExpense,
        month_net: monthSales - monthCost + monthOtherIncome - monthOtherExpense,
        // ← 别名：AnalysisHome 读的是 month_income / month_expense，旧版没这两字段 → 恒显示 0
        today_income: todaySales, today_expense: todayCost,
        month_income: monthSales, month_expense: monthCost,
        today_gross_margin: todaySales > 0 ? Math.round(((todaySales - todayCost) / todaySales) * 10000) / 100 : 0,
        month_gross_margin: monthSales > 0 ? Math.round(((monthSales - monthCost) / monthSales) * 10000) / 100 : 0,
        /* ★ P2（2026-10-11）成本完整性 —— 只加字段，不改任何既有金额/毛利率字段。
         * 前端提示必须用 cost_missing_rows（逐明细行），不要用 today_sales>0 之类近似判据。 */
        cost_basis: ciTodayP.basis,
        cost_complete: ciTodayP.complete,
        cost_partitioned: ciTodayP.partitioned,
        cost_total_rows: ciTodayP.total_rows,
        cost_historic_rows: ciTodayP.historic_rows,
        cost_fallback_rows: ciTodayP.fallback_rows,
        cost_missing_rows: ciTodayP.missing_rows,
        cost_missing_qty: ciTodayP.missing_qty,
        cost_missing_amount: ciTodayP.missing_amount,
        month_cost_basis: ciMonthP.basis,
        month_cost_complete: ciMonthP.complete,
        month_cost_missing_rows: ciMonthP.missing_rows,
        month_cost_missing_amount: ciMonthP.missing_amount,
        month_cost_fallback_rows: ciMonthP.fallback_rows,
        monthly,
        loss_products,
        range,
    });
});
/* 员工业绩 —— 对齐智慧记「员工业绩」口径
 *
 * 🔴🔴 重大口径修正（2026-09-26 实测发现，本次修复的核心）
 *   旧版按 `operator_id` 归属统计，但真实库里：
 *     销售单 4433 条 → operator_id 为 NULL 的 4425 条（99.82%），只有 8 条有 ID；
 *     而 operator_name 基本都有值（曹怡航 2433 / 老板 1992 / 曹 4 / 詹一帆 2 / 蒋斌斌 2）。
 *   结果：旧版员工业绩合计只有 8 单 ¥2,040，而全店正单 4028 单 ¥631 万 —— 页面等于废的。
 *   ⚠️ 这与 /finance/arap 的根因**完全同型**：导入器只落名称、不落 ID → 按 ID JOIN 必然落空。
 *
 * ★ 本次改法：归属键改为「名称优先、ID 兜底」
 *     归属名 = COALESCE(NULLIF(TRIM(operator_name),''), users.real_name, '未归属')
 *   并额外返回 attribution 诊断块，让前端能诚实告知「有多少单未归属」，不假装全覆盖。
 * ★ 保留原字段名（list / summary / 成本利润）→ 旧前端不炸。
 */
app.get('/api/analysis/performance', authMiddleware, hasPerm('performance'), async (req, res) => {
    await initDB();
    const isAdmin = req.user && req.user.role !== 'employee';
    const { start_date, end_date } = req.query;
    // P4：默认窗口改走北京口径（本月首日 + 北京今天）
    const monthStart = bjMonthStart(0);
    const defStart = start_date ? String(start_date) : monthStart;
    const defEnd = end_date ? String(end_date) : bjToday();
    const END = defEnd + ' 23:59:59';
    const R2 = (n) => Math.round(Number(n || 0) * 100) / 100;
    // 归属键（名称优先、ID 兜底）—— 三处查询必须用完全相同的表达式，否则分组对不上
    const NAME_KEY = "COALESCE(NULLIF(TRIM(COALESCE(so.operator_name,'')),''), NULLIF(TRIM(COALESCE(u.real_name,'')),''), '未归属')";
    // 账号表（给「未匹配账号」的历史操作人标一个身份）
    // ★ 性能（2026-10-04）：账号表与「我是谁」互不依赖 ⇒ 并发取，省 1 次往返
    const [uRes, meRes] = await Promise.all([
        safeExec("SELECT id, real_name, role FROM users WHERE status=1"),
        isAdmin ? Promise.resolve(null) : safeExec("SELECT real_name FROM users WHERE id = ?", [Number(req.user.id)]),
    ]);
    const uRows = uRes.values || [];
    const roleByName = {};
    const idToName = {};
    for (const u of uRows) {
        roleByName[String(u[1] || '').trim()] = String(u[2] || 'employee');
        idToName[Number(u[0])] = String(u[1] || '').trim();
    }
    /* ★★ 2026-10-14 修复（老板反馈「老板被标成历史操作人」）：
       智慧记的 operator_name 存的是「老板」这个**称呼**，而不是真名；
       宏瑞 users.real_name 是「詹一帆」⇒ 名称对不上，业绩页把管理员标成「历史操作人（无账号）」。
       这里只补**身份标注**（role/is_account），**不改显示名** —— 显示名仍与智慧记逐字一致。 */
    const OPERATOR_ALIAS = { '老板': '詹一帆' };
    const aliasOf = {};
    for (const [alias, realName] of Object.entries(OPERATOR_ALIAS)) {
        const rn = String(realName).trim();
        if (roleByName[rn] && !roleByName[alias]) { roleByName[alias] = roleByName[rn]; aliasOf[alias] = rn; }
    }
    // 店员只能看自己：用「自己的 real_name」当归属名过滤（旧版按 id 过滤，因 ID 全空恒返回空）
    const selfName = isAdmin ? '' : String(meRes?.values?.[0]?.[0] || '').trim();
    // ---- 主聚合：订单数 / 销售额 / 提成（按归属名） ----
    const c1 = ["COALESCE(so.payment_status,'') <> '作废'", "substr(COALESCE(so.bill_date, so.created_at),1,10) >= ?", "substr(COALESCE(so.bill_date, so.created_at),1,10) <= ?"];
    const p1 = [defStart, END];
    if (!isAdmin) {
        c1.push(`${NAME_KEY} = ?`);
        p1.push(selfName);
    }
    // ---- 件数与成本（同一归属键、同一区间；成本带 COST_SIGN 符号） ----
    const c2 = ["COALESCE(so.payment_status,'') <> '作废'", "substr(COALESCE(so.bill_date, so.created_at),1,10) >= ?", "substr(COALESCE(so.bill_date, so.created_at),1,10) <= ?"];
    const p2 = [defStart, END];
    if (!isAdmin) {
        c2.push(`${NAME_KEY} = ?`);
        p2.push(selfName);
    }
    // ---- 全店汇总 ----
    const tc = ["COALESCE(so.payment_status,'') <> '作废'", "substr(COALESCE(so.bill_date, so.created_at),1,10) >= ?", "substr(COALESCE(so.bill_date, so.created_at),1,10) <= ?"];
    const tp = [defStart, END];
    if (!isAdmin) {
        tc.push(`${NAME_KEY} = ?`);
        tp.push(selfName);
    }
    /* ★ 性能（2026-10-04）：主聚合/件数成本/全店汇总/归属诊断/未归属，5 条互不依赖
     *   ⇒ 并发执行，wall 从约 5×RTT 降到 1×RTT。SQL 与参数逐字未改。 */
    const [mainRes, aggRes, totalRes, diagRes, unattrRes] = await Promise.all([
        safeExec(`
    SELECT ${NAME_KEY} as op_name,
           COUNT(*) as orders,
           COALESCE(SUM(so.final_amount),0) as sales,
           COALESCE(SUM(so.commission_amount),0) as commission
    FROM sales_orders so
    LEFT JOIN users u ON u.id = so.operator_id
    WHERE ${c1.join(' AND ')}
    GROUP BY 1 ORDER BY sales DESC`, p1),
        safeExec(`
    SELECT ${NAME_KEY} as op_name,
           COALESCE(SUM(oi.quantity),0) as qty,
           COALESCE(SUM(${COST_SIGN_SQL} * oi.quantity * ${COST_UNIT_SQL}),0) as cost
    FROM sales_order_items oi
    JOIN sales_orders so ON oi.order_id = so.id
    LEFT JOIN users u ON u.id = so.operator_id
    JOIN products p ON oi.product_id = p.id
    WHERE ${c2.join(' AND ')}
    GROUP BY 1`, p2),
        safeExec(`
    SELECT COUNT(*), COALESCE(SUM(so.final_amount),0)
    FROM sales_orders so LEFT JOIN users u ON u.id = so.operator_id
    WHERE ${tc.join(' AND ')}`, tp),
        safeExec(`
    SELECT COUNT(*),
           SUM(CASE WHEN so.operator_id IS NULL THEN 1 ELSE 0 END),
           SUM(CASE WHEN COALESCE(TRIM(so.operator_name),'') = '' THEN 1 ELSE 0 END),
           COUNT(DISTINCT NULLIF(TRIM(COALESCE(so.operator_name,'')),''))
    FROM sales_orders so WHERE COALESCE(so.payment_status,'') <> '作废' AND substr(COALESCE(so.bill_date, so.created_at),1,10) >= ? AND substr(COALESCE(so.bill_date, so.created_at),1,10) <= ?`, [defStart, END]),
        safeExec(`
    SELECT COUNT(*), COALESCE(SUM(so.final_amount),0)
    FROM sales_orders so LEFT JOIN users u ON u.id = so.operator_id
    WHERE COALESCE(so.payment_status,'') <> '作废' AND substr(COALESCE(so.bill_date, so.created_at),1,10) >= ? AND substr(COALESCE(so.bill_date, so.created_at),1,10) <= ?
      AND ${NAME_KEY} = '未归属'`, [defStart, END]),
    ]);
    const mainRows = mainRes.values || [];
    const aggRows = aggRes.values || [];
    const aggByName = {};
    for (const r of aggRows)
        aggByName[String(r[0])] = { qty: Number(r[1] || 0), cost: Number(r[2] || 0) };
    const rows = mainRows.map((r) => {
        const name = String(r[0]);
        const orders = Number(r[1] || 0);
        const sales = R2(r[2]);
        const ag = aggByName[name] || { qty: 0, cost: 0 };
        const role = roleByName[name];
        return {
            name,
            // role 为空 = 该名称在账号表里找不到（历史操作人 / 已停用账号）→ 明确标出，不冒充在职员工
            role: role ? (role === 'admin' ? '管理员' : role === 'manager' ? '店长' : '店员') : '历史操作人（无账号）',
            is_account: !!role,
            orders,
            sales,
            qty: R2(ag.qty),
            commission: R2(r[3]),
            avg_order: orders > 0 ? R2(sales / orders) : 0,
            cost: isAdmin ? R2(ag.cost) : undefined,
            profit: isAdmin ? R2(sales - ag.cost) : undefined,
            gross_margin: isAdmin && sales > 0 ? Math.round(((sales - ag.cost) / sales) * 10000) / 100 : undefined,
        };
    }).filter((r) => r.orders > 0);
    rows.sort((a, b) => b.sales - a.sales);
    // ---- 汇总与归属诊断（已在上面 Promise.all 中并发取回） ----
    const totalStat = totalRes.values?.[0] || [0, 0];
    const totalS = R2(totalStat[1]);
    const totalO = Number(totalStat[0] || 0);
    const staff = rows.filter((r) => r.orders > 0).length;
    /* ★ 归属诊断（诚实披露用）：告诉前端「有多少单根本没归属」，
     *   避免页面显示成一个看起来完整、实际漏掉大半的排行榜。 */
    const diag = diagRes.values?.[0] || [0, 0, 0, 0];
    const unattributed = unattrRes.values?.[0] || [0, 0];
    const attribution = {
        positive_orders: totalO,
        no_operator_id: Number(diag[1] || 0),
        no_operator_name: Number(diag[2] || 0),
        name_holders: Number(diag[3] || 0),
        unattributed_orders: Number(unattributed[0] || 0),
        unattributed_amount: R2(unattributed[1]),
        covered_rate: totalO > 0 ? Math.round(((totalO - Number(unattributed[0] || 0)) / totalO) * 10000) / 100 : 0,
        /* ★ 2026-10-14 文案修正：operator_id 已按名称回填（NULL 归零），
           原句「operator_id 在历史数据中大面积为空」会把已修好的事实说反。 */
        note: '按 operator_name 归属（业绩归属人＝单据上选的业务员，与开单人无关）；未归属单据已单列，不计入任何人业绩',
    };
    /* 按月趋势（用同一归属键，保证与 list 口径一致） */
    let by_month = [];
    if (String(req.query.group_by || '') === 'month') {
        const c3 = ["COALESCE(so.payment_status,'') <> '作废'", "substr(COALESCE(so.bill_date, so.created_at),1,10) >= ?", "substr(COALESCE(so.bill_date, so.created_at),1,10) <= ?"];
        const p3 = [defStart, END];
        if (!isAdmin) {
            c3.push(`${NAME_KEY} = ?`);
            p3.push(selfName);
        }
        by_month = ((await safeExec(`
      SELECT substr(COALESCE(so.bill_date, so.created_at),1,7) ym, ${NAME_KEY} as op_name, COUNT(*), COALESCE(SUM(so.final_amount),0)
      FROM sales_orders so LEFT JOIN users u ON u.id = so.operator_id
      WHERE ${c3.join(' AND ')}
      GROUP BY ym, op_name ORDER BY ym`, p3)).values || []).map((r) => ({
            month: String(r[0]),
            name: String(r[1] || '未归属'),
            orders: Number(r[2] || 0),
            sales: R2(r[3]),
        }));
    }
    res.json({
        list: rows,
        summary: {
            total_orders: totalO,
            total_sales: totalS,
            is_admin: isAdmin,
            staff_count: staff,
            avg_per_staff: staff > 0 ? R2(totalS / staff) : 0,
            total_qty: R2(rows.reduce((s, r) => s + Number(r.qty || 0), 0)),
            total_commission: R2(rows.reduce((s, r) => s + Number(r.commission || 0), 0)),
            total_profit: isAdmin ? R2(rows.reduce((s, r) => s + Number(r.profit || 0), 0)) : undefined,
            range: { start: defStart, end: defEnd },
        },
        attribution,
        by_month,
    });
});
// ==================== 生产需求分析（按厂/客户的需求情况与月度经营建议） ====================
/* 生产需求分析
 * ★ 2026-10-13 老板拍板：hasPerm('sales_stats') → **adminOnly**。
 *   原因（本轮子账号实测挖出的一处**真实泄漏**）：该接口除了金额字段，还会返回一段
 *   后端拼好的「本月经营建议」**文本**，正文里直接写着「重点维护 零售散客（月均 ¥8,757.97）」
 *   —— 键名脱敏（AMOUNT_SCOPE 按字段名抹 null）**管不到字符串内容**，
 *   子账号照样能读到具体金额。既然该页通篇是金额与金额推导的结论，对店员本无用处，
 *   直接收成 adminOnly 最干净：**不以"抹字段"的方式堵文本，而是不给整页**。 */
app.get('/api/analysis/demand', authMiddleware, adminOnly, async (req, res) => {
    await initDB();
    // 数据权限：员工只看自己的销售单（管理员/店长看全店）
    const isAdminUser = req.user.role === 'admin' || req.user.role === 'manager';
    const scopeSql = ''; // 全店可见
    // P4（2026-10-11 时区统一）：原用本机 getFullYear/getMonth（在 UTC 主机上跨月会错位一个月）
    // ⇒ 改走北京口径唯一真源。
    const curYM = bjMonthStart(0).slice(0, 7); // 当月 YYYY-MM（北京）
    // 历史起点：11 个月前的第一天（共12个月窗口）
    const startDate = bjMonthStart(-11);
    // ---- 1) 客户需求：按 客户×月份 聚合近12个月正金额销售 ----
    const custRows = (await safeExec(`
    SELECT customer_name, substr(COALESCE(bill_date, created_at),1,7) as ym, COUNT(*) as cnt, SUM(final_amount) as amt
    FROM sales_orders
    WHERE COALESCE(payment_status,'') <> '作废' AND substr(COALESCE(bill_date, created_at),1,10) >= '${startDate}' AND customer_name IS NOT NULL AND customer_name != ''${scopeSql}
    GROUP BY customer_name, ym
  `)).values || [];
    const byCust = {};
    for (const r of custRows) {
        const name = String(r[0]);
        const ym = String(r[1]);
        if (!byCust[name])
            byCust[name] = {};
        byCust[name][ym] = { cnt: Number(r[2] || 0), amt: Number(r[3] || 0) };
    }
    // 生成近12个月的月份列表（升序）· P4：改走北京口径
    const months = [];
    for (let i = 11; i >= 0; i--) {
        months.push(bjMonthStart(-i).slice(0, 7));
    }
    const customers = Object.keys(byCust)
        .map((name) => {
        const m = byCust[name];
        const monthly = months.map((ym) => m[ym] || { cnt: 0, amt: 0 });
        const totalAmt = monthly.reduce((s, x) => s + x.amt, 0);
        const activeMonths = monthly.filter((x) => x.amt > 0).length;
        const monthAvg = activeMonths > 0 ? totalAmt / activeMonths : 0;
        // 近3个月加权（越近权重越高），用于预测下月
        const last3 = monthly.slice(-3).map((x, i) => ({ ...x, w: i + 1 }));
        const wSum = last3.reduce((s, x) => s + x.amt * x.w, 0);
        const wDiv = last3.reduce((s, x) => s + (x.amt > 0 ? x.w : 0), 0);
        const forecast = wDiv > 0 ? wSum / wDiv : monthAvg;
        const lastAmt = monthly[monthly.length - 1].amt;
        const trend = monthAvg > 0 ? (lastAmt - monthAvg) / monthAvg : 0;
        return {
            name,
            total_orders: monthly.reduce((s, x) => s + x.cnt, 0),
            total_amount: Math.round(totalAmt * 100) / 100,
            active_months: activeMonths,
            month_avg: Math.round(monthAvg * 100) / 100,
            last_month_amount: Math.round(lastAmt * 100) / 100,
            forecast: Math.round(forecast * 100) / 100,
            trend: Math.round(trend * 100) / 100,
            recent: monthly.slice(-6).map((x, i) => ({ month: months.slice(-6)[i], amount: Math.round(x.amt * 100) / 100 })),
        };
    })
        .sort((a, b) => b.total_amount - a.total_amount)
        .slice(0, 20);
    // ---- 2) 商品采购建议：近12个月销量 + 当前库存 ----
    const itemRows = (await safeExec(`
    SELECT oi.product_name, SUM(oi.quantity) as qty, SUM(oi.amount) as amt
    FROM sales_order_items oi
    JOIN sales_orders so ON oi.order_id = so.id
    WHERE substr(COALESCE(so.bill_date, so.created_at),1,10) >= '${startDate}' AND COALESCE(so.payment_status,'') <> '作废'${scopeSql.replace('operator_id', 'so.operator_id')}
    GROUP BY oi.product_name
  `)).values || [];
    const stockRows = (await safeExec("SELECT name, stock_quantity, warning_quantity, sell_price, cost_price FROM products WHERE status = 1")).values || [];
    const stockByName = {};
    for (const s of stockRows)
        stockByName[String(s[0])] = { stock: Number(s[1] || 0), warn: Number(s[2] || 0), sell: Number(s[3] || 0), cost: Number(s[4] || 0) };
    const products = itemRows
        .map((r) => {
        const name = String(r[0]);
        const qty = Number(r[1] || 0);
        const amt = Number(r[2] || 0);
        const monthQty = qty / 12;
        const st = stockByName[name] || { stock: 0, warn: 10, sell: 0, cost: 0 };
        // 建议备货 = 下月预测销量（月均） - 当前库存（至少补到预警线以上）
        const suggested = Math.max(0, Math.ceil(monthQty * 1.2 - st.stock));
        return {
            name,
            month_avg_qty: Math.round(monthQty * 100) / 100,
            stock: st.stock,
            warning: st.warn,
            suggested_order: suggested,
            est_amount: Math.round(suggested * (st.cost || st.sell || 0) * 100) / 100,
            status: st.stock <= st.warn ? 'low' : (suggested > 0 ? 'refill' : 'ok'),
        };
    })
        .filter((p) => p.month_avg_qty > 0)
        .sort((a, b) => b.est_amount - a.est_amount)
        .slice(0, 15);
    // ---- 3) 月度趋势与经营建议 ----
    const monthRows = (await safeExec(`
    SELECT substr(COALESCE(bill_date, created_at),1,7) as ym, COUNT(*) as cnt, SUM(final_amount) as amt
    FROM sales_orders WHERE COALESCE(payment_status,'') <> '作废' AND substr(COALESCE(bill_date, created_at),1,10) >= '${startDate}'
    GROUP BY ym ORDER BY ym
  `)).values || [];
    const trend = months.map((ym) => {
        const r = monthRows.find((x) => String(x[0]) === ym);
        return { month: ym, orders: Number(r?.[1] || 0), amount: Math.round(Number(r?.[2] || 0) * 100) / 100 };
    });
    const totalMonth = trend.reduce((s, x) => s + x.amount, 0);
    const avgMonth = totalMonth / Math.max(1, trend.filter((x) => x.amount > 0).length);
    const lastMonth = trend[trend.length - 1].amount;
    const prevMonth = trend.length > 1 ? trend[trend.length - 2].amount : lastMonth;
    // 当月可能还没过完：按已过天数折算为全月预估，避免"半月比全月"的假性下跌
    // P4：原引用 `new Date(now.getFullYear(), now.getMonth()+1, 0).getDate()` / `now.getDate()`
    // ⇒ 改走北京口径（顺带修掉 now 未声明的问题）。
    const curMonthFull = trend[trend.length - 1].month === curYM ? Number(bjMonthEnd(0).slice(8, 10)) : 1;
    const curDay = Number(bjToday().slice(8, 10));
    const curMonthEst = curMonthFull > 0 ? Math.round((lastMonth / curDay) * curMonthFull * 100) / 100 : lastMonth;
    const monthTrendPct = prevMonth > 0 ? Math.round(((curMonthEst - prevMonth) / prevMonth) * 100) : 0;
    // 建议文案
    const topCustomers = customers.slice(0, 3).map((c) => `${c.name}（月均 ¥${c.month_avg.toLocaleString()}）`);
    const lowStock = products.filter((p) => p.status === 'low').slice(0, 5);
    const refill = products.filter((p) => p.status === 'refill').slice(0, 5);
    let suggestion = '';
    if (monthTrendPct > 5) {
        suggestion = `本月销售预估较上月增长 ${monthTrendPct}%，需求向好。建议按预测提前备货 ${refill.length > 0 ? refill.slice(0, 3).map((p) => p.name).join('、') : '热销商品'}。`;
    }
    else if (monthTrendPct < -5) {
        suggestion = `本月销售预估较上月下降 ${Math.abs(monthTrendPct)}%，可适当控制进货节奏，重点维护 ${topCustomers.join('、')} 等大客户。`;
    }
    else {
        suggestion = `本月销售预估与上月基本持平。${topCustomers.join('、')} 是稳定需求来源，建议保持现有备货水平，关注 ${lowStock.length > 0 ? lowStock.slice(0, 3).map((p) => p.name).join('、') : '临期/低库存商品'}。`;
    }
    const totalForecast = customers.reduce((s, c) => s + c.forecast, 0);
    const totalRefillAmount = products.filter((p) => p.suggested_order > 0).reduce((s, p) => s + p.est_amount, 0);
    res.json({
        summary: {
            cur_month: curYM,
            month_amount: lastMonth,
            month_est_amount: curMonthEst,
            month_trend_pct: monthTrendPct,
            avg_month_amount: Math.round(avgMonth * 100) / 100,
            forecast_next_month: Math.round(totalForecast * 100) / 100,
            suggested_purchase_amount: Math.round(totalRefillAmount * 100) / 100,
            top_customers: topCustomers,
            suggestion,
        },
        customers,
        products,
        trend,
    });
});
// ==================== STORE ====================
// 店铺信息：只读，返回店名/地址/电话/联系人（无成本毛利）。开单打印小票与采购单都要用，
// 因此放行 settings | sales | purchase 任一权限；无权限者不再能匿名式读取
app.get('/api/store/info', authMiddleware, requireAnyPerm(['settings', 'sales', 'purchase']), async (_req, res) => {
    await initDB();
    const result = await safeExec("SELECT * FROM store_info WHERE id=1");
    const info = result.values?.[0];
    if (!info)
        return res.json({});
    res.json({ id: info[0], name: info[1], address: info[2], phone: info[3], contact_person: info[4] });
});
app.put('/api/store/info', authMiddleware, hasPerm('settings'), async (req, res) => {
    await initDB();
    const { name, address, phone, contact_person } = req.body;
    await run("UPDATE store_info SET name=?, address=?, phone=?, contact_person=?, updated_at=datetime('now','localtime') WHERE id=1", [name, address, phone, contact_person]);
    saveDB();
    saveDB();
    res.json({ ok: true });
});
app.get('/api/store/employees', authMiddleware, hasPerm('employees'), async (_req, res) => {
    await initDB();
    const result = await safeExec("SELECT id, username, real_name, role, phone, status, created_at, last_login FROM users WHERE role != 'admin' ORDER BY id");
    const employees = (result.values || []).map((e) => ({
        id: e[0], username: e[1], real_name: e[2], role: e[3], phone: e[4], status: e[5], created_at: e[6], last_login: e[7]
    }));
    res.json(employees);
});
app.get('/api/store/roles', authMiddleware, hasPerm('employees'), async (_req, res) => {
    await initDB();
    const result = await safeExec("SELECT * FROM roles ORDER BY id");
    res.json(result.values || []);
});
app.get('/api/store/suppliers', authMiddleware, hasPerm('suppliers'), async (req, res) => {
    await initDB();
    /* ★ 2026-10-11（P3）：同 customers。注：本路由改动前**既不返回 status 也不做状态过滤**
       ⇒ 软删除（status=0）的供应商一直混在在用列表里。此处一并对齐：
       默认只出 status=1，include_stopped=1 时全出并带 status 供前端标注。
       实测「+6 户」全部是 status=1（含 5 个双角色实体）⇒ 默认分支结果与改动前一致。 */
    const includeStopped = String(req.query.include_stopped) === '1';
    const result = await safeExec("SELECT * FROM suppliers" + (includeStopped ? "" : " WHERE status=1") + " ORDER BY id");
    const list = (result.values || []).map((s) => ({
        id: Number(s[0]), name: s[1], contact: s[2], phone: s[3], address: s[4], remark: s[5],
        status: Number(s[6]) || 0
    }));
    res.json(list);
});
app.post('/api/store/suppliers', authMiddleware, hasPerm('suppliers'), idem('suppliers'), async (req, res) => {
    await initDB();
    const { name, contact, phone, address, remark } = req.body;
    await run("INSERT INTO suppliers (name, contact, phone, address, remark) VALUES (?, ?, ?, ?, ?)", [name, contact, phone, address, remark]);
    saveDB();
    saveDB();
    res.json({ ok: true });
});
// 更新供应商
app.put('/api/store/suppliers/:id', authMiddleware, hasPerm('suppliers'), async (req, res) => {
    await initDB();
    const { id } = req.params;
    const { name, contact, phone, address, remark } = req.body;
    await run("UPDATE suppliers SET name=?, contact=?, phone=?, address=?, remark=? WHERE id=?", [name, contact, phone, address, remark, id]);
    saveDB();
    saveDB();
    res.json({ ok: true });
});
// 供应商 停用 / 启用（同客户，2026-10-11 P3）
app.put('/api/store/suppliers/:id/status', authMiddleware, hasPerm('suppliers'), async (req, res) => {
    await initDB();
    const { id } = req.params;
    const next = Number((req.body || {}).status);
    if (![1, 2].includes(next)) {
        return res.status(400).json({ error: 'status 只允许 1（在用）或 2（停用）' });
    }
    const row = (await safeExec("SELECT id FROM suppliers WHERE id = ?", [id])).values?.[0];
    if (!row) {
        return res.status(404).json({ error: '供应商不存在' });
    }
    await run("UPDATE suppliers SET status = ? WHERE id = ?", [next, id]);
    saveDB();
    res.json({ ok: true, id: Number(id), status: next });
});
// 删除供应商（软删除：status=0，保留历史引用）
app.delete('/api/store/suppliers/:id', authMiddleware, hasPerm('suppliers'), async (req, res) => {
    await initDB();
    const { id } = req.params;
    const target = (await safeExec("SELECT id FROM suppliers WHERE id = ? AND status = 1", [id])).values?.[0];
    if (!target)
        return res.status(404).json({ error: '供应商不存在' });
    await run("UPDATE suppliers SET status = 0 WHERE id = ?", [id]);
    saveDB();
    saveDB();
    res.json({ ok: true });
});
/**
 * ★ 2026-10-14 新增（老板拍板 1b：业绩按业务员、不按开单人）：
 *   返回每个客户的 `default_operator` —— **该客户历史单据里出现最多的业务员**。
 *   为什么这么取：`customers` 表没有"责任业务员"字段，而开单页现在的默认值是
 *   「开单人自己」（`operatorId = req.user.id`）⇒ 店员代开单时业绩全记到店员头上。
 *   用历史频次当默认值，等效于"客户的责任业务员"，不改表结构、立刻生效。
 * ★ 只给管理员/店长（属经营数据，与金额门同源；子账号拿不到）。
 */
app.get('/api/store/customers/default-operators', authMiddleware, hasPerm('customers'), async (req, res) => {
    await initDB();
    if (!isAdminUser(req.user.role)) return res.json({});
    try {
        const r = await safeExec(
            "SELECT customer_id, operator_name FROM (" +
            "  SELECT customer_id, operator_name, COUNT(*) AS n," +
            "         ROW_NUMBER() OVER (PARTITION BY customer_id ORDER BY COUNT(*) DESC, MAX(created_at) DESC) AS rn" +
            "  FROM sales_orders" +
            "  WHERE COALESCE(payment_status,'') <> '作废'" +
            "    AND COALESCE(operator_name,'') <> ''" +
            "    AND customer_id IS NOT NULL" +
            "  GROUP BY customer_id, operator_name" +
            ") t WHERE rn = 1");
        const out = {};
        for (const row of (r.values || [])) out[String(row[0])] = row[1];
        res.json(out);
    } catch (e) {
        res.status(500).json({ error: '统计默认业务员失败：' + (e && e.message ? e.message : '未知错误') });
    }
});

app.get('/api/store/customers', authMiddleware, hasPerm('customers'), async (req, res) => {
    await initDB();
    /* ★ 2026-10-11（P3）：与智慧记同口径 —— 默认隐藏「已停用」（status=2），
       显式 include_stopped=1 时全部返回，由前端标注「已停用」并给「启用」入口。
       照 /api/inventory/products（:1067-1071）的既有范式，**不改默认行为**：
       迁移前全库 status 只有 1，因此默认分支的结果与改动前逐字一致。
       ⚠ 必须与「导入器映射源 status」同批上线：只映射不加这个开关 ⇒ 44 户一进列表就消失。 */
    const includeStopped = String(req.query.include_stopped) === '1';
    const result = await safeExec("SELECT * FROM customers" + (includeStopped ? "" : " WHERE status=1") + " ORDER BY id");
    const list = (result.values || []).map((c) => ({
        id: Number(c[0]), name: c[1], phone: c[2], address: c[3], contact: c[4], remark: c[5],
        status: Number(c[6]) || 0, created_at: c[7], price_level: c[8] || 'retail'
    }));
    res.json(list);
});
app.post('/api/store/customers', authMiddleware, hasPerm('customers'), idem('customers'), async (req, res) => {
    await initDB();
    const { name, phone, address, contact, remark, price_level } = req.body;
    await run("INSERT INTO customers (name, phone, address, contact, remark, price_level) VALUES (?, ?, ?, ?, ?, ?)", [name, phone, address, contact, remark, price_level || 'retail']);
    saveDB();
    saveDB();
    res.json({ ok: true });
});
app.put('/api/store/customers/:id', authMiddleware, hasPerm('customers'), async (req, res) => {
    await initDB();
    const { id } = req.params;
    const { name, phone, address, contact, remark, price_level, status } = req.body;
    /* ★ 2026-10-11（P3）必须同批改：原实现 `status !== undefined ? status : 1`
       ⇒ 调用方没传 status（编辑表单就是这种情况）就**把当前状态重置为 1**
       ⇒ 引入 status=2（停用）后，「编辑一个停用客户」会**静默把它改回在用**。
       改为：未传 status 时**不写该列**，保持库中现值（既不复活停用，也不复活软删除）。 */
    if (status === undefined) {
        await run("UPDATE customers SET name=?, phone=?, address=?, contact=?, remark=?, price_level=? WHERE id=?", [name, phone, address, contact, remark, price_level || 'retail', id]);
    } else {
        await run("UPDATE customers SET name=?, phone=?, address=?, contact=?, remark=?, price_level=?, status=? WHERE id=?", [name, phone, address, contact, remark, price_level || 'retail', status, id]);
    }
    saveDB();
    saveDB();
    res.json({ ok: true });
});
// 客户 停用 / 启用（对齐智慧记「停用客户」语义，2026-10-11 P3）
//   · 智慧记：status 1=在用 / 2=停用，其客户列表默认隐藏停用档
//   · 宏瑞原「删除客户」实为软删除 status=0，且**没有任何界面能看到或恢复**
//   · 本接口把「停用」变成可逆动作：1↔2；0 是历史软删除标记，不作为可写值对外暴露
/* ★ 2026-10-14 拆权限位：客户「停用」是危险动作，单独走 `customer_disable`。
   原先与查看/新增/编辑共用一个 `customers` 位 ⇒ 子账号也能停用客户。
   管理员/店长不受影响（hasPerm 对 admin 恒真）。 */
app.put('/api/store/customers/:id/status', authMiddleware, hasPerm('customer_disable'), async (req, res) => {
    await initDB();
    const { id } = req.params;
    const next = Number((req.body || {}).status);
    if (![1, 2].includes(next)) {
        return res.status(400).json({ error: 'status 只允许 1（在用）或 2（停用）' });
    }
    const row = (await safeExec("SELECT id FROM customers WHERE id = ?", [id])).values?.[0];
    if (!row) {
        return res.status(404).json({ error: '客户不存在' });
    }
    await run("UPDATE customers SET status = ? WHERE id = ?", [next, id]);
    saveDB();
    res.json({ ok: true, id: Number(id), status: next });
});
// 删除客户（软删除：status=0，保留历史订单引用）
app.delete('/api/store/customers/:id', authMiddleware, hasPerm('customers'), async (req, res) => {
    await initDB();
    const { id } = req.params;
    const target = (await safeExec("SELECT id FROM customers WHERE id = ? AND status = 1", [id])).values?.[0];
    if (!target)
        return res.status(404).json({ error: '客户不存在' });
    await run("UPDATE customers SET status = 0 WHERE id = ?", [id]);
    saveDB();
    saveDB();
    res.json({ ok: true });
});
/**
 * 客户各商品「最近一次成交价」（开单页选中客户后自动带出上次价）
 *
 * 契约（与前端 src/api/index.ts → getCustomerLastPrices 严格对齐）：
 *   入参  GET /api/store/customer-last-prices/:id   （:id = 客户 id）
 *   返回  扁平对象 { [product_id]: unit_price }，前端 setLastPrices(res || {}) 直接用
 *        （axios 响应拦截器已 response.data 解包 ⇒ 这里必须是裸对象，不能套 rows/data）
 *
 * ★ 口径（与 /store/sales-orders、/analysis/* 保持同一套，勿改）：
 *   · 归期一律 substr(COALESCE(so.bill_date, so.created_at),1,10)
 *   · 作废单不参与（COALESCE(payment_status,'') <> '作废'）
 *   · 退货单不参与（biz_type='sale_return'）——退货单价不是成交价，带出来会把价格带偏
 *   · 同商品多条 ⇒ 取归期最新的一条（ORDER BY 归期 DESC, so.id DESC, oi.id DESC 后取首条）
 */
app.get('/api/store/customer-last-prices/:id', authMiddleware, hasPerm('sales'), async (req, res) => {
    await initDB();
    const cid = Number(req.params.id);
    if (!cid)
        return res.json({});
    const result = await safeExec("SELECT oi.product_id, oi.unit_price FROM sales_order_items oi " +
        "JOIN sales_orders so ON oi.order_id = so.id " +
        "WHERE so.customer_id = ? AND COALESCE(so.payment_status,'') <> '作废' " +
        "AND COALESCE(so.biz_type,'sale') <> 'sale_return' AND oi.product_id IS NOT NULL " +
        "ORDER BY substr(COALESCE(so.bill_date, so.created_at),1,10) DESC, so.id DESC, oi.id DESC", [cid]);
    const out = {};
    for (const row of result.values || []) {
        const pid = row[0];
        if (pid === null || pid === undefined)
            continue;
        const key = String(pid);
        if (Object.prototype.hasOwnProperty.call(out, key))
            continue; // 已按归期倒序 ⇒ 首条即「最近一次」
        const price = Number(row[1]);
        if (Number.isFinite(price) && price > 0)
            out[key] = price;
    }
    res.json(out);
});
/* 客户「常购商品」——开单页选中客户后的快捷区
 * ★ 2026-10-09 新增（老板真机反馈：「选择对应的客户能不能提取当时的单价和采购的产品，不用再重新查找」）
 *   与 /store/customer-last-prices/:id **同源同一套口径**（同一条 SQL 骨架、同一套排除规则、
 *   同一个归期表达式），避免"上次价"和"常购清单"两处各算一套、对不上。
 *
 * 契约：GET /api/store/customer-history-products/:id   （:id = 客户 id）
 *   返回 [{ product_id, product_name, sku, last_price, last_date, times, total_qty }]
 *   · last_price / last_date = **最近一次**成交价与归期（按归期倒序取首次出现）
 *   · times = 成交次数（明细行数）；total_qty = 累计数量
 *   · 排序＝最近购买日倒序；上限 50 条（够用且不让手机端铺满）
 *   口径：排除作废单（payment_status='作废'）与退货单（biz_type='sale_return'）；
 *        归期一律 substr(COALESCE(bill_date, created_at),1,10)。
 *   ⚠️ product 已停用/删除的行不过滤 —— 前端会用它去商品池里找，找不到就标灰，
 *      让用户明白"这项买过但现在开不了"，比静默消失可解释。
 */
app.get('/api/store/customer-history-products/:id', authMiddleware, hasPerm('sales'), async (req, res) => {
    await initDB();
    const cid = Number(req.params.id);
    if (!cid)
        return res.json([]);
    const rows = (await safeExec("SELECT oi.product_id, oi.product_name, oi.sku, oi.quantity, oi.unit_price, " +
        "substr(COALESCE(so.bill_date, so.created_at),1,10) AS d " +
        "FROM sales_order_items oi " +
        "JOIN sales_orders so ON oi.order_id = so.id " +
        "WHERE so.customer_id = ? AND COALESCE(so.payment_status,'') <> '作废' " +
        "AND COALESCE(so.biz_type,'sale') <> 'sale_return' AND oi.product_id IS NOT NULL " +
        "ORDER BY d DESC, so.id DESC, oi.id DESC", [cid])).values || [];
    const map = new Map();
    for (const r of rows) {
        const pid = Number(r[0]);
        if (!pid)
            continue;
        if (!map.has(pid)) {
            // 已按归期倒序 ⇒ 首次出现即"最近一次"
            map.set(pid, {
                product_id: pid,
                product_name: r[1] || '',
                sku: r[2] || '',
                last_price: Number(r[4]) || 0,
                last_date: r[5] || '',
                times: 0,
                total_qty: 0,
            });
        }
        const it = map.get(pid);
        it.times += 1;
        it.total_qty += Number(r[3]) || 0;
    }
    res.json([...map.values()].slice(0, 50));
});
const PO_COLS = "id, order_number, supplier_id, supplier_name, total_amount, status, operator_id, operator_name, created_at, payment_status, bill_date, paid_amount, owe_amount, remark, maker_name";
/* 「未删除」判据（2026-10-09）：进货单的删除采用软删除 —— status='cancelled'，记录与明细全保留。
 * ⚠️ 必须 COALESCE：`status NOT IN ('cancelled','void')` 在 status 为 NULL 时求值为 NULL
 *    ⇒ 该行被**静默排除**（不是报错）。原 supplier-reconciliation 就是这么写的，
 *    只因线上 517 张恰好全为 'completed' 才没暴露；新建单若不显式写 status 就会踩到。
 *    凡聚合采购金额/条数的地方一律用本判据，避免「删了还在算」与「NULL 就被吞」两种错。 */
const PO_ALIVE = "COALESCE(status,'completed') NOT IN ('cancelled','void')";
function mapPurchaseOrder(o) {
    const owe = Number(o[12] || 0);
    return {
        id: o[0], order_number: o[1], supplier_id: Number(o[2]) || null, supplier_name: o[3],
        total_amount: Number(o[4]), status: o[5], operator_id: o[6], operator_name: o[7],
        created_at: o[8],
        // 结算状态一律走唯一判据（owe ≤ 0 ⇒ 已结清），不再 `|| '已结清'` 静默兜底
        payment_status: purchasePaymentStatus(o[9], owe),
        bill_date: o[10] || (o[8] ? String(o[8]).slice(0, 10) : null),
        paid_amount: Number(o[11] || 0), owe_amount: owe, remark: o[13] || '', maker_name: o[14] || null
    };
}
app.get('/api/store/purchase-orders', authMiddleware, hasPerm('purchase'), async (req, res) => {
    await initDB();
    const { page = 1, pageSize = 200, keyword, startDate, endDate, status, withTotal } = req.query;
    let where = " WHERE 1=1 AND " + PO_ALIVE;
    if (keyword) {
        const kw = String(keyword).replace(/'/g, "''");
        where += " AND (order_number LIKE '%" + kw + "%' OR supplier_name LIKE '%" + kw + "%')";
    }
    if (startDate) where += " AND COALESCE(bill_date, substr(created_at,1,10)) >= '" + String(startDate).replace(/'/g, "''") + "'";
    if (endDate) where += " AND COALESCE(bill_date, substr(created_at,1,10)) <= '" + String(endDate).replace(/'/g, "''") + "'";
    if (status === 'unpaid') where += " AND COALESCE(owe_amount,0) > 0.005";
    if (status === 'paid') where += " AND COALESCE(owe_amount,0) <= 0.005 AND COALESCE(payment_status,'') <> '作废'";
    const pg = Math.max(1, Number(page) || 1);
    const ps = Math.min(5000, Math.max(1, Number(pageSize) || 200));
    const result = await safeExec("SELECT " + PO_COLS + " FROM purchase_orders" + where +
        " ORDER BY COALESCE(bill_date, substr(created_at,1,10)) DESC, id DESC LIMIT ? OFFSET ?", [ps, (pg - 1) * ps]);
    const orders = (result.values || []).map(mapPurchaseOrder);
    if (withTotal) {
        // ★ 性能（2026-10-04）：COUNT 与两路 SUM 合并为 1 次往返（原 2 次）
        const A = await scalars([
            { key: 'total', sql: "SELECT COUNT(*) FROM purchase_orders" + where },
            { key: 'sum_total', sql: "SELECT COALESCE(SUM(total_amount),0) FROM purchase_orders" + where },
            { key: 'sum_owe', sql: "SELECT COALESCE(SUM(owe_amount),0) FROM purchase_orders" + where },
        ]);
        return res.json({
            rows: orders, total: Number(A.total || 0), page: pg, pageSize: ps,
            sum_total: Number(A.sum_total || 0), sum_owe: Number(A.sum_owe || 0),
        });
    }
    res.json(orders);
});
// 进货单详情（含商品明细，用于 A4 打印）
app.get('/api/store/purchase-orders/:id', authMiddleware, hasPerm('purchase'), async (req, res) => {
    await initDB();
    if (req.params.id === 'export') {
        // 导出进货单（避免与 :id 冲突）
        const { startDate = '2020-01-01', endDate = '2030-12-31' } = req.query;
        const BD = "COALESCE(bill_date, substr(created_at,1,10))";
        const result = await safeExec(`SELECT order_number, supplier_name, total_amount, paid_amount, owe_amount, payment_status, operator_name, ${BD} FROM purchase_orders WHERE ${BD} >= ? AND ${BD} <= ? AND ${PO_ALIVE} ORDER BY ${BD}, id`, [String(startDate), String(endDate)]);
        const rows = [['单据编号', '供应商名称', '应付金额', '已付金额', '欠款', '付款状态', '操作员', '业务日期']];
        for (const r of result.values || []) {
            // 导出与页面用同一判据（owe ≤ 0 ⇒ 已结清），避免「页面说已结清、导出说未结清」
            const out = Array.from(r);
            out[5] = purchasePaymentStatus(out[5], out[4]);
            rows.push(out);
        }
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), '进货单');
        const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename="purchase-orders.xlsx"');
        return res.send(buf);
    }
    const id = Number(req.params.id);
    const o = (await safeExec("SELECT " + PO_COLS + " FROM purchase_orders WHERE id = ?", [id])).values?.[0];
    if (!o)
        return res.status(404).json({ error: '进货单不存在' });
    const items = ((await safeExec("SELECT * FROM purchase_order_items WHERE order_id = ?", [id])).values || []).map((i) => ({
        id: Number(i[0]), product_id: Number(i[2]), product_name: i[3], quantity: Number(i[4]), unit_price: Number(i[5]), amount: Number(i[6])
    }));
    /* 联查商品表补充规格/单位/条形码/编号（打印用）
     * ★ 性能（2026-10-04）：原实现对**每个明细各发一次** SELECT（N+1）
     *   ⇒ 一张 20 行的进货单 = 20 次往返 ≈ 1~1.6s，而打印页正好调这个接口。
     *   改为「先收集 product_id，再用一条 IN 查询取回」，往返 20 → 2。 */
    const pids = Array.from(new Set(items.map((it) => Number(it.product_id)).filter((n) => Number.isFinite(n) && n > 0)));
    const pMap = new Map();
    if (pids.length) {
        // 先经 Number() 白名单过滤再拼进 SQL —— 不存在注入面（非数字已被剔除）
        const pr = await safeExec("SELECT id, sku, spec, unit, batch_number FROM products WHERE id IN (" + pids.join(',') + ")");
        for (const p of pr.values || []) pMap.set(Number(p[0]), p);
    }
    const enriched = items.map((it) => {
        const p = pMap.get(Number(it.product_id));
        return { ...it, sku: p?.[1] || '', spec: p?.[2] || '', unit: p?.[3] || '', barcode: p?.[4] || '' };
    });
    res.json({ ...mapPurchaseOrder(o), items: enriched });
});
app.post('/api/store/purchase-orders', authMiddleware, hasPerm('purchase'), idem('purchase-orders'), async (req, res) => {
    await initDB();
    let { supplier_id, supplier_name, items, discount, final_amount, remark, bill_date, paid_amount } = req.body;
    // 采购单必须含有效明细（与服务端销售单同口径兜底）
    if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: '请至少添加一件商品后再建进货单' });
    }
    if (items.find((it) => !(Number(it.quantity ?? 0) > 0))) {
        return res.status(400).json({ error: '商品数量必须大于 0' });
    }
    // 兜底：未传 supplier_id 时按名称自动解析
    if (!supplier_id && supplier_name) {
        const sidRes = await safeExec("SELECT id FROM suppliers WHERE name = ? ORDER BY id LIMIT 1", [supplier_name]);
        if (sidRes.values?.[0]?.[0]) supplier_id = sidRes.values[0][0];
    }
    const orderNumber = await generateOrderNumber('JH');
    /* ★ 2026-10-09：整单金额改走**唯一解析入口**（与 PUT 共用 resolveOrderTotal）。
     *   原实现 `const totalAmount = final_amount || req.body.total_amount || 0;` 有两个洞：
     *   ① 没送任何金额时**静默存 0** —— 明细进了货、库存加了，单子却记 ¥0.00 应付，
     *      供应商欠款凭空少一笔（这类单只会在对账时以"金额对不上"的形式暴露）；
     *   ② `|| 0` 把非法值（如 'abc'）也变成 0，同上。
     *   现在：final > total > 商品总额−优惠 > 商品总额；非法值 400。
     *   开单页（PurchaseOrder.tsx）始终送 final_amount，行为不变（回归断言见 d55 T8.2）。 */
    const goodsTotal = Math.round((items || []).reduce((s, it) => s + (Number(it.quantity) || 0) * (Number(it.unit_price) || 0), 0) * 100) / 100;
    const tr = resolveOrderTotal(req.body, goodsTotal, 0);
    if (!tr.ok) return res.status(400).json({ error: tr.error });
    const totalAmount = tr.total;
    /* ---- 付款口径：与销售单对称 ----
     * paid_amount 显式传入则用传入值；否则 settled=true 视为全额付讫，否则 0（赊购）
     * owe_amount = 应付 - 已付 */
    if (paid_amount !== undefined && paid_amount !== null && paid_amount !== '' && !Number.isFinite(Number(paid_amount)))
        return res.status(400).json({ error: '已付金额不合法（必须是数字）' });
    const paidAmount = paid_amount !== undefined && paid_amount !== null && paid_amount !== ''
        ? (Number(paid_amount) || 0)
        : (req.body.settled ? Number(totalAmount) : 0);
    const oweAmount = Math.round((Number(totalAmount) - paidAmount) * 100) / 100;
    const paymentStatus = req.body.payment_status || (oweAmount > 0.005 ? '未结清' : '已结清');
    // status 显式写 'completed'：软删除判据是 status='cancelled'，若新单 status 为 NULL
    // 会被 `NOT IN` 判据静默排除（供应商对账里凭空少一张）⇒ 必须显式落值。
    // 见 runLastId 注释：INSERT 与取 id 必须同一条语句（连接池会话漂移会让明细挂到别的单上）
    const orderId = await runLastId("INSERT INTO purchase_orders (order_number, supplier_id, supplier_name, total_amount, operator_id, operator_name, payment_status, bill_date, paid_amount, owe_amount, remark, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed')", [orderNumber, supplier_id, supplier_name, totalAmount, req.user.id, req.user.real_name, paymentStatus, bill_date || todayCST(), paidAmount, oweAmount, remark || '']);
    if (items) {
        for (const item of items) {
            await run("INSERT INTO purchase_order_items (order_id, product_id, product_name, quantity, unit_price, amount) VALUES (?, ?, ?, ?, ?, ?)", [orderId, item.product_id, item.product_name, item.quantity, item.unit_price, item.quantity * item.unit_price]);
            // 增加库存
            if (item.product_id) {
                await run("UPDATE products SET stock_quantity = stock_quantity + ? WHERE id = ?", [item.quantity, item.product_id]);
            }
        }
    }
    saveDB();
    /* ★★ 2026-10-11 P5-4（P2-07）：补回新单 id，与销售单对称。
     *   【缺陷实证】修复前响应只有 { ok, order_number }，调用方拿不到 id
     *     ⇒ 实测连「立即软删刚建的这张单」都做不到（只能再贴一次按单号反查）。
     *   【行为保持】只增不改：原有 ok / order_number 逐字保留。 */
    res.json({ ok: true, id: orderId, order_number: orderNumber });
});
/* ==================== 进货单「修改 / 删除」（2026-10-09 补） ====================
 * 缺口（老板 2026-10-09 拍板第 2 项）：进货单此前只有 GET(列表/详情) + POST，
 *   **没有修改、没有删除**。录错一张（供应商选错 / 数量多打一个 0 / 重复录）
 *   只能干看着，而库存和应付已经跟着偏了。
 *
 * 与销售单的对称关系（不另立标准）：
 *   销售单：PUT 用 hasPerm('sales')；DELETE（作废）用 adminOnly。
 *   本处完全对齐：PUT 用 hasPerm('purchase')；DELETE 用 adminOnly。
 *
 * 铁律：
 *   ① **删除 = 软删除**（status='cancelled'，单据与明细全保留，可查可追溯）。
 *      删除后必须从所有采购口径里消失 —— 已同步改：进货单列表/合计、进货统计、
 *      付款抵扣候选单、单据导出、供应商对账、客户供应商总览（统一用 PO_ALIVE）。
 *   ② **删除必须回冲库存**：按明细逐条 `stock_quantity -= quantity`，
 *      与建单时的 `stock += quantity` 严格互为逆运算。
 *   ③ **删除必须回滚资金**：单号相同、类型为 expense 的「进货支出」流水（实测 109 张单有）
 *      逐条写负数冲销行 + 账户余额回滚 —— 与销售单作废同一范式（复用 writeReversal）。
 *      查不到流水但标记已付的情形**如实披露**，不假装回滚成功。
 *   ④ **修改按明细差量调库存**：以 product_id 聚合 old/new 数量，逐商品 `stock += (new - old)`。
 *      （★ 2026-10-11 P5-4 / P2-08：原注释写成 `(old - new)`，与实际实现「新 − 旧」**方向相反**；
 *       本轮已因该注释产生一次误判 ⇒ 必须改正，否则持续误导维护者。
 *       → 实测行为**本就正确**（20 件改 5 件 ⇒ 库存 −15），故本处**只改注释、不动实现**。）
 *      不做「先整体回冲再整体重建」——中途失败会留下半张单的库存差。
 *   ⑤ **修改不允许把单改成倒欠**：newTotal < paid_amount ⇒ 409 指路，且**在任何写操作之前**校验。
 *   ⑥ 已删除的单、被采购退货单引用的单：一律 409，不做"题不对意"的事。
 */
/* ★ 2026-10-09 新增：整单应付金额的**唯一解析入口**（POST 与 PUT 共用）。
 *   为什么必须抽成一个函数：本轮就是因为 POST 与 PUT 各写了一遍、优先级还不一样
 *   （POST final 优先 / PUT total 优先），导致「优惠」在改单时被静默吞掉 —— 两条路由
 *   只要各写一份，早晚会再分叉。抽成一份，从结构上杜绝。
 *
 *   优先级：final_amount（折后应付）> total_amount（商品总额）> 商品总额 − discount > 商品总额
 *   非法值：任何显式传入但非有限数的金额 ⇒ ok:false，调用方回 400。
 *     **绝不 `Number(v) || 0`** —— `Number('abc')` = NaN，NaN 是 falsy，`|| 0` 把乱码
 *     变成一个看起来完全正常的 ¥0.00，然后一路写进库（只在"该单有已付"时才被 409 偶然拦住）。
 *   兜底：无明细时（改单只改单头）用调用方给的 fallback（= 原单金额）。
 */
function resolveOrderTotal(body, goodsTotal, fallback) {
    const pick = (v) => {
        if (v === undefined || v === null || v === '') return { has: false };
        const n = Number(v);
        return Number.isFinite(n) ? { has: true, n } : { has: false, bad: true };
    };
    const f = pick(body.final_amount), t = pick(body.total_amount), d = pick(body.discount);
    if (f.bad || t.bad || d.bad) return { ok: false, error: '金额不合法（必须是数字）' };
    const r2 = (n) => Math.round(n * 100) / 100;
    if (f.has) return { ok: true, total: r2(f.n) };
    if (t.has) return { ok: true, total: r2(t.n) };
    if (goodsTotal == null) return { ok: true, total: r2(Number(fallback) || 0) };
    if (d.has) return { ok: true, total: r2(goodsTotal - d.n) };
    return { ok: true, total: r2(goodsTotal) };
}

function mapPOForWrite(o) {
    return {
        id: Number(o[0]), order_number: o[1],
        supplier_id: o[2] == null ? null : Number(o[2]), supplier_name: o[3],
        total_amount: Number(o[4] || 0), status: o[5] || 'completed',
        operator_id: o[6], operator_name: o[7], created_at: o[8], payment_status: o[9],
        bill_date: o[10] || null, paid_amount: Number(o[11] || 0), owe_amount: Number(o[12] || 0),
        remark: o[13] || '', maker_name: o[14] || null,
    };
}
async function loadPOForWrite(id) {
    const o = (await safeExec("SELECT " + PO_COLS + " FROM purchase_orders WHERE id = ?", [id])).values?.[0];
    return o ? mapPOForWrite(o) : null;
}
/** 进货单写操作的前置校验（每条拒绝理由都唯一指认原因） */
async function poWriteGuard(po) {
    if (po.status === 'cancelled' || po.status === 'void')
        return { ok: false, code: 409, reason: '该进货单已删除（status=cancelled），不能再修改或重复删除。' };
    const ret = (await safeExec("SELECT id, return_number FROM purchase_returns WHERE purchase_order_id = ? LIMIT 1", [po.id])).values?.[0];
    if (ret) return { ok: false, code: 409, reason: `该进货单已被退货单 ${ret[1] || '#' + ret[0]} 引用，原单不能消失 ⇒ 请先处理退货单。` };
    return { ok: true };
}
app.delete('/api/store/purchase-orders/:id', authMiddleware, adminOnly, async (req, res) => {
    await initDB();
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '进货单 id 不合法' });
    const po = await loadPOForWrite(id);
    if (!po) return res.status(404).json({ error: '进货单不存在' });
    const g = await poWriteGuard(po);
    if (!g.ok) return res.status(g.code).json({ error: g.reason, rejected: true });

    // ① 库存回冲（逐条，与建单时的 stock += qty 互为逆运算；负数明细会被加回，口径一致）
    const items = (await safeExec("SELECT product_id, quantity FROM purchase_order_items WHERE order_id = ?", [id])).values || [];
    const stockRestored = [];
    for (const it of items) {
        const pid = it[0] == null ? null : Number(it[0]);
        const qty = Number(it[1]) || 0;
        if (pid) {
            await run("UPDATE products SET stock_quantity = stock_quantity - ? WHERE id = ?", [qty, pid]);
            stockRestored.push({ product_id: pid, quantity: qty });
        }
    }

    // ② 资金回滚：同单号的流水逐条冲销（负数留痕 + 余额回滚）
    let rolledBack = 0;
    const reversals = [];
    const skipped = [];
    if (po.order_number) {
        const rows = (await safeExec("SELECT " + TX_AUDIT_COLS + " FROM transactions WHERE order_number = ? ORDER BY id", [po.order_number])).values || [];
        for (const raw of rows) {
            const t = row2tx(raw);
            if (!(t.type in TX_NET_SIGN)) { skipped.push({ id: t.id, why: '未知流水类型 ' + t.type }); continue; }
            if (!t.account_id) { skipped.push({ id: t.id, why: '流水无账户指向' }); continue; }
            if (t.reverse_of) { skipped.push({ id: t.id, why: '本身是冲销行' }); continue; }
            const already = (await safeExec("SELECT id FROM transactions WHERE reverse_of = ? LIMIT 1", [t.id])).values?.[0]?.[0];
            if (already) { skipped.push({ id: t.id, why: '已被流水 #' + already + ' 冲销过' }); continue; }
            try {
                const r = await writeReversal(t, req.user, '(进货单删除)');
                rolledBack = Math.round((rolledBack + Math.abs(t.amount)) * 100) / 100;
                reversals.push({ of: t.id, reversal_id: r.reversalId, account_id: Number(t.account_id), amount: -t.amount, balance_delta: r.delta });
            } catch (e) {
                skipped.push({ id: t.id, why: '冲销写入失败：' + e.message });
            }
        }
    }

    await run("UPDATE purchase_orders SET status = 'cancelled' WHERE id = ?", [id]);
    saveDB();
    /* 如实披露（**不许说"从未落账"**）：
     *   本仓的进货付款有**两代**记录方式，单号规则不同 ——
     *   ① 老导入（智慧记，实测 109 张单）：付款流水 `order_number` = 进货单号（如 JH…/原单号），
     *      本次删除能按单号找到并逐条冲销 ⇒ 已走 ② 之前的 reversals 分支。
     *   ② 现行流程：只有 `POST /finance/transactions/expense`（分类「付款/付欠款」），
     *      它自己用 `generateOrderNumber('expense')` 生成 **FKD…** 单号，
     *      **不会**把进货单号写进 transactions ⇒ 按单号根本找不到。
     *   ⇒ 情形 ② 下**本就不该回滚**：钱确实付出去了，删掉单据不等于供应商退钱给你；
     *     供应商欠款会由其余未删单据重新合计（PO_ALIVE 已把它从对账口径剔除）。
     *   所以这里只说「查不到、未回滚」，并指路人工核对，不编造"从未落账"这种可能导致
     *   老板以为钱还在账上的结论。 */
    res.json({
        ok: true, cancelled: id, order_number: po.order_number,
        stock_restored: stockRestored, reversals, rolled_back: rolledBack, skipped,
        note: (po.paid_amount > 0.005 && reversals.length === 0)
            ? `该单登记已付 ¥${po.paid_amount.toFixed(2)}，但**没有**以本单号记账的资金流水，故本次未做资金回滚。`
                + `（现行「付款/付欠款」登记的流水单号是 FKD… 形式、与本单号无关，系统无法据单号认定它属于本单；`
                + `钱已实际付出，删除单据不等同于退款 ⇒ 需人工核对供应商欠款是否要另行调整。）`
            : undefined,
    });
});
app.put('/api/store/purchase-orders/:id', authMiddleware, hasPerm('purchase'), async (req, res) => {
    await initDB();
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '进货单 id 不合法' });
    const po = await loadPOForWrite(id);
    if (!po) return res.status(404).json({ error: '进货单不存在' });
    const g = await poWriteGuard(po);
    if (!g.ok) return res.status(g.code).json({ error: g.reason, rejected: true });

    const body = req.body || {};
    let supplierId = body.supplier_id != null && body.supplier_id !== '' ? Number(body.supplier_id) : po.supplier_id;
    const supplierName = body.supplier_name != null ? String(body.supplier_name) : po.supplier_name;
    if (!supplierId && supplierName) {
        const r = await safeExec("SELECT id FROM suppliers WHERE name = ? ORDER BY id LIMIT 1", [supplierName]);
        if (r.values?.[0]?.[0]) supplierId = Number(r.values[0][0]);
    }
    const billDate = body.bill_date != null && body.bill_date !== '' ? String(body.bill_date) : (po.bill_date || todayCST());
    const remark = body.remark != null ? String(body.remark) : po.remark;

    /* ---------- 第一阶段：全部校验，一个字节都不写 ---------- */
    let next = null;
    let newTotal = po.total_amount;
    if (body.items !== undefined) {
        if (!Array.isArray(body.items) || body.items.length === 0)
            return res.status(400).json({ error: '请至少保留一件商品（要清空整单请直接删除该进货单）' });
        if (body.items.find((it) => !(Number(it.quantity ?? 0) > 0)))
            return res.status(400).json({ error: '商品数量必须大于 0（与新建进货单同口径）' });
        /* ★ 单价也要校验，不能 `Number(x) || 0`：`'abc'` 会被静默当成 ¥0.00
         *   ⇒ 明细金额变 0、整单应付变 0，而请求"成功"了。这是最坏的一类错（静默改数）。 */
        if (body.items.find((it) => it.unit_price !== undefined && it.unit_price !== null && it.unit_price !== '' && !Number.isFinite(Number(it.unit_price))))
            return res.status(400).json({ error: '商品单价不合法（必须是数字）' });
        next = body.items.map((it) => ({
            product_id: it.product_id == null || it.product_id === '' ? null : Number(it.product_id),
            product_name: it.product_name || '',
            quantity: Number(it.quantity) || 0,
            unit_price: Number(it.unit_price) || 0,
        }));
        newTotal = Math.round(next.reduce((s, x) => s + x.quantity * x.unit_price, 0) * 100) / 100;
    }
    /* 整单金额解析（**与 POST 同一段逻辑、同一优先级**，见 resolveOrderTotal）。
     *   ★ 2026-10-09 修正一（优先级）：原本写成 `total_amount` 优先。而 POST 是 final 优先，
     *     开单页又**同时**送 total_amount（商品总额）与 final_amount（折后应付）⇒
     *     若 PUT 取 total_amount，「优惠金额」会在改单时被静默吞掉：页面显示应付 ¥900
     *     （1000 − 优惠 100），保存后库里悄悄变回 ¥1000，页面还会用回执把这个错数回显出来。
     *   ★ 2026-10-09 修正二（非法值）：原本是 `Number(v) || 0`。`Number('abc')` = NaN，
     *     `NaN || 0` = 0 ⇒ 传个乱码金额就把整单应付**静默改成 ¥0.00**；
     *     只在"该单有已付"时才会被后面的 409 偶然拦住，无已付的单则一路写下去。
     *     ⇒ 改为「非数字即 400」，把静默改数变成明确拒绝。 */
    const totalRes = resolveOrderTotal(body, next ? next.reduce((s, x) => s + x.quantity * x.unit_price, 0) : null, newTotal);
    if (!totalRes.ok) return res.status(400).json({ error: totalRes.error });
    newTotal = totalRes.total;
    if (newTotal < po.paid_amount - 0.005)
        return res.status(409).json({
            error: `改后金额 ¥${newTotal.toFixed(2)} 小于该单已付 ¥${po.paid_amount.toFixed(2)}，会让这张单变成倒欠 ⇒ 请先到「付款记录」冲销那笔付款，或把金额改回 ≥ 已付。`,
            rejected: true,
        });

    /* ---------- 第二阶段：落库 ---------- */
    const stockAdjust = [];
    if (next) {
        const oldRows = (await safeExec("SELECT product_id, quantity FROM purchase_order_items WHERE order_id = ?", [id])).values || [];
        const agg = (rows) => {
            const m = new Map();
            for (const r of rows) {
                const p = r[0] == null ? null : Number(r[0]);
                if (!p) continue;
                m.set(p, (m.get(p) || 0) + (Number(r[1]) || 0));
            }
            return m;
        };
        const oldM = agg(oldRows);
        const newM = agg(next.map((x) => [x.product_id, x.quantity]));
        /* ★★ 2026-10-09 修正（装置 d55 抓到的真缺陷）：差量方向必须取 **新 − 旧**。
         *   建单时库存是 `stock += quantity`（一张单给库存 +N）。
         *   改单要把这张单的贡献从「旧数量」换成「新数量」⇒ 库存增量 = (+新) − (+旧) = 新 − 旧。
         *   原实现在这里算的是 `旧 − 新`，方向正好相反 —— **改少反而加库存、改多反而减库存**，
         *   且不改零头、不报错、看不出异常，还会随每次改单持续累积。
         *   实证（d55 T9）：把一行从 3 件改成 1 件，商品#2 库存 14 → 16（应为 → 12），
         *   总库存 +2（应为 −2），而回执里还写着 `stock_delta: 2` 自我印证 —— 错得非常"自洽"。
         *   注意：删除路径用的是 `stock -= quantity`（按当前明细回冲），方向本来就对，不动。 */
        for (const pid of new Set([...oldM.keys(), ...newM.keys()])) {
            const delta = (newM.get(pid) || 0) - (oldM.get(pid) || 0);
            if (Math.abs(delta) < 1e-9) continue;
            await run("UPDATE products SET stock_quantity = stock_quantity + ? WHERE id = ?", [delta, pid]);
            stockAdjust.push({ product_id: pid, old_qty: oldM.get(pid) || 0, new_qty: newM.get(pid) || 0, stock_delta: delta });
        }
        await run("DELETE FROM purchase_order_items WHERE order_id = ?", [id]);
        for (const x of next) {
            await run("INSERT INTO purchase_order_items (order_id, product_id, product_name, quantity, unit_price, amount) VALUES (?, ?, ?, ?, ?, ?)",
                [id, x.product_id, x.product_name, x.quantity, x.unit_price, Math.round(x.quantity * x.unit_price * 100) / 100]);
        }
    }
    const owe = Math.round((newTotal - po.paid_amount) * 100) / 100;
    const payStatus = owe > 0.005 ? '未结清' : '已结清';
    await run("UPDATE purchase_orders SET supplier_id = ?, supplier_name = ?, total_amount = ?, owe_amount = ?, payment_status = ?, bill_date = ?, remark = ? WHERE id = ?",
        [supplierId, supplierName, newTotal, owe, payStatus, billDate, remark, id]);
    saveDB();
    res.json({
        ok: true, revised: id, order_number: po.order_number,
        items_replaced: !!next, stock_adjust: stockAdjust,
        before: { supplier_name: po.supplier_name, total_amount: po.total_amount, owe_amount: po.owe_amount, bill_date: po.bill_date, remark: po.remark },
        after: { supplier_name: supplierName, total_amount: newTotal, owe_amount: owe, payment_status: payStatus, bill_date: billDate, remark },
    });
});
// 开单可选业务员：返回在职业务员 + 管理员（管理员开单选业务员，子账户开单选自己或管理员）
app.get('/api/store/sales-staff', authMiddleware, hasPerm('sales'), async (_req, res) => {
    await initDB();
    const result = await safeExec("SELECT id, real_name, role FROM users WHERE status = 1 AND role IN ('employee','admin') ORDER BY role, id");
    res.json((result.values || []).map((u) => ({ id: u[0], real_name: u[1], role: u[2] })));
});
// 销售单列清单（含财务口径字段），统一在此维护，避免各处 SELECT 漏字段
const SO_COLS = "id, order_number, customer_id, customer_name, total_amount, discount, final_amount, payment_method, operator_id, operator_name, created_at, payment_status, commission_amount, bill_date, receivable_amount, received_amount, owe_amount, small_change_amount, express_amount, tax_amount, remark, biz_type, maker_name";
function mapSalesOrder(o) {
    return {
        id: o[0], order_number: o[1], customer_id: Number(o[2]) || null, customer_name: o[3],
        total_amount: Number(o[4]), discount: Number(o[5]), final_amount: Number(o[6]),
        payment_method: o[7], operator_id: o[8], operator_name: o[9], created_at: o[10],
        payment_status: o[11], commission_amount: Number(o[12] || 0),
        bill_date: o[13] || (o[10] ? String(o[10]).slice(0, 10) : null),
        receivable_amount: Number(o[14] || 0), received_amount: Number(o[15] || 0), owe_amount: Number(o[16] || 0),
        small_change_amount: Number(o[17] || 0), express_amount: Number(o[18] || 0), tax_amount: Number(o[19] || 0),
        remark: o[20] || '', biz_type: o[21] || 'sale', maker_name: o[22] || null
    };
}
app.get('/api/store/sales-orders', authMiddleware, hasPerm('sales'), async (req, res) => {
    await initDB();
    const { pageSize = 200, page = 1, keyword, startDate, endDate, status, bizType, withTotal } = req.query;
    // 数据权限：所有账号均可见全部销售单（对齐智慧记云端默认，管理员开单成员也可查看）
    let where = " WHERE 1=1";
    if (keyword) {
        const kw = String(keyword).replace(/'/g, "''");
        where += " AND (order_number LIKE '%" + kw + "%' OR customer_name LIKE '%" + kw + "%' OR operator_name LIKE '%" + kw + "%')";
    }
    if (startDate) where += " AND COALESCE(bill_date, substr(created_at,1,10)) >= '" + String(startDate).replace(/'/g, "''") + "'";
    if (endDate) where += " AND COALESCE(bill_date, substr(created_at,1,10)) <= '" + String(endDate).replace(/'/g, "''") + "'";
    if (status === 'unpaid') where += " AND COALESCE(owe_amount,0) > 0.005";
    if (status === 'paid') where += " AND COALESCE(owe_amount,0) <= 0.005 AND COALESCE(payment_status,'') <> '作废'";
    if (status === 'void') where += " AND payment_status = '作废'";
    if (bizType && bizType !== 'all') where += " AND COALESCE(biz_type,'sale') = '" + String(bizType).replace(/'/g, "''") + "'";
    else if (!bizType) where += " AND COALESCE(biz_type,'sale') <> 'sale_return'"; // 默认列表不混入退货单
    const pg = Math.max(1, Number(page) || 1);
    const ps = Math.min(5000, Math.max(1, Number(pageSize) || 200));
    const result = await safeExec("SELECT " + SO_COLS + " FROM sales_orders" + where +
        " ORDER BY COALESCE(bill_date, substr(created_at,1,10)) DESC, id DESC LIMIT ? OFFSET ?", [ps, (pg - 1) * ps]);
    const orders = (result.values || []).map(mapSalesOrder);
    if (withTotal) {
        // ★ 性能（2026-10-04）：COUNT 与三路 SUM 合并为 1 次往返（原 2 次）
        const A = await scalars([
            { key: 'total', sql: "SELECT COUNT(*) FROM sales_orders" + where },
            { key: 'sum_final', sql: "SELECT COALESCE(SUM(final_amount),0) FROM sales_orders" + where },
            { key: 'sum_owe', sql: "SELECT COALESCE(SUM(owe_amount),0) FROM sales_orders" + where },
            { key: 'sum_received', sql: "SELECT COALESCE(SUM(received_amount),0) FROM sales_orders" + where },
        ]);
        /* ★★ 金额门（2026-10-13，老板真机反馈实拍）：这三个是**全店全量汇总**
         *   （合计销售额 / 未结清欠款 / 已收合计），原先**无任何权限门** ⇒
         *   子账号在订单管理页直接看到「共 4590 单　合计 ¥6,534,099.60 /
         *   未结清欠款 ¥2,051,050.59 / 已收合计 ¥4,483,049.01」—— 属全店经营数据。
         *
         *   ★ 与「列表每行的金额」严格区分：每行金额是子账号**干活必需**的
         *     （要知道这单收多少钱），**必须保留**；这里汇总的三项才是要挡的。
         *   ★ `total`（单数）不属敏感信息（数量维度）⇒ 照常返回。
         *   ★ 为什么在接口内做而不是交给全局脱敏器：AMOUNT_SCOPE 刻意**不含业务接口**
         *     （否则开单/收款会看不到金额），所以这三个汇总只能在接口内定点处理。
         *   前端同源判据：src/utils/perms.ts 的 canSeeAmount()。 */
        const canAmount = isAdminUser(req.user.role);
        return res.json({
            rows: orders, total: Number(A.total || 0), page: pg, pageSize: ps,
            ...(canAmount ? {
                sum_final: Number(A.sum_final || 0), sum_owe: Number(A.sum_owe || 0), sum_received: Number(A.sum_received || 0),
            } : {}),
        });
    }
    res.json(orders);
});
// 销售单详情（含商品明细，用于小票/PDF 打印）
app.get('/api/store/sales-orders/:id', authMiddleware, hasPerm('sales'), async (req, res) => {
    await initDB();
    if (req.params.id === 'export') {
        // 导出销售单（避免与 :id 冲突）
        const { startDate = '2020-01-01', endDate = '2030-12-31' } = req.query;
        const BD = "COALESCE(bill_date, substr(created_at,1,10))";
        const result = await safeExec(`SELECT order_number, customer_name, receivable_amount, discount, final_amount, received_amount, owe_amount, payment_method, payment_status, operator_name, ${BD} FROM sales_orders WHERE ${BD} >= ? AND ${BD} <= ? AND COALESCE(biz_type,'sale') <> 'sale_return' ORDER BY ${BD}, id`, [String(startDate), String(endDate)]);
        const rows = [['单据编号', '客户名称', '应收金额', '优惠', '单据金额', '已收金额', '欠款', '收款方式', '收款状态', '操作员', '业务日期']];
        for (const r of result.values || []) rows.push(r);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), '销售单');
        const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename="sales-orders.xlsx"');
        return res.send(buf);
    }
    const id = Number(req.params.id);
    const o = (await safeExec("SELECT " + SO_COLS + " FROM sales_orders WHERE id = ?", [id])).values?.[0];
    if (!o)
        return res.status(404).json({ error: '订单不存在' });
    const items = ((await safeExec("SELECT * FROM sales_order_items WHERE order_id = ?", [id])).values || []).map((i) => ({
        id: Number(i[0]), product_id: Number(i[2]), product_name: i[3], sku: i[4], quantity: Number(i[5]), unit_price: Number(i[6]), amount: Number(i[7])
    }));
    /* 联查商品表补充规格/单位/条形码（打印用）
     * ★ 性能（2026-10-04）：同上，N+1 → 1 条 IN 查询（往返 N → 2） */
    const pids = Array.from(new Set(items.map((it) => Number(it.product_id)).filter((n) => Number.isFinite(n) && n > 0)));
    const pMap = new Map();
    if (pids.length) {
        const pr = await safeExec("SELECT id, spec, unit, batch_number FROM products WHERE id IN (" + pids.join(',') + ")");
        for (const p of pr.values || []) pMap.set(Number(p[0]), p);
    }
    const enriched = items.map((it) => {
        const p = pMap.get(Number(it.product_id));
        return { ...it, spec: p?.[1] || '', unit: p?.[2] || '', barcode: p?.[3] || '' };
    });
    res.json({ ...mapSalesOrder(o), items: enriched });
});
app.post('/api/store/sales-orders', authMiddleware, hasPerm('sales'), idem('sales-orders'), async (req, res) => {
    await initDB();
    let { order_number: customOrderNumber, customer_id, customer_name, items, payment_method, discount,
        payment_status, operator_id: targetOperatorId,
        received_amount, small_change_amount, express_amount, tax_amount, remark, bill_date } = req.body;
    /* 开单必须含有效明细：空单/零数量单无业务意义，且会污染欠款统计与利润报表
     * （实测：不校验时可建出 final_amount=0 的空单）。前端已有 cart.length 守卫，此处为服务端兜底。 */
    if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: '请至少添加一件商品后再开单' });
    }
    const badItem = items.find((it) => !(Number(it.quantity ?? 0) > 0));
    if (badItem) {
        return res.status(400).json({ error: '商品数量必须大于 0（' + (badItem.product_name || '未命名商品') + '）' });
    }
    // 兜底：未传 customer_id 时按名称自动解析
    if (!customer_id && customer_name) {
        const cidRes = await safeExec("SELECT id FROM customers WHERE name = ? ORDER BY id LIMIT 1", [customer_name]);
        if (cidRes.values?.[0]?.[0]) customer_id = cidRes.values[0][0];
    }
    // 业务员归属：所有开单人均可指定任意在职员工（业绩记所选业务员）；未指定则记自己
    let operatorId = req.user.id;
    let operatorName = req.user.real_name;
    if (targetOperatorId && Number(targetOperatorId) > 0) {
        const tid = Number(targetOperatorId);
        const emp = (await safeExec("SELECT real_name, COALESCE(commission_rate,0) FROM users WHERE id = ? AND status = 1", [tid])).values?.[0];
        if (emp) {
            operatorId = tid;
            operatorName = emp[0] || req.user.real_name;
        }
    }
    /* ★★ 2026-10-11 P5-4（P2-06）：自定义单号冲突必须**显式拒绝**，不能静默换号。
     *   【缺陷实证】修复前一律直接用传入单号去 INSERT：唯一索引报错 ⇒ run() 吞掉
     *     ⇒ 随后 `SELECT MAX(id) ... WHERE order_number = ?` 反查到**已存在那张单**，于是：
     *       ① 实测 HTTP 500（写失败守卫拦截）
     *       ② 实测**已存在那单的明细被挂上去**（1→2）
     *       ③ 实测**库存多扣 3**（100→92，应 95）——货扣了、单没建。
     *   【修法】在**任何写操作之前**先查单号是否已存在 ⇒ 409 + conflict_order_number。
     *   【行为变更】由「静默/半截」变「显式失败」；仅当传入自定义单号时生效，自动单号路径不受影响。 */
    if (customOrderNumber != null && String(customOrderNumber).trim() !== '') {
        const no = String(customOrderNumber).trim();
        const hit = (await safeExec("SELECT id FROM sales_orders WHERE order_number = ? LIMIT 1", [no])).values?.[0]?.[0];
        if (hit) return res.status(409).json({ ok: false, code: 'ORDER_NUMBER_CONFLICT', conflict_order_number: no, existing_id: Number(hit), error: `单号 ${no} 已存在（销售单 #${hit}）⇒ 请换一个单号，本次开单未生效。` });
    }
    const orderNumber = customOrderNumber || await generateOrderNumber('XS');
    const extra = (Number(express_amount) || 0) + (Number(tax_amount) || 0) - (Number(small_change_amount) || 0);
    let totalAmount = 0;
    if (items) {
        for (const item of items) {
            // 兼容 unit_price / price 两种字段名（前端传 unit_price）
            totalAmount += (item.quantity || 0) * (item.price ?? item.unit_price ?? 0);
        }
    }
    // final_amount = 明细合计 - 折扣 + 运费 + 税额 - 抹零（与智慧记 bill_amt 口径一致）
    const finalAmount = Math.round((totalAmount - (discount || 0) + extra) * 100) / 100;
    // 业绩提成：按业务员（业绩归属人）commission_rate% 计算
    let commissionAmount = 0;
    try {
        const cr = (await safeExec("SELECT COALESCE(commission_rate,0) FROM users WHERE id = ?", [operatorId])).values?.[0]?.[0];
        commissionAmount = Math.round((Number(cr) || 0) * finalAmount) / 100;
    } catch (e) { commissionAmount = 0; }
    /* ---- 收款口径（★ 2026-10-03：改调唯一真源 salesOrderMoney()，与本文件另两条开单路径共用）----
     * received_amount 显式传入则用传入值；否则：有支付方式视为全额收讫，无支付方式（赊账）视为 0
     * owe_amount = 应收 - 已收（赊账单的核心字段，供欠款对账） */
    const _money = salesOrderMoney(finalAmount, received_amount, payment_method, bill_date);
    const receivedAmount = _money.received_amount;
    const oweAmount = _money.owe_amount;
    const paymentStatus = _money.payment_status;
    const billDate = _money.bill_date;
    /* ★ 2026-10-11 P5-4：主单 INSERT 与「取 id」合并为**同一条语句**（INSERT ... RETURNING id）。
     *   原写法靠「再去 SELECT MAX(id) WHERE order_number=?」反查，
     *   它在单号冲突时会**反查到另一张已存在的单**（P2-06 的伤害放大器）。
     *   改为同语句取 id 后，不再依赖二次读，即使将来再出现重号也不会把明细挂错单。
     *   （与 runLastId 定义处的纪律一致：插入与取 id 必须同一条语句、同一个连接。） */
    const orderId = Number(await runLastId("INSERT INTO sales_orders (order_number, customer_id, customer_name, total_amount, discount, final_amount, payment_method, operator_id, operator_name, commission_amount, payment_status, bill_date, receivable_amount, received_amount, owe_amount, small_change_amount, express_amount, tax_amount, remark, biz_type, maker_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [
        orderNumber, customer_id || null, customer_name || null, totalAmount, discount || 0, finalAmount,
        payment_method || null, operatorId, operatorName, commissionAmount, paymentStatus,
        billDate, _money.receivable_amount, receivedAmount, oweAmount,
        Number(small_change_amount) || 0, Number(express_amount) || 0, Number(tax_amount) || 0,
        remark || '', 'sale', req.user.real_name || null
    ]) || 0);
    saveDB();
    if (items && orderId > 0) {
        for (const item of items) {
            await run("INSERT INTO sales_order_items (order_id, product_id, product_name, sku, quantity, unit_price, amount) VALUES (?, ?, ?, ?, ?, ?, ?)", [orderId, item.product_id, item.product_name, item.sku || '', item.quantity, item.price ?? item.unit_price ?? 0, item.amount ?? item.quantity * (item.price ?? item.unit_price ?? 0)]);
            // Deduct stock
            if (item.product_id) {
                await run("UPDATE products SET stock_quantity = stock_quantity - ? WHERE id = ?", [item.quantity, item.product_id]);
            }
        }
    }
    /* ---- 收款落账（★★ 2026-10-09 真机实测修复：两处缺陷，一处错账一处漏记）----
     * 缺陷实证（真机 APK 操作 + 直连生产库回读，非推断）：
     *   在「销售开单」页选 **微信** 账户、本次实收 ¥100 开单 ⇒
     *     · 后台：**支付宝**账户 +100.00，微信账户 +0.00（钱进了另一个账户）
     *     · 单据 payment_method 存成 'bank'（丢失了用户实际选的是哪个账户）
     *     · transactions 里**查不到这笔收款**（资金流水页永远看不到它）
     *
     * 根因①（错账）：用 `SELECT id FROM accounts WHERE type = ? LIMIT 1` 找落账账户。
     *   · 本库三个账户的 type 实际**全是 'bank'**（见 accounts 表；「现金」也是 bank）
     *     ⇒ LIMIT 1 命中「id 最小的 bank 账户」，与用户所选毫无关系；
     *   · 而前端早已把「所选的账户 id」放在 `account_id` 里传上来了，这里**却没用它**。
     *   · 同一个文件里 `POST /:id/receive`（收款登记）用的是 account_id —— 同一系统
     *     的两条收款路径口径相反，本身就是这个 bug 长期没被发现的土壤。
     * 根因②（漏记）：只加余额、不写流水。而开单页文案明写
     *   「收款开单＝写收款流水 ＋ 加账户余额 ＋ 标记结清（动账、不可随手点）」
     *   ⇒ 实现与对用户的承诺不符，对账时这笔钱**在流水里不存在**。
     *
     * 修法：① 以 `account_id` 为准（"用户选的那个账户"只能由它唯一指认）；
     *       旧版前端没传时才退回按 type 匹配；两者都拿不到就**不落账并留日志**，
     *       绝不静默地把钱塞进"第一个账户"。
     *       ② 补写资金流水（category=销售收款，description 统一为「销售单 <单号> 收款」，
     *       与 /:id/receive 同格式，便于日后按单号精确回溯/冲销）。
     *       写流水失败不阻断开单（钱已落账，流水可补），但必须留下服务端日志。 */
    if (receivedAmount > 0) {
        let accId = Number(req.body.account_id) || null;
        if (!accId && payment_method) {
            accId = (await safeExec("SELECT id FROM accounts WHERE type = ? ORDER BY id LIMIT 1", [payment_method])).values?.[0]?.[0] || null;
        }
        if (accId) {
            await run("UPDATE accounts SET balance = balance + ? WHERE id = ?", [receivedAmount, accId]);
            try {
                const incomeNo = await generateOrderNumber('income');
                await run("INSERT INTO transactions (type, account_id, amount, category, description, operator_id, operator_name, party_type, party_id, party_name, order_number) VALUES ('income', ?, ?, '销售收款', ?, ?, ?, 'customer', ?, ?, ?)",
                    [accId, receivedAmount, '销售单 ' + orderNumber + ' 收款', req.user.id, req.user.real_name, customer_id || null, customer_name || '', incomeNo]);
            } catch (e) {
                console.error('[sales-orders] 收款流水写入失败（不阻断开单，钱已落账）:', e.message);
            }
        } else {
            console.error('[sales-orders] 收款 ¥%s 未能落账：account_id=%s payment_method=%s 都匹配不到账户',
                receivedAmount, req.body.account_id, payment_method);
        }
    }
    saveDB();
    res.json({ ok: true, order_number: orderNumber, id: orderId, final_amount: finalAmount, received_amount: receivedAmount, owe_amount: oweAmount, payment_status: paymentStatus });
});
// 销售单收款登记（收欠款 / 收尾款）：累加已收、重算欠款与结算状态，并记一笔资金流水
/* ★ 2026-10-08 新增：修改销售单（PUT /api/store/sales-orders/:id）
 *   对齐智慧记手机端「单据详情 → 修改销售单」（老板要求「依次进行」的 P0 项之一）。
 *
 *   为什么这样设计（安全边界，必须先说清）：
 *   ① 已作废单不可改；
 *   ② **已有收款的单不在这里改** —— 收款会牵动 accounts.balance 与 transactions 流水，
 *      原地改金额会让「资金流水 ↔ 单据」对不上（涉资金回滚，须谨慎设计；这条是既定红线）。
 *      这类单返回 409 + 明确指引：先冲销收款，或作废后用「复制为销售单」重开。
 *   ③ 明细替换 = 先按旧明细回滚库存、再按新明细扣减库存，保证库存守恒。
 *   ④ 本接口**不产生任何资金动作**：收款仍只能走 /:id/receive；这里只重算应收/欠款。
 */
app.put('/api/store/sales-orders/:id', authMiddleware, hasPerm('sales'), async (req, res) => {
    await initDB();
    const id = Number(req.params.id);
    const row = (await safeExec("SELECT " + SO_COLS + " FROM sales_orders WHERE id = ?", [id])).values?.[0];
    if (!row) return res.status(404).json({ error: '订单不存在' });
    const old = mapSalesOrder(row);
    if (old.payment_status === '作废') return res.status(400).json({ error: '该单已作废，不能修改' });

    const received = Number(old.received_amount) || 0;
    if (received > 0.005) {
        return res.status(409).json({
            code: 'HAS_PAYMENT',
            error: '该单已有收款 ¥' + received.toFixed(2) + '，不能原地修改（会让资金流水与单据对不上）。请先冲销该笔收款，或作废本单后用「复制为销售单」按新内容重开。'
        });
    }

    const { items, customer_id, customer_name, discount, express_amount, tax_amount,
        small_change_amount, remark, bill_date, operator_id: targetOperatorId } = req.body;
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: '请至少添加一件商品后再保存' });
    const badItem = items.find((it) => !(Number(it.quantity ?? 0) > 0));
    if (badItem) return res.status(400).json({ error: '商品数量必须大于 0（' + (badItem.product_name || '未命名商品') + '）' });

    // ① 回滚旧明细占用的库存，并清空旧明细
    const oldItems = (await safeExec("SELECT product_id, quantity FROM sales_order_items WHERE order_id = ?", [id])).values || [];
    for (const it of oldItems) {
        if (it[0]) await run("UPDATE products SET stock_quantity = stock_quantity + ? WHERE id = ?", [Number(it[1]) || 0, it[0]]);
    }
    await run("DELETE FROM sales_order_items WHERE order_id = ?", [id]);

    // ② 重算金额（口径与 POST 完全一致：final = 明细 − 折扣 + 运费 + 税额 − 抹零）
    let totalAmount = 0;
    for (const item of items) totalAmount += (Number(item.quantity) || 0) * Number(item.price ?? item.unit_price ?? 0);
    const extra = (Number(express_amount) || 0) + (Number(tax_amount) || 0) - (Number(small_change_amount) || 0);
    const finalAmount = Math.round((totalAmount - (Number(discount) || 0) + extra) * 100) / 100;

    // ③ 写新明细 + 扣新库存
    for (const item of items) {
        const qty = Number(item.quantity) || 0;
        const up = Number(item.price ?? item.unit_price ?? 0);
        await run("INSERT INTO sales_order_items (order_id, product_id, product_name, sku, quantity, unit_price, amount) VALUES (?, ?, ?, ?, ?, ?, ?)",
            [id, item.product_id, item.product_name, item.sku || '', qty, up, item.amount ?? qty * up]);
        if (item.product_id) await run("UPDATE products SET stock_quantity = stock_quantity - ? WHERE id = ?", [qty, item.product_id]);
    }

    // ④ 业务员（业绩归属）：可改；制单人（真实开单动作）保持原值不动
    let operatorId = old.operator_id;
    let operatorName = old.operator_name;
    if (targetOperatorId && Number(targetOperatorId) > 0) {
        const emp = (await safeExec("SELECT real_name FROM users WHERE id = ? AND status = 1", [Number(targetOperatorId)])).values?.[0];
        if (emp) { operatorId = Number(targetOperatorId); operatorName = emp[0] || operatorName; }
    }
    let commissionAmount = 0;
    try {
        const cr = (await safeExec("SELECT COALESCE(commission_rate,0) FROM users WHERE id = ?", [operatorId])).values?.[0]?.[0];
        commissionAmount = Math.round((Number(cr) || 0) * finalAmount) / 100;
    } catch (e) { commissionAmount = 0; }

    // ⑤ 无收款单 ⇒ 收款保持 0，应收/欠款按新金额重算
    const oweAmount = Math.round(finalAmount * 100) / 100;
    const paymentStatus = oweAmount > 0.005 ? '未结清' : '已结清';
    const newBillDate = bill_date || old.bill_date || null;
    await run("UPDATE sales_orders SET customer_id = ?, customer_name = ?, total_amount = ?, discount = ?, final_amount = ?, express_amount = ?, tax_amount = ?, small_change_amount = ?, receivable_amount = ?, received_amount = 0, owe_amount = ?, payment_status = ?, operator_id = ?, operator_name = ?, commission_amount = ?, remark = ?, bill_date = ? WHERE id = ?",
        [customer_id || old.customer_id || null, customer_name || old.customer_name || null, totalAmount, Number(discount) || 0, finalAmount,
            Number(express_amount) || 0, Number(tax_amount) || 0, Number(small_change_amount) || 0,
            finalAmount, oweAmount, paymentStatus, operatorId, operatorName, commissionAmount,
            remark ?? old.remark ?? '', newBillDate, id]);
    saveDB();
    res.json({ ok: true, id, order_number: old.order_number, final_amount: finalAmount, owe_amount: oweAmount, payment_status: paymentStatus, items: items.length });
});
app.post('/api/store/sales-orders/:id/receive', authMiddleware, hasPerm('sales'), idem('sales-orders-receive'), async (req, res) => {
    await initDB();
    const id = Number(req.params.id);
    const amount = Number(req.body.amount) || 0;
    if (amount <= 0) return res.status(400).json({ ok: false, code: 'RECEIVE_BAD_AMOUNT', error: '收款金额必须大于 0' });
    /* ★★ 2026-10-11 P5-3（B0-3 / P1-01·P1-02）并发「丢失更新」根治 —— 销售单收款登记。
     * 【缺陷实证】隔离库 hongrui_ws48，同一张单 5 笔并发收款各 ¥100
     *   （装置：_diag/sprint/p5-b03-test.cjs，原始响应 out/p5b03-BEFORE-probes.json）：
     *     · 单据 received_amount 只从 0 走到 **200**（应 500），owe 停在 **800**（应 500）；
     *     · 而账户是 `balance = balance + ?` 原子累加 ⇒ **账户 +500**；
     *   ⇒ 不变量「Σ账户余额增量 ≡ Σ单据已收增量」被打破，差额 **300**（
     *     钱确实收了，单据却只核销一部分 ⇒ 客户被重复催收）。
     *   · 回执同样是错的：OrderManagement.submitPay 的 toast 直接显示响应里的 owe_amount，
     *     5 个并发的用户会看到同一个"剩余欠款"（实测 5 个回执只产生 2 个不同值）。
     * 【根因】"读-算-写"跨语句无锁：`safeExec(读单据)` 与 `run(写单据)` 各自
     *   getPool().connect()→release()，**落在不同连接**（池 max:20）⇒ 并发请求各自基于
     *   同一快照计算，再把各自算出的**绝对值**覆盖写回去 ⇒ 后写者吃掉前写者。
     * 【修法（最小增量，计算口径逐字不动）】
     *   ① 整段进 withTx ⇒「单据 + 资金流水 + 账户余额」同生共死（顺带消灭半截账）；
     *   ② 取单语句加**行级排他锁**（ORDER BY 之外的锁定读）⇒ 并发收款在数据库侧排队，
     *      后到者读到的一定是前一笔提交后的值；
     *   ③ receivable / newReceived / newOwe / newStatus 四个公式**原样保留**，只是把"读"挪进锁内；
     *   ④ 锁内复查「作废」态：旧写法在事务外判断，与"作废"并发时会把钱收进已作废的单。
     * 【加锁顺序】本路由为「先锁单据、后动账户」，与 /finance/transactions/income|expense
     *   完全同序 ⇒ 三条资金路径交叉并发不成环、不死锁（转账死锁实证见 transfer 路由）。
     * 【顺带】显式传入的 account_id 现在必须真实存在：旧写法若账户不存在，
     *   `UPDATE ... WHERE id=?` 影响 0 行且不报错 ⇒ 流水记了、账户没动（与 P5-2 的 A3 同型）。 */
    const accountId = Number(req.body.account_id) || null;
    if (accountId) {
        const okAcc = (await safeExec("SELECT id FROM accounts WHERE id = ?", [accountId])).values?.[0]?.[0];
        if (!okAcc) return res.status(400).json({ ok: false, code: 'RECEIVE_BAD_ACCOUNT', error: `账户 #${accountId} 不存在` });
    }
    /* 单号在事务外先取：① 不在持锁期间多耗一次数据库往返；② 避免"事务占着连接、取号再要连接"
     *   在连接池见底时互相等待。取号走序列 nextval、本就不参与事务回滚 ⇒ 语义与旧实现完全一致
     *   （旧实现也是"有 accountId 才取号"）。 */
    const incomeNo = accountId ? await generateOrderNumber('income') : null;
    let out;
    try {
        out = await withTx(async (tx) => {
            // ① 先取锁：并发收款在此排队，读到的一定是前一笔提交后的值 —— 这是丢失更新的唯一根治点
            const o = (await tx.q("SELECT " + SO_COLS + " FROM sales_orders WHERE id = ? FOR UPDATE", [id])).values?.[0];
            if (!o) throw Object.assign(new Error('订单不存在'), { httpCode: 404, code: 'RECEIVE_NOT_FOUND', msg: '订单不存在' });
            const so = mapSalesOrder(o);
            if (so.payment_status === '作废') throw Object.assign(new Error('该单已作废'), { httpCode: 400, code: 'RECEIVE_VOIDED', msg: '该单已作废，不能收款' });
            const receivable = so.receivable_amount || so.final_amount;
            const newReceived = Math.round((so.received_amount + amount) * 100) / 100;
            const newOwe = Math.round((receivable - newReceived) * 100) / 100;
            const newStatus = newOwe > 0.005 ? '未结清' : '已结清';
            await tx.run("UPDATE sales_orders SET received_amount = ?, owe_amount = ?, payment_status = ? WHERE id = ?", [newReceived, newOwe, newStatus, id]);
            // 资金流水（可选账户）
            if (accountId) {
                // 补单据号（2026-10-05）：这一处此前只写流水不写号，导致「收款记录」页里
                // 手工收款有号、销售单自动收款没号，同一列表两种形态 ⇒ 对账时无法指认。
                await tx.run("INSERT INTO transactions (type, account_id, amount, category, description, party_type, party_id, party_name, operator_id, operator_name, order_number) VALUES ('income', ?, ?, '销售收款', ?, 'customer', ?, ?, ?, ?, ?)",
                    [accountId, amount, '销售单 ' + so.order_number + ' 收款', so.customer_id || null, so.customer_name || '', req.user.id, req.user.real_name, incomeNo]);
                await tx.run("UPDATE accounts SET balance = balance + ? WHERE id = ?", [amount, accountId]);
            }
            return { received_amount: newReceived, owe_amount: newOwe, payment_status: newStatus };
        });
    }
    catch (e) {
        if (e && e.httpCode) return res.status(e.httpCode).json({ ok: false, code: e.code, error: e.msg });
        console.error('[SO-RECEIVE] 收款失败，已整体回滚:', e.message);
        return res.status(500).json({
            ok: false, code: 'RECEIVE_WRITE_FAILED',
            error: '收款失败，本次操作未生效（已整体回滚）',
            detail: String(e.message).slice(0, 200),
        });
    }
    saveDB();
    res.json({ ok: true, received_amount: out.received_amount, owe_amount: out.owe_amount, payment_status: out.payment_status });
});
/* 作废销售单（仅管理员）：标记作废 + 冲回库存 + **回滚已收资金**；
 * 保留记录与明细（对齐智慧记 invalid，不做物理删除）。
 *
 * ★★ 2026-10-09 真机实测修复：原实现只回冲库存、把状态改成"作废"，
 *   **已收的钱仍留在账户里** ⇒ 作废一张已收款单，账面资金虚高，
 *   而且流水里没有任何痕迹可以追（不知道钱去哪了、该从哪个账户扣）。
 *   作废的语义是「这笔生意不成立」⇒ 库存要回来、钱也要退回去，缺一不可。
 *
 * 回滚方式（可审计）：
 *   ① 按单号找出该单的全部收款流水 —— 开单收款与收款登记两处都写
 *      `销售单 <单号> 收款`（格式统一，便于精确匹配，不用模糊 LIKE 误伤他单）；
 *   ② 逐条把金额从**当时落账的那个账户**扣回（account_id 来自流水本身，不是猜的）；
 *   ③ **另记一条负数冲销流水**（不删原流水）—— 资金变动必须留痕，可审计、可复算；
 *   ④ 若单据标着已收却找不到对应流水（旧版写入/外部导入），**不回滚但打日志**，
 *      绝不静默假装回滚成功。
 */
app.delete('/api/store/sales-orders/:id', authMiddleware, adminOnly, async (req, res) => {
    await initDB();
    const id = Number(req.params.id);
    const row = (await safeExec("SELECT " + SO_COLS + " FROM sales_orders WHERE id = ?", [id])).values?.[0];
    if (!row) return res.status(404).json({ error: '订单不存在' });
    const so = mapSalesOrder(row);
    if (so.payment_status === '作废') return res.status(400).json({ error: '该单已作废，无需重复操作' });

    // ① 回冲库存
    const items = (await safeExec("SELECT product_id, quantity FROM sales_order_items WHERE order_id = ?", [id])).values || [];
    for (const it of items) {
        if (it[0]) await run("UPDATE products SET stock_quantity = stock_quantity + ? WHERE id = ?", [Number(it[1]) || 0, it[0]]);
    }

    // ② 回滚已收资金（账户 + 冲销流水）
    let rolledBack = 0;
    const recv = Number(so.received_amount) || 0;
    if (recv > 0.005) {
        const desc = '销售单 ' + so.order_number + ' 收款';
        const txs = (await safeExec("SELECT id, account_id, amount FROM transactions WHERE type = 'income' AND description = ?", [desc])).values || [];
        const touched = [];
        for (const t of txs) {
            const accId = t[1], amt = Number(t[2]) || 0;
            if (accId && amt > 0) {
                await run("UPDATE accounts SET balance = balance - ? WHERE id = ?", [amt, accId]);
                rolledBack = Math.round((rolledBack + amt) * 100) / 100;
                touched.push({ account_id: accId, amount: amt });
            }
        }
        if (rolledBack > 0) {
            /* 冲销流水**逐账户各记一条**：一张单的收款有可能分多次落进不同账户
             * （先微信后支付宝）。若只按 touched[0] 记一条，金额对得上但账户指认是错的，
             * 日后按账户核账会对不上。 */
            for (const t of touched) {
                try {
                    const no = await generateOrderNumber('income');
                    await run("INSERT INTO transactions (type, account_id, amount, category, description, operator_id, operator_name, party_type, party_id, party_name, order_number) VALUES ('income', ?, ?, '销售单作废冲销', ?, ?, ?, 'customer', ?, ?, ?)",
                        [t.account_id, -t.amount, '销售单 ' + so.order_number + ' 作废冲销', req.user.id, req.user.real_name, so.customer_id || null, so.customer_name || '', no]);
                } catch (e) {
                    console.error('[sales-orders] 作废冲销流水写入失败（账户已扣回，仅缺留痕）:', e.message);
                }
            }
        } else {
            console.error('[sales-orders] 单 %s 标记已收 ¥%s，但未匹配到收款流水 ⇒ 账户未回滚，需人工核对', so.order_number, recv);
        }
    }

    await run("UPDATE sales_orders SET payment_status = '作废' WHERE id = ?", [id]);
    saveDB();
    res.json({ ok: true, rolled_back: rolledBack, stock_restored: items.length });
});
// Sales Return APIs
app.get('/api/store/sales-returns', authMiddleware, hasPerm('return'), async (req, res) => {
    await initDB();
    const { page = 1, pageSize = 100, withTotal } = req.query;
    const pg = Math.max(1, Number(page) || 1);
    const ps = Math.min(1000, Math.max(1, Number(pageSize) || 100));
    // 关联原销售单，补充原单号/客户/业务日期（便于退货对账）
    // ★ P5/B0-1：额外取 so.id 与 so.payment_status，用于判定该退货单**是否已折入应收**
    //   （computeArap 只折入"原单存在且未作废"的退货；其余是孤立单，必须显式标记，
    //    否则用户看到的是"退了货但欠款没变"，且**没有任何提示**）。
    const sql = `SELECT r.id, r.return_number, r.sales_order_id, r.total_amount, r.operator_id, r.operator_name,
                        r.reason, r.status, r.created_at,
                        so.order_number, so.customer_name, COALESCE(so.bill_date, substr(so.created_at,1,10)),
                        so.id, COALESCE(so.payment_status,'')
                   FROM sales_returns r LEFT JOIN sales_orders so ON so.id = r.sales_order_id
                  ORDER BY r.id DESC LIMIT ? OFFSET ?`;
    const result = await safeExec(sql, [ps, (pg - 1) * ps]);
    const returns = (result.values || []).map((r) => {
        const soExists = r[12] !== null && r[12] !== undefined;
        const soVoid = String(r[13] || '') === '作废';
        const attributed = soExists && !soVoid;
        return {
            id: r[0], return_number: r[1], sales_order_id: r[2], total_amount: Number(r[3]),
            operator_id: r[4], operator_name: r[5], reason: r[6], status: r[7], created_at: r[8],
            ref_order_number: r[9] || '', customer_name: r[10] || '', bill_date: r[11] || null,
            /* ★ 是否已折入应收（computeArap 口径）。false ⇒ 这张退货**没有**减少任何客户欠款，
             *   前端必须显式提示，不能让用户以为"退货成功 = 欠款已减"。 */
            attributed,
            unattributed_reason: attributed ? null : (soExists ? '原单已作废' : '原单不存在'),
        };
    });
    if (withTotal) {
        const totalRow = (await safeExec("SELECT COUNT(*) FROM sales_returns")).values?.[0]?.[0];
        return res.json({ rows: returns, total: Number(totalRow || 0), page: pg, pageSize: ps });
    }
    res.json(returns);
});
app.post('/api/store/sales-returns', authMiddleware, hasPerm('return'), idem('sales-returns'), async (req, res) => {
    await initDB();
    const { sales_order_id, items, reason } = req.body;

    /* ★ B0-1 入口硬校验（2026-10-11 · P5）。
     * 【为什么必须挡在最前面】P1-06 的"静默假成功"之所以能发生，是因为后端把
     * 「明细根本写不进去」当成了「没问题」：前端漏 product_id/unit_price ⇒ 后端算 ¥0
     * ⇒ 明细 INSERT 违反 NOT NULL ⇒ 被 run() 的 catch 吞掉 ⇒ 路由照样 res.json({ok:true})。
     * 结果：一张「看起来成功、实际零明细」的退货单，而客户欠款一分没减。
     * ⇒ 上游拦死，这类错**不可能**再变成一张"看起来成功"的单据。 */
    if (!Array.isArray(items) || items.length === 0)
        return res.status(400).json({ error: '退货明细不能为空' });
    for (let i = 0; i < items.length; i++) {
        const it = items[i] || {};
        if (!Number.isFinite(Number(it.product_id)) || Number(it.product_id) <= 0)
            return res.status(400).json({ error: `第 ${i + 1} 行退货明细缺少有效的 product_id` });
        if (!Number.isFinite(Number(it.quantity)) || Number(it.quantity) <= 0)
            return res.status(400).json({ error: `第 ${i + 1} 行退货数量必须为正数` });
        if (!Number.isFinite(Number(it.unit_price)) || Number(it.unit_price) < 0)
            return res.status(400).json({ error: `第 ${i + 1} 行退货单价不能为负数（0 = 赠品退货，允许）` });
    }

    /* 原单必须存在且未作废 —— 退货的客户归属与"是否折入应收"都依赖它（见 computeArap）。
     * 不做这一层校验，就会造出"查不到客户的孤立退货单"，那种单只能不折入任何客户，
     * 于是用户看到的是"退了货但欠款没变"（= 又一个看不见的错）。 */
    const soRow = (await safeExec(
        "SELECT id, order_number, customer_id, customer_name, COALESCE(payment_status,'') FROM sales_orders WHERE id = ?",
        [Number(sales_order_id)])).values?.[0];
    if (!soRow)
        return res.status(404).json({ error: '原销售单不存在，不能退货' });
    if (String(soRow[4]) === '作废')
        return res.status(400).json({ error: '原单已作废，不能退货' });

    const returnNumber = await generateOrderNumber('TH');
    let totalAmount = 0;
    for (const it of items) totalAmount += Number(it.quantity) * Number(it.unit_price);

    /* ★ 全部写入收进**同一事务**：主单 + 明细 + 回补库存，要么全成、要么全不成。
     *   失败**不吞**，转成明确错误码 —— 绝不返回 ok:true。 */
    let returnId = null;
    try {
        returnId = await withTx(async (tx) => {
            const id = await tx.lastId(
                "INSERT INTO sales_returns (return_number, sales_order_id, total_amount, operator_id, operator_name, reason) VALUES (?, ?, ?, ?, ?, ?)",
                [returnNumber, Number(sales_order_id), totalAmount, req.user.id, req.user.real_name, reason || '']);
            if (!id) throw new Error('退货主单写入未返回 id');
            for (const it of items) {
                const qty = Number(it.quantity), price = Number(it.unit_price);
                await tx.run(
                    "INSERT INTO sales_return_items (return_id, product_id, product_name, sku, quantity, unit_price, amount) VALUES (?, ?, ?, ?, ?, ?, ?)",
                    [id, Number(it.product_id), it.product_name || '', it.sku || '', qty, price, qty * price]);
                await tx.run("UPDATE products SET stock_quantity = stock_quantity + ? WHERE id = ?", [qty, Number(it.product_id)]);
            }
            return id;
        });
    }
    catch (e) {
        console.error('销售退货写入失败（已整单回滚）:', e.message);
        return res.status(500).json({ error: '退货单写入失败，已整单回滚，未产生任何数据', code: e.code || null });
    }
    saveDB();
    /* attributed:true —— 能走到这里说明原单存在且未作废 ⇒ computeArap 的 sr 子查询**会**把它折入应收。
     * 显式回传该字段，让前端能断言"欠款确实减了"，而不是笼统提示"退货成功"。 */
    res.json({ ok: true, id: returnId, return_number: returnNumber, total_amount: totalAmount, attributed: true });
});
// ==================== 回收单（旧件回收：回收入库 + 成本=回收价 + 记回收支出） ====================
app.get('/api/store/recycles', authMiddleware, hasPerm('recycle'), async (_req, res) => {
    await initDB();
    const isAdminUser = _req.user.role === 'admin' || _req.user.role === 'manager';
    const scopeSql = ''; // 全店可见
    const result = await safeExec(`SELECT * FROM recycles${scopeSql} ORDER BY id DESC LIMIT 100`);
    const list = (result.values || []).map((r) => ({
        id: r[0], recycle_number: r[1], customer_id: r[2], customer_name: r[3],
        total_amount: Number(r[4]), operator_id: r[5], operator_name: r[6], remark: r[7], created_at: r[8]
    }));
    res.json(list);
});
app.get('/api/store/recycles/:id', authMiddleware, hasPerm('recycle'), async (req, res) => {
    await initDB();
    const id = Number(req.params.id);
    const r = (await safeExec("SELECT * FROM recycles WHERE id = ?", [id])).values?.[0];
    if (!r)
        return res.status(404).json({ error: '回收单不存在' });
    const items = ((await safeExec("SELECT * FROM recycle_items WHERE recycle_id = ?", [id])).values || []).map((i) => ({
        id: Number(i[0]), product_id: Number(i[2]), product_name: i[3], sku: i[4], quantity: Number(i[5]), unit_price: Number(i[6]), amount: Number(i[7])
    }));
    res.json({
        id: r[0], recycle_number: r[1], customer_id: r[2], customer_name: r[3],
        total_amount: Number(r[4]), operator_id: r[5], operator_name: r[6], remark: r[7], created_at: r[8], items
    });
});
app.post('/api/store/recycles', authMiddleware, hasPerm('recycle'), idem('recycles'), async (req, res) => {
    await initDB();
    if (req.user && req.user.role === 'employee')
        return res.status(403).json({ error: '店员无权操作回收，请联系管理员' });
    const { customer_id, customer_name, items, remark, account_id } = req.body;
    if (!items || !items.length)
        return res.status(400).json({ error: '请添加回收商品' });
    const recycleNumber = await generateOrderNumber('HS');
    let totalAmount = 0;
    for (const it of items)
        totalAmount += (it.quantity || 0) * (it.unit_price || 0);
    const recycleId = await runLastId("INSERT INTO recycles (recycle_number, customer_id, customer_name, total_amount, operator_id, operator_name, remark) VALUES (?, ?, ?, ?, ?, ?, ?)", [recycleNumber, customer_id || null, customer_name || null, totalAmount, req.user.id, req.user.real_name, remark || '']);
    if (items && recycleId) {
        for (const it of items) {
            await run("INSERT INTO recycle_items (recycle_id, product_id, product_name, sku, quantity, unit_price, amount) VALUES (?, ?, ?, ?, ?, ?, ?)", [recycleId, it.product_id, it.product_name, it.sku || '', it.quantity, it.unit_price, (it.quantity || 0) * (it.unit_price || 0)]);
            if (it.product_id) {
                // 回收旧件入库；"回收后当作进价"——成本按回收价（set_cost 默认 true，可在界面上关）
                const setCost = it.set_cost !== false;
                if (setCost) {
                    await run("UPDATE products SET stock_quantity = stock_quantity + ?, cost_price = ? WHERE id = ?", [it.quantity, it.unit_price, it.product_id]);
                }
                else {
                    await run("UPDATE products SET stock_quantity = stock_quantity + ? WHERE id = ?", [it.quantity, it.product_id]);
                }
            }
        }
    }
    // 记一笔"回收支出"（付给客户的钱），避免每月净利虚高
    // 账户选择：优先前端指定 → 现金账户 → 任意账户 → 都没有则自动建一个现金账户（保证流水能记上）
    let accId = account_id || null;
    if (!accId) {
        accId = (await safeExec("SELECT id FROM accounts WHERE type = 'cash' LIMIT 1")).values?.[0]?.[0] || null;
    }
    if (!accId) {
        accId = (await safeExec("SELECT id FROM accounts ORDER BY id LIMIT 1")).values?.[0]?.[0] || null;
    }
    if (!accId) {
        // 见 runLastId 注释：INSERT 与「取刚插入的 id」必须同一条语句，否则连接池会话漂移会取到别的 id
        accId = await runLastId("INSERT INTO accounts (name, type, balance) VALUES ('现金', 'cash', 0)");
    }
    if (accId) {
        /* 补单据号（2026-10-05）：回收是「付钱给客户」，属付款流水 ⇒ 单号用 FKD。
         * 但用户在这一行最想看到的是「这是哪张回收单」⇒ 把 HSD 回收单号写进 description，
         * 这样既满足「付款流水有号」，又保留了与回收单的关联线索。
         * （两条流水指向同一笔业务，但 order_number 有唯一约束，不能共用同一个号。） */
        const payNo = await generateOrderNumber('expense');
        /* ★★ 2026-10-11 P5-4（P3-07）：回收是「付钱给客户」，既记了支出流水，就**必须**同步减账户余额。
         *   【缺陷实证】修复前只写流水、不改余额 ⇒ 实测余额 10000 → 10000（纹丝不动），
         *     而流水净额 −300 ⇒ **余额 ≢ Σ流水净额**，gap = +300（记账工具最不能犯的错）。
         *   【同步修法】与 income / expense 两条路径同形：流水写入后紧跟一句原子累减。
         *   【现状】隔离库 recycles 为 0 行 ⇒ 本改动**当前金额影响 ¥0.00**，但修复前只要录一笔就会破不变量。 */
        await run("INSERT INTO transactions (type, account_id, amount, category, description, operator_id, operator_name, created_at, order_number) VALUES ('expense', ?, ?, '回收支出', ?, ?, ?, datetime('now','localtime'), ?)",
            [accId, totalAmount, '回收单 ' + recycleNumber + '（' + (customer_name || '散客') + '，' + items.length + '项）', req.user.id, req.user.real_name, payNo]);
        await run("UPDATE accounts SET balance = balance - ? WHERE id = ?", [totalAmount, accId]);
    }
    saveDB();
    res.json({ ok: true, recycle_number: recycleNumber, total_amount: totalAmount });
});
app.get('/api/store/pos/products', authMiddleware, async (req, res) => {
    await initDB();
    const { keyword } = req.query;
    let sql = "SELECT * FROM products WHERE status = 1 AND stock_quantity > 0";
    if (keyword) {
        sql += " AND (name LIKE '%" + String(keyword).replace(/'/g, "''") + "%' OR sku LIKE '%" + String(keyword).replace(/'/g, "''") + "%')";
    }
    sql += " ORDER BY id DESC LIMIT 100";
    const result = await safeExec(sql);
    // 转换为对象格式（与 /inventory/products 保持一致，前端按 p.name/p.sku 解析）
    const products = (result.values || []).map((p) => ({
        id: p[0], sku: p[1], name: p[2], category: p[3], spec: p[4], unit: p[5],
        cost_price: Number(p[6]), sell_price: Number(p[7]), stock_quantity: Number(p[8]),
        warning_quantity: Number(p[9]), batch_number: p[10], production_date: p[11],
        expiry_date: p[12], supplier_id: p[13], status: p[14], created_at: p[15], updated_at: p[16],
        wholesale_price: Number(p[17] || 0)
    }));
    res.json(products);
});
app.get('/api/store/settings', authMiddleware, hasPerm('settings'), async (_req, res) => {
    await initDB();
    const result = await safeExec("SELECT key, value FROM settings");
    const settings = {};
    for (const row of result.values || []) {
        settings[row[0]] = row[1];
    }
    res.json(settings);
});
app.put('/api/store/settings', authMiddleware, hasPerm('settings'), async (req, res) => {
    await initDB();
    const { settings } = req.body;
    /* ★ B0-5（P1-05）：入参硬校验。修复前缺 settings ⇒ `Object.entries(undefined)` 抛 TypeError
     *   ⇒ 本路由无 try/catch ⇒ Express 默认错误页把完整调用栈 ＋ 绝对路径回给客户端。*/
    if (!settings || typeof settings !== 'object' || Array.isArray(settings))
        return res.status(400).json({ ok: false, error: 'settings 必须为对象（键值对）' });
    for (const [key, value] of Object.entries(settings)) {
        await run("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=?", [key, value, value]);
    }
    saveDB();
    saveDB();
    res.json({ ok: true });
});
app.post('/api/store/settings/init', authMiddleware, hasPerm('settings'), async (_req, res) => {
    await initDB();
    const defaultSettings = {
        store_tax_rate: '0',
        default_payment_method: 'cash',
        auto_backup: 'true'
    };
    for (const [key, value] of Object.entries(defaultSettings)) {
        await run("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=?", [key, value, value]);
    }
    saveDB();
    saveDB();
    res.json({ ok: true });
});
// ==================== Excel 导入导出 ====================
// 导出商品（xlsx）
/* ★ 2026-10-09（老板拍板 1-A）：本接口由 inventory_view 开放给子账号，
 *   但 xlsx 是二进制响应、**绕过全局出口脱敏器**（那个只改 res.json）⇒ 若原样导出，
 *   只读子账号能把「进货价」整表带走 —— 相当于把成本泄露从界面挪到了文件里。
 *   ⇒ 按 sensitiveFlags(req.user).cost 决定是否带成本列（与页面隐藏同一判据）。 */
app.get('/api/inventory/products/export', authMiddleware, hasPerm('inventory_view'), async (req, res) => {
    await initDB();
    const canCost = sensitiveFlags(req.user).cost;
    const sel = canCost
        ? "name, category, spec, unit, cost_price, sell_price, stock_quantity, warning_quantity"
        : "name, category, spec, unit, sell_price, stock_quantity, warning_quantity";
    const result = await safeExec(`SELECT ${sel} FROM products WHERE status = 1 ORDER BY id`);
    const rows = [canCost
        ? ['商品名称', '分类', '规格', '单位', '进货价', '销售价', '库存数量', '预警数量']
        : ['商品名称', '分类', '规格', '单位', '销售价', '库存数量', '预警数量']];
    for (const r of result.values || []) rows.push(r);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), '商品');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="products.xlsx"');
    res.send(buf);
});
// 导入商品（按名称 upsert；表头：商品名称/分类/规格/单位/进货价/销售价/库存数量/预警数量）
app.post('/api/inventory/products/import', authMiddleware, hasPerm('inventory_full'), upload.single('file'), async (req, res) => {
    await initDB();
    if (!req.file) return res.status(400).json({ error: '未上传文件' });
    const wb = XLSX.read(req.file.buffer);
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' });
    let added = 0, updated = 0, skipped = 0;
    for (const r of rows.slice(1)) {
        const name = String(r[0] || '').trim();
        if (!name) { skipped++; continue; }
        const exist = (await safeExec("SELECT id FROM products WHERE name = ? AND status = 1", [name])).values?.[0];
        const cost = Number(r[4]) || 0, sell = Number(r[5]) || 0, stock = Number(r[6]) || 0, warn = Number(r[7]) || 0;
        if (exist) {
            await run("UPDATE products SET category=?, spec=?, unit=?, cost_price=?, sell_price=?, stock_quantity=?, warning_quantity=?, updated_at=datetime('now','localtime') WHERE id=?", [String(r[1] || ''), String(r[2] || ''), String(r[3] || ''), cost, sell, stock, warn, exist[0]]);
            updated++;
        } else {
            await run("INSERT INTO products (name, category, spec, unit, cost_price, sell_price, stock_quantity, warning_quantity) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [name, String(r[1] || ''), String(r[2] || ''), String(r[3] || ''), cost, sell, stock, warn]);
            added++;
        }
    }
    saveDB(); saveDB();
    res.json({ ok: true, added, updated, skipped });
});
// 导出客户（xlsx）
app.get('/api/store/customers/export', authMiddleware, hasPerm('customers'), async (_req, res) => {
    await initDB();
    const result = await safeExec("SELECT name, contact, phone, address, remark FROM customers WHERE status = 1 ORDER BY id");
    const rows = [['客户名称', '联系人', '电话', '地址', '备注']];
    for (const r of result.values || []) rows.push(r);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), '客户');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="customers.xlsx"');
    res.send(buf);
});
// ==================== 数据导出扩展 ====================
// 导出供应商
app.get('/api/store/suppliers/export', authMiddleware, hasPerm('suppliers'), async (_req, res) => {
    await initDB();
    const result = await safeExec("SELECT name, contact, phone, address, remark FROM suppliers WHERE status = 1 ORDER BY id");
    const rows = [['供应商名称', '联系人', '电话', '地址', '备注']];
    for (const r of result.values || []) rows.push(r);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), '供应商');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="suppliers.xlsx"');
    res.send(buf);
});
// 导出资金流水（按日期范围）
app.get('/api/finance/transactions/export', authMiddleware, hasPerm('finance_view'), async (req, res) => {
    await initDB();
    const { startDate = '2020-01-01', endDate = '2030-12-31' } = req.query;
    const result = await safeExec("SELECT type, account_id, amount, category, description, party_name, operator_name, created_at FROM transactions WHERE date(created_at) >= ? AND date(created_at) <= ? ORDER BY id", [String(startDate), String(endDate)]);
    const rows = [['类型', '账户ID', '金额', '类别', '描述', '往来对象', '操作员', '日期']];
    for (const r of result.values || []) rows.push(r);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), '资金流水');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="transactions.xlsx"');
    res.send(buf);
});
// 导入客户（按名称 upsert；表头：客户名称/联系人/电话/地址/备注）
app.post('/api/store/customers/import', authMiddleware, hasPerm('customers'), upload.single('file'), async (req, res) => {
    await initDB();
    if (!req.file) return res.status(400).json({ error: '未上传文件' });
    const wb = XLSX.read(req.file.buffer);
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' });
    let added = 0, updated = 0, skipped = 0;
    for (const r of rows.slice(1)) {
        const name = String(r[0] || '').trim();
        if (!name) { skipped++; continue; }
        const exist = (await safeExec("SELECT id FROM customers WHERE name = ? AND status = 1", [name])).values?.[0];
        if (exist) {
            await run("UPDATE customers SET contact=?, phone=?, address=?, remark=? WHERE id=?", [String(r[1] || ''), String(r[2] || ''), String(r[3] || ''), String(r[4] || ''), exist[0]]);
            updated++;
        } else {
            await run("INSERT INTO customers (name, contact, phone, address, remark) VALUES (?, ?, ?, ?, ?)", [name, String(r[1] || ''), String(r[2] || ''), String(r[3] || ''), String(r[4] || '')]);
            added++;
        }
    }
    saveDB(); saveDB();
    res.json({ ok: true, added, updated, skipped });
});
// ==================== 供应商对账 ====================
app.get('/api/finance/supplier-reconciliation', authMiddleware, hasPerm('reconciliation'), async (_req, res) => {
    await initDB();
    // status 可能是 '1' / 'completed' / 空，统一视为有效单据
    const result = await safeExec("SELECT supplier_id, supplier_name, COUNT(*), COALESCE(SUM(total_amount),0) FROM purchase_orders WHERE " + PO_ALIVE + " GROUP BY supplier_id, supplier_name ORDER BY SUM(total_amount) DESC");
    const list = (result.values || []).map((r) => ({
        supplier_id: r[0], supplier_name: r[1] || '未填供应商', order_count: Number(r[2]), total_amount: Number(r[3])
    }));
    res.json(list);
});
// ==================== 往来单位余额口径（2026-10-03 改造） ====================
/**
 * 为什么改成「按名称归集」：
 *   历史迁移只落了「名称」不落「ID」——sales_orders.customer_id 仅 9/4,434 有值、
 *   transactions.party_id 与 party_type 全空、purchase_orders.supplier_id 仅零星。
 *   旧实现按 ID JOIN ⇒ 两个子查询恒落空 ⇒ 应收只剩期初（线上曾长期显示 ¥44,220，
 *   而真实应收为 ¥568,013）。故一律【按名称】归集。
 *
 * 余额口径 = 期初 + 全量非作废单据 − 全量收付款流水
 *   这是「往来单位级滚动余额」，与智慧记 cur_amt 同型；【不是】「未结清单据」。
 *   旁证：智慧记自身单据 owe_amt 合计 ¥1,961,049 而客户 cur_amt 合计 ¥460,668，
 *   落差 ¥150 万 —— 「单据未付 ≫ 客户欠款」是行业常态，未结清单据从来不是应收。
 */
const SANKE_NAMES = ['零售散客', '批发散客']; // 散客为现金交易，不计应收/应付（智慧记同口径：cur_amt=0）
const PARTY_ALIAS = { '宇辉厨卫Y': '大宇厨卫' }; // 旧名 → 现名：同一个往来单位的多份档案按现名合并计数
const _sqlLit = (s) => "'" + String(s).replace(/'/g, "''") + "'";
/**
 * ★ 空白折叠（2026-10-04，以智慧记为准）：NBSP(U+00A0) / 全角空格(U+3000) / Tab / 换行
 *   一律折成【单个半角空格】并去首尾。
 * 为什么必须：PostgreSQL 的 TRIM() 不去 NBSP，而库内名可能带 NBSP、外部系统导出用半角空格
 *   ⇒ 同一往来单位被拆成两组：真身拿不到调整额（优惠/抹零静默失效）、前台多出「倒欠」幽灵客户，
 *   而【总合计不变】——只看总数永远发现不了。
 * 规则必须与 JS 侧 canonName 完全一致（单一真源）。
 */
const FOLD_SQL = (col) => `btrim(regexp_replace(translate(${col}, chr(160)||chr(12288)||chr(9)||chr(10)||chr(13), '     '), ' +', ' ', 'g'))`;
const canonName = (n) => {
    const k = String(n === null || n === undefined ? '' : n).replace(/[\s\u00A0\u3000]+/g, ' ').trim();
    return Object.prototype.hasOwnProperty.call(PARTY_ALIAS, k) ? PARTY_ALIAS[k] : k;
};
/** 生成「把某列规范化到现名」的 SQL 表达式。规则必须与 canonName 完全一致。 */
function canonSQL(col) {
    const base = FOLD_SQL(col);
    const cases = Object.entries(PARTY_ALIAS)
        .map(([from, to]) => `WHEN ${base} = ${_sqlLit(from)} THEN ${_sqlLit(to)}`).join(' ');
    return cases ? `CASE ${cases} ELSE ${base} END` : base;
}
// ==================== 应收应付对账（口径：期初欠款 + 全量销售/进货 − 全量已收/已付 = 期末欠款） ====================
/* ★★ 单一真源（2026-10-08）：应收/应付的**唯一**计算入口。
 *   仪表盘此前用的是 `SUM(owe_amount)`（未结清单据合计），与对账页给出的数字**自相矛盾**：
 *     仪表盘 ¥2,107,243.20（1103 单）  vs  对账页 ¥487,404.60（186 家）
 *   两者并非"算错"，而是**口径不同**——见上方注释旁证：智慧记自身单据 owe 合计 ¥1,961,049
 *   而客户 cur_amt 合计 ¥460,668，落差 ¥150 万。**未结清单据从来不是应收**。
 *   ⇒ 抽成函数，两处共用，从结构上杜绝口径再次分叉。 */
async function computeArap() {
    await initDB();
    const CANON_C = canonSQL('c.name');
    const CANON_S = canonSQL('s.name');
    // 客户：先按现名合并同单位多档案（pid 取「档案名就是现名」那条的 id，保证对账单跳转到主档）
    /* ★ 口径（2026-10-04 以智慧记为准，逐家预演已对齐 ¥0 差异）：
     *   balance = 期初 + 单据发生额 − 收支流水净额 − 优惠 + 抹零
     *   ① 单据发生额取【双向净额】= Σ销售单 − Σ采购单
     *      —— 智慧记对「同时有销售与采购」的单位只按其档案主类型归一侧，且两侧互抵。
     *      实测：赵明义 Σ采 608,327.80 − Σ销 88,040.80 ⇒ 只出现在应付侧 33,866.60（应收侧完全不出现）。
     *   ② 应收侧【排除】「在 suppliers(status=1) 里同名的单位」
     *      —— 智慧记 29 家 type=2 供应商曾被宏瑞一并建成客户档案 ⇒ 应收虚增 ¥94,297.80 的真正根因。
     *   ③ 流水取【收支净额】= Σ(income) − Σ(expense)
     *      —— 智慧记 back_tamt 即净额（实测佳研新材料：−3,960 − 10,080 = −14,040，与其 back 完全一致）。
     *   ④ 归集一律走 FOLD_SQL 折叠空白，杜绝 NBSP 撕裂。 */
    const custRows = (await safeExec(`SELECT cg.nm, cg.pid, cg.ib,
        COALESCE(u.cnt,0) uc, COALESCE(u.amt,0) ua,
        COALESCE(pu.cnt,0) puc, COALESCE(pu.amt,0) pua,
        COALESCE(t.amt,0) ta,
        COALESCE(adj.pref,0) pref, COALESCE(adj.trim,0) trim,
        COALESCE(sr.cnt,0) srcnt, COALESCE(sr.amt,0) sramt
        FROM (
            SELECT ${CANON_C} nm,
                   COALESCE(MIN(c.id) FILTER (WHERE ${CANON_C} = ${FOLD_SQL('c.name')}), MIN(c.id)) pid,
                   SUM(COALESCE(c.initial_balance,0)) ib
            FROM customers c
            WHERE c.status=1
              AND NOT EXISTS (SELECT 1 FROM suppliers s
                              WHERE s.status=1 AND ${FOLD_SQL('s.name')} = ${FOLD_SQL('c.name')})
            GROUP BY 1
        ) cg
        LEFT JOIN (SELECT ${canonSQL('customer_name')} nm, COUNT(*) cnt, SUM(final_amount) amt
                   FROM sales_orders
                   WHERE COALESCE(payment_status,'') <> '作废'
                     AND customer_name IS NOT NULL AND ${FOLD_SQL('customer_name')} <> ''
                   GROUP BY 1) u ON u.nm = cg.nm
        LEFT JOIN (SELECT ${canonSQL('supplier_name')} nm, COUNT(*) cnt, SUM(total_amount) amt
                   FROM purchase_orders
                   WHERE COALESCE(payment_status,'') <> '作废' AND ${PO_ALIVE}
                     AND supplier_name IS NOT NULL AND ${FOLD_SQL('supplier_name')} <> ''
                   GROUP BY 1) pu ON pu.nm = cg.nm
        LEFT JOIN (SELECT ${canonSQL('party_name')} nm,
                          SUM(CASE WHEN type='income' THEN amount ELSE -amount END) amt
                   FROM transactions
                   WHERE party_name IS NOT NULL AND ${FOLD_SQL('party_name')} <> ''
                   GROUP BY 1) t ON t.nm = cg.nm
        LEFT JOIN (SELECT ${canonSQL('party_name')} nm,
                          SUM(CASE WHEN adj_type='preferential' THEN amount ELSE 0 END) pref,
                          SUM(CASE WHEN adj_type='trim' THEN amount ELSE 0 END) trim
                   FROM party_adjustments WHERE party_type='customer'
                   GROUP BY 1) adj ON adj.nm = cg.nm
        /* ★★★ 2026-10-11 P5 / B0-1（P1-07 修复）：把**系统退货**折入应收。
         * 【为什么必须折】修复前 sales_returns 在全后端"只被写和列、从不被算"（孤岛表）⇒
         *   客户退货后 sales_orders 不动 ⇒ **应收不减**，而前端显示"退货成功"。
         *   这正是 P1-06 一修好就会立刻制造的"看不见的错"（看得见的错 → 看不见的错），
         *   所以 B0-1 规定 P1-06 与 P1-07 **必须同批**，禁止分批。
         * 【口径】unpaidAmt = Σ销售 − Σ采购 − Σ退货，与历史导入路径（biz_type=sale_return）
         *   落在销售侧的算法**方向一致**（两条路径都让应收变小，不再不对称）。
         * 【归属】sales_returns 表**没有 customer_id**（实测字段清单），只能经 sales_order_id
         *   反查 sales_orders.customer_name。故用 INNER JOIN：
         *     · 原单不存在 ⇒ **自然不折入任何客户**（宁可少折，不可错折；禁按名字模糊猜测）
         *     · 原单已作废 ⇒ 本子查询排除（作废单本就不计应收，其退货也不该计）
         *   这类"未折入"的孤立退货单，在 GET /store/sales-returns 列表里以 attributed:false 显式标记。
         * 【现状】生产/隔离库 sales_returns 均为 0 行 ⇒ 本改动**当前金额影响 ¥0.00**，
         *   即 ARAP 与已验收值（69 家/¥440,672.85 ＋ 4 家/¥214,754.60）必须**逐字不变**（零回归判据）。
         * 【注意】本注释在 SQL 模板串内部，**禁用反引号**（会提前终止模板串）。 */
        LEFT JOIN (SELECT ${canonSQL('so.customer_name')} nm,
                          COUNT(*) cnt,
                          SUM(sr.total_amount) amt
                   FROM sales_returns sr
                   JOIN sales_orders so ON so.id = sr.sales_order_id
                   WHERE COALESCE(so.payment_status,'') <> '作废'
                     AND so.customer_name IS NOT NULL AND ${FOLD_SQL('so.customer_name')} <> ''
                   GROUP BY 1) sr ON sr.nm = cg.nm`)).values || [];
    const receivables = custRows.map((r) => {
        const initial = Number(r[2]) || 0;
        const saleAmt = Number(r[4]) || 0;      // Σ销售单
        const purchAmt = Number(r[6]) || 0;     // Σ采购单
        const received = Number(r[7]) || 0;     // 收支净额
        const preferential = Number(r[8]) || 0;
        const trim = Number(r[9]) || 0;
        /* ★ 列序自证：SELECT 列表里是 `COALESCE(sr.cnt,0) srcnt, COALESCE(sr.amt,0) sramt`
         *   ⇒ r[10] = **退货单数**，r[11] = **退货金额**。首版把两者写反，被装置 D1/D2 当场抓住
         *   （现象：应收账款只减了"1"、return_amount 显示 1、return_count 显示 125）——
         *   ⇒ 新增列一律紧贴其 SELECT 位置读，禁止按"业务上谁先谁后"想当然。 */
        const returnCount = Number(r[10]) || 0;  // Σ系统退货单数（P5/B0-1 新增，见上方 sr 子查询）
        const returnAmt = Number(r[11]) || 0;    // Σ系统退货金额
        const unpaidAmt = Math.round((saleAmt - purchAmt - returnAmt) * 100) / 100; // ★ 双向净额 − 退货
        const balance = Math.round((initial + unpaidAmt - received - preferential + trim) * 100) / 100;
        return {
            party_id: Number(r[1]), name: String(r[0] || ''),
            initial_balance: Math.round(initial * 100) / 100,
            unpaid_orders: Number(r[3]) || 0, unpaid_amount: unpaidAmt,
            return_amount: Math.round(returnAmt * 100) / 100,   // ★ 新增：本户已折入的退货合计
            return_count: returnCount,                          // ★ 新增：本户已折入的退货单数
            received: Math.round(received * 100) / 100,
            preferential: Math.round(preferential * 100) / 100,
            trim: Math.round(trim * 100) / 100,
            balance,
        };
    }).filter((x) => !SANKE_NAMES.includes(x.name))
      /* ★★★ 2026-10-10 口径修正（与智慧记逐项对齐）：
         旧过滤器 `|balance|>0.001 || unpaid_orders>0 || received!==0` 会把
         **余额为零但有往来记录**的单位一并算进「家数」——实测 187 家里 118 家余额恰为 0
         （187 = 69 非零 + 118 零余额；用直连库同构 SQL 可精确复算，见 _diag/d99），
         于是首页出现「欠款待收（187家）」，而智慧记同口径是 69 家（= 余额非零家数）。
         金额不受影响（零余额户不贡献金额），但家数是明显虚高。
         ⇒ 改为只保留**余额非零**的行：既修首页 KPI，也修「应收应付」页的「N 家客户」
           （该页直接取 receivables.length），一处改动两处同时归位。
         实测对齐后：应收 69 家 / ¥440,672.85，应付 4 家 / ¥214,754.60，与智慧记分毫不差。 */
      .filter((x) => Math.abs(x.balance) > 0.001)
      .sort((a, b) => b.balance - a.balance);
    // 供应商：同一套按名称归集。赵明义等「既是客户又是供应商」的单位，两侧各自独立计入（老板 10-03 定性：两个都算）
    /* ★ 供应商侧同口径（2026-10-04）：docAmt = Σ采购单 − Σ销售单；paid = 收支净额(expense − income)。
     *   双向单位（赵明义/伟岸中科）在智慧记里只出现在应付侧，且与销售侧互抵 ⇒ 本侧【不】做排除。 */
    const supRows = (await safeExec(`SELECT sg.nm, sg.pid, sg.ib,
        COALESCE(u.cnt,0) uc, COALESCE(u.amt,0) ua,
        COALESCE(su.cnt,0) suc, COALESCE(su.amt,0) sua,
        COALESCE(t.amt,0) ta,
        COALESCE(adj.pref,0) pref, COALESCE(adj.trim,0) trim
        FROM (
            SELECT ${CANON_S} nm,
                   COALESCE(MIN(s.id) FILTER (WHERE ${CANON_S} = ${FOLD_SQL('s.name')}), MIN(s.id)) pid,
                   SUM(COALESCE(s.initial_balance,0)) ib
            FROM suppliers s WHERE s.status=1 GROUP BY 1
        ) sg
        LEFT JOIN (SELECT ${canonSQL('supplier_name')} nm, COUNT(*) cnt, SUM(total_amount) amt
                   FROM purchase_orders
                   /* ★★ 2026-10-11 P5-4（P1-03）：补上 AND ${PO_ALIVE}，与客户侧 pu 子查询完全对齐。
                    *   【缺陷实证】软删后的进货单仍计入供应商应付（隔离库实测：删单后 arap 仍为 100）。
                    *   【为何是潜伏】当前库内 status IN ('cancelled','void') 为 0 张 ⇒ 金额影响 ¥0.00，
                    *     但一旦历史上删过单就会看得见。
                    *   【不改口径】只加一个过滤条件，宜家宜金额计算公式逐字未动。 */
                   WHERE COALESCE(payment_status,'') <> '作废' AND ${PO_ALIVE}
                     AND supplier_name IS NOT NULL AND ${FOLD_SQL('supplier_name')} <> ''
                   GROUP BY 1) u ON u.nm = sg.nm
        LEFT JOIN (SELECT ${canonSQL('customer_name')} nm, COUNT(*) cnt, SUM(final_amount) amt
                   FROM sales_orders
                   WHERE COALESCE(payment_status,'') <> '作废'
                     AND customer_name IS NOT NULL AND ${FOLD_SQL('customer_name')} <> ''
                   GROUP BY 1) su ON su.nm = sg.nm
        LEFT JOIN (SELECT ${canonSQL('party_name')} nm,
                          SUM(CASE WHEN type='expense' THEN amount ELSE -amount END) amt
                   FROM transactions
                   WHERE party_name IS NOT NULL AND ${FOLD_SQL('party_name')} <> ''
                   GROUP BY 1) t ON t.nm = sg.nm
        LEFT JOIN (SELECT ${canonSQL('party_name')} nm,
                          SUM(CASE WHEN adj_type='preferential' THEN amount ELSE 0 END) pref,
                          SUM(CASE WHEN adj_type='trim' THEN amount ELSE 0 END) trim
                   FROM party_adjustments WHERE party_type='supplier'
                   GROUP BY 1) adj ON adj.nm = sg.nm`)).values || [];
    const payables = supRows.map((r) => {
        const initial = Number(r[2]) || 0;
        const purchAmt = Number(r[4]) || 0;     // Σ采购单
        const saleAmt = Number(r[6]) || 0;      // Σ销售单
        const paid = Number(r[7]) || 0;         // 收支净额
        const preferential = Number(r[8]) || 0;
        const trim = Number(r[9]) || 0;
        const unpaidAmt = Math.round((purchAmt - saleAmt) * 100) / 100; // ★ 双向净额
        const balance = Math.round((initial + unpaidAmt - paid - preferential + trim) * 100) / 100;
        return {
            party_id: Number(r[1]), name: String(r[0] || ''),
            initial_balance: Math.round(initial * 100) / 100,
            unpaid_orders: Number(r[3]) || 0, unpaid_amount: unpaidAmt,
            paid: Math.round(paid * 100) / 100,
            preferential: Math.round(preferential * 100) / 100,
            trim: Math.round(trim * 100) / 100,
            balance,
        };
    }).filter((x) => !SANKE_NAMES.includes(x.name))
      /* ★★★ 2026-10-10 同应收侧口径修正：只保留余额非零的供应商（旧口径 30 家 →
         实际有欠款 4 家，与智慧记 payables=4 一致）。 */
      .filter((x) => Math.abs(x.balance) > 0.001)
      .sort((a, b) => b.balance - a.balance);
    return {
        receivables,
        payables,
        summary: {
            total_receivable: Math.round(receivables.reduce((s, r) => s + r.balance, 0) * 100) / 100,
            total_payable: Math.round(payables.reduce((s, r) => s + r.balance, 0) * 100) / 100,
            receivable_parties: receivables.length,
            payable_parties: payables.length,
        },
    };
}
/* ★★★ 2026-10-09 欠款可见性：**两轮改动，以第二轮为准**
 *   ① 白天（对齐智慧记）：把 /finance/arap 与两个对账单接口的 finance_view 门去掉，
 *      让"欠款可见"回到脱敏器说明里的既定口径。
 *   ② 当晚（**老板拍板 2-C，本版生效**）：老板真机反馈「子账户看到欠款代收/欠款待付，
 *      这个不是子账户的权限」⇒ **老板口径优先于对标**，欠款可见性收为独立权限位
 *      `debt_view`，由管理员在「员工管理 → 资金管理 → 欠款查看」按账号授予。
 *      · /finance/arap 与应收应付页：需 debt_view
 *      · 首页 /analysis/dashboard 的两块欠款 KPI：需 debt_view（未授权时字段**不返回**）
 *      · **两个对账单接口（customer/supplier-statement）不挂此门**：
 *        老板要求子账户能点开客户往来详情，对账单是它的数据源；
 *        且这里的金额是"这个客户欠多少"的单据流水，不是全店欠款汇总。
 *   ⚠️ 成本 / 利润仍由全局出口脱敏器统一保护，本改动不影响。
 *   ⚠️ 「能不能收款/付款」仍由页面按钮与 income / expense 权限决定，与"能不能看"是两件事。
 */
app.get('/api/finance/arap', authMiddleware, hasPerm('debt_view'), async (_req, res) => {
    res.json(await computeArap());
});
/* 客户对账单：期初 + 销售单 + 收款流水明细（口径与 /finance/arap 完全一致：按现名归集）
 *
 * ★ 2026-10-09 新增可选区间 from / to（老板反馈「对账单不能选择时间」，智慧记可自选期间）
 *   · **不传 ⇒ 行为与改造前逐字段一致**（期初 = 档案期初；明细全量）—— 向后兼容
 *   · 传了 ⇒ 明细只给 [from, to] 内的，且**期初按区间开始日结转**：
 *          区间期初 = 档案期初 + Σ(归期 < from 的销售) − Σ(归期 < from 的收款)
 *     ★ 这一步不能省：只过滤明细而不动期初，会把「区间外的回款」算进本期，
 *       金额直接算错，而且是**看起来对的错**（数字是具体数、不是 0，最容易被信）。
 *   · 归期一律 substr(COALESCE(bill_date, created_at),1,10)，与 /store/customer-last-prices 同源。
 *   · 响应新增 `date`（每行的归期）与 `range` / `archived_initial_balance`，旧字段全部保留。
 */
app.get('/api/finance/customer-statement/:id', authMiddleware, async (req, res) => {
    await initDB();
    const cid = Number(req.params.id);
    const cust = (await safeExec("SELECT name FROM customers WHERE id = ?", [cid])).values?.[0];
    if (!cust) return res.status(404).json({ error: '客户不存在' });
    // 传进来的是档案 id，但单据/流水只落了名称 ⇒ 先归一到「现名」，再把同单位多档案的期初合并
    const cnm = canonName(cust[0]);
    const initRow = (await safeExec(`SELECT COALESCE(SUM(initial_balance),0) FROM customers WHERE status=1 AND ${canonSQL('name')} = ?`, [cnm])).values?.[0];
    const archInit = Number(initRow?.[0]) || 0;
    const from = req.query.from ? String(req.query.from).slice(0, 10) : '';
    const to = req.query.to ? String(req.query.to).slice(0, 10) : '';
    /* 单据 + 商品明细一次取全（LEFT JOIN）：前端打印模板会按 o.items 逐行渲染，
     * 未挂明细的历史单据 items 为空数组，不影响单据行本身。 */
    const stmtRows = (await safeExec(`SELECT so.id, so.order_number, so.created_at, so.final_amount, so.payment_status,
        oi.product_name, oi.quantity, oi.unit_price, oi.amount,
        substr(COALESCE(so.bill_date, so.created_at),1,10) AS d
        FROM sales_orders so
        LEFT JOIN sales_order_items oi ON oi.order_id = so.id
        WHERE ${canonSQL('so.customer_name')} = ? AND COALESCE(so.payment_status,'') <> '作废'
        ORDER BY so.id, oi.id`, [cnm])).values || [];
    const orderMap = new Map();
    for (const r of stmtRows) {
        const oid = Number(r[0]);
        if (!orderMap.has(oid))
            orderMap.set(oid, {
                order_number: r[1], created_at: r[2],
                date: r[9] || String(r[2] || '').slice(0, 10),
                amount: Number(r[3]), status: r[4], items: [],
            });
        if (r[5] !== null && r[5] !== undefined) {
            orderMap.get(oid).items.push({ product_name: r[5], quantity: Number(r[6]) || 0, unit_price: Number(r[7]) || 0, amount: Number(r[8]) || 0 });
        }
    }
    const payRows = (await safeExec(`SELECT created_at, amount, description FROM transactions WHERE type='income' AND ${canonSQL('party_name')} = ? ORDER BY id`, [cnm])).values || [];
    const paymentsAll = payRows.map((p) => ({ created_at: p[0], date: String(p[0] || '').slice(0, 10), amount: Number(p[1]), description: p[2] }));
    const ordersAll = [...orderMap.values()];
    /* 区间切分：未传区间时全部通过（= 旧行为） */
    const inRange = (d) => (!from || (d && d >= from)) && (!to || (d && d <= to));
    const ranged = !!(from || to);
    const orders = ranged ? ordersAll.filter((o) => inRange(o.date)) : ordersAll;
    const payments = ranged ? paymentsAll.filter((p) => inRange(p.date)) : paymentsAll;
    /* 区间期初 = 档案期初 + 区间开始日之前的销售 − 区间开始日之前的收款 */
    let carried = archInit;
    if (from) {
        for (const o of ordersAll) if (o.date && o.date < from) carried += Number(o.amount) || 0;
        for (const p of paymentsAll) if (p.date && p.date < from) carried -= Number(p.amount) || 0;
    }
    res.json({
        name: cnm,
        initial_balance: Math.round(carried * 100) / 100,
        archived_initial_balance: archInit,
        range: { from: from || null, to: to || null },
        orders,
        payments,
    });
});
/* 供应商对账单：期初 + 进货单 + 付款流水明细（口径同上，含同一套 from/to 区间与期初结转） */
app.get('/api/finance/supplier-statement/:id', authMiddleware, async (req, res) => {
    await initDB();
    const sid = Number(req.params.id);
    const sup = (await safeExec("SELECT name FROM suppliers WHERE id = ?", [sid])).values?.[0];
    if (!sup) return res.status(404).json({ error: '供应商不存在' });
    const snm = canonName(sup[0]);
    const initRow = (await safeExec(`SELECT COALESCE(SUM(initial_balance),0) FROM suppliers WHERE status=1 AND ${canonSQL('name')} = ?`, [snm])).values?.[0];
    const archInit = Number(initRow?.[0]) || 0;
    const from = req.query.from ? String(req.query.from).slice(0, 10) : '';
    const to = req.query.to ? String(req.query.to).slice(0, 10) : '';
    /* 同客户对账单：单据 + 商品明细一次取全（LEFT JOIN），未挂明细的历史单据 items 为空数组 */
    const stmtRows = (await safeExec(`SELECT po.id, po.order_number, po.created_at, po.total_amount, po.payment_status,
        oi.product_name, oi.quantity, oi.unit_price, oi.amount,
        substr(COALESCE(po.bill_date, po.created_at),1,10) AS d
        FROM purchase_orders po
        LEFT JOIN purchase_order_items oi ON oi.order_id = po.id
        WHERE ${canonSQL('po.supplier_name')} = ? AND COALESCE(po.payment_status,'') <> '作废' AND COALESCE(po.status,'completed') NOT IN ('cancelled','void')
        ORDER BY po.id, oi.id`, [snm])).values || [];
    const orderMap = new Map();
    for (const r of stmtRows) {
        const oid = Number(r[0]);
        if (!orderMap.has(oid))
            orderMap.set(oid, {
                order_number: r[1], created_at: r[2],
                date: r[9] || String(r[2] || '').slice(0, 10),
                amount: Number(r[3]), status: r[4], items: [],
            });
        if (r[5] !== null && r[5] !== undefined) {
            orderMap.get(oid).items.push({ product_name: r[5], quantity: Number(r[6]) || 0, unit_price: Number(r[7]) || 0, amount: Number(r[8]) || 0 });
        }
    }
    const payRows = (await safeExec(`SELECT created_at, amount, description FROM transactions WHERE type='expense' AND ${canonSQL('party_name')} = ? ORDER BY id`, [snm])).values || [];
    const paymentsAll = payRows.map((p) => ({ created_at: p[0], date: String(p[0] || '').slice(0, 10), amount: Number(p[1]), description: p[2] }));
    const ordersAll = [...orderMap.values()];
    const inRange = (d) => (!from || (d && d >= from)) && (!to || (d && d <= to));
    const ranged = !!(from || to);
    const orders = ranged ? ordersAll.filter((o) => inRange(o.date)) : ordersAll;
    const payments = ranged ? paymentsAll.filter((p) => inRange(p.date)) : paymentsAll;
    let carried = archInit;
    if (from) {
        for (const o of ordersAll) if (o.date && o.date < from) carried += Number(o.amount) || 0;
        for (const p of paymentsAll) if (p.date && p.date < from) carried -= Number(p.amount) || 0;
    }
    res.json({
        name: snm,
        initial_balance: Math.round(carried * 100) / 100,
        archived_initial_balance: archInit,
        range: { from: from || null, to: to || null },
        orders,
        payments,
    });
});
// ==================== 销售预订 ====================
app.get('/api/store/reservations', authMiddleware, hasPerm('sales'), async (_req, res) => {
    await initDB();
    const isAdminUser = _req.user.role === 'admin' || _req.user.role === 'manager';
    const scopeSql = ''; // 全店可见
    const result = await safeExec(`SELECT * FROM sales_reservations${scopeSql} ORDER BY id DESC LIMIT 100`);
    const list = (result.values || []).map((r) => ({
        id: r[0], reservation_number: r[1], customer_id: Number(r[2]) || null, customer_name: r[3],
        total_amount: Number(r[4]), status: r[5], remark: r[6], operator_id: r[7], operator_name: r[8], created_at: r[9]
    }));
    res.json(list);
});
app.post('/api/store/reservations', authMiddleware, hasPerm('sales'), idem('reservations'), async (req, res) => {
    await initDB();
    let { customer_id, customer_name, items, remark } = req.body;
    if (!customer_id && customer_name) {
        const cidRes = await safeExec("SELECT id FROM customers WHERE name = ? ORDER BY id LIMIT 1", [customer_name]);
        if (cidRes.values?.[0]?.[0]) customer_id = cidRes.values[0][0];
    }
    if (!items || !items.length) return res.status(400).json({ error: '请添加预订商品' });
    const rn = await generateOrderNumber('YD');
    let totalAmount = 0;
    for (const it of items) totalAmount += (it.quantity || 0) * (it.price || 0);
    const rid = await runLastId("INSERT INTO sales_reservations (reservation_number, customer_id, customer_name, total_amount, status, remark, operator_id, operator_name) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)",
        [rn, customer_id || null, customer_name || null, totalAmount, remark || '', req.user.id, req.user.real_name]);
    if (items && rid) {
        for (const it of items) {
            await run("INSERT INTO sales_reservation_items (reservation_id, product_id, product_name, sku, quantity, unit_price, amount) VALUES (?, ?, ?, ?, ?, ?, ?)",
                [rid, it.product_id || null, it.product_name, it.sku || '', it.quantity, it.price || 0, (it.quantity || 0) * (it.price || 0)]);
        }
    }
    saveDB(); saveDB();
    res.json({ ok: true, reservation_number: rn });
});
// 预订出库：生成销售单并扣库存，状态置 done
app.post('/api/store/reservations/:id/complete', authMiddleware, hasPerm('sales'), async (req, res) => {
    await initDB();
    const id = Number(req.params.id);
    const r = (await safeExec("SELECT * FROM sales_reservations WHERE id = ?", [id])).values?.[0];
    if (!r) return res.status(404).json({ error: '预订不存在' });
    if (r[5] !== 'pending') return res.status(400).json({ error: '仅待处理预订可出库' });
    const items = (await safeExec("SELECT * FROM sales_reservation_items WHERE reservation_id = ?", [id])).values || [];
    // ★ 预扫（2026-10-03）：先把明细商品全部解析成 product_id（sales_order_items.product_id 为 NOT NULL），
    //   任一解析失败即**在写库之前**返回，绝不留下「主单进了、明细没进」的半截数据。
    const resolved = [];
    for (const it of items) {
        const pid = await resolveProductIdForOrder(it[2], it[3]);
        if (!pid) return res.status(400).json({ error: `出库失败：明细商品「${it[3]}」在商品档案中不存在（明细必须能解析到商品），本次未写入任何数据` });
        resolved.push({ pid, name: it[3], sku: it[4] || '', qty: Number(it[5]) || 0, price: Number(it[6]) || 0, amount: Number(it[7]) || 0 });
    }
    const orderNumber = await generateOrderNumber('XS');
    const finalAmount = Number(r[4]) || 0;
    // ★ 修复（2026-10-03）：原先只写 final_amount，漏 receivable_amount/received_amount/owe_amount/
    //   payment_status/bill_date（列默认 0）⇒ 生成「金额≠0 但应收=0」的不自洽单。现与手工开单共用 salesOrderMoney()。
    const M = salesOrderMoney(finalAmount, undefined, null);
    let commissionAmount = 0;
    try {
        const cr = (await safeExec("SELECT COALESCE(commission_rate,0) FROM users WHERE id = ?", [req.user.id])).values?.[0]?.[0];
        commissionAmount = Math.round((Number(cr) || 0) * finalAmount) / 100;
    } catch (e) { commissionAmount = 0; }
    const orderId = await runLastId("INSERT INTO sales_orders (order_number, customer_id, customer_name, total_amount, discount, final_amount, payment_method, operator_id, operator_name, commission_amount, payment_status, bill_date, receivable_amount, received_amount, owe_amount, small_change_amount, express_amount, tax_amount, remark, biz_type) VALUES (?, ?, ?, ?, 0, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, '', 'sale')",
        [orderNumber, r[2], r[3], finalAmount, finalAmount, req.user.id, req.user.real_name, commissionAmount, M.payment_status, M.bill_date, M.receivable_amount, M.received_amount, M.owe_amount]);
    for (const it of resolved) {
        await run("INSERT INTO sales_order_items (order_id, product_id, product_name, sku, quantity, unit_price, amount) VALUES (?, ?, ?, ?, ?, ?, ?)",
            [orderId, it.pid, it.name, it.sku, it.qty, it.price, it.amount]);
        if (it.pid) await run("UPDATE products SET stock_quantity = stock_quantity - ? WHERE id = ?", [it.qty, it.pid]);
    }
    await run("UPDATE sales_reservations SET status = 'done' WHERE id = ?", [id]);
    saveDB(); saveDB();
    res.json({ ok: true, order_number: orderNumber });
});
// 取消预订
app.post('/api/store/reservations/:id/cancel', authMiddleware, hasPerm('sales'), async (req, res) => {
    await initDB();
    const id = Number(req.params.id);
    await run("UPDATE sales_reservations SET status = 'cancelled' WHERE id = ?", [id]);
    saveDB(); saveDB();
    res.json({ ok: true });
});
// ==================== 进货退货 ====================
app.get('/api/store/purchase-returns', authMiddleware, hasPerm('purchase'), async (_req, res) => {
    await initDB();
    const result = await safeExec("SELECT * FROM purchase_returns ORDER BY id DESC LIMIT 100");
    const list = (result.values || []).map((r) => ({
        id: r[0], return_number: r[1], purchase_order_id: Number(r[2]) || null, supplier_id: Number(r[3]) || null,
        supplier_name: r[4], total_amount: Number(r[5]), reason: r[6], operator_id: r[7], operator_name: r[8], created_at: r[9]
    }));
    res.json(list);
});
// 进货退货：purchase_order_id 可选，直接按商品退，冲减库存
app.post('/api/store/purchase-returns', authMiddleware, hasPerm('purchase'), idem('purchase-returns'), async (req, res) => {
    await initDB();
    const { purchase_order_id, supplier_id, supplier_name, items, reason } = req.body;
    if (!items || !items.length) return res.status(400).json({ error: '请添加退货商品' });
    const rn = await generateOrderNumber('TH');
    let totalAmount = 0;
    for (const it of items) totalAmount += (it.quantity || 0) * (it.price || 0);
    const rid = await runLastId("INSERT INTO purchase_returns (return_number, purchase_order_id, supplier_id, supplier_name, total_amount, reason, operator_id, operator_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [rn, purchase_order_id || null, supplier_id || null, supplier_name || null, totalAmount, reason || '', req.user.id, req.user.real_name]);
    if (items && rid) {
        for (const it of items) {
            await run("INSERT INTO purchase_return_items (return_id, product_id, product_name, quantity, unit_price, amount) VALUES (?, ?, ?, ?, ?, ?)",
                [rid, it.product_id || null, it.product_name, it.quantity, it.price || 0, (it.quantity || 0) * (it.price || 0)]);
            if (it.product_id) await run("UPDATE products SET stock_quantity = stock_quantity - ? WHERE id = ?", [it.quantity, it.product_id]);
        }
    }
    saveDB(); saveDB();
    res.json({ ok: true, return_number: rn });
});
// ==================== 报价单 ====================
app.get('/api/store/quotes', authMiddleware, hasPerm('sales'), async (_req, res) => {
    await initDB();
    const isAdminUser = _req.user.role === 'admin' || _req.user.role === 'manager';
    const scopeSql = ''; // 全店可见
    const result = await safeExec(`SELECT * FROM quotes${scopeSql} ORDER BY id DESC LIMIT 100`);
    const list = (result.values || []).map((r) => ({
        id: r[0], quote_number: r[1], customer_id: Number(r[2]) || null, customer_name: r[3],
        total_amount: Number(r[4]), status: r[5], remark: r[6], operator_id: r[7], operator_name: r[8], created_at: r[9]
    }));
    res.json(list);
});
app.post('/api/store/quotes', authMiddleware, hasPerm('sales'), idem('quotes'), async (req, res) => {
    await initDB();
    let { customer_id, customer_name, items, remark } = req.body;
    if (!customer_id && customer_name) {
        const cidRes = await safeExec("SELECT id FROM customers WHERE name = ? ORDER BY id LIMIT 1", [customer_name]);
        if (cidRes.values?.[0]?.[0]) customer_id = cidRes.values[0][0];
    }
    if (!items || !items.length) return res.status(400).json({ error: '请添加报价商品' });
    const qn = await generateOrderNumber('BJ');
    let totalAmount = 0;
    for (const it of items) totalAmount += (it.quantity || 0) * (it.price || 0);
    const qid = await runLastId("INSERT INTO quotes (quote_number, customer_id, customer_name, total_amount, status, remark, operator_id, operator_name) VALUES (?, ?, ?, ?, 'draft', ?, ?, ?)",
        [qn, customer_id || null, customer_name || null, totalAmount, remark || '', req.user.id, req.user.real_name]);
    if (items && qid) {
        for (const it of items) {
            await run("INSERT INTO quote_items (quote_id, product_id, product_name, sku, quantity, unit_price, amount) VALUES (?, ?, ?, ?, ?, ?, ?)",
                [qid, it.product_id || null, it.product_name, it.sku || '', it.quantity, it.price || 0, (it.quantity || 0) * (it.price || 0)]);
        }
    }
    saveDB(); saveDB();
    res.json({ ok: true, quote_number: qn });
});
// 报价单转销售单（状态置 sent）
app.post('/api/store/quotes/:id/convert', authMiddleware, hasPerm('sales'), async (req, res) => {
    await initDB();
    const id = Number(req.params.id);
    const q = (await safeExec("SELECT * FROM quotes WHERE id = ?", [id])).values?.[0];
    if (!q) return res.status(404).json({ error: '报价单不存在' });
    const items = (await safeExec("SELECT * FROM quote_items WHERE quote_id = ?", [id])).values || [];
    // ★ 预扫（2026-10-03）：先把明细商品全部解析成 product_id（sales_order_items.product_id 为 NOT NULL），
    //   任一解析失败即**在写库之前**返回，绝不留下「主单进了、明细没进」的半截数据。
    const resolved = [];
    for (const it of items) {
        const pid = await resolveProductIdForOrder(it[2], it[3]);
        if (!pid) return res.status(400).json({ error: `转单失败：明细商品「${it[3]}」在商品档案中不存在（明细必须能解析到商品），本次未写入任何数据` });
        resolved.push({ pid, name: it[3], sku: it[4] || '', qty: Number(it[5]) || 0, price: Number(it[6]) || 0, amount: Number(it[7]) || 0 });
    }
    const orderNumber = await generateOrderNumber('XS');
    const finalAmount = Number(q[4]) || 0;
    // ★ 修复（2026-10-03）：原先只写 final_amount，漏 receivable_amount/received_amount/owe_amount/
    //   payment_status/bill_date（列默认 0）⇒ 生成「金额≠0 但应收=0」的不自洽单。现与手工开单共用 salesOrderMoney()。
    const M = salesOrderMoney(finalAmount, undefined, null);
    let commissionAmount = 0;
    try {
        const cr = (await safeExec("SELECT COALESCE(commission_rate,0) FROM users WHERE id = ?", [req.user.id])).values?.[0]?.[0];
        commissionAmount = Math.round((Number(cr) || 0) * finalAmount) / 100;
    } catch (e) { commissionAmount = 0; }
    const orderId = await runLastId("INSERT INTO sales_orders (order_number, customer_id, customer_name, total_amount, discount, final_amount, payment_method, operator_id, operator_name, commission_amount, payment_status, bill_date, receivable_amount, received_amount, owe_amount, small_change_amount, express_amount, tax_amount, remark, biz_type) VALUES (?, ?, ?, ?, 0, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, '', 'sale')",
        [orderNumber, q[2], q[3], finalAmount, finalAmount, req.user.id, req.user.real_name, commissionAmount, M.payment_status, M.bill_date, M.receivable_amount, M.received_amount, M.owe_amount]);
    for (const it of resolved) {
        await run("INSERT INTO sales_order_items (order_id, product_id, product_name, sku, quantity, unit_price, amount) VALUES (?, ?, ?, ?, ?, ?, ?)",
            [orderId, it.pid, it.name, it.sku, it.qty, it.price, it.amount]);
        if (it.pid) await run("UPDATE products SET stock_quantity = stock_quantity - ? WHERE id = ?", [it.qty, it.pid]);
    }
    await run("UPDATE quotes SET status = 'sent' WHERE id = ?", [id]);
    saveDB(); saveDB();
    res.json({ ok: true, order_number: orderNumber });
});
// ==================== 规格 / 单位字典 ====================
app.get('/api/inventory/specs', authMiddleware, hasPerm('inventory_view'), async (_req, res) => {
    await initDB();
    const result = await safeExec("SELECT * FROM product_specs ORDER BY id");
    res.json((result.values || []).map((r) => ({ id: r[0], name: r[1], remark: r[2] })));
});
app.post('/api/inventory/specs', authMiddleware, hasPerm('inventory_full'), async (req, res) => {
    await initDB();
    const { name, remark } = req.body;
    if (!name) return res.status(400).json({ error: '规格名称必填' });
    await run("INSERT INTO product_specs (name, remark) VALUES (?, ?)", [name, remark || '']);
    saveDB(); saveDB();
    res.json({ ok: true });
});
app.delete('/api/inventory/specs/:id', authMiddleware, hasPerm('inventory_full'), async (req, res) => {
    await initDB();
    await run("DELETE FROM product_specs WHERE id = ?", [Number(req.params.id)]);
    saveDB(); saveDB();
    res.json({ ok: true });
});
app.get('/api/inventory/units', authMiddleware, hasPerm('inventory_view'), async (_req, res) => {
    await initDB();
    const result = await safeExec("SELECT * FROM units ORDER BY id");
    res.json((result.values || []).map((r) => ({ id: r[0], name: r[1], remark: r[2] })));
});
app.post('/api/inventory/units', authMiddleware, hasPerm('inventory_full'), async (req, res) => {
    await initDB();
    const { name, remark } = req.body;
    if (!name) return res.status(400).json({ error: '单位名称必填' });
    await run("INSERT INTO units (name, remark) VALUES (?, ?)", [name, remark || '']);
    saveDB(); saveDB();
    res.json({ ok: true });
});
app.delete('/api/inventory/units/:id', authMiddleware, hasPerm('inventory_full'), async (req, res) => {
    await initDB();
    await run("DELETE FROM units WHERE id = ?", [Number(req.params.id)]);
    saveDB(); saveDB();
    res.json({ ok: true });
});
// ==================== 资金流水汇总 ====================
app.get('/api/finance/summary', authMiddleware, hasPerm('finance_view'), async (req, res) => {
    await initDB();
    const days = Number(req.query.days || 30);
    // P4：近 N 天起始日改走北京口径
    const start = bjDaysAgo(days);
    const rows = (await safeExec(`SELECT to_char(date(created_at), 'YYYY-MM-DD') d, type, COALESCE(SUM(amount),0) FROM transactions WHERE date(created_at) >= '${start}' AND type IN ('income','expense') GROUP BY date(created_at), type ORDER BY d`)).values || [];
    const byDate = {};
    for (const r of rows) {
        const d = String(r[0]);
        if (!byDate[d]) byDate[d] = { date: d, income: 0, expense: 0 };
        if (r[1] === 'income') byDate[d].income = Number(r[2]);
        else byDate[d].expense = Number(r[2]);
    }
    const catRows = (await safeExec(`SELECT type, COALESCE(NULLIF(category,''),'未分类') AS cat_name, COALESCE(SUM(amount),0) AS cat_amount FROM transactions WHERE date(created_at) >= '${start}' AND type IN ('income','expense') GROUP BY type, category ORDER BY 3 DESC`)).values || [];
    const byCat = { income: [], expense: [] };
    for (const r of catRows) {
        if (r[0] === 'income') byCat.income.push({ category: r[1], amount: Number(r[2]) });
        else byCat.expense.push({ category: r[1], amount: Number(r[2]) });
    }
    res.json({ by_date: Object.values(byDate), by_category: byCat, days });
});
/* ==================== 智慧记统计报表镜像（2026-10-14） ====================
 * 老板指令：「把智慧记的初始数据到现在的数据都统计过来」。
 *
 * 背景：宏瑞此前只有**单据 + 主数据**，没有智慧记的**统计报表**。这些报表的接口
 *   路径无文档、按命名规律猜 45 个全 404，只能用带调试端口的浏览器逐页录流量拿到
 *   （见 _governance/zhj-capture-reports.cjs），再由 _governance/zhj-fetch-reports.cjs
 *   按「2023-10-14 → 今天」的全时段拉全、_governance/import-zhj-reports.py 落库。
 *
 * 数据源（纯新增表，不碰任何既有表）：
 *   · zhj_stock_stat —— 库存统计：init_qty/init_amt（期初）→ in_*（入库）
 *                       → out_*（出库）→ last_qty/last_amt（期末），172 个 SKU
 *                       恒等式自证：期初 + 入 − 出 = 期末（实测差 0.00）
 *   · zhj_report_kv  —— 其他报表（经营利润汇总/销售统计/采购统计/热销/员工/仓库…），
 *                       一行一报表存 JSONB，「先存原样、再按需展开」
 *
 * 口径提醒（避免误判成本页）：库存统计的 last_qty 合计 9,120.11，
 *   而商品档案的 sum_stock 合计 11,708.18 —— **两者都是智慧记自己的口径**，
 *   报表是「进销存推导」、档案是「当前库存」。宏瑞 products.stock_quantity 对齐的是
 *   档案口径（已 0 差异），本接口提供的是报表口径，两者用途不同，不可互相校验。
 * ==================================================================== */
app.get('/api/reports/zhj/stock-stat', authMiddleware, hasPerm('sales_stats'), async (req, res) => {
    await initDB();
    const kw = String(req.query.keyword || '').trim();
    const page = Math.max(1, Number(req.query.page) || 1);
    const ps = Math.min(500, Math.max(1, Number(req.query.page_size) || 50));
    const where = kw ? " WHERE product_name ILIKE '%'||?||'%' OR COALESCE(sku_number,'') ILIKE '%'||?||'%'" : '';
    const params = kw ? [kw, kw] : [];
    const [aggR, listR] = await Promise.all([
        safeExec(`SELECT count(*) AS n,
            COALESCE(SUM(init_qty),0) AS init_qty, COALESCE(SUM(init_amt),0) AS init_amt,
            COALESCE(SUM(in_qty),0) AS in_qty, COALESCE(SUM(in_amt),0) AS in_amt,
            COALESCE(SUM(out_qty),0) AS out_qty, COALESCE(SUM(out_amt),0) AS out_amt,
            COALESCE(SUM(last_qty),0) AS last_qty, COALESCE(SUM(last_amt),0) AS last_amt
            FROM zhj_stock_stat${where}`, params),
        safeExec(`SELECT product_id, product_name, product_spec, sku_number, type_name, unit_name,
            init_qty, init_amt, in_qty, in_amt, out_qty, out_amt, last_qty, last_amt, window_start, window_end
            FROM zhj_stock_stat${where} ORDER BY last_amt DESC NULLS LAST, product_name
            LIMIT ${ps} OFFSET ${(page - 1) * ps}`, params),
    ]);
    const a = (aggR.values && aggR.values[0]) || [];
    const n = (x) => Math.round(Number(x || 0) * 100) / 100;
    const cols = ['n', 'init_qty', 'init_amt', 'in_qty', 'in_amt', 'out_qty', 'out_amt', 'last_qty', 'last_amt'];
    const summary = {};
    cols.forEach((c, i) => { summary[c] = n(a[i]); });
    summary.rows = Number(a[0] || 0);
    summary.identity_diff = n((Number(a[1] || 0) + Number(a[3] || 0) - Number(a[5] || 0)) - Number(a[7] || 0));
    const COLS = ['product_id', 'product_name', 'product_spec', 'sku_number', 'type_name', 'unit_name',
        'init_qty', 'init_amt', 'in_qty', 'in_amt', 'out_qty', 'out_amt', 'last_qty', 'last_amt',
        'window_start', 'window_end'];
    const list = (listR.values || []).map((r) => {
        const o = {};
        COLS.forEach((c, i) => { o[c] = r[i]; });
        return o;
    });
    res.json({
        summary, list, page, page_size: ps, total: summary.rows,
        window: { start: list[0] && list[0].window_start, end: list[0] && list[0].window_end },
        note: '口径＝智慧记「库存统计」报表（进销存推导）；与商品档案的 sum_stock 是两套口径，勿互相校验',
    });
});

app.get('/api/reports/zhj/summary', authMiddleware, hasPerm('sales_stats'), async (_req, res) => {
    await initDB();
    const r = await safeExec("SELECT report_key, descr, rows, payload, captured_at FROM zhj_report_kv ORDER BY report_key");
    const out = {};
    let capturedAt = null;
    for (const row of (r.values || [])) {
        const key = String(row[0]);
        let payload = row[3];
        if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch { /* 保留原样 */ } }
        out[key] = { desc: row[1], rows: Number(row[2] || 0), payload };
        capturedAt = capturedAt || row[4];
    }
    /* 经营利润：直接取智慧记官方报表的累计值（全时段），供页面与宏瑞自算值并列展示 */
    const profit = (out.profit && Array.isArray(out.profit.payload) && out.profit.payload[0]) || null;
    const stockAgg = await safeExec(`SELECT COALESCE(SUM(init_qty),0), COALESCE(SUM(init_amt),0),
        COALESCE(SUM(in_qty),0), COALESCE(SUM(in_amt),0), COALESCE(SUM(out_qty),0), COALESCE(SUM(out_amt),0),
        COALESCE(SUM(last_qty),0), COALESCE(SUM(last_amt),0) FROM zhj_stock_stat`);
    const sa = (stockAgg.values && stockAgg.values[0]) || [];
    res.json({
        captured_at: capturedAt,
        reports: Object.fromEntries(Object.entries(out).map(([k, v]) => [k, { desc: v.desc, rows: v.rows }])),
        profit: profit ? {
            sum_in: Number(profit.sum_in || 0), sum_out: Number(profit.sum_out || 0),
            sum_profit: Number(profit.sum_profit || 0), sum_profit_v2: Number(profit.sum_profit_v2 || 0),
            sale_in: Number(profit.sale_in || 0), sale_out: Number(profit.sale_out || 0),
            sale_return_out: Number(profit.sale_return_out || 0),
            receipt_preferential_out: Number(profit.receipt_preferential_out || 0),
            payment_preferential_in: Number(profit.payment_preferential_in || 0),
            other_out: Number(profit.other_out || 0), pur_return_in: Number(profit.pur_return_in || 0),
        } : null,
        stock: {
            init_qty: Number(sa[0] || 0), init_amt: Number(sa[1] || 0),
            in_qty: Number(sa[2] || 0), in_amt: Number(sa[3] || 0),
            out_qty: Number(sa[4] || 0), out_amt: Number(sa[5] || 0),
            last_qty: Number(sa[6] || 0), last_amt: Number(sa[7] || 0),
        },
        note: '来源＝智慧记官方统计报表（全时段 2023-10-14 → 今天）；这是「初始到现在」的权威口径',
    });
});

// 静态资源（dist 下的 assets/favicon 等；SPA 路由交给 catch-all）
// 仅当 dist 目录存在时启用（纯 API 部署无 dist，避免每次启动 stat 报 ENOENT）
const hasDist = fs.existsSync(DIST_PATH);
if (hasDist) {
    app.use(express.static(DIST_PATH));
}
// SPA catch-all
app.use((_req, res) => {
    if (hasDist) {
        res.sendFile(path.join(DIST_PATH, 'index.html'));
    } else {
        res.status(404).json({ error: 'Not Found', api: 'ok' });
    }
});
/* ==== GLOBAL-ERR-BEGIN（唯一真源 · 2026-10-11 48h 冲刺 P5-5 / P1-05）====
 * 病灶（隔离后端实测，非推断）：**全 110 条路由**在「畸形 body」下都返回
 *   `HTTP 400 + text/html` 的 Express 默认错误页，正文带**绝对路径 ＋ node_modules 路径
 *   ＋ 完整调用栈**（示例：`at parse (D:\\创新工作区\\…\\body-parser\\lib\\types\\json.js:91:21)`）；
 *   `PUT /auth/password` / `PUT /store/settings` 更进一步：入参缺失 ⇒ 路由内抛错 ⇒ 500 ＋ 同款 HTML。
 *   ⇒ **未鉴权即可拿到内部路径与依赖结构**（连 `/api/health` 都能拿到）。
 * 本中间件做三件事：
 *   ① 错误响应一律 JSON，**不回显任何内部细节**（无 stack / 无路径 / 无 SQL / 无 err.message）；
 *   ② **沿用错误自带的状态码**（400 仍是 400）⇒ 不把 body-parser 的 400 降级成 500；
 *   ③ 真 500 在服务端日志里留唯一出口（带 stack，供运维定位）。
 * ⚠️ 五条硬约束：
 *   ① 必须注册在**所有路由与普通中间件之后**（本处紧邻 `async function start()`，即模块顶层末位）；
 *   ② 必须**保留 4 个形参**，否则 Express 不把它当错误处理器；
 *   ③ **禁止**回显 `err.message`：body-parser 的 `entity.parse.failed` 消息会**回显请求体片段**
 *      （例如把 `{"password":"…"}` 回给客户端）⇒ 那是二次泄漏；
 *   ④ `res.headersSent` 时必须 `next(err)` 交回默认处理器，否则会破坏已开始的响应/连接；
 *   ⑤ 本中间件不参与启动链，与 `initDB()` / `start()` 的调用顺序无关。
 * 回滚：删除本段即可（单文件、无 DB 改动、无契约变更）。
 * ==================================================================== */
const ERR_TEXT_BY_TYPE = {
    'entity.parse.failed': '请求体不是合法 JSON',
    'entity.too.large': '请求体过大',
    'request.aborted': '请求被中断',
    'request.size.invalid': '请求体长度不合法',
    'encoding.unsupported': '不支持的字符集',
};
function errTextOf(status, err) {
    const t = err && err.type;
    if (t && ERR_TEXT_BY_TYPE[t]) return ERR_TEXT_BY_TYPE[t];
    return ({
        400: '请求无效', 401: '未授权', 403: '无权限', 404: '资源不存在',
        405: '请求方法不被允许', 408: '请求超时', 409: '数据冲突',
        413: '请求体过大', 415: '不支持的请求类型', 422: '请求参数无法处理',
        429: '请求过于频繁',
    })[status] || (status >= 500 ? '服务器内部错误' : '请求无效');
}
app.use((err, req, res, next) => {
    const raw = Number((err && (err.httpCode || err.status || err.statusCode)) || 0);
    const status = (raw >= 400 && raw <= 599) ? raw : 500;
    /* 服务端留痕：stack **只进日志，绝不进响应体** */
    console.error('[UNCAUGHT]', status, req.method, req.originalUrl, '-', (err && err.stack) || err);
    if (res.headersSent) return next(err);
    const body = { ok: false, error: errTextOf(status, err) };
    /* 仅「我方显式抛出的域错误」（同时带 httpCode 与 code）才透传文案 —— 它们不含内部细节 */
    if (err && err.httpCode && err.code) {
        body.code = err.code;
        if (typeof err.msg === 'string' && err.msg) body.error = err.msg;
    }
    res.status(status).json(body);
});
/* ==== GLOBAL-ERR-END ==== */

async function start() {
    await initDB();
    /* 进程内 4 分钟自热身：保持数据库连接不被池回收，
     * 也保证 Render 偶发回收后本进程能自愈（不替代外部保活——平台侧休眠只看入站流量）。 */
    setInterval(() => { safeExec('SELECT 1').catch(() => { }); }, 4 * 60 * 1000).unref();
    const server = app.listen(PORT, '0.0.0.0', () => {
        console.log(`HongruiBOSS Backend Server - http://localhost:${PORT}`);
    });
}
/* ==================== 测试钩子（2026-10-11 P2） ====================
 * 目的：让「成本完整性判据」这套逻辑能被单元测试**直接引用同一实现**，
 *   而不是在测试脚本里另抄一份 SQL/判据（P1 学到的教训：测副本 = 什么都没测到）。
 * 影响面：本文件是服务入口，生产环境**无人 import 它**；
 *   这两个 export 对正常运行零影响；`HR_NO_LISTEN=1` 时不起监听，仅供测试。
 * ==================================================================== */
export { costIntegritySql, costIntegrityOut, COST_SIGN_SQL };
export const __costTest = {
    get unitSql() { return COST_UNIT_SQL; },
    get isHistorical() { return COST_UNIT_IS_HISTORICAL; },
    /** 测试用：强制切换成本口径（模拟「生产尚未迁移」与「已迁移」两种库） */
    setMode(on) {
        COST_UNIT_IS_HISTORICAL = !!on;
        COST_UNIT_SQL = on ? `COALESCE(${COST_ITEM_EXPR}, p.cost_price)` : 'p.cost_price';
    },
    rowMissingSql: COST_ROW_MISSING_SQL,
    rowFallbackSql: COST_ROW_FALLBACK_SQL,
    rowHistoricSql: COST_ROW_HISTORIC_SQL,
};
if (process.env.HR_NO_LISTEN !== '1') {
    start().catch(console.error);
}
