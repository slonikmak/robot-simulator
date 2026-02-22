// ============================================================
//  Exhibition Robot Simulator
//  Top-down view, Arduino-style behaviour, differential drive,
//  simulated ultrasonic + colour-sensor.
// ============================================================

'use strict';

// ── Tuneable constants ────────────────────────────────────────
const CFG = {
  // World
  ZONE_RADIUS:   2.0,   // m  – habitat zone radius (диаметр 4.0 м)
  ROBOT_RADIUS:  0.15,  // m  – robot body radius (30 cm ⌀)
  WHEEL_BASE:    0.28,  // m  – distance between driven wheels

  // Obstacles
  WALL_WIDTH:     3.0,   // m – bottom wall length (slightly wider than zone)
  WALL_THICKNESS: 0.12,  // m – wall thickness
  WALL_INTRUSION: 0.10,  // m – how much the wall enters the zone from the bottom

  // Legs (cursor) physical approximation (for ultrasonic ray hit)
  LEGS_RADIUS:    0.11,  // m – effective radius for ray intersection

  // Speeds (realistic Arduino/motor limits)
  MAX_LIN_SPEED: 0.25,  // m/s  forward/backward
  MAX_ANG_SPEED: 2.0,   // rad/s  rotation
  LINEAR_ACCEL:  0.5,   // m/s² acceleration limit
  LUNGE_SPEED:   0.35,  // m/s  aggression lunge speed

  // Timings (seconds, real-time; TIME_SCALE multiplies sim clock)
  AGGRESSION_DURATION:  30,
  GUARD_DURATION:       30,
  CALM_WAIT:            60,   // before extra clutch after legs leave
  SAFE_CYCLE_PERIOD:    180,  // 3 minutes before laying in safety
  INTER_CLUTCH_DELAY:   3.0,  // pause between clutches during laying

  // Eggs
  CLUTCH_COUNT:         3,    // clutches per safety cycle
  EGGS_PER_CLUTCH:      10,
  EGG_SPREAD:           0.07, // m – radius of egg scatter around drop point
  CLUTCH_OFFSET:        0.05, // m – shift for "post-calming" clutch

  // Sensor model
  ULTRASONIC_RANGE:     3.0,  // m
  ULTRASONIC_NOISE:     0.02, // m std-dev noise
  ULTRASONIC_HZ:        15,   // update frequency
  ULTRASONIC_FOV:       Math.PI * (15 / 180), // rad (15°) valid detection cone
  COLOR_SENSOR_DIST:    0.06, // m – sensor is this far ahead of robot center

  // Trigger distances (metres)
  WAKE_DIST_FROM_BOUNDARY:  3.0,  // legs this close → robot wakes/activates
  LUNGE_AMPLITUDE_MIN:      0.25,
  LUNGE_AMPLITUDE_MAX:      0.50,

  // Rendering
  PX_PER_METER_DEFAULT: 130,  // pixels per metre at zoom=1
  ZOOM_MIN:  0.3,
  ZOOM_MAX:  4.0,
  ZOOM_STEP: 0.001,
};

// ── Helpers ───────────────────────────────────────────────────
function lerp(a, b, t) { return a + (b - a) * t; }
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function randBetween(a, b) { return a + Math.random() * (b - a); }
function randSign() { return Math.random() < 0.5 ? 1 : -1; }
function normaliseAngle(a) {
  while (a >  Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

// ── Geometry helpers (ray casts / collisions) ─────────────────
function rayIntersectCircle(origin, dir, center, radius) {
  // dir should be normalized; returns t >= 0 (meters) or Infinity
  const fx = origin.x - center.x;
  const fy = origin.y - center.y;
  const b  = 2 * (fx * dir.x + fy * dir.y);
  const c  = (fx * fx + fy * fy) - radius * radius;
  const disc = b * b - 4 * c;
  if (disc < 0) return Infinity;
  const s = Math.sqrt(disc);
  const t1 = (-b - s) / 2;
  const t2 = (-b + s) / 2;
  if (t1 >= 0) return t1;
  if (t2 >= 0) return t2;
  return Infinity;
}

function rayIntersectAABB(origin, dir, minX, minY, maxX, maxY) {
  // Returns t >= 0 to first intersection with AABB or Infinity.
  let tmin = -Infinity;
  let tmax = Infinity;

  if (Math.abs(dir.x) < 1e-9) {
    if (origin.x < minX || origin.x > maxX) return Infinity;
  } else {
    const tx1 = (minX - origin.x) / dir.x;
    const tx2 = (maxX - origin.x) / dir.x;
    tmin = Math.max(tmin, Math.min(tx1, tx2));
    tmax = Math.min(tmax, Math.max(tx1, tx2));
  }

  if (Math.abs(dir.y) < 1e-9) {
    if (origin.y < minY || origin.y > maxY) return Infinity;
  } else {
    const ty1 = (minY - origin.y) / dir.y;
    const ty2 = (maxY - origin.y) / dir.y;
    tmin = Math.max(tmin, Math.min(ty1, ty2));
    tmax = Math.min(tmax, Math.max(ty1, ty2));
  }

  if (tmax < 0 || tmin > tmax) return Infinity;
  return tmin >= 0 ? tmin : tmax >= 0 ? 0 : Infinity;
}

function resolveCircleVsAABB(circlePos, circleRadius, minX, minY, maxX, maxY) {
  const closestX = clamp(circlePos.x, minX, maxX);
  const closestY = clamp(circlePos.y, minY, maxY);
  let dx = circlePos.x - closestX;
  let dy = circlePos.y - closestY;
  const d2 = dx * dx + dy * dy;
  const r2 = circleRadius * circleRadius;
  if (d2 >= r2) return false;

  if (d2 > 1e-12) {
    const d = Math.sqrt(d2);
    const push = (circleRadius - d);
    dx /= d;
    dy /= d;
    circlePos.x += dx * push;
    circlePos.y += dy * push;
    return true;
  }

  // Circle center is inside the AABB; push it out via smallest axis.
  const toLeft   = circlePos.x - minX;
  const toRight  = maxX - circlePos.x;
  const toTop    = circlePos.y - minY;
  const toBottom = maxY - circlePos.y;
  const m = Math.min(toLeft, toRight, toTop, toBottom);
  if (m === toLeft)      circlePos.x = minX - circleRadius;
  else if (m === toRight)  circlePos.x = maxX + circleRadius;
  else if (m === toTop)    circlePos.y = minY - circleRadius;
  else                     circlePos.y = maxY + circleRadius;
  return true;
}

// ── Vec2 ──────────────────────────────────────────────────────
class Vec2 {
  constructor(x = 0, y = 0) { this.x = x; this.y = y; }
  add(v)       { return new Vec2(this.x + v.x, this.y + v.y); }
  sub(v)       { return new Vec2(this.x - v.x, this.y - v.y); }
  scale(s)     { return new Vec2(this.x * s, this.y * s); }
  len()        { return Math.hypot(this.x, this.y); }
  norm()       { const l = this.len(); return l > 1e-9 ? this.scale(1 / l) : new Vec2(0, 0); }
  dot(v)       { return this.x * v.x + this.y * v.y; }
  angle()      { return Math.atan2(this.y, this.x); }
  distTo(v)    { return this.sub(v).len(); }
  clone()      { return new Vec2(this.x, this.y); }
  set(v)       { this.x = v.x; this.y = v.y; return this; }
  static fromAngle(a, l = 1) { return new Vec2(Math.cos(a) * l, Math.sin(a) * l); }
}

// ── Obstacles (axis-aligned rectangles) ───────────────────────
class RectObstacle {
  constructor(cx, cy, w, h) {
    this.cx = cx;
    this.cy = cy;
    this.w  = w;
    this.h  = h;
  }
  get minX() { return this.cx - this.w * 0.5; }
  get maxX() { return this.cx + this.w * 0.5; }
  get minY() { return this.cy - this.h * 0.5; }
  get maxY() { return this.cy + this.h * 0.5; }
}

const OBSTACLES = (() => {
  const yTop = CFG.ZONE_RADIUS - CFG.WALL_INTRUSION;
  const cy   = yTop + CFG.WALL_THICKNESS * 0.5;
  return [
    // Bottom wall: mostly outside the zone, slightly intrudes.
    new RectObstacle(0, cy, CFG.WALL_WIDTH, CFG.WALL_THICKNESS),
  ];
})();

// ── Camera ────────────────────────────────────────────────────
const camera = {
  x: 0, y: 0,     // world position of canvas centre
  zoom: 1.0,
};

function worldToScreen(wx, wy, canvas) {
  const cx = canvas.width  / 2;
  const cy = canvas.height / 2;
  const scale = CFG.PX_PER_METER_DEFAULT * camera.zoom;
  return {
    x: cx + (wx - camera.x) * scale,
    y: cy + (wy - camera.y) * scale,
  };
}

function screenToWorld(sx, sy, canvas) {
  const cx = canvas.width  / 2;
  const cy = canvas.height / 2;
  const scale = CFG.PX_PER_METER_DEFAULT * camera.zoom;
  return {
    x: (sx - cx) / scale + camera.x,
    y: (sy - cy) / scale + camera.y,
  };
}

// ── Renderer ──────────────────────────────────────────────────
class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx    = canvas.getContext('2d');
  }

  resize() {
    this.canvas.width  = window.innerWidth;
    this.canvas.height = window.innerHeight;
  }

  // Metre → pixel scale factor
  get scale() { return CFG.PX_PER_METER_DEFAULT * camera.zoom; }

  mToPx(m) { return m * this.scale; }

  // Convert world Vec2 (or x,y) to screen coords
  w2s(v) {
    const r = worldToScreen(v.x, v.y, this.canvas);
    return new Vec2(r.x, r.y);
  }

  // ── Draw zone ─────────────────────────────────────────
  drawZone() {
    const ctx = this.ctx;
    const c   = this.w2s(new Vec2(0, 0));
    const R   = this.mToPx(CFG.ZONE_RADIUS);

    // Floor fill (light concrete)
    ctx.save();
    ctx.beginPath();
    ctx.arc(c.x, c.y, R, 0, 2 * Math.PI);
    ctx.fillStyle = '#2a2a1e';
    ctx.fill();

    // Floor tile grid (subtle)
    ctx.clip();
    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
    ctx.lineWidth   = 1;
    const tileM  = 0.5; // 50 cm grid
    const tilePx = this.mToPx(tileM);
    const startX = c.x - R - tilePx;
    const startY = c.y - R - tilePx;
    for (let x = startX; x <= c.x + R + tilePx; x += tilePx) {
      ctx.beginPath();
      ctx.moveTo(x, startY);
      ctx.lineTo(x, c.y + R + tilePx);
      ctx.stroke();
    }
    for (let y = startY; y <= c.y + R + tilePx; y += tilePx) {
      ctx.beginPath();
      ctx.moveTo(startX, y);
      ctx.lineTo(c.x + R + tilePx, y);
      ctx.stroke();
    }
    ctx.restore();

    // Boundary marking (thick coloured line on floor)
    ctx.beginPath();
    ctx.arc(c.x, c.y, R, 0, 2 * Math.PI);
    ctx.strokeStyle = '#e8c84a';
    ctx.lineWidth   = Math.max(3, this.mToPx(0.04));
    ctx.setLineDash([this.mToPx(0.18), this.mToPx(0.09)]);
    ctx.stroke();
    ctx.setLineDash([]);

    // Inner safety "trigger" ring (faint, 0.5m from boundary)
    const Ri = this.mToPx(CFG.ZONE_RADIUS - CFG.WAKE_DIST_FROM_BOUNDARY);
    ctx.beginPath();
    ctx.arc(c.x, c.y, Ri, 0, 2 * Math.PI);
    ctx.strokeStyle = 'rgba(255,100,100,0.14)';
    ctx.lineWidth   = 1.5;
    ctx.setLineDash([this.mToPx(0.1), this.mToPx(0.12)]);
    ctx.stroke();
    ctx.setLineDash([]);

    // Labels
    const labelR = R + this.mToPx(0.12);
    ctx.font      = `${Math.max(10, this.mToPx(0.11))}px 'Segoe UI',sans-serif`;
    ctx.fillStyle = '#e8c84a88';
    ctx.textAlign = 'center';
    ctx.fillText('⌀ 4.0 м (зона обитания)', c.x, c.y - labelR);
  }

  // ── Draw obstacles ───────────────────────────────────
  drawObstacles(obstacles) {
    if (!obstacles || !obstacles.length) return;
    const ctx = this.ctx;
    ctx.save();
    for (const o of obstacles) {
      const tl = this.w2s(new Vec2(o.minX, o.minY));
      const br = this.w2s(new Vec2(o.maxX, o.maxY));
      const w = br.x - tl.x;
      const h = br.y - tl.y;

      // Wall body
      ctx.fillStyle = 'rgba(70, 90, 120, 0.55)';
      ctx.strokeStyle = 'rgba(120, 170, 255, 0.35)';
      ctx.lineWidth = Math.max(1, this.mToPx(0.01));
      ctx.beginPath();
      ctx.rect(tl.x, tl.y, w, h);
      ctx.fill();
      ctx.stroke();

      // Subtle highlight edge (top)
      ctx.strokeStyle = 'rgba(255,255,255,0.10)';
      ctx.lineWidth = Math.max(1, this.mToPx(0.006));
      ctx.beginPath();
      ctx.moveTo(tl.x, tl.y);
      ctx.lineTo(tl.x + w, tl.y);
      ctx.stroke();
    }
    ctx.restore();
  }

  // ── Draw egg clutches ─────────────────────────────────
  drawClutches(clutches, activeIdx) {
    clutches.forEach((clutch, ci) => {
      const isActive = ci === activeIdx;
      clutch.eggs.forEach(egg => {
        const sp = this.w2s(egg.pos);
        const r  = this.mToPx(egg.radius);
        this.ctx.save();
        this.ctx.globalAlpha = egg.alpha * 0.92;
        this.ctx.beginPath();
        this.ctx.ellipse(sp.x, sp.y, r * 1.3, r, 0, 0, 2 * Math.PI);
        this.ctx.fillStyle   = egg.color;
        this.ctx.strokeStyle = 'rgba(0,0,0,0.4)';
        this.ctx.lineWidth   = 0.8;
        this.ctx.fill();
        this.ctx.stroke();
        this.ctx.restore();
      });

      // Active clutch: glow ring
      if (isActive && clutch.eggs.length > 0) {
        const sp = this.w2s(clutch.center);
        const r  = this.mToPx(0.1);
        const g  = this.ctx.createRadialGradient(sp.x, sp.y, 0, sp.x, sp.y, r * 2);
        g.addColorStop(0, 'rgba(180,255,120,0.22)');
        g.addColorStop(1, 'rgba(180,255,120,0)');
        this.ctx.beginPath();
        this.ctx.arc(sp.x, sp.y, r * 2, 0, 2 * Math.PI);
        this.ctx.fillStyle = g;
        this.ctx.fill();
      }
    });
  }

  // ── Draw flying egg particles ─────────────────────────
  drawParticles(particles) {
    particles.forEach(p => {
      const sp = this.w2s(p.pos);
      const r  = this.mToPx(p.r);
      const alpha = (1 - p.t) * 0.9;
      this.ctx.save();
      this.ctx.globalAlpha = alpha;
      this.ctx.beginPath();
      this.ctx.ellipse(sp.x, sp.y, r * 1.3, r, p.t * Math.PI, 0, 2 * Math.PI);
      this.ctx.fillStyle   = `hsl(${90 + p.t * 30}, 65%, 58%)`;
      this.ctx.strokeStyle = 'rgba(0,0,0,0.3)';
      this.ctx.lineWidth   = 0.7;
      this.ctx.fill();
      this.ctx.stroke();
      this.ctx.restore();
    });
  }

  // ── Draw robot (ladybug, top view) ───────────────────
  drawRobot(robot) {
    const ctx  = this.ctx;
    const pos  = robot.pos.add(robot.vibrate);
    const sp   = this.w2s(pos);
    const R    = this.mToPx(CFG.ROBOT_RADIUS);
    const h    = robot.heading;
    const s    = this.scale;

    ctx.save();
    ctx.translate(sp.x, sp.y);
    ctx.rotate(h);

    // ── Shadow ──
    ctx.save();
    ctx.globalAlpha = 0.25;
    ctx.beginPath();
    ctx.ellipse(R * 0.08, R * 0.12, R * 1.05, R * 0.9, 0, 0, 2 * Math.PI);
    ctx.fillStyle = '#000';
    ctx.fill();
    ctx.restore();

    // ── Body (red ellipse) ──
    ctx.beginPath();
    ctx.ellipse(0, 0, R, R * 0.9, 0, 0, 2 * Math.PI);
    const bodyGrad = ctx.createRadialGradient(-R * 0.25, -R * 0.3, 0, 0, 0, R * 1.1);
    bodyGrad.addColorStop(0, '#ff5a3a');
    bodyGrad.addColorStop(0.6, '#cc2200');
    bodyGrad.addColorStop(1,   '#801400');
    ctx.fillStyle   = bodyGrad;
    ctx.strokeStyle = '#601000';
    ctx.lineWidth   = Math.max(1, R * 0.07);
    ctx.fill();
    ctx.stroke();

    // ── Centre line (elytra seam) ──
    ctx.beginPath();
    ctx.moveTo(-R * 0.08, -R * 0.85);
    ctx.lineTo(-R * 0.08,  R * 0.85);
    ctx.strokeStyle = 'rgba(80,0,0,0.6)';
    ctx.lineWidth   = Math.max(0.5, R * 0.04);
    ctx.stroke();

    // ── Black spots (4 on body) ──
    const spotPositions = [
      [-0.35, -0.40], [0.35, -0.40],
      [-0.32,  0.22], [0.32,  0.22],
    ];
    spotPositions.forEach(([sx, sy]) => {
      ctx.beginPath();
      ctx.ellipse(sx * R, sy * R, R * 0.16, R * 0.14, 0, 0, 2 * Math.PI);
      ctx.fillStyle = 'rgba(0,0,0,0.75)';
      ctx.fill();
    });

    // ── Head (dark circle, front = +x direction in local space) ──
    ctx.beginPath();
    ctx.arc(R * 0.82, 0, R * 0.32, 0, 2 * Math.PI);
    const headGrad = ctx.createRadialGradient(R * 0.72, -R * 0.1, 0, R * 0.82, 0, R * 0.32);
    headGrad.addColorStop(0, '#444');
    headGrad.addColorStop(1, '#111');
    ctx.fillStyle   = headGrad;
    ctx.strokeStyle = '#000';
    ctx.lineWidth   = Math.max(0.5, R * 0.05);
    ctx.fill();
    ctx.stroke();

    // Head eyes (two tiny white dots)
    [[-0.1, -0.17], [-0.1, 0.17]].forEach(([ex, ey]) => {
      ctx.beginPath();
      ctx.arc((R * 0.82) + ex * R, ey * R, R * 0.05, 0, 2 * Math.PI);
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.fill();
    });

    // ── Antennae ──
    ctx.strokeStyle = 'rgba(0,0,0,0.7)';
    ctx.lineWidth   = Math.max(0.5, R * 0.04);
    const antLen = R * 0.55;
    [[-0.28], [0.28]].forEach(([ay]) => {
      ctx.beginPath();
      ctx.moveTo(R * 0.95, ay * R);
      ctx.quadraticCurveTo(
        R * 1.3,  ay * R - Math.sign(ay) * R * 0.15,
        R * 1.35, ay * R - Math.sign(ay) * R * 0.35
      );
      ctx.stroke();
      // Antenna tip ball
      ctx.beginPath();
      ctx.arc(R * 1.35, ay * R - Math.sign(ay) * R * 0.35, R * 0.06, 0, 2 * Math.PI);
      ctx.fillStyle = '#2a2a2a';
      ctx.fill();
    });

    // ── Transparent "belly window" showing eggs inside ──
    ctx.beginPath();
    ctx.ellipse(-R * 0.10, 0, R * 0.42, R * 0.30, 0, 0, 2 * Math.PI);
    ctx.save();
    ctx.clip();
    // Inside tint
    ctx.fillStyle = 'rgba(230, 255, 200, 0.18)';
    ctx.fill();
    // Draw mini-eggs inside window
    const miniEggs = Math.min(
      robot.clutches.reduce((a, c) => a + c.eggs.length, 0),
      8
    );
    for (let i = 0; i < miniEggs; i++) {
      const ea = (i / 8) * 2 * Math.PI;
      const er = R * 0.22;
      ctx.beginPath();
      ctx.ellipse(
        -R * 0.10 + Math.cos(ea) * er * 0.55,
        Math.sin(ea) * er * 0.4,
        R * 0.07, R * 0.055, ea, 0, 2 * Math.PI
      );
      ctx.fillStyle = `hsl(${90 + i * 15}, 55%, 55%)`;
      ctx.globalAlpha = 0.75;
      ctx.fill();
    }
    ctx.restore();
    ctx.beginPath();
    ctx.ellipse(-R * 0.10, 0, R * 0.42, R * 0.30, 0, 0, 2 * Math.PI);
    ctx.strokeStyle = 'rgba(180,255,130,0.35)';
    ctx.lineWidth   = Math.max(0.5, R * 0.04);
    ctx.stroke();

    // ── Wheels (2 driven wheels, visible from top) ──
    const wheelW = R * 0.22;
    const wheelH = R * 0.45;
    [-1, 1].forEach(side => {
      ctx.save();
      ctx.translate(0, side * R * 0.88);
      ctx.beginPath();
      ctx.rect(-wheelH * 0.5, -wheelW * 0.5, wheelH, wheelW);
      ctx.fillStyle   = '#222';
      ctx.strokeStyle = '#555';
      ctx.lineWidth   = Math.max(0.3, R * 0.03);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    });

    // ── State indicator ring ──────────────────────────────
    let stateColor = '#ffffff44';
    switch (robot.state) {
      case STATE.SLEEP:      stateColor = '#7fb3d388'; break;
      case STATE.IDLE_SAFE:  stateColor = '#6fcf9788'; break;
      case STATE.LAYING:     stateColor = '#c19fff';   break;
      case STATE.AGGRESSION: stateColor = '#ff6b6bee'; break;
      case STATE.RETREATING: stateColor = '#f5a62399'; break;
      case STATE.GUARD:      stateColor = '#4fc3f7aa'; break;
      case STATE.CALMING:    stateColor = '#a5d6a799'; break;
    }
    ctx.beginPath();
    ctx.arc(0, 0, R * 1.08, 0, 2 * Math.PI);
    ctx.strokeStyle = stateColor;
    ctx.lineWidth   = Math.max(1, R * 0.09);
    ctx.stroke();

    // Buzz ripples
    if (robot.isBuzzing) {
      const buzzR = R * 1.4 + Math.sin(robot.buzzPhase) * R * 0.25;
      ctx.beginPath();
      ctx.arc(0, 0, buzzR, 0, 2 * Math.PI);
      ctx.strokeStyle = 'rgba(200,170,255,0.35)';
      ctx.lineWidth   = 1.5;
      ctx.stroke();
    }

    ctx.restore();

    // ── Ultrasonic sensor cone (debug visual) ──────────
    if (s > 80) {
      const rangeR = this.mToPx(Math.min(CFG.ULTRASONIC_RANGE, 3.0));
      ctx.save();
      ctx.translate(sp.x, sp.y);
      ctx.rotate(h);
      const halfFov = CFG.ULTRASONIC_FOV * 0.5;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, rangeR, -halfFov, halfFov);
      ctx.closePath();
      ctx.fillStyle = 'rgba(100,200,255,0.04)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(100,200,255,0.10)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.restore();
    }
  }

  // ── Draw "legs" cursor ────────────────────────────────
  drawLegs(legsPos) {
    const sp  = this.w2s(legsPos);
    const ctx = this.ctx;
    const r   = this.mToPx(0.06);
    const now = performance.now() / 1000;

    // Two foot silhouettes
    const offsets = [
      { dx: -r * 0.55, dy: r * 0.1, rot: -0.2 },
      { dx:  r * 0.55, dy: r * 0.1, rot:  0.2 },
    ];
    offsets.forEach(o => {
      ctx.save();
      ctx.translate(sp.x + o.dx, sp.y + o.dy);
      ctx.rotate(o.rot + Math.sin(now * 5) * 0.06);
      ctx.beginPath();
      ctx.ellipse(0, 0, r * 0.55, r * 0.9, 0, 0, 2 * Math.PI);
      ctx.fillStyle = 'rgba(255,220,180,0.85)';
      ctx.strokeStyle = 'rgba(100,60,30,0.6)';
      ctx.lineWidth = 1.5;
      ctx.fill();
      ctx.stroke();
      // Toes
      for (let t = 0; t < 4; t++) {
        const ta = -0.5 + t * 0.33;
        ctx.beginPath();
        ctx.ellipse(Math.sin(ta) * r * 0.45, -r * 0.78, r * 0.13, r * 0.18, ta, 0, 2 * Math.PI);
        ctx.fillStyle = 'rgba(255,210,160,0.85)';
        ctx.strokeStyle = 'rgba(100,60,30,0.5)';
        ctx.lineWidth = 1;
        ctx.fill();
        ctx.stroke();
      }
      ctx.restore();
    });

    // Ring to make position clear
    ctx.save();
    ctx.beginPath();
    ctx.arc(sp.x, sp.y, r * 2.2, 0, 2 * Math.PI);
    ctx.strokeStyle = 'rgba(255,255,255,0.2)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
  }

  // ── Scale bar ─────────────────────────────────────────
  drawScaleBar() {
    const ctx = this.ctx;
    const barM   = 1.0;  // 1 metre
    const barPx  = this.mToPx(barM);
    const bx     = 24;
    const by     = this.canvas.height - 36;
    ctx.save();
    ctx.fillStyle   = 'rgba(10,10,20,0.6)';
    ctx.strokeStyle = '#aaa';
    ctx.lineWidth   = 2;
    ctx.beginPath();
    ctx.moveTo(bx, by);
    ctx.lineTo(bx + barPx, by);
    ctx.moveTo(bx, by - 6);
    ctx.lineTo(bx, by + 6);
    ctx.moveTo(bx + barPx, by - 6);
    ctx.lineTo(bx + barPx, by + 6);
    ctx.stroke();
    ctx.fillStyle   = '#ddd';
    ctx.font        = '12px Segoe UI,sans-serif';
    ctx.textAlign   = 'center';
    ctx.fillText('1 м', bx + barPx / 2, by - 10);
    ctx.restore();
  }

  // ── Main draw ─────────────────────────────────────────
  draw(robot, legsPos, obstacles) {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    // Background
    ctx.fillStyle = '#16162a';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    this.drawZone();
    this.drawObstacles(obstacles);
    this.drawClutches(robot.clutches, robot.activeClutchIdx);
    this.drawParticles(robot.particles);
    this.drawRobot(robot);
    this.drawLegs(legsPos);
    this.drawScaleBar();
  }
}

// ── UI helpers ────────────────────────────────────────────────
const elState   = document.getElementById('state-label');
const elDist    = document.getElementById('dist-label');
const elClutch  = document.getElementById('clutch-count-label');
const elLayTmr  = document.getElementById('lay-timer-label');
const elTimer   = document.getElementById('timer-label');
const elSpeed   = document.getElementById('speed-value');
const speedSldr = document.getElementById('speed-slider');

function updateUI(robot, timeScale) {
  const stateKey = robot.state.toLowerCase().replace('_', '-');
  elState.textContent = STATE_LABELS[robot.state] || robot.state;
  elState.className   = 'state-badge ' + stateKey.replace('idle-safe','safe').replace('laying','laying');

  // show ultrasonic sensor reading instead of legs distance
  const d = robot.ultrasonic.lastMeasurement;
  elDist.textContent = isFinite(d) ? `${d.toFixed(2)} м` : '> 3 м';

  const totalEggs = robot.clutches.reduce((a, c) => a + c.eggs.length, 0);
  elClutch.textContent = `${robot.clutches.length} кл. (${totalEggs} икринок)`;

  const safeRemain = CFG.SAFE_CYCLE_PERIOD / timeScale - robot.safeTimer / timeScale;
  if (robot.state === STATE.IDLE_SAFE) {
    elLayTmr.textContent = `${Math.max(0, (CFG.SAFE_CYCLE_PERIOD - robot.safeTimer) / timeScale).toFixed(0)} с`;
  } else {
    elLayTmr.textContent = '—';
  }

  elTimer.textContent = `${robot.stateTimer.toFixed(1)} с`;
  elSpeed.textContent = `${timeScale}×`;
}

// ── Main simulation loop ──────────────────────────────────────
const canvas   = document.getElementById('canvas');
const renderer = new Renderer(canvas);
renderer.resize();

// initial robot near zone centre, slightly offset
const robot = new Robot(0.15, -0.10);
const legsPos = new Vec2(-999, -999); // off-screen initially

let lastTime  = null;
let timeScale = 1;

// Zoom
canvas.addEventListener('wheel', e => {
  e.preventDefault();
  const delta = e.deltaY * CFG.ZOOM_STEP * -1;
  camera.zoom = clamp(camera.zoom + delta * camera.zoom, CFG.ZOOM_MIN, CFG.ZOOM_MAX);
}, { passive: false });

// Mouse → legs position
canvas.addEventListener('mousemove', e => {
  const rect  = canvas.getBoundingClientRect();
  const sx    = (e.clientX - rect.left) * (canvas.width  / rect.width);
  const sy    = (e.clientY - rect.top)  * (canvas.height / rect.height);
  const world = screenToWorld(sx, sy, canvas);
  legsPos.x   = world.x;
  legsPos.y   = world.y;
});

// Touch support (tablets)
canvas.addEventListener('touchmove', e => {
  e.preventDefault();
  const touch = e.touches[0];
  const rect  = canvas.getBoundingClientRect();
  const sx    = (touch.clientX - rect.left) * (canvas.width  / rect.width);
  const sy    = (touch.clientY - rect.top)  * (canvas.height / rect.height);
  const world = screenToWorld(sx, sy, canvas);
  legsPos.x   = world.x;
  legsPos.y   = world.y;
}, { passive: false });

speedSldr.addEventListener('input', () => {
  timeScale = parseInt(speedSldr.value, 10);
});

window.addEventListener('resize', () => { renderer.resize(); });

function loop(ts) {
  if (!lastTime) lastTime = ts;
  let realDt = Math.min((ts - lastTime) / 1000, 0.05); // cap at 50 ms
  lastTime   = ts;
  const simDt = realDt * timeScale;

  robot.update(simDt, legsPos, OBSTACLES);

  // keep camera roughly centred on robot (smooth follow)
  camera.x += (robot.pos.x - camera.x) * 0.08;
  camera.y += (robot.pos.y - camera.y) * 0.08;

  renderer.draw(robot, legsPos, OBSTACLES);
  updateUI(robot, timeScale);

  requestAnimationFrame(loop);
}

requestAnimationFrame(loop);
