# SEISMIC — Splash video storyboard & submission speech

## 1. Splash background video (looping, muted, ~8s)

A clean cinematic shot of the game itself — HUD hidden (`?cinema=1`) — recorded from
real gameplay with Playwright + ffmpeg. It sits behind the SEISMIC title + CTA on the
post preview so a scroller instantly *gets* the game before clicking.

| Beat | Time | What's on screen |
|------|------|------------------|
| **1. The climb** | 0.0–2.5s | A tall, colorful community tower stands against the deep-space sky, stars twinkling, the distant city glowing far below. The tower sways gently — alive, precarious. |
| **2. The warning** | 2.5–3.0s | A beat of stillness. (In-game this is the red countdown; in the loop it's the calm before.) |
| **3. THE QUAKE** | 3.0–7.0s | Screen flashes red, **"EARTHQUAKE M7.9"** slams across, the whole tower convulses, dust erupts from the base, and blocks tumble off one by one in a dramatic cascade into the void. |
| **4. Aftermath** | 7.0–8.0s | The dust settles. A few survivors stand. Loop restarts (the tower "rebuilt"). |

- **Dimensions:** recorded 720×560, embedded with `object-fit: cover` so it fills any
  splash aspect (mobile-tall or desktop-wide). Encoded H.264, muted, ~1–2 MB.
- **Overlay:** a dark gradient over the video keeps "SEISMIC / Enter the tower" legible.

## 2. Submission speech / pitch (for the Devpost description)

> **SEISMIC — one tower. The whole community. An earthquake nobody controls.**
>
> Most Reddit games put you alone in a post. Seismic puts the *entire subreddit* on
> one shared tower. You drop a block with your name on it, choosing where — play it
> safe near the base, or stack high for more points and more risk. Everyone's blocks,
> one growing tower, climbing from the city streets all the way to space.
>
> Then, at a time nobody controls, an **earthquake** strikes. The server decides —
> fairly, for everyone at once — which blocks survive and which come crashing down.
> Survive, and you score by how high your block stood. Get wiped, and the tower begins
> again as Tower #N, its record enshrined.
>
> The hook is the wait. You place your block and leave — but the quake comes whether
> you're watching or not. You come back to a top-of-thread **aftershock report**
> ("M7.2 — 40 floors fell, u/you survived at floor 31"), a new **flair** on your best
> climb, and a daily streak pulling you in. It's asynchronous, community-scale tension
> that's native to how Reddit actually works.
>
> Built on Devvit Web + Phaser — hand-crafted physics, a space-climb atmosphere, a
> cinematic quake, and a mobile-first "Arcade Brut" look that's all its own.
>
> **Stack a block. Survive the quake. Come back tomorrow.**

## 3. 30-second demo-post script (for the judges)

1. "This is Seismic — a tower the whole subreddit builds together." *(show the tower)*
2. "I pick a block and drop it — safe and low, or high and risky for more points." *(place)*
3. "Everyone's blocks are here. See the names, the stress meter, what's at stake." *(pan)*
4. "Then the earthquake hits — the server decides who survives." *(force quake → collapse)*
5. "I earned points for surviving high. It posts a report, gives flair, and the next
   quake is already coming. That's why you come back." *(show aftermath + comment)*
