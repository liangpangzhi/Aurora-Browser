const http = require('http');
const https = require('https');
const { URL } = require('url');

function encodeLiteTarget(targetUrl) {
    return Buffer.from(targetUrl, 'utf8').toString('base64url');
}

function decodeLiteTarget(encoded) {
    return Buffer.from(encoded, 'base64url').toString('utf8');
}

function stripTokenFromSearch(search, tokenParam) {
    if (!search) return '';
    try {
        const params = new URLSearchParams(search);
        params.delete(tokenParam);
        const rest = params.toString();
        return rest ? `?${rest}` : '';
    } catch {
        return '';
    }
}

function rewriteHtmlForLiteProxy(html, baseUrl) {
    const base = new URL(baseUrl);
    const wrapUrl = (raw) => {
        if (!raw || /^(data:|javascript:|mailto:|tel:|blob:|#)/i.test(raw.trim())) {
            return raw;
        }
        try {
            const resolved = new URL(raw.trim(), base).toString();
            return `/lite-proxy/${encodeLiteTarget(resolved)}`;
        } catch {
            return raw;
        }
    };

    const bridgeScript = `
<script>
(function() {
  try {
    var tabId = (window.name || '').replace(/^aurora-/, '');
    window.parent.postMessage({
      type: 'fn-browser-nav',
      tabId: tabId,
      url: ${JSON.stringify(baseUrl)},
      title: document.title || ${JSON.stringify(base.hostname)}
    }, window.location.origin);
    window.addEventListener('load', function() {
      window.parent.postMessage({
        type: 'fn-browser-nav',
        tabId: tabId,
        url: ${JSON.stringify(baseUrl)},
        title: document.title || ${JSON.stringify(base.hostname)}
      }, window.location.origin);
    });
  } catch (e) {}
})();
</script>`;

    let out = html
        .replace(/\b(href|src|action)\s*=\s*(["'])(.*?)\2/gi, (match, attr, quote, val) => {
            return `${attr}=${quote}${wrapUrl(val)}${quote}`;
        })
        .replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (match, quote, val) => {
            return `url(${quote}${wrapUrl(val)}${quote})`;
        });

    if (/<\/head>/i.test(out)) {
        out = out.replace(/<\/head>/i, `${bridgeScript}</head>`);
    } else {
        out = bridgeScript + out;
    }
    return out;
}

function createLiteProxy({ tokenParam }) {
    return function handleLiteProxy(req, res, encodedPart, extraSearch) {
        let targetUrl;
        try {
            targetUrl = decodeLiteTarget(encodedPart);
            const cleanSearch = stripTokenFromSearch(extraSearch, tokenParam);
            if (cleanSearch && !targetUrl.includes('?')) {
                targetUrl += cleanSearch;
            }
        } catch {
            res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
            return res.end('Invalid proxy target URL');
        }

        let parsed;
        try {
            parsed = new URL(targetUrl);
        } catch {
            res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
            return res.end('Malformed target URL');
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
            return res.end('Unsupported target protocol');
        }

        const client = parsed.protocol === 'https:' ? https : http;
        const headers = { ...req.headers };
        delete headers.host;
        delete headers['accept-encoding'];
        delete headers.cookie;
        delete headers.authorization;
        delete headers['proxy-authorization'];
        delete headers[tokenParam];
        delete headers['x-aurora-token'];
        headers['host'] = parsed.host;
        headers['user-agent'] =
            headers['user-agent'] ||
            'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/128.0.0.0 Safari/537.36';

        const proxyReq = client.request(
            {
                protocol: parsed.protocol,
                hostname: parsed.hostname,
                port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
                path: parsed.pathname + parsed.search,
                method: req.method,
                headers,
                rejectUnauthorized: false,
                timeout: 20000
            },
            (proxyRes) => {
                const resHeaders = { ...proxyRes.headers };
                delete resHeaders['x-frame-options'];
                delete resHeaders['content-security-policy'];
                delete resHeaders['content-security-policy-report-only'];
                delete resHeaders['cross-origin-opener-policy'];
                delete resHeaders['cross-origin-embedder-policy'];
                delete resHeaders['cross-origin-resource-policy'];
                delete resHeaders['strict-transport-security'];
                resHeaders['access-control-allow-origin'] = '*';
                resHeaders['cross-origin-resource-policy'] = 'cross-origin';
                resHeaders['cross-origin-embedder-policy'] = 'credentialless';

                if ([301, 302, 303, 307, 308].includes(proxyRes.statusCode) && resHeaders.location) {
                    try {
                        const nextUrl = new URL(resHeaders.location, parsed).toString();
                        resHeaders.location = `/lite-proxy/${encodeLiteTarget(nextUrl)}`;
                    } catch {}
                    res.writeHead(proxyRes.statusCode, resHeaders);
                    return res.end();
                }

                const contentType = (resHeaders['content-type'] || '').toLowerCase();
                if (contentType.includes('text/html')) {
                    delete resHeaders['content-length'];
                    const chunks = [];
                    proxyRes.on('data', (c) => chunks.push(c));
                    proxyRes.on('end', () => {
                        const rawHtml = Buffer.concat(chunks).toString('utf8');
                        const rewritten = rewriteHtmlForLiteProxy(rawHtml, parsed.toString());
                        resHeaders['content-type'] = 'text/html; charset=utf-8';
                        res.writeHead(proxyRes.statusCode || 200, resHeaders);
                        res.end(rewritten);
                    });
                } else {
                    res.writeHead(proxyRes.statusCode || 200, resHeaders);
                    proxyRes.pipe(res);
                }
            }
        );

        proxyReq.on('timeout', () => {
            proxyReq.destroy();
            if (!res.headersSent) {
                res.writeHead(504, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(`<h3>请求超时</h3><p>无法在规定时间内连接到：${parsed.toString()}</p>`);
            }
        });

        proxyReq.on('error', () => {
            if (!res.headersSent) {
                res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end('<h3>连接目标站点失败</h3><p>请检查目标地址是否可达，或目标站点是否拒绝代理访问。</p>');
            }
        });

        if (req.method !== 'GET' && req.method !== 'HEAD') {
            req.pipe(proxyReq);
        } else {
            proxyReq.end();
        }
    };
}

module.exports = { createLiteProxy };
