import { Hono } from 'hono';
import type { UiResponse } from '@devvit/web/shared';
import { context, redis, reddit } from '@devvit/web/server';
import { createPost } from '../core/post';
import { seedDemo } from '../core/state';
import { runQuake } from '../core/quake';

export const menu = new Hono();

async function activePost(): Promise<string | undefined> {
  return context.postId ?? (await redis.get('active_post')) ?? undefined;
}

// ⚡ Force a quake immediately (testing / demo).
menu.post('/force-quake', async (c) => {
  try {
    const post = await activePost();
    if (!post) return c.json<UiResponse>({ showToast: 'No active tower yet' }, 400);
    const q = await runQuake(post);
    return c.json<UiResponse>({
      showToast: q ? `⚡ Quake fired — ${q.fallen} blocks fell` : 'A quake is already resolving',
    });
  } catch (err) {
    console.error(`force-quake: ${err}`);
    return c.json<UiResponse>({ showToast: 'Failed to fire quake' }, 400);
  }
});

// 🌱 Seed the tower with lifelike bot blocks so it looks multiplayer.
menu.post('/seed-demo', async (c) => {
  try {
    const post = await activePost();
    if (!post) return c.json<UiResponse>({ showToast: 'No active tower yet' }, 400);
    const user = (await reddit.getCurrentUsername()) ?? 'anonymous';
    const n = await seedDemo(post, user);
    return c.json<UiResponse>({ showToast: `🌱 Added ${n} demo blocks + 60 💎` });
  } catch (err) {
    console.error(`seed-demo: ${err}`);
    return c.json<UiResponse>({ showToast: 'Failed to seed tower' }, 400);
  }
});

menu.post('/post-create', async (c) => {
  try {
    const post = await createPost();

    return c.json<UiResponse>(
      {
        navigateTo: `https://reddit.com/r/${context.subredditName}/comments/${post.id}`,
      },
      200
    );
  } catch (error) {
    console.error(`Error creating post: ${error}`);
    return c.json<UiResponse>(
      {
        showToast: 'Failed to create post',
      },
      400
    );
  }
});
