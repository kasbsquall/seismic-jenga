import { Hono } from 'hono';
import { context, redis, reddit } from '@devvit/web/server';
import { K } from '../core/keys';
import {
  getTower,
  appendBlock,
  ensureFoundation,
  maybeTremor,
  dropTopBlocks,
  spendCredits,
  getCredits,
  getScore,
  touchStreak,
  buildState,
  leaderboard,
  bumpPeak,
  rolloverEpoch,
  stakeFor,
  rewardWatch,
  shouldOnboard,
  int,
} from '../core/state';
import { ensureScheduled } from '../core/quake';
import {
  BLOCK_STATS,
  clampPlacement,
  isBlockType,
  resolveQuake,
} from '../../shared/model';
import type { Block } from '../../shared/model';
import type {
  InitResponse,
  PlaceRequest,
  PlaceResponse,
  StateResponse,
  LeaderboardResponse,
  QuakeReport,
  WatchResponse,
  ErrorResponse,
} from '../../shared/api';

export const api = new Hono();

// Per-post lock so concurrent /place requests can't each read the same tower
// snapshot and independently pass the anti-grief check (TOCTOU). Serializes the
// read-check-append so the second placement sees the first's block.
const PLACE_LOCK_MS = 5000;
async function acquirePlaceLock(post: string): Promise<boolean> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const got = await redis.set(K.placeLock(post), '1', {
      nx: true,
      expiration: new Date(Date.now() + PLACE_LOCK_MS),
    });
    if (got) return true;
    await new Promise((resolve) => setTimeout(resolve, 70));
  }
  return false;
}

async function currentUser(): Promise<string> {
  return (await reddit.getCurrentUsername()) ?? 'anonymous';
}

async function num(key: string): Promise<number> {
  return int(await redis.get(key));
}

// ─── GET /api/init ────────────────────────────────────────────────────────────
api.get('/init', async (c) => {
  const post = context.postId;
  if (!post)
    return c.json<ErrorResponse>(
      { status: 'error', message: 'Missing postId' },
      400
    );

  try {
    await ensureScheduled(post); // lazy bootstrap of the quake schedule
    await ensureFoundation(post); // bedrock is present from the first load (no pop-in)
    const user = await currentUser();

    const [tower, streakInfo, credits, score, state] = await Promise.all([
      getTower(post),
      touchStreak(post, user),
      getCredits(post, user),
      getScore(post, user),
      buildState(post),
    ]);

    const standingNow = tower.filter((b) => b.owner === user).length;
    const [lastSeen, seenStanding, earnedSince] = await Promise.all([
      num(K.lastSeenQuake(post, user)),
      num(K.seenStanding(post, user)),
      num(K.earnedSince(post, user)),
    ]);

    const [bestFloor, showOnboard] = await Promise.all([
      num(K.bestFloor(post, user)),
      shouldOnboard(post, user),
    ]);
    const quakesMissed = Math.max(0, state.quakeId - lastSeen);
    const report: QuakeReport | null =
      lastSeen > 0 && quakesMissed > 0
        ? {
            quakesMissed,
            standingNow,
            lostSinceSeen: Math.max(0, seenStanding - standingNow),
            earnedSinceSeen: earnedSince,
          }
        : null;

    await Promise.all([
      redis.set(K.lastSeenQuake(post, user), String(state.quakeId)),
      redis.set(K.seenStanding(post, user), String(standingNow)),
      redis.set(K.earnedSince(post, user), '0'),
    ]);

    return c.json<InitResponse>({
      type: 'init',
      username: user,
      credits,
      score,
      streak: streakInfo.streak,
      dailyBonus: streakInfo.bonus,
      bestFloor,
      report,
      showOnboard,
      state,
      stake: stakeFor(tower, user),
    });
  } catch (err) {
    return c.json<ErrorResponse>(
      { status: 'error', message: String(err) },
      500
    );
  }
});

// ─── GET /api/state ───────────────────────────────────────────────────────────
api.get('/state', async (c) => {
  const post = context.postId;
  if (!post)
    return c.json<ErrorResponse>(
      { status: 'error', message: 'Missing postId' },
      400
    );
  try {
    await maybeTremor(post); // time-gated: nudges the tower off-center over time
    const [user, tower] = await Promise.all([currentUser(), getTower(post)]);
    return c.json<StateResponse>({
      type: 'state',
      state: await buildState(post, tower),
      stake: stakeFor(tower, user),
    });
  } catch (err) {
    return c.json<ErrorResponse>(
      { status: 'error', message: String(err) },
      500
    );
  }
});

// ─── POST /api/watch — credit trickle while the player is actively watching ─────
api.post('/watch', async (c) => {
  const post = context.postId;
  if (!post) return c.json<ErrorResponse>({ status: 'error', message: 'Missing postId' }, 400);
  try {
    const user = await currentUser();
    const { credits, granted } = await rewardWatch(post, user);
    return c.json<WatchResponse>({ type: 'watch', credits, granted });
  } catch (err) {
    return c.json<ErrorResponse>({ status: 'error', message: String(err) }, 500);
  }
});

// ─── POST /api/place ──────────────────────────────────────────────────────────
api.post('/place', async (c) => {
  const post = context.postId;
  if (!post)
    return c.json<ErrorResponse>(
      { status: 'error', message: 'Missing postId' },
      400
    );

  try {
    const body = await c.req.json<PlaceRequest>();
    if (!isBlockType(body.type)) {
      return c.json<ErrorResponse>(
        { status: 'error', message: 'Bad block type' },
        400
      );
    }

    const user = await currentUser();
    const cost = BLOCK_STATS[body.type].cost;

    if (!(await acquirePlaceLock(post))) {
      return c.json<ErrorResponse>(
        { status: 'error', message: 'Tower is busy — try again.' },
        409
      );
    }
    try {
      const credits = await spendCredits(post, user, cost);
      if (credits === null) {
        return c.json<ErrorResponse>(
          { status: 'error', message: 'Not enough credits' },
          402
        );
      }

      await ensureFoundation(post);
      const tower = await getTower(post);
      const x = clampPlacement(Number(body.x) || 0, tower[tower.length - 1]);
      const block: Block = {
        id: `b_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        owner: user,
        type: body.type,
        x: Math.round(x),
      };

      await appendBlock(post, block);

      // Gravity settle: any overhang past support slides off immediately. A risky
      // drop onto an already-teetering tower CAN bring a chunk down — that tension
      // is the point, so we no longer block it.
      const gravity = resolveQuake([...tower, block], 0);
      let settled = [...tower, block];
      let collapsed = 0;
      if (gravity.fallenIds.length > 0) {
        await dropTopBlocks(post, gravity.survived);
        collapsed = gravity.fallenIds.length;
        settled = settled.slice(0, gravity.survived);
      }

      await bumpPeak(post, settled.length);
      if (settled.length === 0) await rolloverEpoch(post);

      return c.json<PlaceResponse>({
        type: 'place',
        block,
        credits,
        collapsed,
        state: await buildState(post, settled),
        stake: stakeFor(settled, user),
      });
    } finally {
      await redis.del(K.placeLock(post));
    }
  } catch (err) {
    return c.json<ErrorResponse>(
      { status: 'error', message: String(err) },
      500
    );
  }
});

// ─── GET /api/leaderboard ─────────────────────────────────────────────────────
api.get('/leaderboard', async (c) => {
  const post = context.postId;
  if (!post)
    return c.json<ErrorResponse>(
      { status: 'error', message: 'Missing postId' },
      400
    );
  try {
    const user = await currentUser();
    const tower = await getTower(post);
    const { entries, you } = await leaderboard(post, user, tower);
    return c.json<LeaderboardResponse>({
      type: 'leaderboard',
      entries,
      totalBlocks: tower.length,
      you,
    });
  } catch (err) {
    return c.json<ErrorResponse>(
      { status: 'error', message: String(err) },
      500
    );
  }
});
