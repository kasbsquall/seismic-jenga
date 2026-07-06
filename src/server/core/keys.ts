// Central Redis key registry — one place so keys never drift between modules.

export const K = {
  tower: (post: string) => `tower:${post}`, // sorted set: member=JSON(block), score=seq
  towerSeq: (post: string) => `towerSeq:${post}`, // monotonic append counter
  quakeId: (post: string) => `quakeId:${post}`,
  quakeLock: (post: string) => `quakeLock:${post}`,
  placeLock: (post: string) => `placeLock:${post}`,
  nextQuakeAt: (post: string) => `nextQuakeAt:${post}`,
  lastQuake: (post: string) => `lastQuake:${post}`,
  jobId: (post: string) => `quakeJob:${post}`,
  scoreboard: (post: string) => `scoreboard:${post}`,
  reinforced: (post: string) => `reinforced:${post}`, // hash: blockId -> "1"
  drift: (post: string) => `drift:${post}`, // hash: blockId -> accumulated tremor px
  lastTremor: (post: string) => `lastTremor:${post}`,
  epoch: (post: string) => `epoch:${post}`,
  epochPeak: (post: string) => `epochPeak:${post}`,
  hallOfFame: (post: string) => `hallOfFame:${post}`,

  credits: (post: string, user: string) => `credits:${post}:${user}`,
  score: (post: string, user: string) => `score:${post}:${user}`,
  streak: (post: string, user: string) => `streak:${post}:${user}`,
  lastVisit: (post: string, user: string) => `lastVisit:${post}:${user}`,
  lastSeenQuake: (post: string, user: string) =>
    `lastSeenQuake:${post}:${user}`,
  seenStanding: (post: string, user: string) => `seenStanding:${post}:${user}`,
  earnedSince: (post: string, user: string) => `earnedSince:${post}:${user}`,
  bestFloor: (post: string, user: string) => `bestFloor:${post}:${user}`,
  watchAt: (post: string, user: string) => `watchAt:${post}:${user}`,
  watchDay: (post: string, user: string) => `watchDay:${post}:${user}`,
  watchEarned: (post: string, user: string) => `watchEarned:${post}:${user}`,
  onboardDay: (post: string, user: string) => `onboardDay:${post}:${user}`,
};
