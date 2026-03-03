import express from 'express';
import { createClient } from '@supabase/supabase-js';
import webhookRoutes from './routes/webhooks.js';
import { provisionUser } from './lib/provisioner.js';

const app = express();
const PORT = process.env.CONTROL_PLANE_PORT || 4445;

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
});

app.use('/api/webhooks/stripe', express.raw({ type: 'application/json' }));
app.use(express.json());

app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || 'http://localhost:5173');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Internal-Secret');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
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

app.get('/healthz', (_, res) => res.json({ ok: true }));

app.use('/api/webhooks', webhookRoutes);

app.post('/api/provision/user', requireInternal, async (req, res) => {
    const { userId, username } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    console.log(`[control-plane] provisioning user ${userId} (${username || userId})`);
    try {
        const result = await provisionUser(userId, username || userId);
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
