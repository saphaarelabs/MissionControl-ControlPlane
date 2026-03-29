import 'dotenv/config';
import express from 'express';
import { createClient } from '@supabase/supabase-js';
import { verifyToken } from '@clerk/backend';
import webhookRoutes from './routes/webhooks.js';
import { provisionUser } from './lib/provisioner.js';

const app = express();
const PORT = process.env.CONTROL_PLANE_PORT || 4445;
const CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY;
const CLERK_JWT_KEY = process.env.CLERK_JWT_KEY;

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
});

// Helper function to validate OpenClaw VPS instance URLs
function isOpenClawInstance(origin) {
    if (!origin) return false;
    
    // Pattern for OpenClaw VPS instances: https://openclaw-user-{unique-id}.h1.openclaw.magicteams.ai
    // Also supports ws:// for WebSocket connections and any subdomain patterns
    const openClawPatterns = [
        /^https:\/\/openclaw-user-[a-zA-Z0-9]+\.h1\.openclaw\.magicteams\.ai$/,  // HTTPS instances
        /^wss:\/\/openclaw-user-[a-zA-Z0-9]+\.h1\.openclaw\.magicteams\.ai$/,   // WebSocket Secure
        /^ws:\/\/openclaw-user-[a-zA-Z0-9]+\.h1\.openclaw\.magicteams\.ai$/,    // WebSocket
        /^https:\/\/[a-zA-Z0-9-]+\.openclaw\.magicteams\.ai$/,                  // Any subdomain pattern
        /^wss:\/\/[a-zA-Z0-9-]+\.openclaw\.magicteams\.ai$/,                    // WSS any subdomain
        /^ws:\/\/[a-zA-Z0-9-]+\.openclaw\.magicteams\.ai$/                      // WS any subdomain
    ];
    
    return openClawPatterns.some(pattern => pattern.test(origin));
}

app.use('/api/webhooks/stripe', express.raw({ type: 'application/json' }));
app.use(express.json());

app.use((req, res, next) => {
    // Define allowed origins for CORS
    const allowedOrigins = [
        'http://localhost:5173',        // Local development
        'https://localhost:5173',       // Local development with HTTPS
        'https://magicteams.ai',        // Production domain
        'https://www.magicteams.ai',    // Production domain with www
        'https://mission-control-frontend-kappa.vercel.app',
        'https://magicteams-missioncontrol.netlify.app',
        'https://mission-control-control-plane.vercel.app/',
        process.env.ALLOWED_ORIGIN      // Additional origin from env
    ].filter(Boolean); // Remove undefined values

    const origin = req.headers.origin;
    
    // Check for exact matches first
    if (allowedOrigins.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
    }
    // Check for OpenClaw VPS instance patterns
    else if (origin && isOpenClawInstance(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
    }
    else if (!origin) {
        // Allow requests with no origin (like mobile apps or curl)
        res.setHeader('Access-Control-Allow-Origin', allowedOrigins[0]);
    }
    
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Internal-Secret, stripe-signature');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, PUT, PATCH, OPTIONS');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});

// ── Request logger ────────────────────────────────────────────────────────────
app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
        const ms = Date.now() - start;
        const status = res.statusCode;
        const flag = status >= 500 ? '✗' : status >= 400 ? '!' : '✓';
        console.log(`[control-plane] ${flag} ${req.method} ${req.path} → ${status} (${ms}ms)`);
    });
    next();
});

function requireInternal(req, res, next) {
    if (req.headers['x-internal-secret'] !== process.env.OPENCLAW_INTERNAL_SECRET) {
        console.warn(`[control-plane] AUTH 401 ${req.method} ${req.path} — bad internal secret`);
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
}

function getBearerToken(req) {
    const header = req.headers?.authorization || req.headers?.Authorization;
    if (!header || typeof header !== 'string') return null;
    const match = header.match(/^Bearer\s+(.+)$/i);
    return match ? match[1].trim() : null;
}

function normalizeGatewayBaseUrl(value) {
    if (!value || typeof value !== 'string') return null;
    try {
        return new URL(value).origin;
    } catch {
        return null;
    }
}

async function requireClerkUser(req, res) {
    const token = getBearerToken(req);
    if (!token) {
        res.status(401).json({ error: 'Missing Authorization: Bearer <token>' });
        return null;
    }

    if (!CLERK_JWT_KEY && !CLERK_SECRET_KEY) {
        res.status(500).json({ error: 'Set CLERK_JWT_KEY or CLERK_SECRET_KEY to verify tokens' });
        return null;
    }

    try {
        const verified = await verifyToken(token, {
            ...(CLERK_JWT_KEY ? { jwtKey: CLERK_JWT_KEY } : {}),
            ...(CLERK_SECRET_KEY ? { secretKey: CLERK_SECRET_KEY } : {}),
        });
        const userId = verified?.sub;
        if (!userId) {
            res.status(401).json({ error: 'Invalid token (missing sub claim)' });
            return null;
        }
        req._clerkAuth = { userId, claims: verified };
        return userId;
    } catch (err) {
        console.warn(`[control-plane] AUTH 401 ${req.method} ${req.path} — ${err.message}`);
        res.status(401).json({ error: 'Invalid token' });
        return null;
    }
}

async function resolveUserRuntimeContext(req, res, { requireProvisioned = false } = {}) {
    const userId = await requireClerkUser(req, res);
    if (!userId) return null;

    const { data, error } = await supabase
        .from('user_profiles')
        .select(`
            userid,
            username,
            operation_status,
            vps_node_id,
            docker_container_name,
            gateway_name,
            gateway_token,
            local_websocket,
            instance_url,
            terminal_url,
            provisioned_at,
            provisioning_started_at,
            provisioning_completed_at,
            provisioning_error,
            provisioning_lock_id,
            last_health_check,
            updated_at
        `)
        .eq('userid', userId)
        .maybeSingle();

    if (error) {
        res.status(500).json({ error: error.message });
        return null;
    }

    if (!data) {
        res.status(404).json({ error: 'User profile not found' });
        return null;
    }

    const baseUrl = normalizeGatewayBaseUrl(data.instance_url);
    if (requireProvisioned && !baseUrl) {
        res.status(409).json({
            error: 'User instance is not provisioned yet',
            operationStatus: data.operation_status || null,
        });
        return null;
    }

    return {
        userId,
        profile: data,
        baseUrl,
        gatewayToken: data.gateway_token || null,
    };
}

app.get('/healthz', (_, res) => res.json({ ok: true }));

app.use('/api/webhooks', webhookRoutes);

app.get('/api/runtime/status', async (req, res) => {
    const runtime = await resolveUserRuntimeContext(req, res, { requireProvisioned: false });
    if (!runtime) return;

    const { profile, baseUrl } = runtime;
    return res.json({
        ok: true,
        runtime: {
            userId: profile.userid,
            username: profile.username || null,
            operationStatus: profile.operation_status || null,
            provisioned: Boolean(baseUrl),
            provisioningLockId: profile.provisioning_lock_id || null,
            provisioningStartedAt: profile.provisioning_started_at || null,
            provisioningCompletedAt: profile.provisioning_completed_at || null,
            provisioningError: profile.provisioning_error || null,
            instanceUrl: profile.instance_url || null,
            terminalUrl: profile.terminal_url || null,
            websocketUrl: profile.local_websocket || null,
            gatewayName: profile.gateway_name || null,
            vpsNodeId: profile.vps_node_id || null,
            dockerContainerName: profile.docker_container_name || null,
            provisionedAt: profile.provisioned_at || null,
            lastHealthCheck: profile.last_health_check || null,
            updatedAt: profile.updated_at || null,
        },
    });
});

app.get('/api/runtime/health', async (req, res) => {
    const runtime = await resolveUserRuntimeContext(req, res, { requireProvisioned: false });
    if (!runtime) return;

    const { profile, baseUrl, gatewayToken } = runtime;
    if (!baseUrl) {
        return res.status(200).json({
            ok: true,
            status: 'provisioning',
            operationStatus: profile.operation_status || null,
            message: 'User instance is not ready yet',
        });
    }

    try {
        try {
            const rootRes = await fetch(`${baseUrl}/`, {
                method: 'GET',
                signal: AbortSignal.timeout(2000),
            });
            if (rootRes.ok) {
                return res.json({ ok: true, status: 'online', ts: new Date().toISOString() });
            }
        } catch {
            // Fall through to gateway token probe.
        }

        if (!gatewayToken) {
            return res.status(200).json({
                ok: true,
                status: 'offline',
                message: 'Missing user gateway token',
            });
        }

        const gatewayRes = await fetch(`${baseUrl}/v1/chat/completions`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${gatewayToken}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model: 'health-check',
                messages: [{ role: 'user', content: 'ping' }],
                max_tokens: 1,
            }),
            signal: AbortSignal.timeout(10000),
        });

        if (!gatewayRes.ok) {
            const text = await gatewayRes.text().catch(() => '');
            return res.status(200).json({
                ok: true,
                status: 'offline',
                message: `Gateway error ${gatewayRes.status}`,
                details: text.slice(0, 200),
            });
        }

        return res.json({ ok: true, status: 'online', ts: new Date().toISOString() });
    } catch (err) {
        return res.status(200).json({
            ok: true,
            status: 'offline',
            message: err?.message || 'Health probe failed',
        });
    }
});

app.post('/api/provision/user', requireInternal, async (req, res) => {
    const { userId, username, onboardingData } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    console.log(`[control-plane] provisioning user ${userId} (${username || userId}) with onboarding data: ${!!onboardingData}`);
    try {
        const result = await provisionUser(userId, username || userId, onboardingData);
        console.log(`[control-plane] provisioning done for ${userId}:`, result);
        return res.json(result);
    } catch (err) {
        console.error(`[control-plane] provisioning FAILED for ${userId}:`, err.message);
        return res.status(500).json({ error: err.message });
    }
});

app.delete('/api/provision/user/:userId', requireInternal, async (req, res) => {
    const { userId } = req.params;
    if (!userId) return res.status(400).json({ error: 'userId required' });

    try {
        const { data: profile } = await supabase
            .from('user_profiles')
            .select('vps_node_id, docker_container_name, instance_url')
            .eq('userid', userId)
            .maybeSingle();

        if (profile?.vps_node_id) {
            const { data: node } = await supabase
                .from('vps_nodes')
                .select('id, ip_address, capacity_used, status')
                .eq('id', profile.vps_node_id)
                .single();

            if (node) {
                // Tell the VPS to actually stop and remove the container
                fetch(`http://${node.ip_address}:${process.env.LOCAL_API_PORT || 4444}/api/internal/remove-instance/${userId}`, {
                    method: 'DELETE',
                    headers: { 'X-Internal-Secret': process.env.OPENCLAW_INTERNAL_SECRET },
                    signal: AbortSignal.timeout(30_000),
                }).catch((err) => console.error('[cancel] vps-agent remove-instance failed:', err));

                const newUsed = Math.max(0, (node.capacity_used || 1) - 1);
                await supabase.from('vps_nodes').update({
                    capacity_used: newUsed,
                    status: node.status === 'full' ? 'ready' : node.status,
                }).eq('id', node.id);
            }
        }

        await supabase.from('user_profiles').update({
            operation_status: 'suspended',
            vps_node_id: null,
            docker_container_name: null,
            instance_url: null,
            terminal_url: null,
        }).eq('userid', userId);

        return res.json({ ok: true, userId });
    } catch (err) {
        console.error('[cancel] error:', err);
        return res.status(500).json({ error: err.message });
    }
});

app.get('/api/fleet', requireInternal, async (_, res) => {
    const { data, error } = await supabase
        .from('vps_nodes')
        .select('id, host_shard, ip_address, base_domain, capacity_max, capacity_used, status, created_at')
        .order('created_at', { ascending: true });
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ nodes: data });
});

app.listen(PORT, () => console.log(`[control-plane] port ${PORT}`));

export default app;
