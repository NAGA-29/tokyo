# Performance

Goal: 60 fps at the very least, 120 fps where the screen allows — without changing the picture.

## What limits the frame

The frame is limited by the CPU, not by the graphics card: three.js spends its time walking and drawing
thousands of small objects, several times per frame (the picture, the sun's shadow map, the water mirror, the
lamp light map at night, ambient occlusion's extra renders). Halving the resolution barely changes the frame
time. So the work below is about fewer objects, fewer walks through the scene and fewer, larger draws — the
graphics card has room to spare.

Measured in headless Chrome at 3840 × 2160 on an RTX 5090, frames driven by hand without vsync
(`tools/_bench.mjs`, `tools/_prof.mjs`; not in the repository). The picture is checked against captures of
twelve fixed views, frozen in time, taken before the work began (`tools/_fid.mjs`).

## Baseline (before the work)

| Scene | Frame | Draw calls |
|---|---|---|
| Tokyo, view radius 900 m, day | 3.6 ms | 1565 |
| Tokyo, view radius 900 m, night | 9.6 ms | 2190 |
| Tokyo, whole city, day | 13.9 ms | 4380 |
| Tokyo, whole city, night | 32.9 ms | 5545 |

## Checklist

- [x] 1. Lamp light quads drawn in a single pass (they were drawn twice, and looked their shader up anew at
      every draw)
- [x] 2. Matrices of things that never move are computed once, and the scene's matrices once per frame
      instead of once per render
- [x] 3. Ambient occlusion: no walks through the whole scene for the few transparent things
- [x] 4. Lamp light quads in a scene of their own: the light map no longer walks the city three times per
      frame (the quads themselves join the instance pools of step 6)
- [x] 5. Trees: one instanced mesh per tile for the far shapes instead of one per species
- [ ] 6. Small props (poles, lamps, signals, vending machines, parked cars, street furniture): instance pools
      for the whole city instead of one mesh per kind per tile
- [ ] 7. Roof and wall photos: one material for all tiles (the photos in a texture array)

## Results

Frame time: the median of 100 frames, each waited for (`gl.finish`), best of five runs.

| Step | Tokyo day | Tokyo night | Whole city day | Whole city night | Picture |
|---|---|---|---|---|---|
| baseline | 3.6 ms | 9.6 ms | 13.9 ms | 32.9 ms | |
| 1. lamp quads in one pass | 3.6 ms | 4.9 ms | 13.9 ms | 20.1 ms | identical |
| 2. matrices once per frame | 3.2 ms | 3.9 ms | 10.9 ms | 14.7 ms | identical |
| 3. ambient occlusion without the scene walks | = | = | −1.5 ms | −1.5 ms | identical |
| 4. lamp quads in their own scene | = | = | = | −2 ms | identical |
| 5. far trees: one mesh per tile | −46 draws | −46 draws | −234 draws | −234 draws | identical |

From step 3 on the machine was busy with other work while measuring, so the times of different runs no longer
compare: a step's gain is given as the difference between the old and the new code, switched within one run.
