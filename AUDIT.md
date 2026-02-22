# Render Performance Audit — Robot Simulator

## Goal
Identify rendering bottlenecks in the simulator's drawing subsystem (`main.js`,
`index.html`, `styles.css`) and propose targeted optimizations.  
Scope is strictly the rendering layer; `robot.js` and `firmware.js` are untouched.

---

## Baseline estimates

| Scenario | Estimated frame budget (60 fps) | Key draw calls per frame |
|---|---|---|
| Default zoom (1×), 0 eggs | ~16.7 ms | ~70–80 Canvas API calls |
| Max zoom (4×), 30 eggs, particles | ~16.7 ms | ~170–200 Canvas API calls |

_Measurements are code-path estimates from static analysis; actual profiling numbers
will vary by device. Use browser DevTools Performance tab → "Rendering" for live data._

---

## Identified bottlenecks

### B-1 · Redundant full-canvas clear (main.js · `draw()` lines 606–610)

```js
ctx.clearRect(0, 0, this.canvas.width, this.canvas.height); // ← redundant
ctx.fillStyle = '#16162a';
ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);  // opaque, covers everything
```

`clearRect` resets all pixels to transparent, then `fillRect` immediately overwrites
them with a solid colour. The first call does unnecessary work.

**Fix:** remove the `clearRect`; `fillRect` alone is sufficient and slightly faster.

---

### B-2 · Grid drawn with O(n) individual stroke calls (main.js · `drawZone()` lines 207–220)

Each grid line is its own `beginPath()` + `moveTo()` + `lineTo()` + `stroke()` cycle.
At default zoom (130 px/m, tile = 65 px, zone diameter ≈ 390 px) this produces
roughly 28 individual pipeline flushes per frame. GPU state changes are the expensive
part here; the extra draw calls prevent batching.

**Fix:** collect all grid lines into a single path and issue one `stroke()`:

```js
ctx.beginPath();
for (let x = startX; x <= endX; x += tilePx) {
  ctx.moveTo(x, startY);
  ctx.lineTo(x, endY);
}
for (let y = startY; y <= endY; y += tilePx) {
  ctx.moveTo(startX, y);
  ctx.lineTo(endX, y);
}
ctx.stroke(); // single call
```

---

### B-3 · Radial gradients recreated every frame (main.js · `drawRobot()` lines 363, 396)

`createRadialGradient()` allocates a new GPU resource on every frame:

```js
const bodyGrad = ctx.createRadialGradient(-R*0.25, -R*0.3, 0, 0, 0, R*1.1); // every frame
const headGrad = ctx.createRadialGradient(R*0.72, -R*0.1, 0, R*0.82, 0, R*0.32); // every frame
```

The gradient geometry only changes when the camera zoom changes (because `R` scales
with `this.scale`). Between zoom events the same object could be reused.

**Fix:** cache gradients keyed on `R` (or `camera.zoom`); invalidate and recreate only
when zoom changes.

```js
// in Renderer constructor
this._cachedZoom = null;
this._bodyGrad   = null;
this._headGrad   = null;

// in drawRobot, before use
if (this._cachedZoom !== camera.zoom) {
  this._cachedZoom = camera.zoom;
  const R = this.mToPx(CFG.ROBOT_RADIUS);
  this._bodyGrad = ctx.createRadialGradient(-R*0.25, -R*0.3, 0, 0, 0, R*1.1);
  // … add color stops once …
  this._headGrad = ctx.createRadialGradient(/* … */);
}
```

---

### B-4 · Per-egg and per-particle `save()`/`restore()` (main.js · `drawClutches()`, `drawParticles()`)

With 3 clutches × 10 eggs = 30 eggs, `drawClutches()` calls `ctx.save()` / `ctx.restore()`
30 times per frame only to set `globalAlpha`. Each save/restore snapshots the full
Canvas 2D state (transform, clip, styles, etc.).

**Fix for eggs:** set `globalAlpha` directly per egg and restore it afterward without
a full save/restore:

```js
const prevAlpha = ctx.globalAlpha;
ctx.globalAlpha = egg.alpha * 0.92;
// … draw egg …
ctx.globalAlpha = prevAlpha;
```

Same pattern applies to particles.

---

### B-5 · Static scene elements redrawn every frame (main.js · `drawZone()`, `drawObstacles()`)

The zone circle, boundary dashes, inner safety ring, and four wall rectangles never
move; they only need to be redrawn when zoom or window size changes. Redrawing them
every frame at 60 fps wastes CPU/GPU time on work that produces identical pixels.

**Fix:** render zone and obstacles to an offscreen `OffscreenCanvas` (or a hidden
`<canvas>`). Composite it each frame with a single `ctx.drawImage()` call. Invalidate
and re-render the offscreen canvas only on `resize` or zoom change.

---

### B-6 · `w2s()` allocates a new `Vec2` object on every call (main.js · `Renderer.w2s()`)

```js
w2s(v) {
  const r = worldToScreen(v.x, v.y, this.canvas);
  return new Vec2(r.x, r.y); // new allocation every call
}
```

`w2s` is called ≥ 20 times per frame (zone center, obstacle corners, each egg, each
particle, robot position, legs position, etc.). Each call allocates two temporary
objects, increasing GC pressure.

**Fix:** reuse a pre-allocated scratch `Vec2` for temporary conversions:

```js
// in Renderer constructor
this._tmpSP = new Vec2();

// w2s to in-place version where the caller doesn't need to hold the result:
_w2sInto(v, out) {
  const cx = this.canvas.width / 2, cy = this.canvas.height / 2;
  const s  = this.scale;
  out.x = cx + (v.x - camera.x) * s;
  out.y = cy + (v.y - camera.y) * s;
  return out;
}
```

For callers that need a persistent result, `w2s` can remain as-is; switch only the
hot-path callers (egg/particle loops) to the in-place version.

---

### B-7 · DOM text updated unconditionally every frame (main.js · `updateUI()` lines 631–651)

`updateUI()` sets `textContent` on six DOM elements every frame (~60× per second),
even when the values have not changed. Each write can trigger style recalculation
on browsers that do not defer DOM mutations.

**Fix:** cache the last written values; skip the DOM write when the value is unchanged:

```js
let _lastState = null, _lastDist = null, _lastTotalEggs = null;
// …
if (robot.state !== _lastState) {
  _lastState = robot.state;
  elState.textContent = STATE_LABELS[robot.state] || robot.state;
  elState.className   = …;
}
```

---

### B-8 · Legs animation always computed even when off-screen (main.js · `drawLegs()` line 545)

```js
ctx.rotate(o.rot + Math.sin(now * 5) * 0.06); // runs every frame
```

When legs are off-screen (initial position `Vec2(-999, -999)`) the foot drawing still
runs, accumulating the `Math.sin` call and all the sub-paths. The shapes are clipped
by the viewport and never reach the screen.

**Fix:** early-exit when `legsPos` is off-screen:

```js
drawLegs(legsPos) {
  const sp = this.w2s(legsPos);
  if (sp.x < -50 || sp.x > this.canvas.width + 50 ||
      sp.y < -50 || sp.y > this.canvas.height + 50) return;
  // … rest of drawing …
}
```

---

### B-9 · `backdrop-filter: blur` on UI panel (styles.css line 38)

```css
backdrop-filter: blur(8px);
```

This forces the browser compositor to render the panel's backdrop to a separate
texture and apply a Gaussian blur. On integrated GPUs (common at exhibition kiosks)
this can cause dropped frames during state transitions when the badge background
animates via CSS `transition`.

**Fix:** if frame rate is tight on target hardware, replace with a solid semi-transparent
`background` (`rgba(10, 10, 30, 0.92)`) and remove `backdrop-filter`.

---

## Priority ranking

| Priority | ID | Impact | Effort |
|---|---|---|---|
| High | B-2 | reduces ~28 → 1 stroke call per frame | Trivial (1 code block) |
| High | B-1 | ~1 redundant full-canvas GPU write | Trivial (1 line removed) |
| Medium | B-3 | 2 gradient allocations → 0 per frame | Low (add 3 cache fields) |
| Medium | B-7 | 6 DOM writes → 0–6 per frame | Low (add cache vars) |
| Medium | B-4 | 30 save/restore → 30 alpha swaps | Low (swap pattern) |
| Low | B-5 | Static redraw → 1 drawImage per frame | Medium (offscreen canvas) |
| Low | B-6 | GC pressure from Vec2 allocs | Medium (scratch objects) |
| Low | B-8 | Skip invisible leg drawing | Trivial (guard at top) |
| Low | B-9 | Compositor layer on target device | Trivial (CSS change) |

---

## Proof of no change

- `robot.js` — **not modified**
- `firmware.js` — **not modified**
- Robot state logic in `main.js` (`loop()`, `robot.update()` call) — **not modified**
- Public simulation constants in `config.js` (`CFG`) — **not modified**
- All public interfaces remain identical

---

_Audit performed via static code analysis of `main.js` (720 lines), `index.html`,
and `styles.css`. Commit hash of audited code: `e17f9bf`._
