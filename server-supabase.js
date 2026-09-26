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
            max: 20, idleTimeoutMillis: 30000, connectionTimeoutMillis: 15000,
        });
        console.log('Supabase Postgres pool initialized');
    }
    return pool;
}
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
    }
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
        ];
        for (const sql of ddl) {
            try { await client.query(sql); } catch (e) { console.log('DDL skip:', e.message); }
        }
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
/** 业务日期（东八区），格式 YYYY-MM-DD —— 与智慧记 bill_date 口径一致 */
function todayCST() {
    return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}
/**
 * 成本符号修正（关键）：智慧记里「红字冲销单」以负数销售单形式存在（实测 348 张），
 * 其单据金额为负、但明细数量与成本仍记正 → 直接 SUM(qty×cost) 会把成本虚增。
 * 同理销售退货单。故成本必须按「单据符号」取反，否则成本率 >100%（实测 105.83%）。
 * 修正后全期间毛利率 = 6.76%（原为 -5.83%）。
 */
const COST_SIGN_SQL = "CASE WHEN so.final_amount < 0 OR COALESCE(so.biz_type,'sale')='sale_return' THEN -1 ELSE 1 END";
function generateOrderNumber(prefix) {
    const now = new Date();
    const date = now.toISOString().slice(0, 10).replace(/-/g, '');
    const rand = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
    return `${prefix}${date}${rand}`;
}
const app = express();
app.use(helmet());
app.use(cors());
app.use(morgan('dev'));
app.use(express.json());
// ==================== 权限体系 ====================
// 细粒度功能权限：管理员/店长默认拥有全部；店员按 permissions 数组控制
const ALL_PERMS = [
    'sales', 'return', 'recycle', 'purchase', 'orders', 'customers', 'suppliers',
    'inventory_view', 'inventory_full', 'income', 'expense', 'finance_view',
    'reconciliation', 'performance', 'sales_stats', 'employees', 'settings',
];
// 新店员默认权限（开单必需的基础功能）
const DEFAULT_EMPLOYEE_PERMS = ['sales', 'return', 'customers', 'income', 'expense', 'performance'];
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

// 过滤敏感数据（根据权限返回 null 或脱敏值）
const filterSensitiveData = (data, user, category, field) => {
    if (isAdminUser(user.role)) return data;
    const sensitivePerms = JSON.parse(user.sensitive_permissions || '{}');
    if (sensitivePerms[category]?.includes(field)) return data;
    return null;
};

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
        await initDB();
        const result = await safeExec(`SELECT * FROM users WHERE username = '${username.replace(/'/g, "''")}'`);
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
        const permissions = user[10] || '[]';
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
app.get('/api/inventory/products', authMiddleware, hasPerm('inventory_view'), async (req, res) => {
    await initDB();
    const { category, keyword, page = 1, pageSize = 50, withTotal } = req.query;
    let where = " WHERE status = 1";
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
        const totalRow = (await safeExec("SELECT COUNT(*) FROM products" + where)).values?.[0]?.[0];
        return res.json({ rows: products, total: Number(totalRow || 0), page: pg, pageSize: ps });
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
    const endDate = new Date(Date.now() + (Number(days) || 30) * 86400000).toISOString().slice(0, 10);
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
    await run("UPDATE products SET sku=?, name=?, category=?, spec=?, unit=?, cost_price=?, sell_price=?, stock_quantity=?, warning_quantity=?, batch_number=?, production_date=?, expiry_date=?, supplier_id=?, wholesale_price=?, updated_at=datetime('now','localtime') WHERE id=?", [sku, name, category, spec, unit, cost_price, sell_price, stock_quantity, warning_quantity, batch_number, production_date, expiry_date, supplier_id, wholesale_price || 0, id]);
    saveDB();
    saveDB();
    res.json({ ok: true });
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
app.post('/api/inventory/checks', authMiddleware, adminOnly, async (req, res) => {
    await initDB();
    const checkNumber = generateOrderNumber('PD');
    await run("INSERT INTO inventory_checks (check_number, operator_id) VALUES (?, ?)", [checkNumber, req.user.id]);
    // 获取刚插入的盘点单 ID（SQLite: last_insert_rowid，PG 端 translateSQL 自动转 lastval）
    const checkId = (await safeExec("SELECT last_insert_rowid()")).values?.[0]?.[0];
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
    const diff = actual_quantity - req.body.system_quantity || 0;
    await run("UPDATE inventory_check_items SET actual_quantity=?, difference=?, remark=? WHERE check_id=? AND product_id=?", [actual_quantity, diff, remark, checkId, product_id]);
    saveDB();
    saveDB();
    res.json({ ok: true });
});
app.put('/api/inventory/checks/:id/complete', authMiddleware, adminOnly, async (req, res) => {
    await initDB();
    const { id } = req.params;
    // Update product stock based on check items
    const items = await safeExec("SELECT product_id, actual_quantity FROM inventory_check_items WHERE check_id = ?", [id]);
    if (items.values) {
        for (const item of items.values) {
            await run("UPDATE products SET stock_quantity = ?, updated_at=datetime('now','localtime') WHERE id = ?", [item[1], item[0]]);
        }
    }
    await run("UPDATE inventory_checks SET status='completed', completed_at=datetime('now','localtime') WHERE id=?", [id]);
    saveDB();
    saveDB();
    res.json({ ok: true });
});
// Assembly and Split
app.post('/api/inventory/assemblies', authMiddleware, adminOnly, async (req, res) => {
    await initDB();
    const { items, operator_id } = req.body;
    // TODO: implement assembly logic
    saveDB();
    res.json({ ok: true });
});
app.post('/api/inventory/splits', authMiddleware, adminOnly, async (req, res) => {
    await initDB();
    const { items, operator_id } = req.body;
    // TODO: implement split logic
    saveDB();
    res.json({ ok: true });
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
app.post('/api/finance/accounts', authMiddleware, adminOnly, async (req, res) => {
    await initDB();
    const { name, type, balance } = req.body;
    await run("INSERT INTO accounts (name, type, balance) VALUES (?, ?, ?)", [name, type || 'cash', balance || 0]);
    saveDB();
    saveDB();
    res.json({ ok: true });
});
app.post('/api/finance/transactions/income', authMiddleware, hasPerm('income'), async (req, res) => {
    await initDB();
    const { account_id, amount, category, description, customer_id, customer_name } = req.body;
    // 客户收款：记录往来对象，冲减该客户欠款
    let pid = customer_id || null, pname = customer_name || null, ptype = null;
    if (!pid && pname) {
        const r = await safeExec("SELECT id FROM customers WHERE name = ? ORDER BY id LIMIT 1", [pname]);
        if (r.values?.[0]?.[0]) pid = r.values[0][0];
    }
    if (pid) { ptype = 'customer'; }
    else if (pname) { ptype = 'customer'; }
    // 账户兜底：优先前端指定 → 现金账户 → 任意账户 → 自动创建现金账户
    let accId = account_id || null;
    if (!accId) {
        accId = (await safeExec("SELECT id FROM accounts WHERE type = 'cash' LIMIT 1")).values?.[0]?.[0] || null;
    }
    if (!accId) {
        accId = (await safeExec("SELECT id FROM accounts ORDER BY id LIMIT 1")).values?.[0]?.[0] || null;
    }
    if (!accId) {
        await run("INSERT INTO accounts (name, type, balance) VALUES ('现金', 'cash', 0)");
        accId = (await safeExec("SELECT last_insert_rowid()")).values?.[0]?.[0] || null;
    }
    const cat = category || (pname ? '收欠款' : '直接收款');
    await run("INSERT INTO transactions (type, account_id, amount, category, description, operator_id, operator_name, party_type, party_id, party_name) VALUES ('income', ?, ?, ?, ?, ?, ?, ?, ?, ?)", [accId, amount, cat, description, req.user.id, req.user.real_name, ptype, pid, pname]);
    await run("UPDATE accounts SET balance = balance + ? WHERE id = ?", [amount, accId]);
    // 冲减该客户欠款：若指定客户，将其最早未结清销售单标记已结清（按金额抵扣）
    if (pid && category !== '直接收款') {
        const unpaid = (await safeExec("SELECT id, final_amount FROM sales_orders WHERE customer_id = ? AND payment_status != '已结清' ORDER BY id LIMIT 20", [pid])).values || [];
        // 按金额逐单抵扣：收款金额先抵最早的欠单，不足部分保持未结清（不再一刀切全部标记已结清）
        let remain = Number(amount) || 0;
        for (const row of unpaid) {
            if (remain <= 0) break;
            const due = Number(row[1]) || 0;
            if (remain >= due) {
                await run("UPDATE sales_orders SET payment_status = '已结清' WHERE id = ?", [row[0]]);
                remain -= due;
            } else {
                remain = 0;
            }
        }
    }
    saveDB(); saveDB();
    res.json({ ok: true });
});
app.post('/api/finance/transactions/expense', authMiddleware, hasPerm('expense'), async (req, res) => {
    await initDB();
    const { account_id, amount, category, description, supplier_id, supplier_name } = req.body;
    let pid = supplier_id || null, pname = supplier_name || null, ptype = null;
    if (!pid && pname) {
        const r = await safeExec("SELECT id FROM suppliers WHERE name = ? ORDER BY id LIMIT 1", [pname]);
        if (r.values?.[0]?.[0]) pid = r.values[0][0];
    }
    if (pid) { ptype = 'supplier'; }
    else if (pname) { ptype = 'supplier'; }
    // 账户兜底：优先前端指定 → 现金账户 → 任意账户 → 自动创建现金账户
    let accId = account_id || null;
    if (!accId) {
        accId = (await safeExec("SELECT id FROM accounts WHERE type = 'cash' LIMIT 1")).values?.[0]?.[0] || null;
    }
    if (!accId) {
        accId = (await safeExec("SELECT id FROM accounts ORDER BY id LIMIT 1")).values?.[0]?.[0] || null;
    }
    if (!accId) {
        await run("INSERT INTO accounts (name, type, balance) VALUES ('现金', 'cash', 0)");
        accId = (await safeExec("SELECT last_insert_rowid()")).values?.[0]?.[0] || null;
    }
    const cat = category || (pname ? '付欠款' : '直接付款');
    await run("INSERT INTO transactions (type, account_id, amount, category, description, operator_id, operator_name, party_type, party_id, party_name) VALUES ('expense', ?, ?, ?, ?, ?, ?, ?, ?, ?)", [accId, amount, cat, description, req.user.id, req.user.real_name, ptype, pid, pname]);
    await run("UPDATE accounts SET balance = balance - ? WHERE id = ?", [amount, accId]);
    if (pid && category !== '直接付款') {
        const unpaid = (await safeExec("SELECT id, total_amount FROM purchase_orders WHERE supplier_id = ? AND payment_status != '已结清' ORDER BY id LIMIT 20", [pid])).values || [];
        // 按金额逐单抵扣：付款金额先抵最早的欠单，不足部分保持未结清
        let remain = Number(amount) || 0;
        for (const row of unpaid) {
            if (remain <= 0) break;
            const due = Number(row[1]) || 0;
            if (remain >= due) {
                await run("UPDATE purchase_orders SET payment_status = '已结清' WHERE id = ?", [row[0]]);
                remain -= due;
            } else {
                remain = 0;
            }
        }
    }
    saveDB(); saveDB();
    res.json({ ok: true });
});
app.post('/api/finance/transactions/transfer', authMiddleware, adminOnly, async (req, res) => {
    await initDB();
    const { from_account_id, to_account_id, amount, description } = req.body;
    await run("INSERT INTO transactions (type, account_id, amount, description, operator_id, operator_name) VALUES ('transfer', ?, ?, ?, ?, ?)", [from_account_id, amount, description, req.user.id, req.user.real_name]);
    await run("UPDATE accounts SET balance = balance - ? WHERE id = ?", [amount, from_account_id]);
    await run("INSERT INTO transactions (type, account_id, amount, description, operator_id, operator_name) VALUES ('transfer_in', ?, ?, ?, ?, ?)", [to_account_id, amount, description, req.user.id, req.user.real_name]);
    await run("UPDATE accounts SET balance = balance + ? WHERE id = ?", [amount, to_account_id]);
    saveDB();
    saveDB();
    res.json({ ok: true });
});
app.get('/api/finance/transactions', authMiddleware, (req, res, next) => {
    // 收款/付款列表：有 income 或 expense 或 finance_view 任一权限即可查看
    const perms = parsePerms(req.user);
    if (perms.includes('finance_view') || perms.includes('income') || perms.includes('expense')) return next();
    return res.status(403).json({ error: '无权限：该功能未开放给当前账号' });
}, async (req, res) => {
    await initDB();
    const { type, account_id, page = 1, pageSize = 50 } = req.query;
    let sql = "SELECT * FROM transactions WHERE 1=1";
    const params = [];
    if (type) {
        sql += " AND type = '" + String(type).replace(/'/g, "''") + "'";
    }
    if (account_id) {
        sql += " AND account_id = " + Number(account_id);
    }
    sql += " ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?";
    params.push(Number(pageSize), (Number(page) - 1) * Number(pageSize));
    const result = await safeExec(sql, params);
    const transactions = (result.values || []).map((t) => ({
        id: t[0], type: t[1], account_id: t[2], amount: Number(t[3]), category: t[4],
        description: t[5], reference_id: t[6], operator_id: t[7], operator_name: t[8],
        created_at: t[9]
    }));
    res.json(transactions);
});
app.get('/api/finance/overview', authMiddleware, hasPerm('finance_view'), async (_req, res) => {
    await initDB();
    const today = new Date().toISOString().slice(0, 10);
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10);
    const todayIncome = Number((await safeExec(`SELECT COALESCE(SUM(amount),0) FROM transactions WHERE type='income' AND date(created_at) = '${today}'`)).values?.[0]?.[0] || 0);
    const todayExpense = Number((await safeExec(`SELECT COALESCE(SUM(amount),0) FROM transactions WHERE type='expense' AND date(created_at) = '${today}'`)).values?.[0]?.[0] || 0);
    const monthIncome = Number((await safeExec(`SELECT COALESCE(SUM(amount),0) FROM transactions WHERE type='income' AND date(created_at) >= '${monthStart}'`)).values?.[0]?.[0] || 0);
    const monthExpense = Number((await safeExec(`SELECT COALESCE(SUM(amount),0) FROM transactions WHERE type='expense' AND date(created_at) >= '${monthStart}'`)).values?.[0]?.[0] || 0);
    const accountsResult = await safeExec("SELECT id, name, type, balance FROM accounts WHERE status=1");
    const accountList = (accountsResult.values || []).map((a) => ({ id: a[0], name: a[1], type: a[2], balance: Number(a[3]) }));
    const totalBalance = accountList.reduce((sum, a) => sum + a.balance, 0);
    res.json({ today_income: todayIncome, today_expense: todayExpense, month_income: monthIncome, month_expense: monthExpense, accounts: accountList, total_balance: totalBalance });
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
    const today = new Date().toISOString().slice(0, 10);
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10);
    // 数据权限：所有账号统计全店数据（对齐智慧记云端默认，管理员开单成员也可查看）
    const scopeSql = '';
    // 排除作废单（对齐智慧记：作废单不计入统计）
    const VOID = " AND COALESCE(payment_status,'') <> '作废'";
    const VOID_SO = " AND COALESCE(so.payment_status,'') <> '作废'";
    const todaySales = Number((await safeExec(`SELECT COALESCE(SUM(final_amount),0) FROM sales_orders WHERE substr(COALESCE(bill_date, created_at),1,10)='${today}'${scopeSql}${VOID}`)).values?.[0]?.[0] || 0);
    const todayExpense = Number((await safeExec(`SELECT COALESCE(SUM(amount),0) FROM transactions WHERE type='expense' AND date(created_at)='${today}'${scopeSql}`)).values?.[0]?.[0] || 0);
    // 真实成本/毛利（成本 = Σ 数量×采购价；退货单收入为负，成本同步取负）
    const todayCost = Number((await safeExec(`SELECT COALESCE(SUM(${COST_SIGN_SQL} * oi.quantity * p.cost_price),0) FROM sales_order_items oi JOIN sales_orders so ON oi.order_id=so.id JOIN products p ON oi.product_id=p.id WHERE substr(COALESCE(so.bill_date, so.created_at),1,10)='${today}'${scopeSql}${VOID_SO}`)).values?.[0]?.[0] || 0);
    const todayOrders = Number((await safeExec(`SELECT COUNT(*) FROM sales_orders WHERE substr(COALESCE(bill_date, created_at),1,10)='${today}'${scopeSql}${VOID}`)).values?.[0]?.[0] || 0);
    const warningCount = Number((await safeExec("SELECT COUNT(*) FROM products WHERE stock_quantity <= warning_quantity AND status=1")).values?.[0]?.[0] || 0);
    const monthSales = Number((await safeExec(`SELECT COALESCE(SUM(final_amount),0) FROM sales_orders WHERE substr(COALESCE(bill_date, created_at),1,10) >= '${monthStart}'${scopeSql}${VOID}`)).values?.[0]?.[0] || 0);
    const monthCost = Number((await safeExec(`SELECT COALESCE(SUM(${COST_SIGN_SQL} * oi.quantity * p.cost_price),0) FROM sales_order_items oi JOIN sales_orders so ON oi.order_id=so.id JOIN products p ON oi.product_id=p.id WHERE substr(COALESCE(so.bill_date, so.created_at),1,10) >= '${monthStart}'${scopeSql}${VOID_SO}`)).values?.[0]?.[0] || 0);
    // 应收/欠款（对齐智慧记）：欠款余额 = Σ owe_amount；未结清单数
    const ar = (await safeExec(`SELECT COALESCE(SUM(owe_amount),0), COUNT(*) FROM sales_orders WHERE COALESCE(biz_type,'sale') <> 'sale_return' AND COALESCE(owe_amount,0) > 0.005${scopeSql}${VOID}`)).values?.[0] || [0, 0];
    const ap = (await safeExec(`SELECT COALESCE(SUM(owe_amount),0), COUNT(*) FROM purchase_orders WHERE COALESCE(owe_amount,0) > 0.005`)).values?.[0] || [0, 0];
    res.json({
        todaySales, todayExpense, todayCost, todayProfit: todaySales - todayCost, todayOrders, warningCount, monthSales,
        monthCost, monthProfit: monthSales - monthCost,
        receivable: Number(ar[0] || 0), unpaidCount: Number(ar[1] || 0),
        payable: Number(ap[0] || 0), payableCount: Number(ap[1] || 0),
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
           COALESCE(SUM(${COST_SIGN_SQL} * oi.quantity * p.cost_price),0) as cost,
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
    const startDate = req.query.start_date
        ? String(req.query.start_date)
        : new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
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
           SUM(${COST_SIGN_SQL} * oi.quantity * p.cost_price) as total_cost,
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
 * ★ 同 sales：不传 group_by → 旧形态裸数组 [{date,total,order_count}]；传 group_by → 信封。
 * ★ 口径：采购单表无「作废」状态字段，故不做状态过滤（与旧版一致，不擅自改口径）。
 */
app.get('/api/analysis/purchase', authMiddleware, hasPerm('sales_stats'), async (req, res) => {
    await initDB();
    const { start_date, end_date } = req.query;
    const BD = "substr(COALESCE(bill_date, created_at),1,10)";
    const gb = String(req.query.group_by || '').toLowerCase();
    const isPeriodic = gb === 'month' || gb === 'year' || gb === 'day';
    const P = gb === 'month' ? "substr(COALESCE(bill_date, created_at),1,7)"
        : gb === 'year' ? "substr(COALESCE(bill_date, created_at),1,4)" : BD;
    const cond = ['1=1'];
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
    const rows = (result.values || []).map((r) => {
        const total = Math.round(Number(r[1] || 0) * 100) / 100;
        const orderCount = Number(r[4] || 0);
        return {
            period: String(r[0]),
            date: String(r[0]),
            total,
            total_amount: total,
            paid_amount: Math.round(Number(r[2] || 0) * 100) / 100,
            owe_amount: Math.round(Number(r[3] || 0) * 100) / 100,
            order_count: orderCount,
            supplier_count: Number(r[5] || 0),
            avg_order: orderCount > 0 ? Math.round((total / orderCount) * 100) / 100 : 0,
        };
    });
    if (!isPeriodic) {
        return res.json(rows.map((r) => ({ date: r.date, total: r.total, order_count: r.order_count })));
    }
    const sums = rows.reduce((s, r) => ({
        total_amount: s.total_amount + r.total_amount,
        paid_amount: s.paid_amount + r.paid_amount,
        owe_amount: s.owe_amount + r.owe_amount,
        order_count: s.order_count + r.order_count,
        periods: s.periods + 1,
    }), { total_amount: 0, paid_amount: 0, owe_amount: 0, order_count: 0, periods: 0 });
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
app.get('/api/analysis/profit', authMiddleware, hasPerm('sales_stats'), async (req, res) => {
    await initDB();
    const today = new Date().toISOString().slice(0, 10);
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10);
    // 数据权限：员工只统计自己的销售单（管理员/店长看全店）
    const isAdminUser = req.user.role === 'admin' || req.user.role === 'manager';
    const scopeSql = ''; // 全店可见
    // 排除作废单（作废单不计入统计）
    const VOID = " AND COALESCE(payment_status,'') <> '作废'";
    const VOID_SO = " AND COALESCE(so.payment_status,'') <> '作废'";
    const todaySales = Number((await safeExec(`SELECT COALESCE(SUM(final_amount),0) FROM sales_orders WHERE substr(COALESCE(bill_date, created_at),1,10)='${today}'${scopeSql}${VOID}`)).values?.[0]?.[0] || 0);
    // 成本口径修正：退货单（biz_type='sale_return'）收入为负、成本必须同步取负，否则成本率会被虚增
    const todayCost = Number((await safeExec(`SELECT COALESCE(SUM(${COST_SIGN_SQL} * oi.quantity * p.cost_price),0) FROM sales_order_items oi JOIN sales_orders so ON oi.order_id = so.id JOIN products p ON oi.product_id = p.id WHERE substr(COALESCE(so.bill_date, so.created_at),1,10)='${today}'${scopeSql}${VOID_SO}`)).values?.[0]?.[0] || 0);
    const monthSales = Number((await safeExec(`SELECT COALESCE(SUM(final_amount),0) FROM sales_orders WHERE substr(COALESCE(bill_date, created_at),1,10) >= '${monthStart}'${scopeSql}${VOID}`)).values?.[0]?.[0] || 0);
    const monthCost = Number((await safeExec(`SELECT COALESCE(SUM(${COST_SIGN_SQL} * oi.quantity * p.cost_price),0) FROM sales_order_items oi JOIN sales_orders so ON oi.order_id = so.id JOIN products p ON oi.product_id = p.id WHERE substr(COALESCE(so.bill_date, so.created_at),1,10) >= '${monthStart}'${scopeSql}${VOID_SO}`)).values?.[0]?.[0] || 0);
    // 其他收入/其他支出（category 以"其他"开头的收支，如 其他收入-房租、其他支出-水电）；员工只看自己的流水
    const otherSql = (t, from) => `SELECT COALESCE(SUM(amount),0) FROM transactions WHERE type='${t}' AND (category LIKE '其他%' OR category LIKE '%其他%') AND date(created_at) ${from}${scopeSql}`;
    const todayOtherIncome = Number((await safeExec(otherSql('income', `='${today}'`))).values?.[0]?.[0] || 0);
    const todayOtherExpense = Number((await safeExec(otherSql('expense', `='${today}'`))).values?.[0]?.[0] || 0);
    const monthOtherIncome = Number((await safeExec(otherSql('income', `>= '${monthStart}'`))).values?.[0]?.[0] || 0);
    const monthOtherExpense = Number((await safeExec(otherSql('expense', `>= '${monthStart}'`))).values?.[0]?.[0] || 0);
    /* ---------- 以下为本次新增（全部为「只加字段」，不删不改旧字段，发布顺序无关） ---------- */
    // (1) 近 12 个月序列：销售额 / 成本 / 毛利 / 其他收支 / 净利润
    const BD = "substr(COALESCE(bill_date, created_at),1,7)";
    const BDS = "substr(COALESCE(so.bill_date, so.created_at),1,7)";
    const m12 = new Date(new Date().getFullYear(), new Date().getMonth() - 11, 1);
    const start12 = `${m12.getFullYear()}-${String(m12.getMonth() + 1).padStart(2, '0')}`;
    const months12 = [];
    for (let i = 11; i >= 0; i--) {
        const d = new Date(new Date().getFullYear(), new Date().getMonth() - i, 1);
        months12.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    }
    const saleByM = {};
    for (const r of ((await safeExec(`
      SELECT ${BD} ym,
             COALESCE(SUM(CASE WHEN COALESCE(biz_type,'sale')='sale_return' THEN final_amount ELSE 0 END),0) ret,
             COALESCE(SUM(CASE WHEN COALESCE(biz_type,'sale')='sale_return' THEN 0 ELSE final_amount END),0) sale
      FROM sales_orders
      WHERE COALESCE(payment_status,'') <> '作废' AND ${BD} >= '${start12}'
      GROUP BY ym`)).values || [])) {
        saleByM[String(r[0])] = { ret: Number(r[1] || 0), sale: Number(r[2] || 0) };
    }
    const costByM = {};
    for (const r of ((await safeExec(`
      SELECT ${BDS} ym, COALESCE(SUM(${COST_SIGN_SQL} * oi.quantity * p.cost_price),0) cost
      FROM sales_order_items oi
      JOIN sales_orders so ON oi.order_id = so.id
      JOIN products p ON oi.product_id = p.id
      WHERE COALESCE(so.payment_status,'') <> '作废' AND ${BDS} >= '${start12}'
      GROUP BY ym`)).values || [])) {
        costByM[String(r[0])] = Number(r[1] || 0);
    }
    const otherByM = {};
    for (const r of ((await safeExec(`
      SELECT substr(created_at,1,7) ym, type, COALESCE(SUM(amount),0) amt
      FROM transactions
      WHERE (category LIKE '其他%' OR category LIKE '%其他%') AND substr(created_at,1,7) >= '${start12}'
      GROUP BY ym, type`)).values || [])) {
        const ym = String(r[0]);
        if (!otherByM[ym])
            otherByM[ym] = { income: 0, expense: 0 };
        otherByM[ym][String(r[1]) === 'income' ? 'income' : 'expense'] += Number(r[2] || 0);
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
           SUM(${COST_SIGN_SQL} * oi.quantity * p.cost_price) as cost,
           SUM(${COST_SIGN_SQL} * oi.amount) - SUM(${COST_SIGN_SQL} * oi.quantity * p.cost_price) as profit
    FROM sales_order_items oi
    JOIN sales_orders so ON oi.order_id = so.id
    JOIN products p ON oi.product_id = p.id
    WHERE ${lpCond.join(' AND ')}
    GROUP BY p.id, p.name, p.sku
    HAVING SUM(${COST_SIGN_SQL} * oi.amount) - SUM(${COST_SIGN_SQL} * oi.quantity * p.cost_price) < 0
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
        const rCost = Number((await safeExec(`SELECT COALESCE(SUM(${COST_SIGN_SQL} * oi.quantity * p.cost_price),0) FROM sales_order_items oi JOIN sales_orders so ON oi.order_id = so.id JOIN products p ON oi.product_id = p.id WHERE COALESCE(so.payment_status,'') <> '作废' AND ${BDSd} >= '${sd}' AND ${BDSd} <= '${ed}'`)).values?.[0]?.[0] || 0);
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
app.get('/api/analysis/performance', authMiddleware, async (req, res) => {
    await initDB();
    const isAdmin = req.user && req.user.role !== 'employee';
    const { start_date, end_date } = req.query;
    const now = new Date();
    const ym = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const monthStart = `${ym(now)}-01`;
    const defStart = start_date ? String(start_date) : monthStart;
    const defEnd = end_date ? String(end_date) : now.toISOString().slice(0, 10);
    const END = defEnd + ' 23:59:59';
    const R2 = (n) => Math.round(Number(n || 0) * 100) / 100;
    // 归属键（名称优先、ID 兜底）—— 三处查询必须用完全相同的表达式，否则分组对不上
    const NAME_KEY = "COALESCE(NULLIF(TRIM(COALESCE(so.operator_name,'')),''), NULLIF(TRIM(COALESCE(u.real_name,'')),''), '未归属')";
    // 账号表（给「未匹配账号」的历史操作人标一个身份）
    const uRows = (await safeExec("SELECT id, real_name, role FROM users WHERE status=1")).values || [];
    const roleByName = {};
    const idToName = {};
    for (const u of uRows) {
        roleByName[String(u[1] || '').trim()] = String(u[2] || 'employee');
        idToName[Number(u[0])] = String(u[1] || '').trim();
    }
    // 店员只能看自己：用「自己的 real_name」当归属名过滤（旧版按 id 过滤，因 ID 全空恒返回空）
    let selfName = '';
    if (!isAdmin) {
        const me = (await safeExec("SELECT real_name FROM users WHERE id = ?", [Number(req.user.id)])).values?.[0];
        selfName = String(me?.[0] || '').trim();
    }
    // ---- 主聚合：订单数 / 销售额 / 提成（按归属名） ----
    const c1 = ["COALESCE(so.payment_status,'') <> '作废'", "so.created_at >= ?", "so.created_at <= ?"];
    const p1 = [defStart, END];
    if (!isAdmin) {
        c1.push(`${NAME_KEY} = ?`);
        p1.push(selfName);
    }
    const mainRows = (await safeExec(`
    SELECT ${NAME_KEY} as op_name,
           COUNT(*) as orders,
           COALESCE(SUM(so.final_amount),0) as sales,
           COALESCE(SUM(so.commission_amount),0) as commission
    FROM sales_orders so
    LEFT JOIN users u ON u.id = so.operator_id
    WHERE ${c1.join(' AND ')}
    GROUP BY 1 ORDER BY sales DESC`, p1)).values || [];
    // ---- 件数与成本（同一归属键、同一区间；成本带 COST_SIGN 符号） ----
    const c2 = ["COALESCE(so.payment_status,'') <> '作废'", "so.created_at >= ?", "so.created_at <= ?"];
    const p2 = [defStart, END];
    if (!isAdmin) {
        c2.push(`${NAME_KEY} = ?`);
        p2.push(selfName);
    }
    const aggRows = (await safeExec(`
    SELECT ${NAME_KEY} as op_name,
           COALESCE(SUM(oi.quantity),0) as qty,
           COALESCE(SUM(${COST_SIGN_SQL} * oi.quantity * p.cost_price),0) as cost
    FROM sales_order_items oi
    JOIN sales_orders so ON oi.order_id = so.id
    LEFT JOIN users u ON u.id = so.operator_id
    JOIN products p ON oi.product_id = p.id
    WHERE ${c2.join(' AND ')}
    GROUP BY 1`, p2)).values || [];
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
    // ---- 全店汇总 ----
    const tc = ["COALESCE(so.payment_status,'') <> '作废'", "so.created_at >= ?", "so.created_at <= ?"];
    const tp = [defStart, END];
    if (!isAdmin) {
        tc.push(`${NAME_KEY} = ?`);
        tp.push(selfName);
    }
    const totalStat = (await safeExec(`
    SELECT COUNT(*), COALESCE(SUM(so.final_amount),0)
    FROM sales_orders so LEFT JOIN users u ON u.id = so.operator_id
    WHERE ${tc.join(' AND ')}`, tp)).values?.[0] || [0, 0];
    const totalS = R2(totalStat[1]);
    const totalO = Number(totalStat[0] || 0);
    const staff = rows.filter((r) => r.orders > 0).length;
    /* ★ 归属诊断（诚实披露用）：告诉前端「有多少单根本没归属」，
     *   避免页面显示成一个看起来完整、实际漏掉大半的排行榜。 */
    const diag = (await safeExec(`
    SELECT COUNT(*),
           SUM(CASE WHEN so.operator_id IS NULL THEN 1 ELSE 0 END),
           SUM(CASE WHEN COALESCE(TRIM(so.operator_name),'') = '' THEN 1 ELSE 0 END),
           COUNT(DISTINCT NULLIF(TRIM(COALESCE(so.operator_name,'')),''))
    FROM sales_orders so WHERE COALESCE(so.payment_status,'') <> '作废' AND so.created_at >= ? AND so.created_at <= ?`, [defStart, END])).values?.[0] || [0, 0, 0, 0];
    const unattributed = (await safeExec(`
    SELECT COUNT(*), COALESCE(SUM(so.final_amount),0)
    FROM sales_orders so LEFT JOIN users u ON u.id = so.operator_id
    WHERE COALESCE(so.payment_status,'') <> '作废' AND so.created_at >= ? AND so.created_at <= ?
      AND ${NAME_KEY} = '未归属'`, [defStart, END])).values?.[0] || [0, 0];
    const attribution = {
        positive_orders: totalO,
        no_operator_id: Number(diag[1] || 0),
        no_operator_name: Number(diag[2] || 0),
        name_holders: Number(diag[3] || 0),
        unattributed_orders: Number(unattributed[0] || 0),
        unattributed_amount: R2(unattributed[1]),
        covered_rate: totalO > 0 ? Math.round(((totalO - Number(unattributed[0] || 0)) / totalO) * 10000) / 100 : 0,
        note: '按 operator_name 归属（operator_id 在历史数据中大面积为空）；未归属单据已单列，不计入任何人业绩',
    };
    /* 按月趋势（用同一归属键，保证与 list 口径一致） */
    let by_month = [];
    if (String(req.query.group_by || '') === 'month') {
        const c3 = ["COALESCE(so.payment_status,'') <> '作废'", "so.created_at >= ?", "so.created_at <= ?"];
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
app.get('/api/analysis/demand', authMiddleware, hasPerm('sales_stats'), async (req, res) => {
    await initDB();
    const now = new Date();
    // 数据权限：员工只看自己的销售单（管理员/店长看全店）
    const isAdminUser = req.user.role === 'admin' || req.user.role === 'manager';
    const scopeSql = ''; // 全店可见
    // 本地时间 YYYY-MM（不能用 toISOString，UTC 会偏移月份）
    const ymOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const curYM = ymOf(now); // 当月 YYYY-MM
    // 历史起点：11 个月前的第一天（共12个月窗口）
    const startDate = `${new Date(now.getFullYear(), now.getMonth() - 11, 1).getFullYear()}-${String(new Date(now.getFullYear(), now.getMonth() - 11, 1).getMonth() + 1).padStart(2, '0')}-01`;
    // ---- 1) 客户需求：按 客户×月份 聚合近12个月正金额销售 ----
    const custRows = (await safeExec(`
    SELECT customer_name, substr(created_at,1,7) as ym, COUNT(*) as cnt, SUM(final_amount) as amt
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
    // 生成近12个月的月份列表（升序）
    const months = [];
    for (let i = 11; i >= 0; i--) {
        months.push(ymOf(new Date(now.getFullYear(), now.getMonth() - i, 1)));
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
    SELECT substr(created_at,1,7) as ym, COUNT(*) as cnt, SUM(final_amount) as amt
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
    const curMonthFull = trend[trend.length - 1].month === curYM ? new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate() : 1;
    const curDay = now.getDate();
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
app.get('/api/store/info', authMiddleware, async (_req, res) => {
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
app.get('/api/store/suppliers', authMiddleware, hasPerm('suppliers'), async (_req, res) => {
    await initDB();
    const result = await safeExec("SELECT * FROM suppliers ORDER BY id");
    const list = (result.values || []).map((s) => ({
        id: Number(s[0]), name: s[1], contact: s[2], phone: s[3], address: s[4], remark: s[5]
    }));
    res.json(list);
});
app.post('/api/store/suppliers', authMiddleware, hasPerm('suppliers'), async (req, res) => {
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
app.get('/api/store/customers', authMiddleware, hasPerm('customers'), async (_req, res) => {
    await initDB();
    const result = await safeExec("SELECT * FROM customers WHERE status=1 ORDER BY id");
    const list = (result.values || []).map((c) => ({
        id: Number(c[0]), name: c[1], phone: c[2], address: c[3], contact: c[4], remark: c[5], status: c[6], created_at: c[7], price_level: c[8] || 'retail'
    }));
    res.json(list);
});
app.post('/api/store/customers', authMiddleware, hasPerm('customers'), async (req, res) => {
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
    await run("UPDATE customers SET name=?, phone=?, address=?, contact=?, remark=?, price_level=?, status=? WHERE id=?", [name, phone, address, contact, remark, price_level || 'retail', status !== undefined ? status : 1, id]);
    saveDB();
    saveDB();
    res.json({ ok: true });
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
const PO_COLS = "id, order_number, supplier_id, supplier_name, total_amount, status, operator_id, operator_name, created_at, payment_status, bill_date, paid_amount, owe_amount, remark";
function mapPurchaseOrder(o) {
    return {
        id: o[0], order_number: o[1], supplier_id: Number(o[2]) || null, supplier_name: o[3],
        total_amount: Number(o[4]), status: o[5], operator_id: o[6], operator_name: o[7],
        created_at: o[8], payment_status: o[9] || '已结清',
        bill_date: o[10] || (o[8] ? String(o[8]).slice(0, 10) : null),
        paid_amount: Number(o[11] || 0), owe_amount: Number(o[12] || 0), remark: o[13] || ''
    };
}
app.get('/api/store/purchase-orders', authMiddleware, hasPerm('purchase'), async (req, res) => {
    await initDB();
    const { page = 1, pageSize = 200, keyword, startDate, endDate, status, withTotal } = req.query;
    let where = " WHERE 1=1";
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
        const totalRow = (await safeExec("SELECT COUNT(*) FROM purchase_orders" + where)).values?.[0]?.[0];
        const agg = (await safeExec("SELECT COALESCE(SUM(total_amount),0) AS sum_total, COALESCE(SUM(owe_amount),0) AS sum_owe FROM purchase_orders" + where)).values?.[0] || [0, 0];
        return res.json({
            rows: orders, total: Number(totalRow || 0), page: pg, pageSize: ps,
            sum_total: Number(agg[0] || 0), sum_owe: Number(agg[1] || 0),
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
        const result = await safeExec(`SELECT order_number, supplier_name, total_amount, paid_amount, owe_amount, payment_status, operator_name, ${BD} FROM purchase_orders WHERE ${BD} >= ? AND ${BD} <= ? ORDER BY ${BD}, id`, [String(startDate), String(endDate)]);
        const rows = [['单据编号', '供应商名称', '应付金额', '已付金额', '欠款', '付款状态', '操作员', '业务日期']];
        for (const r of result.values || []) rows.push(r);
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
        id: i[0], product_id: i[2], product_name: i[3], quantity: Number(i[4]), unit_price: Number(i[5]), amount: Number(i[6])
    }));
    // 联查商品表补充规格/单位/条形码/编号（打印用）
    const enriched = await Promise.all(items.map(async (it) => {
        if (!it.product_id) return { ...it, sku: '', spec: '', unit: '', barcode: '' };
        const p = (await safeExec("SELECT sku, spec, unit, batch_number FROM products WHERE id = ?", [it.product_id])).values?.[0];
        return { ...it, sku: p?.[0] || '', spec: p?.[1] || '', unit: p?.[2] || '', barcode: p?.[3] || '' };
    }));
    res.json({ ...mapPurchaseOrder(o), items: enriched });
});
app.post('/api/store/purchase-orders', authMiddleware, hasPerm('purchase'), async (req, res) => {
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
    const orderNumber = generateOrderNumber('JH');
    const totalAmount = final_amount || req.body.total_amount || 0;
    /* ---- 付款口径：与销售单对称 ----
     * paid_amount 显式传入则用传入值；否则 settled=true 视为全额付讫，否则 0（赊购）
     * owe_amount = 应付 - 已付 */
    const paidAmount = paid_amount !== undefined && paid_amount !== null && paid_amount !== ''
        ? (Number(paid_amount) || 0)
        : (req.body.settled ? Number(totalAmount) : 0);
    const oweAmount = Math.round((Number(totalAmount) - paidAmount) * 100) / 100;
    const paymentStatus = req.body.payment_status || (oweAmount > 0.005 ? '未结清' : '已结清');
    await run("INSERT INTO purchase_orders (order_number, supplier_id, supplier_name, total_amount, operator_id, operator_name, payment_status, bill_date, paid_amount, owe_amount, remark) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [orderNumber, supplier_id, supplier_name, totalAmount, req.user.id, req.user.real_name, paymentStatus, bill_date || todayCST(), paidAmount, oweAmount, remark || '']);
    if (items) {
        const orderIdResult = await safeExec("SELECT last_insert_rowid()");
        const orderId = orderIdResult.values?.[0]?.[0];
        for (const item of items) {
            await run("INSERT INTO purchase_order_items (order_id, product_id, product_name, quantity, unit_price, amount) VALUES (?, ?, ?, ?, ?, ?)", [orderId, item.product_id, item.product_name, item.quantity, item.unit_price, item.quantity * item.unit_price]);
            // 增加库存
            if (item.product_id) {
                await run("UPDATE products SET stock_quantity = stock_quantity + ? WHERE id = ?", [item.quantity, item.product_id]);
            }
        }
    }
    saveDB();
    res.json({ ok: true, order_number: orderNumber });
});
// 开单可选业务员：返回在职业务员 + 管理员（管理员开单选业务员，子账户开单选自己或管理员）
app.get('/api/store/sales-staff', authMiddleware, hasPerm('sales'), async (_req, res) => {
    await initDB();
    const result = await safeExec("SELECT id, real_name, role FROM users WHERE status = 1 AND role IN ('employee','admin') ORDER BY role, id");
    res.json((result.values || []).map((u) => ({ id: u[0], real_name: u[1], role: u[2] })));
});
// 销售单列清单（含财务口径字段），统一在此维护，避免各处 SELECT 漏字段
const SO_COLS = "id, order_number, customer_id, customer_name, total_amount, discount, final_amount, payment_method, operator_id, operator_name, created_at, payment_status, commission_amount, bill_date, receivable_amount, received_amount, owe_amount, small_change_amount, express_amount, tax_amount, remark, biz_type";
function mapSalesOrder(o) {
    return {
        id: o[0], order_number: o[1], customer_id: Number(o[2]) || null, customer_name: o[3],
        total_amount: Number(o[4]), discount: Number(o[5]), final_amount: Number(o[6]),
        payment_method: o[7], operator_id: o[8], operator_name: o[9], created_at: o[10],
        payment_status: o[11], commission_amount: Number(o[12] || 0),
        bill_date: o[13] || (o[10] ? String(o[10]).slice(0, 10) : null),
        receivable_amount: Number(o[14] || 0), received_amount: Number(o[15] || 0), owe_amount: Number(o[16] || 0),
        small_change_amount: Number(o[17] || 0), express_amount: Number(o[18] || 0), tax_amount: Number(o[19] || 0),
        remark: o[20] || '', biz_type: o[21] || 'sale'
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
        const totalRow = (await safeExec("SELECT COUNT(*) FROM sales_orders" + where)).values?.[0]?.[0];
        const agg = (await safeExec("SELECT COALESCE(SUM(final_amount),0) AS sum_final, COALESCE(SUM(owe_amount),0) AS sum_owe, COALESCE(SUM(received_amount),0) AS sum_received FROM sales_orders" + where)).values?.[0] || [0, 0, 0];
        return res.json({
            rows: orders, total: Number(totalRow || 0), page: pg, pageSize: ps,
            sum_final: Number(agg[0] || 0), sum_owe: Number(agg[1] || 0), sum_received: Number(agg[2] || 0),
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
        id: i[0], product_id: i[2], product_name: i[3], sku: i[4], quantity: Number(i[5]), unit_price: Number(i[6]), amount: Number(i[7])
    }));
    // 联查商品表补充规格/单位/条形码（打印用）
    const enriched = await Promise.all(items.map(async (it) => {
        if (!it.product_id) return { ...it, spec: '', unit: '', barcode: '' };
        const p = (await safeExec("SELECT spec, unit, batch_number, production_date FROM products WHERE id = ?", [it.product_id])).values?.[0];
        return { ...it, spec: p?.[0] || '', unit: p?.[1] || '', barcode: p?.[2] || '' };
    }));
    res.json({ ...mapSalesOrder(o), items: enriched });
});
app.post('/api/store/sales-orders', authMiddleware, hasPerm('sales'), async (req, res) => {
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
    const orderNumber = customOrderNumber || generateOrderNumber('XS');
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
    /* ---- 收款口径 ----
     * received_amount 显式传入则用传入值；否则：有支付方式视为全额收讫，无支付方式（赊账）视为 0
     * owe_amount = 应收 - 已收（赊账单的核心字段，供欠款对账） */
    const receivedAmount = received_amount !== undefined && received_amount !== null && received_amount !== ''
        ? (Number(received_amount) || 0)
        : (payment_method ? finalAmount : 0);
    const oweAmount = Math.round((finalAmount - receivedAmount) * 100) / 100;
    const paymentStatus = oweAmount > 0.005 ? '未结清' : '已结清';
    const billDate = bill_date || todayCST();
    await run("INSERT INTO sales_orders (order_number, customer_id, customer_name, total_amount, discount, final_amount, payment_method, operator_id, operator_name, commission_amount, payment_status, bill_date, receivable_amount, received_amount, owe_amount, small_change_amount, express_amount, tax_amount, remark, biz_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [
        orderNumber, customer_id || null, customer_name || null, totalAmount, discount || 0, finalAmount,
        payment_method || null, operatorId, operatorName, commissionAmount, paymentStatus,
        billDate, finalAmount, receivedAmount, oweAmount,
        Number(small_change_amount) || 0, Number(express_amount) || 0, Number(tax_amount) || 0,
        remark || '', 'sale'
    ]);
    saveDB();
    // Get the inserted order ID by finding the max id
    const orderIdResult = await safeExec("SELECT MAX(id) FROM sales_orders WHERE order_number = ?", [orderNumber]);
    const orderId = orderIdResult.values?.[0]?.[0] || 0;
    if (items && orderId > 0) {
        for (const item of items) {
            await run("INSERT INTO sales_order_items (order_id, product_id, product_name, sku, quantity, unit_price, amount) VALUES (?, ?, ?, ?, ?, ?, ?)", [orderId, item.product_id, item.product_name, item.sku || '', item.quantity, item.price ?? item.unit_price ?? 0, item.amount ?? item.quantity * (item.price ?? item.unit_price ?? 0)]);
            // Deduct stock
            if (item.product_id) {
                await run("UPDATE products SET stock_quantity = stock_quantity - ? WHERE id = ?", [item.quantity, item.product_id]);
            }
        }
    }
    // Update account balance if payment
    if (payment_method && ['cash', 'alipay', 'wechat', 'bank'].includes(payment_method) && receivedAmount > 0) {
        const accResult = await safeExec("SELECT id FROM accounts WHERE type = ? LIMIT 1", [payment_method]);
        if (accResult.values?.[0]) {
            await run("UPDATE accounts SET balance = balance + ? WHERE id = ?", [receivedAmount, accResult.values[0][0]]);
        }
    }
    saveDB();
    res.json({ ok: true, order_number: orderNumber, id: orderId, final_amount: finalAmount, received_amount: receivedAmount, owe_amount: oweAmount, payment_status: paymentStatus });
});
// 销售单收款登记（收欠款 / 收尾款）：累加已收、重算欠款与结算状态，并记一笔资金流水
app.post('/api/store/sales-orders/:id/receive', authMiddleware, hasPerm('sales'), async (req, res) => {
    await initDB();
    const id = Number(req.params.id);
    const amount = Number(req.body.amount) || 0;
    if (amount <= 0) return res.status(400).json({ error: '收款金额必须大于 0' });
    const o = (await safeExec("SELECT " + SO_COLS + " FROM sales_orders WHERE id = ?", [id])).values?.[0];
    if (!o) return res.status(404).json({ error: '订单不存在' });
    const so = mapSalesOrder(o);
    if (so.payment_status === '作废') return res.status(400).json({ error: '该单已作废，不能收款' });
    const receivable = so.receivable_amount || so.final_amount;
    const newReceived = Math.round((so.received_amount + amount) * 100) / 100;
    const newOwe = Math.round((receivable - newReceived) * 100) / 100;
    const newStatus = newOwe > 0.005 ? '未结清' : '已结清';
    await run("UPDATE sales_orders SET received_amount = ?, owe_amount = ?, payment_status = ? WHERE id = ?", [newReceived, newOwe, newStatus, id]);
    // 资金流水（可选账户）
    const accountId = Number(req.body.account_id) || null;
    if (accountId) {
        await run("INSERT INTO transactions (type, account_id, amount, category, description, party_type, party_id, party_name, operator_id, operator_name) VALUES ('income', ?, ?, '销售收款', ?, 'customer', ?, ?, ?, ?)",
            [accountId, amount, '销售单 ' + so.order_number + ' 收款', so.customer_id || null, so.customer_name || '', req.user.id, req.user.real_name]);
        await run("UPDATE accounts SET balance = balance + ? WHERE id = ?", [amount, accountId]);
    }
    saveDB();
    res.json({ ok: true, received_amount: newReceived, owe_amount: newOwe, payment_status: newStatus });
});
// 作废销售单（仅管理员）：标记作废 + 冲回库存，保留记录与明细（对齐智慧记 invalid，不做物理删除）
app.delete('/api/store/sales-orders/:id', authMiddleware, adminOnly, async (req, res) => {
    await initDB();
    const id = Number(req.params.id);
    const o = (await safeExec("SELECT * FROM sales_orders WHERE id = ?", [id])).values?.[0];
    if (!o) return res.status(404).json({ error: '订单不存在' });
    if (o[11] === '作废') return res.status(400).json({ error: '该单已作废，无需重复操作' });
    const items = (await safeExec("SELECT * FROM sales_order_items WHERE order_id = ?", [id])).values || [];
    for (const it of items) {
        if (it[2]) await run("UPDATE products SET stock_quantity = stock_quantity + ? WHERE id = ?", [Number(it[5]) || 0, it[2]]);
    }
    await run("UPDATE sales_orders SET payment_status='作废' WHERE id = ?", [id]);
    saveDB();
    res.json({ ok: true });
});
// Sales Return APIs
app.get('/api/store/sales-returns', authMiddleware, hasPerm('return'), async (req, res) => {
    await initDB();
    const { page = 1, pageSize = 100, withTotal } = req.query;
    const pg = Math.max(1, Number(page) || 1);
    const ps = Math.min(1000, Math.max(1, Number(pageSize) || 100));
    // 关联原销售单，补充原单号/客户/业务日期（便于退货对账）
    const sql = `SELECT r.id, r.return_number, r.sales_order_id, r.total_amount, r.operator_id, r.operator_name,
                        r.reason, r.status, r.created_at,
                        so.order_number, so.customer_name, COALESCE(so.bill_date, substr(so.created_at,1,10))
                   FROM sales_returns r LEFT JOIN sales_orders so ON so.id = r.sales_order_id
                  ORDER BY r.id DESC LIMIT ? OFFSET ?`;
    const result = await safeExec(sql, [ps, (pg - 1) * ps]);
    const returns = (result.values || []).map((r) => ({
        id: r[0], return_number: r[1], sales_order_id: r[2], total_amount: Number(r[3]),
        operator_id: r[4], operator_name: r[5], reason: r[6], status: r[7], created_at: r[8],
        ref_order_number: r[9] || '', customer_name: r[10] || '', bill_date: r[11] || null
    }));
    if (withTotal) {
        const totalRow = (await safeExec("SELECT COUNT(*) FROM sales_returns")).values?.[0]?.[0];
        return res.json({ rows: returns, total: Number(totalRow || 0), page: pg, pageSize: ps });
    }
    res.json(returns);
});
app.post('/api/store/sales-returns', authMiddleware, hasPerm('return'), async (req, res) => {
    await initDB();
    const { sales_order_id, items, reason } = req.body;
    const returnNumber = generateOrderNumber('TH');
    let totalAmount = 0;
    if (items) {
        for (const item of items) {
            totalAmount += (item.quantity || 0) * (item.unit_price || 0);
        }
    }
    await run("INSERT INTO sales_returns (return_number, sales_order_id, total_amount, operator_id, operator_name, reason) VALUES (?, ?, ?, ?, ?, ?)", [returnNumber, sales_order_id, totalAmount, req.user.id, req.user.real_name, reason || '']);
    const returnIdResult = await safeExec("SELECT last_insert_rowid()");
    const returnId = returnIdResult.values?.[0]?.[0];
    if (items && returnId) {
        for (const item of items) {
            await run("INSERT INTO sales_return_items (return_id, product_id, product_name, sku, quantity, unit_price, amount) VALUES (?, ?, ?, ?, ?, ?, ?)", [returnId, item.product_id, item.product_name, item.sku, item.quantity, item.unit_price, item.quantity * item.unit_price]);
            // Restore stock
            if (item.product_id) {
                await run("UPDATE products SET stock_quantity = stock_quantity + ? WHERE id = ?", [item.quantity, item.product_id]);
            }
        }
    }
    saveDB();
    res.json({ ok: true, return_number: returnNumber });
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
        id: i[0], product_id: i[2], product_name: i[3], sku: i[4], quantity: Number(i[5]), unit_price: Number(i[6]), amount: Number(i[7])
    }));
    res.json({
        id: r[0], recycle_number: r[1], customer_id: r[2], customer_name: r[3],
        total_amount: Number(r[4]), operator_id: r[5], operator_name: r[6], remark: r[7], created_at: r[8], items
    });
});
app.post('/api/store/recycles', authMiddleware, hasPerm('recycle'), async (req, res) => {
    await initDB();
    if (req.user && req.user.role === 'employee')
        return res.status(403).json({ error: '店员无权操作回收，请联系管理员' });
    const { customer_id, customer_name, items, remark, account_id } = req.body;
    if (!items || !items.length)
        return res.status(400).json({ error: '请添加回收商品' });
    const recycleNumber = generateOrderNumber('HS');
    let totalAmount = 0;
    for (const it of items)
        totalAmount += (it.quantity || 0) * (it.unit_price || 0);
    await run("INSERT INTO recycles (recycle_number, customer_id, customer_name, total_amount, operator_id, operator_name, remark) VALUES (?, ?, ?, ?, ?, ?, ?)", [recycleNumber, customer_id || null, customer_name || null, totalAmount, req.user.id, req.user.real_name, remark || '']);
    const recycleId = (await safeExec("SELECT last_insert_rowid()")).values?.[0]?.[0];
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
        await run("INSERT INTO accounts (name, type, balance) VALUES ('现金', 'cash', 0)");
        accId = (await safeExec("SELECT last_insert_rowid()")).values?.[0]?.[0] || null;
    }
    if (accId) {
        await run("INSERT INTO transactions (type, account_id, amount, category, description, operator_id, operator_name, created_at) VALUES ('expense', ?, ?, '回收支出', ?, ?, ?, datetime('now','localtime'))", [accId, totalAmount, (customer_name || '散客') + ' 回收' + items.length + '项', req.user.id, req.user.real_name]);
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
app.get('/api/inventory/products/export', authMiddleware, hasPerm('inventory_view'), async (_req, res) => {
    await initDB();
    const result = await safeExec("SELECT name, category, spec, unit, cost_price, sell_price, stock_quantity, warning_quantity FROM products WHERE status = 1 ORDER BY id");
    const rows = [['商品名称', '分类', '规格', '单位', '进货价', '销售价', '库存数量', '预警数量']];
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
    const result = await safeExec("SELECT supplier_id, supplier_name, COUNT(*), COALESCE(SUM(total_amount),0) FROM purchase_orders WHERE status NOT IN ('cancelled','void') GROUP BY supplier_id, supplier_name ORDER BY SUM(total_amount) DESC");
    const list = (result.values || []).map((r) => ({
        supplier_id: r[0], supplier_name: r[1] || '未填供应商', order_count: Number(r[2]), total_amount: Number(r[3])
    }));
    res.json(list);
});
// ==================== 应收应付对账（智慧记模型：期初欠款 + 未结清销售/进货 - 已收/已付 = 期末欠款） ====================
app.get('/api/finance/arap', authMiddleware, hasPerm('finance_view'), async (_req, res) => {
    await initDB();
    // 客户：期初欠款 + 未结清销售单 - 客户收款流水（批量聚合）
    const custRows = (await safeExec(`SELECT c.id, c.name, COALESCE(c.initial_balance,0) ib,
        COALESCE(u.cnt,0) uc, COALESCE(u.amt,0) ua, COALESCE(p.amt,0) pa
        FROM customers c
        LEFT JOIN (SELECT customer_id, COUNT(*) cnt, SUM(final_amount) amt FROM sales_orders WHERE payment_status != '已结清' GROUP BY customer_id) u ON u.customer_id = c.id
        LEFT JOIN (SELECT party_id, SUM(amount) amt FROM transactions WHERE type='income' AND party_type='customer' GROUP BY party_id) p ON p.party_id = c.id
        WHERE c.status=1`)).values || [];
    const receivables = custRows.map((r) => {
        const initial = Number(r[2]) || 0;
        const unpaidAmt = Number(r[4]) || 0;
        const received = Number(r[5]) || 0;
        const balance = Math.round((initial + unpaidAmt - received) * 100) / 100;
        return {
            party_id: Number(r[0]), name: String(r[1] || ''),
            initial_balance: Math.round(initial * 100) / 100,
            unpaid_orders: Number(r[3]) || 0, unpaid_amount: Math.round(unpaidAmt * 100) / 100,
            received: Math.round(received * 100) / 100, balance,
        };
    }).filter((x) => Math.abs(x.balance) > 0.001 || x.unpaid_orders > 0)
      .sort((a, b) => b.balance - a.balance);
    // 供应商：期初欠款 + 未结清进货单 - 供应商付款流水
    const supRows = (await safeExec(`SELECT s.id, s.name, COALESCE(s.initial_balance,0) ib,
        COALESCE(u.cnt,0) uc, COALESCE(u.amt,0) ua, COALESCE(p.amt,0) pa
        FROM suppliers s
        LEFT JOIN (SELECT supplier_id, COUNT(*) cnt, SUM(total_amount) amt FROM purchase_orders WHERE payment_status != '已结清' GROUP BY supplier_id) u ON u.supplier_id = s.id
        LEFT JOIN (SELECT party_id, SUM(amount) amt FROM transactions WHERE type='expense' AND party_type='supplier' GROUP BY party_id) p ON p.party_id = s.id
        WHERE s.status=1`)).values || [];
    const payables = supRows.map((r) => {
        const initial = Number(r[2]) || 0;
        const unpaidAmt = Number(r[4]) || 0;
        const paid = Number(r[5]) || 0;
        const balance = Math.round((initial + unpaidAmt - paid) * 100) / 100;
        return {
            party_id: Number(r[0]), name: String(r[1] || ''),
            initial_balance: Math.round(initial * 100) / 100,
            unpaid_orders: Number(r[3]) || 0, unpaid_amount: Math.round(unpaidAmt * 100) / 100,
            paid: Math.round(paid * 100) / 100, balance,
        };
    }).filter((x) => Math.abs(x.balance) > 0.001 || x.unpaid_orders > 0)
      .sort((a, b) => b.balance - a.balance);
    res.json({
        receivables,
        payables,
        summary: {
            total_receivable: Math.round(receivables.reduce((s, r) => s + r.balance, 0) * 100) / 100,
            total_payable: Math.round(payables.reduce((s, r) => s + r.balance, 0) * 100) / 100,
        },
    });
});
// 客户对账单：期初 + 销售单 + 收款流水明细
app.get('/api/finance/customer-statement/:id', authMiddleware, hasPerm('finance_view'), async (req, res) => {
    await initDB();
    const cid = Number(req.params.id);
    const cust = (await safeExec("SELECT id, name, COALESCE(initial_balance,0) FROM customers WHERE id = ?", [cid])).values?.[0];
    if (!cust) return res.status(404).json({ error: '客户不存在' });
    const orders = (await safeExec("SELECT order_number, created_at, final_amount, payment_status FROM sales_orders WHERE customer_id = ? ORDER BY id", [cid])).values || [];
    const payments = (await safeExec("SELECT created_at, amount, description FROM transactions WHERE type='income' AND party_type='customer' AND party_id = ? ORDER BY id", [cid])).values || [];
    res.json({
        name: cust[1], initial_balance: Number(cust[2]) || 0,
        orders: orders.map((o) => ({ order_number: o[0], created_at: o[1], amount: Number(o[2]), status: o[3] })),
        payments: payments.map((p) => ({ created_at: p[0], amount: Number(p[1]), description: p[2] })),
    });
});
// 供应商对账单：期初 + 进货单 + 付款流水明细
app.get('/api/finance/supplier-statement/:id', authMiddleware, hasPerm('finance_view'), async (req, res) => {
    await initDB();
    const sid = Number(req.params.id);
    const sup = (await safeExec("SELECT id, name, COALESCE(initial_balance,0) FROM suppliers WHERE id = ?", [sid])).values?.[0];
    if (!sup) return res.status(404).json({ error: '供应商不存在' });
    const orders = (await safeExec("SELECT order_number, created_at, total_amount, payment_status FROM purchase_orders WHERE supplier_id = ? ORDER BY id", [sid])).values || [];
    const payments = (await safeExec("SELECT created_at, amount, description FROM transactions WHERE type='expense' AND party_type='supplier' AND party_id = ? ORDER BY id", [sid])).values || [];
    res.json({
        name: sup[1], initial_balance: Number(sup[2]) || 0,
        orders: orders.map((o) => ({ order_number: o[0], created_at: o[1], amount: Number(o[2]), status: o[3] })),
        payments: payments.map((p) => ({ created_at: p[0], amount: Number(p[1]), description: p[2] })),
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
app.post('/api/store/reservations', authMiddleware, hasPerm('sales'), async (req, res) => {
    await initDB();
    let { customer_id, customer_name, items, remark } = req.body;
    if (!customer_id && customer_name) {
        const cidRes = await safeExec("SELECT id FROM customers WHERE name = ? ORDER BY id LIMIT 1", [customer_name]);
        if (cidRes.values?.[0]?.[0]) customer_id = cidRes.values[0][0];
    }
    if (!items || !items.length) return res.status(400).json({ error: '请添加预订商品' });
    const rn = generateOrderNumber('YD');
    let totalAmount = 0;
    for (const it of items) totalAmount += (it.quantity || 0) * (it.price || 0);
    await run("INSERT INTO sales_reservations (reservation_number, customer_id, customer_name, total_amount, status, remark, operator_id, operator_name) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)",
        [rn, customer_id || null, customer_name || null, totalAmount, remark || '', req.user.id, req.user.real_name]);
    const rid = (await safeExec("SELECT last_insert_rowid()")).values?.[0]?.[0];
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
    const orderNumber = generateOrderNumber('XS');
    const finalAmount = Number(r[4]) || 0;
    await run("INSERT INTO sales_orders (order_number, customer_id, customer_name, total_amount, discount, final_amount, payment_method, operator_id, operator_name) VALUES (?, ?, ?, ?, 0, ?, NULL, ?, ?)",
        [orderNumber, r[2], r[3], finalAmount, finalAmount, req.user.id, req.user.real_name]);
    const orderId = (await safeExec("SELECT last_insert_rowid()")).values?.[0]?.[0];
    for (const it of items) {
        await run("INSERT INTO sales_order_items (order_id, product_id, product_name, sku, quantity, unit_price, amount) VALUES (?, ?, ?, ?, ?, ?, ?)",
            [orderId, it[2], it[3], it[4] || '', it[5], it[6], it[7]]);
        if (it[2]) await run("UPDATE products SET stock_quantity = stock_quantity - ? WHERE id = ?", [it[5], it[2]]);
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
app.post('/api/store/purchase-returns', authMiddleware, hasPerm('purchase'), async (req, res) => {
    await initDB();
    const { purchase_order_id, supplier_id, supplier_name, items, reason } = req.body;
    if (!items || !items.length) return res.status(400).json({ error: '请添加退货商品' });
    const rn = generateOrderNumber('TH');
    let totalAmount = 0;
    for (const it of items) totalAmount += (it.quantity || 0) * (it.price || 0);
    await run("INSERT INTO purchase_returns (return_number, purchase_order_id, supplier_id, supplier_name, total_amount, reason, operator_id, operator_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [rn, purchase_order_id || null, supplier_id || null, supplier_name || null, totalAmount, reason || '', req.user.id, req.user.real_name]);
    const rid = (await safeExec("SELECT last_insert_rowid()")).values?.[0]?.[0];
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
app.post('/api/store/quotes', authMiddleware, hasPerm('sales'), async (req, res) => {
    await initDB();
    let { customer_id, customer_name, items, remark } = req.body;
    if (!customer_id && customer_name) {
        const cidRes = await safeExec("SELECT id FROM customers WHERE name = ? ORDER BY id LIMIT 1", [customer_name]);
        if (cidRes.values?.[0]?.[0]) customer_id = cidRes.values[0][0];
    }
    if (!items || !items.length) return res.status(400).json({ error: '请添加报价商品' });
    const qn = generateOrderNumber('BJ');
    let totalAmount = 0;
    for (const it of items) totalAmount += (it.quantity || 0) * (it.price || 0);
    await run("INSERT INTO quotes (quote_number, customer_id, customer_name, total_amount, status, remark, operator_id, operator_name) VALUES (?, ?, ?, ?, 'draft', ?, ?, ?)",
        [qn, customer_id || null, customer_name || null, totalAmount, remark || '', req.user.id, req.user.real_name]);
    const qid = (await safeExec("SELECT last_insert_rowid()")).values?.[0]?.[0];
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
    const orderNumber = generateOrderNumber('XS');
    const finalAmount = Number(q[4]) || 0;
    await run("INSERT INTO sales_orders (order_number, customer_id, customer_name, total_amount, discount, final_amount, payment_method, operator_id, operator_name) VALUES (?, ?, ?, ?, 0, ?, NULL, ?, ?)",
        [orderNumber, q[2], q[3], finalAmount, finalAmount, req.user.id, req.user.real_name]);
    const orderId = (await safeExec("SELECT last_insert_rowid()")).values?.[0]?.[0];
    for (const it of items) {
        await run("INSERT INTO sales_order_items (order_id, product_id, product_name, sku, quantity, unit_price, amount) VALUES (?, ?, ?, ?, ?, ?, ?)",
            [orderId, it[2], it[3], it[4] || '', it[5], it[6], it[7]]);
        if (it[2]) await run("UPDATE products SET stock_quantity = stock_quantity - ? WHERE id = ?", [it[5], it[2]]);
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
    const start = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
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
async function start() {
    await initDB();
    const server = app.listen(PORT, '0.0.0.0', () => {
        console.log(`HongruiBOSS Backend Server - http://localhost:${PORT}`);
    });
}
start().catch(console.error);
