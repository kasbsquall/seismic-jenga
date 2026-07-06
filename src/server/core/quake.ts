import { redis, scheduler, reddit, context } from '@devvit/web/server';
import { K } from './keys';
import {
  getTower,
  dropTopBlocks,
  addScore,
  rewardCredits,
  rolloverEpoch,
  ensureFoundation,
  int,
} from './state';
import {
  resolveQuake,
  magnitudeFromSeed,
  toRichter,
  scoreForBlock,
  FOUNDATION_OWNER,
} from '../../shared/model';
import type { Block } from '../../shared/model';
import type { QuakeSummary } from '../../shared/api';

// Seeded "demo" contributors — never get real flair or @-mentions.
const BOTS = new Set([
  'mara_88', 'j_klein', 'tavo_p', 'sam_rd', 'nkoval', 'dee_w',
  'lucas_m', 'r_ortega', 'kaywill', 'pm_reyes', 'anonymous',
  FOUNDATION_OWNER, // the system bedrock block — never flair/score/mention it
]);

// Semi-random gap between quakes (24/7). Demo-friendly cadence so the tower
// feels alive during a play/judging session (bump these up for a slower burn).
const MIN_GAP_MS = 60_000; // 1 min
const MAX_GAP_MS = 3 * 60_000; // 3 min
const MAX_SURVIVE_CREDITS = 12;

export const QUAKE_JOB = 'quake';

function nextGap(seed: number): number {
  const r = magnitudeFromSeed(seed ^ 0x9e3779b9); // reuse the seeded RNG, different salt
  return Math.floor(MIN_GAP_MS + r * (MAX_GAP_MS - MIN_GAP_MS));
}

/** Schedule the next quake at a semi-random future time and persist its timestamp. */
export async function scheduleNext(post: string): Promise<void> {
  const quakeId = int(await redis.get(K.quakeId(post)));
  const now = Date.now();
  const runAt = new Date(now + nextGap(now + quakeId));

  // CRITICAL: advance the deadline FIRST. If the scheduler call below fails, the
  // deadline is already in the future, so the poll/cron backstop won't re-fire the
  // quake over and over (that caused back-to-back quakes). The one-off job is a
  // best-effort optimisation on top of that guarantee.
  await redis.set(K.nextQuakeAt(post), String(runAt.getTime()));

  try {
    const prev = await redis.get(K.jobId(post));
    if (prev) await scheduler.cancelJob(prev).catch(() => {});
    const jobId = await scheduler.runJob({ name: QUAKE_JOB, runAt, data: { post } });
    await redis.set(K.jobId(post), jobId);
  } catch (err) {
    console.error('scheduler.runJob failed (cron/poll will cover it):', err);
  }
}

/** Make sure a quake is always on the books; fire immediately if one is overdue. */
export async function ensureScheduled(post: string): Promise<void> {
  await redis.set('active_post', post); // keep the cron backstop pointed at a live post
  const nextRaw = await redis.get(K.nextQuakeAt(post));
  if (!nextRaw) return scheduleNext(post);
  if (int(nextRaw) < Date.now() - 5_000) await runQuake(post);
}

/** Best-effort lock so a job + cron-tick can't resolve the same quake twice. */
async function acquireLock(post: string): Promise<boolean> {
  const got = await redis.set(K.quakeLock(post), '1', {
    nx: true,
    expiration: new Date(Date.now() + 30_000),
  });
  return Boolean(got);
}

/** Resolve a quake authoritatively: topple blocks, reward survivors, log it, reschedule. */
export async function runQuake(post: string): Promise<QuakeSummary | null> {
  if (!(await acquireLock(post))) return null;

  try {
    const tower = await getTower(post);
    const quakeId = int(await redis.get(K.quakeId(post))) + 1;
    const nextAt = int(await redis.get(K.nextQuakeAt(post))) || Date.now();

    const magnitude = magnitudeFromSeed(Math.floor(nextAt / 1000) ^ quakeId);
    const { fallenIds, survived } = resolveQuake(tower, magnitude);
    const survivors = tower.slice(0, survived);

    // Advance authoritative state FIRST so a later reward hiccup can't stall the cycle.
    if (fallenIds.length > 0) await dropTopBlocks(post, survived);
    if (survivors.length === 0 && tower.length > 0) {
      await rolloverEpoch(post);
      await ensureFoundation(post); // the new tower rises on fresh bedrock
    }
    const summary: QuakeSummary = {
      id: quakeId,
      ts: Date.now(),
      magnitude,
      fallen: fallenIds.length,
      survived: survivors.length,
    };
    await Promise.all([
      redis.set(K.quakeId(post), String(quakeId)),
      redis.set(K.lastQuake(post), JSON.stringify(summary)),
    ]);

    // Reward survivors' owners by HEIGHT: a block that survives at floor N earns
    // its owner N points. Higher, riskier survival = bigger payoff. Isolated so
    // one failure can't abort the rest.
    const owed = new Map<string, { pts: number; blocks: number }>();
    survivors.forEach((b, i) => {
      if (b.owner === FOUNDATION_OWNER) return;
      const e = owed.get(b.owner) ?? { pts: 0, blocks: 0 };
      e.pts += scoreForBlock(i, b, survivors[i - 1]); // height × lean/risk
      e.blocks += 1;
      owed.set(b.owner, e);
    });
    for (const [owner, e] of owed) {
      if (owner === FOUNDATION_OWNER) continue; // bedrock scores for nobody
      try {
        await addScore(post, owner, e.pts);
        await redis.incrBy(K.earnedSince(post, owner), e.pts);
        await rewardCredits(post, owner, Math.min(Math.ceil(e.pts / 4), MAX_SURVIVE_CREDITS));
      } catch (err) {
        console.error(`reward failed for ${owner}:`, err);
      }
    }

    // ── Idea 2: personal best floor + flair on a new record ──────────────────
    const bestByOwner = new Map<string, number>();
    survivors.forEach((b, i) => {
      const floor = i + 1;
      if (floor > (bestByOwner.get(b.owner) ?? 0)) bestByOwner.set(b.owner, floor);
    });
    for (const [owner, floor] of bestByOwner) {
      if (BOTS.has(owner)) continue;
      try {
        const prev = int(await redis.get(K.bestFloor(post, owner)));
        if (floor > prev) {
          await redis.set(K.bestFloor(post, owner), String(floor));
          if (context.subredditName) {
            await reddit
              .setUserFlair({ subredditName: context.subredditName, username: owner, text: `🗼 Floor ${floor}` })
              .catch(() => {});
          }
        }
      } catch (err) {
        console.error(`bestFloor failed for ${owner}:`, err);
      }
    }

    // ── Idea 1: aftershock comment to seed the thread (notable quakes only) ───
    if (fallenIds.length >= 2) {
      const topSurvivor: Block | undefined = survivors[survivors.length - 1];
      const body =
        `⚡ **Aftershock — Magnitude ${toRichter(magnitude).toFixed(1)}**\n\n` +
        `**${fallenIds.length}** block${fallenIds.length === 1 ? '' : 's'} came crashing down. ` +
        `**${survivors.length}** still standing.\n\n` +
        (survivors.length === 0
          ? `The tower was leveled. A new one rises from the rubble — get in early. 🏗️`
          : topSurvivor
            ? `🏆 Highest survivor: ${BOTS.has(topSurvivor.owner) ? 'a block' : `**u/${topSurvivor.owner}**`} at floor **${survivors.length}**.\n\nThink your block can climb higher? The next quake is already brewing…`
            : `The next quake is already brewing…`);
      try {
        await reddit.submitComment({ id: post as `t3_${string}`, text: body });
      } catch (err) {
        console.error('aftershock comment failed:', err);
      }
    }

    return summary;
  } finally {
    await scheduleNext(post).catch((err) => console.error('reschedule failed:', err));
    await redis.del(K.quakeLock(post));
  }
}
