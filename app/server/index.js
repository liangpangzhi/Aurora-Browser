require('dns').setDefaultResultOrder('ipv4first');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const { URL } = require('url');

const { readJson, writeJson, isDirWritable } = require('./storage');
const { createTlsManager } = require('./tls');
const { createDownloadManager } = require('./downloads');
const { createLiteProxy } = require('./lite-proxy');

const APP_VERSION = (() => {
    // fnpack 安装后不会保留 manifest，优先使用飞牛注入的版本号
    if (process.env.TRIM_APPVER) return process.env.TRIM_APPVER;
    try {
        const manifest = fs.readFileSync(path.resolve(__dirname, '../../manifest'), 'utf8');
        const line = manifest.split(/\r?\n/).find((l) => /^version\s*=/.test(l));
        return line ? line.split('=')[1].trim() : '1.0.19';
    } catch {
        return '1.0.19';
    }
})();

const ENV_AUTH_TOKEN = process.env.AUTH_TOKEN || '';
const TOKEN_PARAM = '_aurora_token';
const SESSION_COOKIE_NAME = 'aurora_session';
let activeAuthToken = ENV_AUTH_TOKEN;

function sessionCookieFor(secret) {
    if (!secret) return '';
    return crypto.createHmac('sha256', secret).update('aurora-session-v1').digest('hex');
}

function buildSessionCookieHeader(req, secret) {
    const isHttps = Boolean(req.socket && req.socket.encrypted) || req.headers['x-forwarded-proto'] === 'https';
    if (!secret) {
        return [`${SESSION_COOKIE_NAME}=`, 'HttpOnly', 'SameSite=Lax', 'Path=/', 'Max-Age=0', isHttps ? 'Secure' : '']
            .filter(Boolean)
            .join('; ');
    }
    return [
        `${SESSION_COOKIE_NAME}=${encodeURIComponent(sessionCookieFor(secret))}`,
        'HttpOnly',
        'SameSite=Lax',
        'Path=/',
        'Max-Age=2592000',
        isHttps ? 'Secure' : ''
    ]
        .filter(Boolean)
        .join('; ');
}

function getCookie(req, name) {
    const raw = req.headers.cookie || '';
    const parts = raw.split(';');
    for (const part of parts) {
        const eq = part.indexOf('=');
        if (eq === -1) continue;
        if (part.slice(0, eq).trim() === name) {
            return decodeURIComponent(part.slice(eq + 1).trim());
        }
    }
    return '';
}

function isAuthorized(req, parsedUrl) {
    if (!activeAuthToken) return true;
    const headerToken = req.headers['x-aurora-token'];
    const queryToken = parsedUrl && parsedUrl.searchParams ? parsedUrl.searchParams.get(TOKEN_PARAM) : null;
    const cookieVal = getCookie(req, SESSION_COOKIE_NAME);
    const expected = sessionCookieFor(activeAuthToken);
    return (
        headerToken === activeAuthToken ||
        queryToken === activeAuthToken ||
        (expected && cookieVal === expected)
    );
}

const PORT = parseInt(process.env.PORT || '18920', 10);
const HTTPS_PORT = parseInt(process.env.HTTPS_PORT || '18921', 10);
const HOST = process.env.HOST || '0.0.0.0';
const WWW_DIR = process.env.WWW_DIR || path.resolve(__dirname, '../www');
const DATA_DIR = process.env.DATA_DIR || path.resolve(__dirname, '../../data');
const CACHE_DIR = process.env.CACHE_DIR || path.join(DATA_DIR, 'sessions');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(CACHE_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// 1. 本地持久化与模块装配
// ---------------------------------------------------------------------------
const BOOKMARKS_FILE = path.join(DATA_DIR, 'bookmarks.json');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const DOWNLOADS_FILE = path.join(DATA_DIR, 'downloads.json');
const DEFAULT_DOWNLOAD_DIR = path.join(DATA_DIR, 'downloads');
fs.mkdirSync(DEFAULT_DOWNLOAD_DIR, { recursive: true });

const DEFAULT_BOOKMARKS = [
    { id: 'bm-1', title: '必应搜索', url: 'https://cn.bing.com', category: '常用网站', color: '#0FC6C2' },
    { id: 'bm-2', title: 'Bilibili', url: 'https://www.bilibili.com', category: '常用网站', color: '#FB7299' },
    { id: 'bm-3', title: 'GitHub', url: 'https://github.com', category: '常用网站', color: '#24292F' },
    { id: 'bm-4', title: 'OpenAI', url: 'https://openai.com', category: '常用网站', color: '#10A37F' },
    { id: 'bm-5', title: 'Gemini', url: 'https://gemini.google.com', category: '常用网站', color: '#4796E3' },
    { id: 'bm-6', title: 'Muse', url: 'https://muse.ai', category: '常用网站', color: '#7B61FF' }
];

const DEFAULT_SETTINGS = {
    searchEngine: 'bing',
    theme: 'system',
    homepageMode: 'dashboard',
    maxHistory: 200,
    downloadDir: DEFAULT_DOWNLOAD_DIR
};

readJson(BOOKMARKS_FILE, DEFAULT_BOOKMARKS);
readJson(HISTORY_FILE, []);
const initSettings = readJson(SETTINGS_FILE, DEFAULT_SETTINGS);
if (!ENV_AUTH_TOKEN && initSettings.authPassword) {
    activeAuthToken = String(initSettings.authPassword);
}
readJson(DOWNLOADS_FILE, []);

const tlsManager = createTlsManager({
    dataDir: DATA_DIR,
    settingsFile: SETTINGS_FILE,
    defaultSettings: DEFAULT_SETTINGS,
    httpsPort: HTTPS_PORT,
    readJson
});

const downloadManager = createDownloadManager({
    downloadsFile: DOWNLOADS_FILE,
    defaultDownloadDir: DEFAULT_DOWNLOAD_DIR,
    readJson,
    writeJson,
    isDirWritable
});

const handleLiteProxy = createLiteProxy({ tokenParam: TOKEN_PARAM });

// ---------------------------------------------------------------------------
// 2. 加载代理内核：Scramjet（Mercury Workshop）+ Wisp 服务端
// ---------------------------------------------------------------------------
let engineMode = 'lite';
let sjAssetDirs = null;
let wispRouteRequest = null;

try {
    const { scramjetPath } = require('@mercuryworkshop/scramjet/path');
    const { controllerPath } = require('@mercuryworkshop/scramjet-controller/path');
    const utilsDir = path.dirname(require.resolve('@mercuryworkshop/scramjet-utils'));
    const epoxyDir = path.dirname(require.resolve('@mercuryworkshop/epoxy-transport'));
    const wispServer = require('@mercuryworkshop/wisp-js/server').server;
    if (typeof wispServer.routeRequest !== 'function') {
        throw new Error('wisp-js server.routeRequest unavailable');
    }
    sjAssetDirs = {
        '/scramjet/': scramjetPath,
        '/controller/': controllerPath,
        '/utils/': utilsDir,
        '/epoxy/': epoxyDir
    };
    if (wispServer.options) {
        wispServer.options.allow_private_ips = true;
        // 部分 NAS 环境 IPv6 出站不通但 DNS 优先返回 AAAA，Wisp 默认 verbatim 会挂住
        wispServer.options.dns_result_order = 'ipv4first';
    }
    wispRouteRequest = wispServer.routeRequest.bind(wispServer);
    engineMode = 'scramjet';
    console.log('[fn-browser] Scramjet + Wisp 内核已就绪');
} catch (err) {
    console.log(`[fn-browser] 未检测到 Scramjet 依赖，启用内置零依赖轻量代理内核（${err.message}）`);
}

const SJ_MIME_TYPES = {
    '.js': 'application/javascript; charset=utf-8',
    '.mjs': 'application/javascript; charset=utf-8',
    '.wasm': 'application/wasm',
    '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8'
};

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2'
};

// 不设置 COOP/COEP：飞牛桌面是 HTTP 页面，内嵌 iframe 时跨源隔离会被祖先置为 false，
// 再叠加 COEP 会导致 Scramjet 文档请求被 ERR_BLOCKED_BY_RESPONSE 拦截，图片/视频空白。
const CROSS_ORIGIN_ISOLATION_HEADERS = {};

function serveFileFromDir(req, res, baseDir, relPath, extraHeaders = {}) {
    const safeRel = path.normalize(relPath).replace(/^(\.\.[\/\\])+/, '');
    const filePath = path.join(baseDir, safeRel);
    if (!filePath.startsWith(baseDir)) {
        res.writeHead(403);
        res.end('Forbidden');
        return true;
    }
    try {
        const stats = fs.statSync(filePath);
        if (!stats.isFile()) return false;
        const ext = path.extname(filePath).toLowerCase();
        const headers = {
            'Content-Type': SJ_MIME_TYPES[ext] || MIME_TYPES[ext] || 'application/octet-stream',
            'Cache-Control': 'public, max-age=3600',
            ...extraHeaders
        };
        res.writeHead(200, headers);
        fs.createReadStream(filePath).pipe(res);
        return true;
    } catch {
        return false;
    }
}

function serveScramjetAsset(req, res, pathname) {
    if (!sjAssetDirs) return false;
    for (const [prefix, dir] of Object.entries(sjAssetDirs)) {
        if (pathname.startsWith(prefix)) {
            return serveFileFromDir(req, res, dir, pathname.slice(prefix.length), CROSS_ORIGIN_ISOLATION_HEADERS);
        }
    }
    return false;
}

// ---------------------------------------------------------------------------
// 3. REST API 路由
// ---------------------------------------------------------------------------
function sendJson(res, status, data, extraHeaders = {}) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders });
    res.end(JSON.stringify(data));
}

function parseBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', (chunk) => {
            body += chunk;
            if (body.length > 1024 * 1024) {
                reject(new Error('Payload too large'));
                req.destroy();
            }
        });
        req.on('end', () => {
            try {
                resolve(body ? JSON.parse(body) : {});
            } catch (e) {
                reject(e);
            }
        });
        req.on('error', reject);
    });
}

async function handleApi(req, res, pathname, parsedUrl) {
    // 查询是否开启了访问密码（免鉴权）
    if (pathname === '/api/auth/status' && req.method === 'GET') {
        return sendJson(res, 200, {
            authRequired: Boolean(activeAuthToken),
            envLocked: Boolean(ENV_AUTH_TOKEN),
            authenticated: isAuthorized(req, parsedUrl)
        });
    }

    // 鉴权交换 HttpOnly 会话 Cookie（支持请求头、URL 参数或表单密码）
    if (pathname === '/api/auth/session' && req.method === 'POST') {
        let bodyPass = '';
        try {
            const body = await parseBody(req);
            if (body && typeof body.password === 'string') bodyPass = body.password;
        } catch {}
        const ok = isAuthorized(req, parsedUrl) || (activeAuthToken && bodyPass === activeAuthToken);
        if (!ok) {
            return sendJson(res, 401, { error: '访问密码错误' });
        }
        if (!activeAuthToken) {
            return sendJson(res, 200, { ok: true, authEnabled: false });
        }
        return sendJson(
            res,
            200,
            { ok: true, authEnabled: true },
            { 'Set-Cookie': buildSessionCookieHeader(req, activeAuthToken) }
        );
    }

    if (!isAuthorized(req, parsedUrl)) {
        return sendJson(res, 401, { error: 'Unauthorized' });
    }

    if (pathname === '/api/status' && req.method === 'GET') {
        const hs = tlsManager.httpsStatus;
        return sendJson(res, 200, {
            ok: true,
            engine: engineMode,
            https: { enabled: hs.enabled, port: hs.port, mode: hs.mode },
            version: APP_VERSION,
            uptime: Math.floor(process.uptime()),
            memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024)
        });
    }

    if (pathname === '/api/bookmarks') {
        if (req.method === 'GET') {
            return sendJson(res, 200, readJson(BOOKMARKS_FILE, DEFAULT_BOOKMARKS));
        }
        if (req.method === 'POST') {
            const data = await parseBody(req);
            const list = readJson(BOOKMARKS_FILE, DEFAULT_BOOKMARKS);
            const item = {
                id: `bm-${Date.now()}`,
                title: String(data.title || '未命名网页').slice(0, 40),
                url: String(data.url || '').trim(),
                category: String(data.category || '常用网站').slice(0, 20),
                color: String(data.color || '#165DFF')
            };
            if (!item.url) return sendJson(res, 400, { error: 'URL is required' });
            list.push(item);
            writeJson(BOOKMARKS_FILE, list);
            return sendJson(res, 201, item);
        }
    }

    if (pathname.startsWith('/api/bookmarks/') && req.method === 'DELETE') {
        const id = decodeURIComponent(pathname.slice('/api/bookmarks/'.length));
        const list = readJson(BOOKMARKS_FILE, DEFAULT_BOOKMARKS).filter((b) => b.id !== id);
        writeJson(BOOKMARKS_FILE, list);
        return sendJson(res, 200, { ok: true });
    }

    if (pathname === '/api/history') {
        if (req.method === 'GET') {
            return sendJson(res, 200, readJson(HISTORY_FILE, []));
        }
        if (req.method === 'POST') {
            const data = await parseBody(req);
            if (!data.url || data.url.startsWith('fn://')) {
                return sendJson(res, 200, { ok: true });
            }
            const settings = readJson(SETTINGS_FILE, DEFAULT_SETTINGS);
            let list = readJson(HISTORY_FILE, []);
            list = list.filter((h) => h.url !== data.url);
            list.unshift({
                id: `his-${Date.now()}`,
                title: String(data.title || data.url).slice(0, 80),
                url: String(data.url),
                visitedAt: new Date().toISOString()
            });
            if (list.length > (settings.maxHistory || 200)) {
                list = list.slice(0, settings.maxHistory || 200);
            }
            writeJson(HISTORY_FILE, list);
            return sendJson(res, 201, { ok: true });
        }
        if (req.method === 'DELETE') {
            writeJson(HISTORY_FILE, []);
            return sendJson(res, 200, { ok: true });
        }
    }

    if (pathname === '/api/settings') {
        if (req.method === 'GET') {
            const current = readJson(SETTINGS_FILE, DEFAULT_SETTINGS);
            if (!current.downloadDir) current.downloadDir = DEFAULT_DOWNLOAD_DIR;
            const { authPassword, ...safe } = current;
            return sendJson(res, 200, {
                ...safe,
                hasAuthPassword: Boolean(authPassword),
                envLocked: Boolean(ENV_AUTH_TOKEN)
            });
        }
        if (req.method === 'PUT') {
            const patch = await parseBody(req);
            const current = readJson(SETTINGS_FILE, DEFAULT_SETTINGS);
            const extraHeaders = {};
            if (typeof patch.authPassword === 'string') {
                if (ENV_AUTH_TOKEN) {
                    return sendJson(res, 400, { error: '已通过环境变量 AUTH_TOKEN 锁定，无法在界面修改' });
                }
                const nextPass = patch.authPassword.trim();
                patch.authPassword = nextPass;
                activeAuthToken = nextPass;
                extraHeaders['Set-Cookie'] = buildSessionCookieHeader(req, activeAuthToken);
            }
            if (typeof patch.downloadDir === 'string') {
                const targetDir = path.resolve(patch.downloadDir.trim() || DEFAULT_DOWNLOAD_DIR);
                try {
                    fs.mkdirSync(targetDir, { recursive: true });
                    if (!isDirWritable(targetDir)) {
                        return sendJson(res, 400, {
                            code: 'EACCES_SHARE_PATH',
                            error: '该目录不可写，请在飞牛「应用设置 -> 文件夹权限」中授权，或选择应用默认目录'
                        });
                    }
                    patch.downloadDir = targetDir;
                } catch (err) {
                    const code = err && (err.code === 'EACCES' || err.code === 'EPERM') ? 'EACCES_SHARE_PATH' : 'DIR_ERROR';
                    return sendJson(res, 400, { code, error: `无法访问目录: ${err.message}` });
                }
            }
            const updated = { ...current, ...patch };
            writeJson(SETTINGS_FILE, updated);
            const { authPassword, ...safe } = updated;
            return sendJson(
                res,
                200,
                {
                    ...safe,
                    hasAuthPassword: Boolean(authPassword),
                    envLocked: Boolean(ENV_AUTH_TOKEN)
                },
                extraHeaders
            );
        }
    }

    if (pathname === '/api/fs/roots' && req.method === 'GET') {
        return sendJson(res, 200, {
            defaultDir: DEFAULT_DOWNLOAD_DIR,
            roots: downloadManager.getFnOsRoots()
        });
    }

    if (pathname === '/api/fs/list' && req.method === 'GET') {
        const result = downloadManager.listDir(parsedUrl.searchParams.get('dir'));
        return sendJson(res, result.ok ? 200 : 400, result);
    }

    if (pathname === '/api/fs/mkdir' && req.method === 'POST') {
        const body = await parseBody(req);
        const result = downloadManager.makeDir(body.parent, body.name);
        return sendJson(res, result.ok ? 201 : 400, result);
    }

    if (pathname === '/api/downloads') {
        if (req.method === 'GET') {
            const settings = readJson(SETTINGS_FILE, DEFAULT_SETTINGS);
            return sendJson(res, 200, {
                downloadDir: settings.downloadDir || DEFAULT_DOWNLOAD_DIR,
                items: downloadManager.getDownloadsList()
            });
        }
        if (req.method === 'POST') {
            const body = await parseBody(req);
            const settings = readJson(SETTINGS_FILE, DEFAULT_SETTINGS);
            const dir = body.dir || settings.downloadDir || DEFAULT_DOWNLOAD_DIR;
            try {
                const record = downloadManager.startNasDownload(body.url, body.filename, dir);
                return sendJson(res, 201, record);
            } catch (err) {
                return sendJson(res, 400, { code: err.code || 'DOWNLOAD_ERROR', error: err.message });
            }
        }
        if (req.method === 'DELETE') {
            downloadManager.clearFinished();
            return sendJson(res, 200, { ok: true });
        }
    }

    if (pathname.startsWith('/api/downloads/')) {
        const rest = pathname.slice('/api/downloads/'.length);
        if (rest.endsWith('/cancel') && req.method === 'POST') {
            const id = decodeURIComponent(rest.slice(0, -'/cancel'.length));
            downloadManager.cancelDownload(id);
            return sendJson(res, 200, { ok: true });
        }
        if (rest.endsWith('/file') && req.method === 'GET') {
            const id = decodeURIComponent(rest.slice(0, -'/file'.length));
            const item = downloadManager.findDownload(id);
            if (!item || !item.filePath || !fs.existsSync(item.filePath)) {
                return sendJson(res, 404, { error: '文件不存在或已被移动' });
            }
            const stat = fs.statSync(item.filePath);
            res.writeHead(200, {
                'Content-Type': 'application/octet-stream',
                'Content-Length': stat.size,
                'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(item.filename)}`
            });
            return fs.createReadStream(item.filePath).pipe(res);
        }
        if (req.method === 'DELETE') {
            const id = decodeURIComponent(rest);
            downloadManager.deleteDownload(id, parsedUrl.searchParams.get('deleteFile') === '1');
            return sendJson(res, 200, { ok: true });
        }
    }

    return sendJson(res, 404, { error: 'API route not found' });
}

function serveStatic(req, res, pathname) {
    let relPath = pathname === '/' ? '/index.html' : pathname;
    relPath = path.normalize(relPath).replace(/^(\.\.[\/\\])+/, '');
    const filePath = path.join(WWW_DIR, relPath);

    if (!filePath.startsWith(WWW_DIR)) {
        res.writeHead(403);
        return res.end('Forbidden');
    }

    fs.stat(filePath, (err, stats) => {
        if (err || !stats.isFile()) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            return res.end('404 Not Found');
        }
        const ext = path.extname(filePath).toLowerCase();
        const headers = { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' };
        if (relPath === '/index.html') {
            Object.assign(headers, CROSS_ORIGIN_ISOLATION_HEADERS);
        }
        res.writeHead(200, headers);
        fs.createReadStream(filePath).pipe(res);
    });
}

// ---------------------------------------------------------------------------
// 4. 统一 HTTP & WebSocket 入口
// ---------------------------------------------------------------------------
const requestHandler = async (req, res) => {
    try {
        const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        const pathname = parsedUrl.pathname;

        // 免鉴权健康检查端点
        if (pathname === '/healthz' && req.method === 'GET') {
            return sendJson(res, 200, {
                status: 'ok',
                version: APP_VERSION,
                engine: engineMode,
                https: tlsManager.httpsStatus.enabled,
                uptime: Math.floor(process.uptime())
            }, { 'Access-Control-Allow-Origin': '*' });
        }

        if (pathname === '/sw.js') {
            return serveFileFromDir(req, res, WWW_DIR, 'sw.js', {
                'Cache-Control': 'no-cache',
                ...CROSS_ORIGIN_ISOLATION_HEADERS
            });
        }

        const caDer = tlsManager.getCaCertDer();
        if (pathname === '/aurora-ca.crt' && caDer) {
            res.writeHead(200, {
                'Content-Type': 'application/x-x509-ca-cert',
                'Content-Disposition': 'attachment; filename="aurora-ca.crt"',
                'Cache-Control': 'no-cache'
            });
            return res.end(caDer);
        }
        if (pathname === '/aurora-ca.mobileconfig' && caDer) {
            res.writeHead(200, {
                'Content-Type': 'application/x-apple-aspen-config',
                'Content-Disposition': 'attachment; filename="aurora-ca.mobileconfig"',
                'Cache-Control': 'no-cache'
            });
            return res.end(tlsManager.buildCaMobileConfig());
        }

        if (serveScramjetAsset(req, res, pathname)) {
            return;
        }

        if (pathname.startsWith('/lite-proxy/')) {
            if (!isAuthorized(req, parsedUrl)) {
                res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
                return res.end('Unauthorized');
            }
            const encoded = pathname.slice('/lite-proxy/'.length);
            return handleLiteProxy(req, res, encoded, parsedUrl.search);
        }

        if (pathname.startsWith('/api/')) {
            return await handleApi(req, res, pathname, parsedUrl);
        }

        return serveStatic(req, res, pathname);
    } catch (err) {
        console.error('[fn-browser] Request error:', err);
        if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Internal Server Error');
        }
    }
};

const upgradeHandler = (req, socket, head) => {
    try {
        const parsed = new URL(req.url || '/', 'http://localhost');
        if (parsed.pathname === '/wisp/' && wispRouteRequest) {
            if (!isAuthorized(req, parsed)) {
                return socket.destroy();
            }
            req.url = parsed.pathname;
            return wispRouteRequest(req, socket, head);
        }
    } catch (err) {
        console.error('[fn-browser] WebSocket upgrade error:', err);
    }
    socket.destroy();
};

const server = http.createServer(requestHandler);
server.on('upgrade', upgradeHandler);

server.listen(PORT, HOST, () => {
    console.log(`[fn-browser] 飞牛原生浏览器已启动: http://${HOST}:${PORT} (内核: ${engineMode})`);
});

try {
    const tlsMaterials = tlsManager.initTlsMaterials();
    if (tlsMaterials) {
        const httpsServer = https.createServer(
            { key: tlsMaterials.keyPem, cert: tlsMaterials.certPem },
            requestHandler
        );
        httpsServer.on('upgrade', upgradeHandler);
        httpsServer.on('error', (err) => {
            tlsManager.httpsStatus.enabled = false;
            console.log(`[fn-browser] HTTPS 监听异常，HTTPS 入口不可用（${err.message}）`);
        });
        httpsServer.listen(HTTPS_PORT, HOST, () => {
            tlsManager.httpsStatus.enabled = true;
            const certHint = tlsManager.httpsStatus.mode === 'custom'
                ? '使用自定义外部证书'
                : '根证书下载: /aurora-ca.crt';
            console.log(`[fn-browser] HTTPS 入口已启动: https://${HOST}:${HTTPS_PORT}（${certHint}）`);
        });
    }
} catch (err) {
    console.log(`[fn-browser] HTTPS 初始化失败，继续仅提供 HTTP（${err.message}）`);
}
