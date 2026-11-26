const fs = require('fs');
const os = require('os');
const path = require('path');

function parseCertNames(raw) {
    const list = [];
    const push = (v) => {
        const name = String(v || '').trim().toLowerCase();
        if (name && !list.includes(name)) list.push(name);
    };
    if (Array.isArray(raw)) raw.forEach(push);
    else if (typeof raw === 'string') raw.split(',').forEach(push);
    return list;
}

function forgeSerialNumber(forge) {
    let hex = forge.util.bytesToHex(forge.random.getBytesSync(16));
    if (parseInt(hex.slice(0, 2), 16) >= 0x80) hex = `00${hex}`;
    return hex;
}

function uuidFromHex(hex, offset) {
    const h = (hex.slice(offset, offset + 32) + '00000000000000000000000000000000').slice(0, 32);
    return (
        `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-` +
        `${h.slice(16, 20)}-${h.slice(20, 32)}`
    ).toUpperCase();
}

function createTlsManager({ dataDir, settingsFile, defaultSettings, httpsPort, readJson }) {
    const tlsDir = path.join(dataDir, 'tls');
    const httpsStatus = { enabled: false, port: httpsPort, mode: 'ca' };
    let caCertDerBuffer = null;
    let caProfileUuid = null;
    let caCertUuid = null;

    function collectServerCertSans() {
        const ips = new Set(['127.0.0.1', '::1']);
        const dnsNames = new Set(['localhost']);
        try {
            for (const entries of Object.values(os.networkInterfaces())) {
                for (const entry of entries || []) {
                    if (!entry.internal && entry.address) ips.add(entry.address.toLowerCase());
                }
            }
        } catch {}
        parseCertNames(process.env.AURORA_CERT_NAMES).forEach((n) => dnsNames.add(n));
        try {
            const settings = readJson(settingsFile, defaultSettings);
            parseCertNames(settings.certNames).forEach((n) => dnsNames.add(n));
        } catch {}
        return { ips: [...ips], dnsNames: [...dnsNames] };
    }

    function forgeCreateCa(forge) {
        const keys = forge.pki.rsa.generateKeyPair(2048);
        const cert = forge.pki.createCertificate();
        cert.publicKey = keys.publicKey;
        cert.serialNumber = forgeSerialNumber(forge);
        cert.validity.notBefore = new Date(Date.now() - 24 * 3600 * 1000);
        cert.validity.notAfter = new Date(Date.now() + 10 * 365 * 24 * 3600 * 1000);
        const attrs = [
            { name: 'commonName', value: 'Aurora Local CA' },
            { name: 'organizationName', value: 'Aurora' }
        ];
        cert.setSubject(attrs);
        cert.setIssuer(attrs);
        cert.setExtensions([
            { name: 'basicConstraints', cA: true, critical: true },
            { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
            { name: 'subjectKeyIdentifier' }
        ]);
        cert.sign(keys.privateKey, forge.md.sha256.create());
        return { cert, privateKey: keys.privateKey, fresh: true };
    }

    function loadOrCreateCa(forge) {
        const keyPath = path.join(tlsDir, 'ca.key.pem');
        const crtPath = path.join(tlsDir, 'ca.crt.pem');
        try {
            if (fs.existsSync(keyPath) && fs.existsSync(crtPath)) {
                const privateKey = forge.pki.privateKeyFromPem(fs.readFileSync(keyPath, 'utf8'));
                const cert = forge.pki.certificateFromPem(fs.readFileSync(crtPath, 'utf8'));
                if (cert.validity.notAfter.getTime() - Date.now() > 30 * 24 * 3600 * 1000) {
                    return { cert, privateKey, fresh: false };
                }
                console.log('[fn-browser] 已存 CA 临近过期，将重新生成');
            }
        } catch (err) {
            console.log(`[fn-browser] 已存 CA 无法解析，将重新生成（${err.message}）`);
        }
        const ca = forgeCreateCa(forge);
        fs.writeFileSync(keyPath, forge.pki.privateKeyToPem(ca.privateKey), { mode: 0o600 });
        fs.chmodSync(keyPath, 0o600);
        fs.writeFileSync(crtPath, forge.pki.certificateToPem(ca.cert), { mode: 0o644 });
        return ca;
    }

    function certSansOf(forgeCert) {
        const ips = new Set();
        const dns = new Set();
        try {
            const ext = forgeCert.getExtension('subjectAltName');
            if (ext && Array.isArray(ext.altNames)) {
                for (const alt of ext.altNames) {
                    if (alt.type === 7 && alt.ip) ips.add(String(alt.ip).toLowerCase());
                    else if (alt.type === 2 && alt.value) dns.add(String(alt.value).toLowerCase());
                }
            }
        } catch {}
        return { ips, dns };
    }

    function forgeIssueServerCert(forge, ca, sans) {
        const keys = forge.pki.rsa.generateKeyPair(2048);
        const cert = forge.pki.createCertificate();
        cert.publicKey = keys.publicKey;
        cert.serialNumber = forgeSerialNumber(forge);
        cert.validity.notBefore = new Date(Date.now() - 24 * 3600 * 1000);
        cert.validity.notAfter = new Date(Date.now() + 800 * 24 * 3600 * 1000);
        cert.setSubject([
            { name: 'commonName', value: 'Aurora' },
            { name: 'organizationName', value: 'Aurora' }
        ]);
        cert.setIssuer(ca.cert.subject.attributes);
        cert.setExtensions([
            { name: 'basicConstraints', cA: false },
            { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
            { name: 'extKeyUsage', serverAuth: true },
            {
                name: 'subjectAltName',
                altNames: [
                    ...sans.dnsNames.map((v) => ({ type: 2, value: v })),
                    ...sans.ips.map((ip) => ({ type: 7, ip }))
                ]
            },
            { name: 'subjectKeyIdentifier' }
        ]);
        cert.sign(ca.privateKey, forge.md.sha256.create());
        return { cert, privateKey: keys.privateKey };
    }

    function loadOrIssueServerCert(forge, ca, sans) {
        const keyPath = path.join(tlsDir, 'server.key.pem');
        const crtPath = path.join(tlsDir, 'server.crt.pem');
        if (!ca.fresh) {
            try {
                const cert = forge.pki.certificateFromPem(fs.readFileSync(crtPath, 'utf8'));
                const privateKey = forge.pki.privateKeyFromPem(fs.readFileSync(keyPath, 'utf8'));
                const have = certSansOf(cert);
                const missing =
                    sans.ips.some((ip) => !have.ips.has(ip)) ||
                    sans.dnsNames.some((n) => !have.dns.has(n));
                const expiresSoon = cert.validity.notAfter.getTime() - Date.now() < 30 * 24 * 3600 * 1000;
                if (!missing && !expiresSoon) return { cert, privateKey };
            } catch {}
        }
        const issued = forgeIssueServerCert(forge, ca, sans);
        fs.writeFileSync(keyPath, forge.pki.privateKeyToPem(issued.privateKey), { mode: 0o600 });
        fs.chmodSync(keyPath, 0o600);
        fs.writeFileSync(crtPath, forge.pki.certificateToPem(issued.cert), { mode: 0o644 });
        return issued;
    }

    function initTlsMaterials() {
        const customCertPath = process.env.TLS_CERT_PATH || path.join(tlsDir, 'custom.crt.pem');
        const customKeyPath = process.env.TLS_KEY_PATH || path.join(tlsDir, 'custom.key.pem');
        if (fs.existsSync(customCertPath) && fs.existsSync(customKeyPath)) {
            try {
                const certPem = fs.readFileSync(customCertPath, 'utf8');
                const keyPem = fs.readFileSync(customKeyPath, 'utf8');
                if (certPem.trim() && keyPem.trim()) {
                    httpsStatus.mode = 'custom';
                    console.log(`[fn-browser] 已加载自定义外部 TLS 证书: ${customCertPath}`);
                    return { keyPem, certPem };
                }
            } catch (err) {
                console.log(`[fn-browser] 读取自定义 TLS 证书失败，将回退本地 CA（${err.message}）`);
            }
        }

        let forge;
        try {
            forge = require('node-forge');
        } catch (err) {
            console.log(`[fn-browser] node-forge 不可用，HTTPS 未启用（${err.message}）`);
            return null;
        }
        fs.mkdirSync(tlsDir, { recursive: true });
        const ca = loadOrCreateCa(forge);
        const sans = collectServerCertSans();
        const serverCert = loadOrIssueServerCert(forge, ca, sans);

        const derBytes = forge.asn1.toDer(forge.pki.certificateToAsn1(ca.cert)).getBytes();
        caCertDerBuffer = Buffer.from(derBytes, 'binary');
        const sha1 = forge.md.sha1.create();
        sha1.update(derBytes);
        const fingerprint = sha1.digest().toHex();
        caCertUuid = uuidFromHex(fingerprint, 0);
        const sha256 = forge.md.sha256.create();
        sha256.update(derBytes);
        caProfileUuid = uuidFromHex(sha256.digest().toHex(), 0);
        console.log(
            `[fn-browser] 本地 CA 就绪（指纹 SHA1 ${fingerprint.slice(0, 16)}…，` +
                `${ca.fresh ? '新生成' : '复用已存'}），服务器证书 SAN: ` +
                `${sans.dnsNames.join(', ')} / ${sans.ips.join(', ')}`
        );
        return {
            keyPem: forge.pki.privateKeyToPem(serverCert.privateKey),
            certPem: forge.pki.certificateToPem(serverCert.cert) + forge.pki.certificateToPem(ca.cert)
        };
    }

    function buildCaMobileConfig() {
        const b64 = caCertDerBuffer.toString('base64').replace(/.{64}/g, '$&\n');
        return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>PayloadContent</key>
	<array>
		<dict>
			<key>PayloadType</key>
			<string>com.apple.security.root</string>
			<key>PayloadVersion</key>
			<integer>1</integer>
			<key>PayloadIdentifier</key>
			<string>com.aurora.ca.certificate</string>
			<key>PayloadUUID</key>
			<string>${caCertUuid}</string>
			<key>PayloadDisplayName</key>
			<string>极光浏览器根证书</string>
			<key>PayloadContent</key>
			<data>
${b64}
			</data>
		</dict>
	</array>
	<key>PayloadType</key>
	<string>Configuration</string>
	<key>PayloadVersion</key>
	<integer>1</integer>
	<key>PayloadIdentifier</key>
	<string>com.aurora.ca</string>
	<key>PayloadUUID</key>
	<string>${caProfileUuid}</string>
	<key>PayloadDisplayName</key>
	<string>极光浏览器根证书</string>
	<key>PayloadOrganization</key>
	<string>Aurora</string>
	<key>PayloadDescription</key>
	<string>安装极光浏览器的本地根证书，以便通过 HTTPS 安全打开并启用 Scramjet 内核。</string>
</dict>
</plist>
`;
    }

    return {
        httpsStatus,
        initTlsMaterials,
        getCaCertDer: () => caCertDerBuffer,
        buildCaMobileConfig
    };
}

module.exports = { createTlsManager };
