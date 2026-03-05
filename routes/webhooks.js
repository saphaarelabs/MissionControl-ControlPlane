import express from 'express';
import { createClient } from '@supabase/supabase-js';
import { provisionUser } from '../lib/provisioner.js';

const router = express.Router();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
});

function requireInternalSecret(req, res, next) {
    if (req.headers['x-internal-secret'] !== process.env.OPENCLAW_INTERNAL_SECRET) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
}

router.post('/node-register', requireInternalSecret, async (req, res) => {
    const { ip, shard, baseDomain, ttydSecret, pendingUserId } = req.body;

    if (!ip || !shard || !baseDomain || !ttydSecret) {
        return res.status(400).json({ error: 'Missing required fields: ip, shard, baseDomain, ttydSecret' });
    }

    try {
        const { data: existing } = await supabase
            .from('vps_nodes')
            .select('id')
            .eq('host_shard', shard)
            .eq('base_domain', baseDomain)
            .maybeSingle();

        let nodeId;

        if (existing) {
            const { data, error } = await supabase
                .from('vps_nodes')
                .update({ ip_address: ip, ttyd_secret: ttydSecret, status: 'ready' })
                .eq('id', existing.id)
                .select('id')
                .single();
            if (error) throw error;
            nodeId = data.id;
        } else {
            const { data, error } = await supabase
                .from('vps_nodes')
                .insert({
                    ip_address: ip,
                    host_shard: shard,
                    base_domain: baseDomain,
                    ttyd_secret: ttydSecret,
                    capacity_max: parseInt(process.env.VPS_CAPACITY_MAX || '5'),
                    capacity_used: 0,
                    status: 'ready',
                })
                .select('id')
                .single();
            if (error) throw error;
            nodeId = data.id;
        }

        // Provision any users who were waiting for a VPS to become available.
        // This covers both the explicit pendingUserId case and the generic
        // 'provisioning' status set by queueNewVpsProvisioning().
        const usersToProvision = new Set();
        if (pendingUserId) usersToProvision.add(pendingUserId);

        const { data: waitingUsers } = await supabase
            .from('user_profiles')
            .select('userid, username')
            .eq('operation_status', 'provisioning');

        for (const u of waitingUsers || []) usersToProvision.add(u.userid);

        for (const uid of usersToProvision) {
            const uname = waitingUsers?.find((u) => u.userid === uid)?.username || uid;
            console.log(`[webhook] auto-provisioning waiting user ${uid} on new node ${nodeId}`);
            provisionUser(uid, uname).catch((err) =>
                console.error(`[webhook] Failed to provision waiting user ${uid}:`, err.message)
            );
        }

        return res.json({ ok: true, nodeId });
    } catch (err) {
        console.error('[webhook] node-register error:', err);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

router.post('/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
    let event;
    try {
        const stripe = (await import('stripe')).default(process.env.STRIPE_SECRET_KEY);
        event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
        return res.status(400).json({ error: err.message });
    }

    if (event.type === 'checkout.session.completed') {
        const { userId, username } = event.data.object.metadata || {};

        if (userId) {
            await supabase.from('user_profiles').update({ operation_status: 'provisioning' }).eq('userid', userId);

            provisionUser(userId, username || userId).catch(async (err) => {
                console.error(`[webhook] Provisioning failed for ${userId}:`, err);
                await supabase.from('user_profiles').update({ operation_status: 'onboarded' }).eq('userid', userId);
            });
        }
    }

    return res.json({ received: true });
});

export default router;
