const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const { URL } = require('url');

function sanitizeFilename(name) {
    const cleaned = String(name || '')
        .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
        .replace(/^\.+/, '')
        .trim();
    return cleaned.slice(0, 180) || `download-${Date.now()}`;
}

function filenameFromDisposition(headerVal) {
    if (!headerVal) return '';
    const utf8Match = /filename\*\s*=\s*(?:UTF-8''|utf-8'')([^;]+)/i.exec(headerVal);
    if (utf8Match) {
        try {
            return sanitizeFilename(decodeURIComponent(utf8Match[1].trim().replace(/^["']|["']$/g, '')));
        } catch {}
    }
    const plainMatch = /filename\s*=\s*"([^"]+)"|filename\s*=\s*([^;]+)/i.exec(headerVal);
    if (plainMatch) {
        return sanitizeFilename((plainMatch[1] || plainMatch[2] || '').trim());
    }
    return '';
}

function uniqueFilePath(dir, filename) {
    const ext = path.extname(filename);
    const base = ext ? filename.slice(0, -ext.length) : filename;
    let candidate = path.join(dir, filename);
    let idx = 1;
    while (fs.existsSync(candidate) || fs.existsSync(`${candidate}.part`)) {
        candidate = path.join(dir, `${base} (${idx})${ext}`);
        idx += 1;
    }
    return candidate;
}

function createDownloadManager({ downloadsFile, defaultDownloadDir, readJson, writeJson, isDirWritable }) {
    const activeDownloads = new Map();

    function getFnOsRoots() {
        const roots = [];
        const seen = new Set();
        const pushRoot = (p, label) => {
            const resolved = path.resolve(p);
            if (seen.has(resolved)) return;
            try {
                if (!fs.statSync(resolved).isDirectory()) return;
            } catch {
                return;
            }
            seen.add(resolved);
            roots.push({ path: resolved, label, writable: isDirWritable(resolved) });
        };

        pushRoot(defaultDownloadDir, '默认下载目录 (应用数据)');
        const sharePaths = String(process.env.TRIM_DATA_SHARE_PATHS || '')
            .split(':')
            .map((s) => s.trim())
            .filter(Boolean);
        sharePaths.forEach((p, idx) => pushRoot(p, `飞牛授权目录${sharePaths.length > 1 ? ` ${idx + 1}` : ''}`));

        for (let i = 1; i <= 9; i++) {
            pushRoot(`/vol${i}`, `存储空间 ${i} (/vol${i})`);
        }
        pushRoot('/mnt', '挂载目录 (/mnt)');
        return roots;
    }

    function listDir(rawDir) {
        const target = path.resolve(rawDir || defaultDownloadDir);
        try {
            const entries = fs.readdirSync(target, { withFileTypes: true });
            const dirs = entries
                .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
                .map((e) => {
                    const full = path.join(target, e.name);
                    return { name: e.name, path: full, writable: isDirWritable(full) };
                })
                .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
            const parent = path.dirname(target);
            return {
                ok: true,
                dir: target,
                parent: parent !== target ? parent : null,
                writable: isDirWritable(target),
                dirs
            };
        } catch (err) {
            if (err && (err.code === 'EACCES' || err.code === 'EPERM')) {
                const probeDirs = [];
                const seenProbe = new Set();
                const tryProbe = (p, label) => {
                    const resolved = path.resolve(p);
                    if (seenProbe.has(resolved)) return;
                    if (resolved !== target && !resolved.startsWith(target + path.sep) && target !== '/') return;
                    try {
                        if (fs.statSync(resolved).isDirectory()) {
                            seenProbe.add(resolved);
                            probeDirs.push({
                                name: label || path.basename(resolved) || resolved,
                                path: resolved,
                                writable: isDirWritable(resolved)
                            });
                        }
                    } catch {}
                };
                String(process.env.TRIM_DATA_SHARE_PATHS || '')
                    .split(':')
                    .map((s) => s.trim())
                    .filter(Boolean)
                    .forEach((p) => tryProbe(p));
                tryProbe(path.join(target, '1000'), '1000 (默认用户目录)');
                tryProbe(path.join(target, '1000', 'Downloads'), '1000/Downloads');
                tryProbe(path.join(target, '1000', 'Download'), '1000/Download');

                const parent = path.dirname(target);
                return {
                    ok: true,
                    dir: target,
                    parent: parent !== target ? parent : null,
                    writable: false,
                    restricted: true,
                    code: 'EACCES_SHARE_PATH',
                    dirs: probeDirs
                };
            }
            return { ok: false, error: `无法读取目录: ${err.message}` };
        }
    }

    function makeDir(parentRaw, nameRaw) {
        const parent = path.resolve(String(parentRaw || defaultDownloadDir));
        const name = sanitizeFilename(nameRaw || '');
        if (!name) return { ok: false, error: '请输入文件夹名称' };
        const target = path.join(parent, name);
        try {
            fs.mkdirSync(target, { recursive: true });
            return { ok: true, path: target, name, writable: isDirWritable(target) };
        } catch (err) {
            const code = err && (err.code === 'EACCES' || err.code === 'EPERM') ? 'EACCES_SHARE_PATH' : 'MKDIR_FAILED';
            return { ok: false, code, error: `创建失败: ${err.message}` };
        }
    }

    function getDownloadsList() {
        const saved = readJson(downloadsFile, []);
        return saved.map((item) => {
            const active = activeDownloads.get(item.id);
            if (active) {
                return {
                    ...item,
                    status: 'downloading',
                    receivedBytes: active.receivedBytes,
                    totalBytes: active.totalBytes,
                    speedBps: active.speedBps
                };
            }
            return item;
        });
    }

    function updateDownloadRecord(id, patch) {
        const list = readJson(downloadsFile, []);
        const idx = list.findIndex((d) => d.id === id);
        if (idx === -1) return;
        list[idx] = { ...list[idx], ...patch };
        writeJson(downloadsFile, list);
    }

    function startNasDownload(rawUrl, preferredName, targetDir) {
        let parsed;
        try {
            parsed = new URL(String(rawUrl || '').trim());
        } catch {
            throw new Error('无效的下载地址');
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            throw new Error('仅支持 http / https 下载地址');
        }

        const dir = path.resolve(targetDir || defaultDownloadDir);
        fs.mkdirSync(dir, { recursive: true });
        if (!isDirWritable(dir)) {
            const err = new Error('目标目录不可写，请在飞牛「应用设置 -> 文件夹权限」中授权该目录');
            err.code = 'EACCES_SHARE_PATH';
            throw err;
        }

        let fallbackName = preferredName ? sanitizeFilename(preferredName) : '';
        if (!fallbackName) {
            try {
                const base = path.basename(decodeURIComponent(parsed.pathname));
                if (base && base !== '/') fallbackName = sanitizeFilename(base);
            } catch {}
        }
        if (!fallbackName) fallbackName = `download-${Date.now()}`;

        const id = `dl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        const record = {
            id,
            url: parsed.href,
            filename: fallbackName,
            dir,
            filePath: '',
            status: 'downloading',
            receivedBytes: 0,
            totalBytes: 0,
            speedBps: 0,
            error: '',
            createdAt: new Date().toISOString()
        };

        const list = readJson(downloadsFile, []);
        list.unshift(record);
        if (list.length > 100) list.length = 100;
        writeJson(downloadsFile, list);

        const stateObj = {
            req: null,
            stream: null,
            tmpPath: '',
            cancelled: false,
            receivedBytes: 0,
            totalBytes: 0,
            speedBps: 0,
            lastBytes: 0,
            lastTick: Date.now()
        };
        activeDownloads.set(id, stateObj);

        const fetchUrl = (currentUrl, redirectsLeft) => {
            if (stateObj.cancelled) return;
            let u;
            try {
                u = new URL(currentUrl);
            } catch {
                activeDownloads.delete(id);
                return updateDownloadRecord(id, { status: 'failed', error: '重定向地址无效' });
            }
            const mod = u.protocol === 'https:' ? https : http;
            const req = mod.get(
                u,
                {
                    headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AuroraBrowser/1.0' },
                    rejectUnauthorized: false
                },
                (resp) => {
                    if ([301, 302, 303, 307, 308].includes(resp.statusCode) && resp.headers.location) {
                        resp.resume();
                        if (redirectsLeft <= 0) {
                            activeDownloads.delete(id);
                            return updateDownloadRecord(id, { status: 'failed', error: '重定向次数过多' });
                        }
                        return fetchUrl(new URL(resp.headers.location, u).href, redirectsLeft - 1);
                    }
                    if (resp.statusCode >= 400) {
                        resp.resume();
                        activeDownloads.delete(id);
                        return updateDownloadRecord(id, { status: 'failed', error: `HTTP ${resp.statusCode}` });
                    }

                    const dispName = filenameFromDisposition(resp.headers['content-disposition']);
                    const finalName = dispName || fallbackName;
                    const finalPath = uniqueFilePath(dir, finalName);
                    const tmpPath = `${finalPath}.part`;
                    stateObj.tmpPath = tmpPath;
                    stateObj.totalBytes = parseInt(resp.headers['content-length'] || '0', 10) || 0;
                    updateDownloadRecord(id, {
                        filename: path.basename(finalPath),
                        filePath: finalPath,
                        totalBytes: stateObj.totalBytes
                    });

                    const ws = fs.createWriteStream(tmpPath);
                    stateObj.stream = ws;

                    resp.on('data', (chunk) => {
                        stateObj.receivedBytes += chunk.length;
                        const now = Date.now();
                        const dt = now - stateObj.lastTick;
                        if (dt >= 500) {
                            stateObj.speedBps = Math.round(((stateObj.receivedBytes - stateObj.lastBytes) * 1000) / dt);
                            stateObj.lastBytes = stateObj.receivedBytes;
                            stateObj.lastTick = now;
                        }
                    });

                    resp.pipe(ws);

                    ws.on('finish', () => {
                        activeDownloads.delete(id);
                        if (stateObj.cancelled) {
                            try { fs.unlinkSync(tmpPath); } catch {}
                            return;
                        }
                        try {
                            fs.renameSync(tmpPath, finalPath);
                            updateDownloadRecord(id, {
                                status: 'completed',
                                receivedBytes: stateObj.receivedBytes,
                                totalBytes: stateObj.totalBytes || stateObj.receivedBytes,
                                speedBps: 0,
                                finishedAt: new Date().toISOString()
                            });
                        } catch (err) {
                            updateDownloadRecord(id, { status: 'failed', error: err.message });
                        }
                    });

                    ws.on('error', (err) => {
                        activeDownloads.delete(id);
                        try { fs.unlinkSync(tmpPath); } catch {}
                        if (!stateObj.cancelled) updateDownloadRecord(id, { status: 'failed', error: err.message });
                    });

                    resp.on('error', (err) => {
                        activeDownloads.delete(id);
                        try { ws.destroy(); } catch {}
                        try { fs.unlinkSync(tmpPath); } catch {}
                        if (!stateObj.cancelled) updateDownloadRecord(id, { status: 'failed', error: err.message });
                    });
                }
            );
            stateObj.req = req;
            req.on('error', (err) => {
                activeDownloads.delete(id);
                if (!stateObj.cancelled) updateDownloadRecord(id, { status: 'failed', error: err.message });
            });
        };

        fetchUrl(parsed.href, 5);
        return record;
    }

    function cancelDownload(id) {
        const active = activeDownloads.get(id);
        if (active) {
            active.cancelled = true;
            try { if (active.req) active.req.destroy(); } catch {}
            try { if (active.stream) active.stream.destroy(); } catch {}
            try { if (active.tmpPath) fs.unlinkSync(active.tmpPath); } catch {}
            activeDownloads.delete(id);
        }
        updateDownloadRecord(id, { status: 'cancelled', speedBps: 0 });
    }

    function clearFinished() {
        const remaining = readJson(downloadsFile, []).filter((d) => activeDownloads.has(d.id));
        writeJson(downloadsFile, remaining);
    }

    function deleteDownload(id, deleteFile) {
        const list = readJson(downloadsFile, []);
        const item = list.find((d) => d.id === id);
        if (item && deleteFile && item.filePath) {
            try { fs.unlinkSync(item.filePath); } catch {}
        }
        writeJson(downloadsFile, list.filter((d) => d.id !== id));
    }

    function findDownload(id) {
        return readJson(downloadsFile, []).find((d) => d.id === id);
    }

    return {
        getFnOsRoots,
        listDir,
        makeDir,
        getDownloadsList,
        startNasDownload,
        cancelDownload,
        clearFinished,
        deleteDownload,
        findDownload
    };
}

module.exports = { createDownloadManager };
