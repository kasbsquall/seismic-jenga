// ─────────────────────────────────────────────────────────────────────────────
// SEISMIC — shared game model
//
// This file is the single source of truth for the stacking / stability math.
// It is PURE (no I/O) so the server can use it to resolve quakes authoritatively
// and the client can use the exact same numbers to preview risk while aiming.
// ─────────────────────────────────────────────────────────────────────────────

// Three SHAPES, not materials. What matters is width: the block below you is the
// platform you rest on, so a wide beam is a safe base to build risky things on,
// and a narrow pillar gives almost no margin (risky, but pays more).
export type BlockType = 'beam' | 'block' | 'pillar';

export type Block = {
  id: string;
  owner: string;
  type: BlockType;
  /** Absolute horizontal offset of the block center from the tower centerline. */
  x: number;
  /** Reinforced (anchored) — heavier, more stabilizing. */
  r?: boolean;
};

export const REINFORCE_COST = 4;
/** Reinforcing a block "anchors" it — widens the support it tolerates (defensive). */
export const REINFORCE_SUPPORT_MULT = 1.4;

export function blockMass(b: Block): number {
  return BLOCK_STATS[b.type].mass;
}

// ─── Tunable constants (virtual units) ───────────────────────────────────────
export const BLOCK_W = 58;
export const BLOCK_H = 24;

/** Half-width of the ground platform. Narrower than a block → centering matters. */
export const BASE_HALF = 44;

/**
 * A quake shifts each joint's tolerated support by a fixed lateral amount
 * (models an earthquake's horizontal g-force). Additive (not proportional) so it
 * threatens tall/narrow/off-center stacks and rewards wide, centered, anchored ones.
 */
export const QUAKE_LATERAL = 26;

/** Only the top slice of the tower is ever rendered / at risk. */
export const VISIBLE_BLOCKS = 16;

export const START_CREDITS = 50;

/**
 * The system-owned "bedrock" block: always index 0, centered, belongs to nobody
 * and scores for nobody. It gives every player's first real block something to
 * land on — so being *first* is no longer a free, near-guaranteed point.
 */
export const FOUNDATION_OWNER = 'seismic';
export function foundationBlock(): Block {
  return { id: 'foundation', owner: FOUNDATION_OWNER, type: 'beam', x: 0 };
}
export function isFoundation(b: Block): boolean {
  return b.owner === FOUNDATION_OWNER;
}

export const BLOCK_STATS: Record<
  BlockType,
  { widthMul: number; mass: number; cost: number; label: string }
> = {
  // widthMul scales BLOCK_W → the footprint a block offers to whatever sits on it.
  // Cost scales with size (bigger piece = more material): intuitive + it keeps the
  // wide, ultra-stable beam from being spammed, so shape stays a real decision.
  beam: { widthMul: 1.6, mass: 2.4, cost: 3, label: 'Beam' }, // wide, stable platform
  block: { widthMul: 1.0, mass: 1.0, cost: 2, label: 'Block' }, // the standard piece
  pillar: { widthMul: 0.74, mass: 0.7, cost: 1, label: 'Pillar' }, // narrow, risky — but still buildable
};

/** Rendered / physical width of a block (varies by shape). */
export function blockW(b: Block): number {
  return BLOCK_W * BLOCK_STATS[b.type].widthMul;
}

/** How far a block's center may sit from the block below before it slides off —
 *  scaled by the SUPPORT (the block below's width). Wide below = lots of room. */
export function overhangLimit(below: Block | undefined): number {
  // 0.42 leaves a safety margin below the 0.5 tip point, so a *legal* placement is
  // never already at the edge of collapse — it takes a quake or drift to finish it.
  // Wider support below → more room to lean out over the void.
  return below ? blockW(below) * 0.42 : BASE_HALF * 0.88;
}

/**
 * Points a surviving block is worth = its height (floor number) × a lean/risk
 * multiplier. A block stacked dead-center on the one below scores the bare floor;
 * one that leans out toward the edge and *survives* pays up to ~2× more. This is
 * the core anti-boredom lever: playing it safe in the center is worth the least,
 * so a tower of timid centered blocks is a losing strategy. Shared by the server
 * (quake rewards) and client (at-stake preview) so the numbers always match.
 */
export const LEAN_REWARD = 1.15; // max ≈ 2.15× points for a max-overhang survivor
export function scoreForBlock(
  floorIndex: number,
  block: Block,
  below: Block | undefined
): number {
  const floor = floorIndex + 1; // 1-based (bedrock is floor 1)
  const overhang = Math.abs(block.x - (below ? below.x : 0));
  const lean = Math.min(1, overhang / overhangLimit(below));
  return Math.max(1, Math.round(floor * (1 + LEAN_REWARD * lean)));
}

export const BLOCK_TYPES: BlockType[] = ['beam', 'block', 'pillar'];

export function isBlockType(v: unknown): v is BlockType {
  return v === 'beam' || v === 'block' || v === 'pillar';
}

// ─── Placement ───────────────────────────────────────────────────────────────

/**
 * Clamp a desired drop position so the new block still rests on support:
 * within OVERLAP_LIMIT of the block below, or within the base for the first block.
 */
export function clampPlacement(desiredX: number, topBlock: Block | undefined): number {
  const lim = overhangLimit(topBlock);
  const center = topBlock ? topBlock.x : 0;
  return Math.max(center - lim, Math.min(center + lim, desiredX));
}

// ─── Stability ───────────────────────────────────────────────────────────────

type Joint = { supportCenter: number; supportHalf: number; comAbove: number };

/**
 * For each block i, compute the mass-weighted center of everything from i upward
 * and the support it rests on (block below, or the base for i = 0).
 */
function joints(blocks: Block[]): Joint[] {
  const n = blocks.length;
  if (n === 0) return [];

  // Suffix mass and mass*x, computed from the top down.
  const result: Joint[] = new Array(n);
  let mass = 0;
  let moment = 0;
  for (let i = n - 1; i >= 0; i--) {
    const m = blockMass(blocks[i]!);
    mass += m;
    moment += m * blocks[i]!.x;
    const comAbove = moment / mass;
    const below = blocks[i - 1];
    const anchor = blocks[i]!.r ? REINFORCE_SUPPORT_MULT : 1;
    result[i] = {
      supportCenter: below ? below.x : 0,
      supportHalf: (below ? blockW(below) / 2 : BASE_HALF) * anchor,
      comAbove,
    };
  }
  return result;
}

/**
 * Structural stress as a 0..1+ ratio. 0 = perfectly balanced, 1 = at the edge of
 * toppling under its own weight (no quake needed). Can exceed 1 when critical.
 */
export function stressRatio(blocks: Block[]): number {
  let worst = 0;
  for (const j of joints(blocks)) {
    const r = Math.abs(j.comAbove - j.supportCenter) / j.supportHalf;
    if (r > worst) worst = r;
  }
  return worst;
}

/** Instability meter for the HUD (0..100, capped). */
export function instabilityPct(blocks: Block[]): number {
  return Math.min(100, Math.round(stressRatio(blocks) * 100));
}

/**
 * A single quake shears off the unstable TOP of the tower — it never levels a
 * tall, well-built tower in one hit. The cap scales with magnitude (a huge quake
 * takes more) but a 50-floor tower keeps a real base. Also keeps the on-screen
 * collapse readable instead of yanking the view all the way to the ground.
 */
function maxQuakeFall(height: number, magnitude: number): number {
  return Math.max(8, Math.ceil(height * (0.2 + magnitude * 0.4)));
}

/**
 * Resolve a quake authoritatively. A quake of `magnitude` (0..1) shrinks every
 * joint's tolerated support. The tower snaps at the LOWEST failing joint — that
 * joint and everything above it topples, capped so the base survives. Deterministic.
 *
 * Returns the ids that fall and how many survive.
 */
export function resolveQuake(
  blocks: Block[],
  magnitude: number
): { fallenIds: string[]; survived: number } {
  const js = joints(blocks);
  const lateral = magnitude * QUAKE_LATERAL;
  const minSurvived = Math.max(0, blocks.length - maxQuakeFall(blocks.length, magnitude));
  for (let i = 0; i < js.length; i++) {
    const j = js[i]!;
    const tolerated = j.supportHalf - lateral;
    if (Math.abs(j.comAbove - j.supportCenter) > tolerated) {
      const survived = Math.max(i, minSurvived); // shear the top; keep a base on tall towers
      return { fallenIds: blocks.slice(survived).map((b) => b.id), survived };
    }
  }
  return { fallenIds: [], survived: blocks.length };
}

// ─── Seeded RNG (deterministic magnitude generation on the server) ────────────

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Internal magnitude 0..1, skewed toward STRONG quakes (the fun ones) with some
 * smaller tremors mixed in. Most quakes are a real threat; a few are gentle.
 */
export function magnitudeFromSeed(seed: number): number {
  const r = mulberry32(seed)();
  return Math.round((0.2 + 0.75 * Math.pow(r, 0.55)) * 100) / 100;
}

/** Map the internal 0..1 magnitude to a familiar Richter-scale reading (~4.1–8.0). */
export function toRichter(magnitude: number): number {
  return Math.round((3.8 + magnitude * 4.4) * 10) / 10;
}
