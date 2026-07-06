import { reddit, redis } from '@devvit/web/server';
import { ensureScheduled } from './quake';
import { ensureFoundation } from './state';

export const createPost = async () => {
  const post = await reddit.submitCustomPost({
    title: '🏗️ Seismic — the community tower. Stack a block. Survive the quake.',
  });
  // Remember the latest post so the cron backstop can keep its quakes scheduled.
  await redis.set('active_post', post.id);
  await ensureFoundation(post.id); // start the tower on system bedrock
  await ensureScheduled(post.id);
  return post;
};
