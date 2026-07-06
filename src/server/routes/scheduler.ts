import { Hono } from 'hono';
import { redis } from '@devvit/web/server';
import { runQuake, ensureScheduled } from '../core/quake';

export const schedulerRoutes = new Hono();

type QuakeJobData = { post?: string };

// Fired by the one-off scheduled job at each quake's exact time.
schedulerRoutes.post('/quake', async (c) => {
  try {
    const body = (await c.req.json().catch(() => ({}))) as { data?: QuakeJobData };
    const post = body.data?.post;
    if (typeof post === 'string' && post.length > 0) await runQuake(post);
    return c.json({});
  } catch (err) {
    console.error('quake job failed:', err);
    return c.json({});
  }
});

// Cron safety net: recover any post whose scheduled quake was lost/overdue.
schedulerRoutes.post('/tick', async (c) => {
  try {
    // Best-effort sweep over known posts (tracked as scoreboard keys exist per post).
    // We only have context-free access here, so rely on any registered post pointer.
    const activePost = await redis.get('active_post');
    if (activePost) await ensureScheduled(activePost);
    return c.json({});
  } catch (err) {
    console.error('tick failed:', err);
    return c.json({});
  }
});
