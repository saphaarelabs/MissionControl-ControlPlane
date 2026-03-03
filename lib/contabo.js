import crypto from 'crypto';

const BASE_URL = 'https://api.contabo.com';
const TOKEN_URL = 'https://auth.contabo.com/auth/realms/contabo/protocol/openid-connect/token';

let _token = null;
let _tokenExpiresAt = 0;

async function fetchToken() {
    const params = new URLSearchParams({
        grant_type: 'password',
        client_id: process.env.CONTABO_CLIENT_ID,
        client_secret: process.env.CONTABO_CLIENT_SECRET,
        username: process.env.CONTABO_API_USER,
        password: process.env.CONTABO_API_PASSWORD,
    });

    const res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
    });

    if (!res.ok) throw new Error(`Contabo auth failed (${res.status}): ${await res.text()}`);

    const data = await res.json();
    _token = data.access_token;
    _tokenExpiresAt = Date.now() + (data.expires_in - 60) * 1000;
    return _token;
}

async function getToken() {
    return _token && Date.now() < _tokenExpiresAt ? _token : fetchToken();
}

async function request(method, path, body = null) {
    const token = await getToken();
    const options = {
        method,
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'x-request-id': crypto.randomUUID(),
        },
    };
    if (body !== null) options.body = JSON.stringify(body);

    const res = await fetch(`${BASE_URL}${path}`, options);
    if (res.status === 204) return null;

    const data = await res.json();
    if (!res.ok) throw new Error(`Contabo ${method} ${path} → ${res.status}: ${JSON.stringify(data)}`);

    return data.data !== undefined ? data.data : data;
}

export async function listInstances(filters = {}) {
    const params = new URLSearchParams(Object.fromEntries(Object.entries(filters).filter(([, v]) => v)));
    const qs = params.toString() ? `?${params}` : '';
    return request('GET', `/v1/compute/instances${qs}`);
}

export async function getInstance(instanceId) {
    const data = await request('GET', `/v1/compute/instances/${instanceId}`);
    return Array.isArray(data) ? data[0] : data;
}

export async function createInstance({ imageId, productId = 'V94', region = 'EU', displayName = 'openclaw-node', userData = '', sshKeys = [] }) {
    const body = {
        imageId,
        productId,
        region,
        displayName,
        defaultUser: 'root',
        ...(userData ? { userData } : {}),
        ...(sshKeys.length ? { sshKeys } : {}),
    };
    const data = await request('POST', '/v1/compute/instances', body);
    return Array.isArray(data) ? data[0] : data;
}

export async function cancelInstance(instanceId) {
    return request('DELETE', `/v1/compute/instances/${instanceId}`);
}

export async function waitForInstanceStatus(instanceId, expectedStatus = 'running', timeoutMs = 10 * 60 * 1000, pollIntervalMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const instance = await getInstance(instanceId);
        if (instance?.status === expectedStatus) return instance;
        if (instance?.status === 'error') throw new Error(`Instance ${instanceId} entered error state`);
        await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
    throw new Error(`Timed out waiting for instance ${instanceId} → "${expectedStatus}"`);
}

export async function listImages(standardOnly = true) {
    return request('GET', `/v1/compute/images${standardOnly ? '?standardImage=true' : ''}`);
}

let _cachedImageId = null;

// Preference order for base OS image (non-Plesk/cPanel only):
//   Ubuntu 22.04 → Ubuntu 24.04 → Debian 12 → Debian 13
const IMAGE_MATCHERS = [
    (i) => /ubuntu/i.test(i.name) && i.name.includes('22.04') && !/plesk|cpanel/i.test(i.name),
    (i) => /ubuntu/i.test(i.name) && i.name.includes('24.04') && !/plesk|cpanel/i.test(i.name),
    (i) => /debian/i.test(i.name) && i.name.includes('12')   && !/plesk|cpanel/i.test(i.name),
    (i) => /debian/i.test(i.name) && i.name.includes('13')   && !/plesk|cpanel/i.test(i.name),
];

export async function getUbuntu2204ImageId() {
    // Allow hard-coding the image ID via env to bypass catalog lookup
    if (process.env.CONTABO_IMAGE_ID) return process.env.CONTABO_IMAGE_ID;
    if (_cachedImageId) return _cachedImageId;

    const images = await listImages(true);
    let img;
    for (const match of IMAGE_MATCHERS) {
        img = images?.find(match);
        if (img) break;
    }

    if (!img) {
        const names = images?.map((i) => i.name).join(', ') || 'none';
        throw new Error(`No suitable base Linux image found in Contabo catalog. Available: ${names}`);
    }

    console.log(`[contabo] Selected OS image: ${img.name} (${img.imageId})`);
    _cachedImageId = img.imageId;
    return _cachedImageId;
}

export async function createSecret(name, type, value) {
    const data = await request('POST', '/v1/secrets', { name, type, value });
    return Array.isArray(data) ? data[0] : data;
}

export async function listSecrets() {
    return request('GET', '/v1/secrets');
}

export async function createTag(name, color) {
    const data = await request('POST', '/v1/tags', { name, ...(color ? { color } : {}) });
    return Array.isArray(data) ? data[0] : data;
}

export async function assignTagToInstance(tagId, instanceId) {
    return request('POST', `/v1/tags/${tagId}/assignments/instance/${instanceId}`);
}
