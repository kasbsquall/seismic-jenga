import { redis } from '@devvit/web/server';
import { K } from './keys';
import {
  START_CREDITS,
  VISIBLE_BLOCKS,
  instabilityPct,
  isBlockType,
  clampPlacement,
  foundationBlock,
  scoreForBlock,
} from '../../shared/model';
import type { Block, BlockType } from '../../shared/model';
import type { PublicState, QuakeSummary, LeaderboardEntry, Stake } from '../../shared/api';

const TOWER_CAP = 600;

/** Safe integer read — never lets a corrupt/NaN Redis value poison arithmetic. */
export function int(v: string | undefined | null, fallback = 0): number {
  if (v === undefined || v === null || v === '') return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

async function numKey(key: string, fallback = 0): Promise<number> {
  return int(await redis.get(key), fallback);
}

function isBlock(v: unknown): v is Block {
  if (typeof v !== 'object' || v === null) return false;
  const b = v as Record<string, unknown>;
  return (
    typeof b.id === 'string' &&
    typeof b.owner === 'string' &&
    isBlockType(b.type) &&
    typeof b.x === 'number' &&
    Number.isFinite(b.x)
  );
}

// ─── Tower (Redis sorted set: atomic append, no read-modify-write) ────────────
export async function getTower(post: string): Promise<Block[]> {
  const [rows, reinforced, drift] = await Promise.all([
    redis.zRange(K.tower(post), 0, -1, { by: 'rank' }),
    redis.hGetAll(K.reinforced(post)),
    redis.hGetAll(K.drift(post)),
  ]);
  const rset: Record<string, string> = reinforced ?? {};
  const dset: Record<string, string> = drift ?? {};
  const out: Block[] = [];
  for (const r of rows) {
    try {
      const parsed: unknown = JSON.parse(r.member);
      if (isBlock(parsed)) {
        if (rset[parsed.id]) parsed.r = true;
        // Apply accumulated mini-tremor drift, but keep the block physically
        // resting on the one below (clamped) so state never goes illegal.
        const d = int(dset[parsed.id]);
        if (d !== 0) parsed.x = Math.round(clampPlacement(parsed.x + d, out[out.length - 1]));
        out.push(parsed);
      }
    } catch {
      /* skip a corrupt member rather than crash the model math */
    }
  }
  return out;
}

// ─── Mini-tremors: small quakes nudge the upper blocks off-center over time, so a
//     perfectly centered "safe" tower never stays safe. Time-gated so any activity
//     (a poll or a placement) drives it, without a dedicated scheduled job. ───────
const TREMOR_INTERVAL_MS = 22_000; // one gentle nudge per ~22s
const TREMOR_STEP = 3; // px of outward drift per tremor — a slow lean, not a wrecking ball
const DRIFT_CAP = 22; // never drift a single block further than this

const TREMOR_QUAKE_QUIET_MS = 20_000; // no tremors in the last 20s before a quake
const TREMOR_AFTER_QUAKE_MS = 10_000; // …nor in the 10s after one (so they never overlap)

export async function maybeTremor(post: string): Promise<boolean> {
  const now = Date.now();
  const last = int(await redis.get(K.lastTremor(post)));
  if (now - last < TREMOR_INTERVAL_MS) return false;
  // Stay still around the earthquake: hold in the final run-up (build tension) and
  // for a beat afterward, so a mini-quake never collides with the real one.
  // skip when a quake is within 20s OR already overdue (about to fire)
  const nextQuake = int(await redis.get(K.nextQuakeAt(post)));
  if (nextQuake > 0 && nextQuake - now < TREMOR_QUAKE_QUIET_MS) return false;
  const lastRaw = await redis.get(K.lastQuake(post));
  if (lastRaw) {
    try {
      const lq = JSON.parse(lastRaw) as { ts: number };
      if (now - int(String(lq.ts)) < TREMOR_AFTER_QUAKE_MS) return false;
    } catch {
      /* ignore */
    }
  }
  await redis.set(K.lastTremor(post), String(now)); // gate; a rare double-nudge is harmless

  const rows = await redis.zRange(K.tower(post), 0, -1, { by: 'rank' });
  if (rows.length < 3) return false;

  const drift = (await redis.hGetAll(K.drift(post))) ?? {};
  const next: Record<string, string> = {};
  const startIdx = Math.max(1, rows.length - 4); // never nudge the bedrock (index 0)
  for (let i = startIdx; i < rows.length; i++) {
    try {
      const b = JSON.parse(rows[i]!.member) as Block;
      const cur = int(drift[b.id]);
      // Bias the nudge in the direction the block already leans → positive feedback
      // toward instability; random component keeps it lifelike.
      const side = b.x + cur >= 0 ? 1 : -1;
      const nudge = side * TREMOR_STEP + Math.round((Math.random() - 0.5) * 4);
      const capped = Math.max(-DRIFT_CAP, Math.min(DRIFT_CAP, cur + nudge));
      next[b.id] = String(capped);
    } catch {
      /* skip corrupt */
    }
  }
  if (Object.keys(next).length > 0) await redis.hSet(K.drift(post), next);
  return true;
}

export async function reinforceBlock(post: string, blockId: string): Promise<void> {
  await redis.hSet(K.reinforced(post), { [blockId]: '1' });
}

/** Populate the tower with lifelike "bot" blocks so it looks multiplayer (demo/testing). */
const BOT_NAMES = [
  'mara_88',
  'j_klein',
  'tavo_p',
  'sam_rd',
  'nkoval',
  'dee_w',
  'lucas_m',
  'r_ortega',
  'kaywill',
  'pm_reyes',
];
const BOT_TYPES: BlockType[] = ['block', 'block', 'beam', 'pillar', 'block'];

export async function seedDemo(post: string, forUser: string, count = 16): Promise<number> {
  await ensureFoundation(post);
  const tower = await getTower(post);
  for (let i = 0; i < count; i++) {
    const prev = tower[tower.length - 1];
    const owner = BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)]!;
    const type = BOT_TYPES[Math.floor(Math.random() * BOT_TYPES.length)]!;
    // Mild lean (triangular dist) — enough instability that strong quakes topple
    // the top, but not so much it collapses at rest. Rare wild placements.
    const centered = (Math.random() + Math.random() - 1) * 15;
    const wild = Math.random() < 0.14 ? (Math.random() - 0.5) * 30 : 0;
    const base = prev ? prev.x : 0;
    const x = Math.round(clampPlacement(base + centered + wild, prev));
    const block: Block = { id: `bot_${Date.now()}_${i}`, owner, type, x };
    await appendBlock(post, block);
    tower.push(block);
  }
  await bumpPeak(post, tower.length);
  await rewardCredits(post, forUser, 60); // top the caller up so they can play
  return count;
}

/**
 * Guarantee the system bedrock block exists as index 0 whenever a tower starts
 * empty (post creation, epoch rollover, first placement). Callers already hold a
 * per-post lock, so the zCard check is race-free.
 */
export async function ensureFoundation(post: string): Promise<void> {
  const size = await redis.zCard(K.tower(post));
  if (size === 0) await appendBlock(post, foundationBlock());
}

/** Append one block atomically; trim the oldest if the tower exceeds the cap. */
export async function appendBlock(post: string, block: Block): Promise<void> {
  const seq = await redis.incrBy(K.towerSeq(post), 1);
  await redis.zAdd(K.tower(post), { member: JSON.stringify(block), score: seq });
  const size = await redis.zCard(K.tower(post));
  if (size > TOWER_CAP) await redis.zRemRangeByRank(K.tower(post), 0, size - TOWER_CAP - 1);
}

/** Remove the top `fallenCount` blocks (highest sequence = top of the tower). */
export async function dropTopBlocks(post: string, survivedCount: number): Promise<void> {
  await redis.zRemRangeByRank(K.tower(post), survivedCount, -1);
}

// ─── Credits (atomic incrBy — no double-spend) ────────────────────────────────
async function ensureCredits(post: string, user: string): Promise<void> {
  const v = await redis.get(K.credits(post, user));
  if (v === undefined || v === null || v === '') {
    await redis.set(K.credits(post, user), String(START_CREDITS));
  }
}

export async function getCredits(post: string, user: string): Promise<number> {
  const v = await redis.get(K.credits(post, user));
  if (v === undefined || v === null || v === '') {
    await redis.set(K.credits(post, user), String(START_CREDITS));
    return START_CREDITS;
  }
  return int(v, START_CREDITS);
}

/** Atomically spend; returns the new balance, or null if insufficient. */
export async function spendCredits(
  post: string,
  user: string,
  cost: number
): Promise<number | null> {
  await ensureCredits(post, user);
  const balance = await redis.incrBy(K.credits(post, user), -cost);
  if (balance < 0) {
    await redis.incrBy(K.credits(post, user), cost); // refund the overshoot
    return null;
  }
  return balance;
}

export async function rewardCredits(post: string, user: string, amount: number): Promise<void> {
  if (amount <= 0) return;
  await ensureCredits(post, user);
  await redis.incrBy(K.credits(post, user), amount);
}

// ─── Watch-to-earn: a small credit trickle just for keeping the tower on screen,
//     so an active watcher never runs dry. Time-gated + daily-capped (not gameable
//     by spamming, and the client only pings while the tab is actually visible). ──
const WATCH_STEP_MS = 12_000; // one credit per ~12s watched
const WATCH_DAILY_CAP = 30; // most credits/day you can earn just by watching

export async function rewardWatch(
  post: string,
  user: string
): Promise<{ credits: number; granted: number }> {
  const now = Date.now();
  const today = dayStr(0);
  const [day, lastRaw, earnedRaw] = await Promise.all([
    redis.get(K.watchDay(post, user)),
    redis.get(K.watchAt(post, user)),
    redis.get(K.watchEarned(post, user)),
  ]);
  let earned = int(earnedRaw);
  if (day !== today) {
    earned = 0;
    await Promise.all([
      redis.set(K.watchDay(post, user), today),
      redis.set(K.watchEarned(post, user), '0'),
    ]);
  }
  const last = int(lastRaw);
  const elapsed = now - last;
  await redis.set(K.watchAt(post, user), String(now));
  // first ping just sets the baseline; then grant once enough time has passed
  if (last === 0 || elapsed < WATCH_STEP_MS - 1500 || earned >= WATCH_DAILY_CAP) {
    return { credits: await getCredits(post, user), granted: 0 };
  }
  await redis.set(K.watchEarned(post, user), String(earned + 1));
  await rewardCredits(post, user, 1);
  return { credits: await getCredits(post, user), granted: 1 };
}

// ─── Score (atomic) ───────────────────────────────────────────────────────────
export async function getScore(post: string, user: string): Promise<number> {
  return numKey(K.score(post, user));
}

export async function addScore(post: string, user: string, delta: number): Promise<number> {
  const next = await redis.incrBy(K.score(post, user), delta);
  await redis.zAdd(K.scoreboard(post), { member: user, score: next });
  return next;
}

// ─── Daily streak → { streak, bonus } (bonus only on first visit each day) ─────
function dayStr(offset = 0): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

export async function touchStreak(
  post: string,
  user: string
): Promise<{ streak: number; bonus: number }> {
  const today = dayStr(0);
  const last = await redis.get(K.lastVisit(post, user));
  let streak = await numKey(K.streak(post, user));

  if (last === today) return { streak, bonus: 0 };

  streak = last === dayStr(-1) ? streak + 1 : 1;
  const bonus = 10 * Math.min(streak, 7);

  await Promise.all([
    redis.set(K.lastVisit(post, user), today),
    redis.set(K.streak(post, user), String(streak)),
  ]);
  await rewardCredits(post, user, bonus);
  return { streak, bonus };
}

/** True at most once per day per user — drives the "How to play" card so it never
 *  nags a returning player who already knows the game. */
export async function shouldOnboard(post: string, user: string): Promise<boolean> {
  const today = dayStr(0);
  const seen = await redis.get(K.onboardDay(post, user));
  if (seen === today) return false;
  await redis.set(K.onboardDay(post, user), today);
  return true;
}

// ─── Epochs (tower resets to a new "Tower #N" when it fully collapses) ─────────
export async function getEpoch(post: string): Promise<number> {
  return Math.max(1, int(await redis.get(K.epoch(post)), 1));
}

export async function getPeak(post: string): Promise<number> {
  return numKey(K.epochPeak(post));
}

export async function bumpPeak(post: string, height: number): Promise<void> {
  if (height > (await getPeak(post))) await redis.set(K.epochPeak(post), String(height));
}

/** Archive the finished tower and start the next epoch. Returns the closed epoch. */
export async function rolloverEpoch(post: string): Promise<{ epoch: number; peak: number }> {
  const [epoch, peak] = await Promise.all([getEpoch(post), getPeak(post)]);
  const raw = await redis.get(K.hallOfFame(post));
  let list: unknown[];
  try {
    list = raw ? (JSON.parse(raw) as unknown[]) : [];
  } catch {
    list = [];
  }
  list.unshift({ epoch, peak, ts: Date.now() });
  await Promise.all([
    redis.set(K.hallOfFame(post), JSON.stringify(list.slice(0, 10))),
    redis.set(K.epoch(post), String(epoch + 1)),
    redis.set(K.epochPeak(post), '0'),
    redis.del(K.drift(post)), // fresh tower starts undrifted
  ]);
  return { epoch, peak };
}

/**
 * What `user` would earn if a quake struck now: each of their standing blocks is
 * worth its floor number (higher = worth more). This is the player's "at stake".
 */
export function stakeFor(tower: Block[], user: string): Stake {
  let blocks = 0;
  let pts = 0;
  tower.forEach((b, i) => {
    if (b.owner === user) {
      blocks += 1;
      pts += scoreForBlock(i, b, tower[i - 1]); // height × lean/risk
    }
  });
  return { blocks, pts };
}

// ─── Public state snapshot ────────────────────────────────────────────────────
export async function buildState(post: string, tower?: Block[]): Promise<PublicState> {
  const blocks = tower ?? (await getTower(post));
  const [quakeId, nextRaw, lastRaw, epoch, epochPeak, tremorAt] = await Promise.all([
    numKey(K.quakeId(post)),
    redis.get(K.nextQuakeAt(post)),
    redis.get(K.lastQuake(post)),
    getEpoch(post),
    getPeak(post),
    numKey(K.lastTremor(post)),
  ]);

  let lastQuake: QuakeSummary | null = null;
  if (lastRaw) {
    try {
      lastQuake = JSON.parse(lastRaw) as QuakeSummary;
    } catch {
      lastQuake = null;
    }
  }

  return {
    tower: blocks.slice(Math.max(0, blocks.length - VISIBLE_BLOCKS)),
    height: blocks.length,
    instability: instabilityPct(blocks),
    quakeId,
    nextQuakeAt: int(nextRaw),
    serverNow: Date.now(),
    lastQuake,
    epoch,
    epochPeak: Math.max(epochPeak, blocks.length),
    tremorAt,
  };
}

// ─── Leaderboard (top by all-time survival score) ─────────────────────────────
export async function leaderboard(
  post: string,
  you: string,
  tower: Block[]
): Promise<{ entries: LeaderboardEntry[]; you: LeaderboardEntry | null }> {
  const standingByUser = new Map<string, number>();
  for (const b of tower) standingByUser.set(b.owner, (standingByUser.get(b.owner) ?? 0) + 1);

  const rows = await redis.zRange(K.scoreboard(post), 0, 9, { reverse: true, by: 'rank' });
  const entries: LeaderboardEntry[] = rows.map((r, i) => ({
    username: r.member,
    score: r.score,
    standing: standingByUser.get(r.member) ?? 0,
    rank: i + 1,
  }));

  let youEntry: LeaderboardEntry | null = entries.find((e) => e.username === you) ?? null;
  if (!youEntry && you) {
    const [score, ascRank, total] = await Promise.all([
      getScore(post, you),
      redis.zRank(K.scoreboard(post), you),
      redis.zCard(K.scoreboard(post)),
    ]);
    // zRank is ascending; convert to descending "from the top" rank.
    const rank = ascRank === undefined || ascRank === null ? 0 : total - ascRank;
    youEntry = { username: you, score, standing: standingByUser.get(you) ?? 0, rank };
  }
  return { entries, you: youEntry };
}
