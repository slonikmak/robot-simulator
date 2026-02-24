'use strict';

// ─────────────────────────────────────────────
//  CFG  –  all tunable constants in one place
// ─────────────────────────────────────────────
const CFG = {
  // Room (metres)
  ROOM_W: 10,
  ROOM_H: 20,

  // Robot body (metres)
  ROBOT_RADIUS: 0.15,         // 30 cm diameter
  WHEEL_BASE:   0.20,         // distance between left and right wheel contact points

  // ToF sensors – angles relative to robot heading (radians)
  TOF_ANGLES: [0, -35 * Math.PI / 180, 35 * Math.PI / 180],
  // Approx. VL53L1X FoV is ~27° (cone). We approximate by sampling rays across the cone.
  TOF_FOV_DEG: 27,
  TOF_CONE_RAYS: 7,
  TOF_MIN_MM:   40,
  TOF_MAX_MM:   2000,
  TOF_NOISE_SIGMA_MM:   15,   // Gaussian σ
  TOF_OUTLIER_PROB:     0.05, // probability of a ±80 mm spike
  TOF_OUTLIER_AMP_MM:   80,
  TOF_DROPOUT_PROB:     0.02, // probability of returning null (no reading)
  TOF_HZ:               30,   // sensor update rate (Hz)

  // Visitor legs model (metres)
  LEG_RADIUS:    0.05,        // 100 mm diameter cylinders
  LEG_SPACING:   0.18,        // 180 mm between centres
  // Bags (metres) – simple circular obstacle approximation
  BAG_RADIUS: 0.20,
  // "Alive" bags timing (seconds)
  BAG_MOVE_MIN_S: 12.0,
  BAG_MOVE_MAX_S: 28.0,
  BAG_HIDE_MIN_S: 0.6,
  BAG_HIDE_MAX_S: 1.6,
  // Pedestals (metres)
  PEDESTAL_RADIUS: 0.75,      // 1.5 m diameter

  // Firmware behaviour thresholds (mm, matching firmware.js logic)
  SCAN_FRONT_MM:      1100,
  SCAN_DETECT_MM:     1400,  // start active scan when any sensor sees nearer than this
  SCAN_ASYM_MM:       150,
  WALL_ALL_MM:        600,
  APPROACH_STOP_MM:   320,
  DEPOSIT_DIST_MM:    300,
  SCAN_TURN_SPEED:    0.16,  // wheel speed (m/s) during scan turn-in-place
  SCAN_SWEEP_DEG:     70,    // how far to rotate during scan
  SCAN_MAX_S:         1.0,   // hard time cap for scan state
  SCAN_COOLDOWN_S:    1.5,   // after a wall/unknown scan, wait before re-triggering
  DEPOSIT_COOLDOWN_S: 3.5,   // extra long cooldown after depositing eggs to explore elsewhere
  SCAN_HIT_MM:        1400,  // "hit" threshold for scan signature
  SCAN_FAR_MM:        1700,  // consider "open space" if farther than this
  WALL_SCAN_HIT_FRAC:   0.65,
  WALL_SCAN_MIN_SPAN_DEG: 55,
  WALL_SCAN_SPREAD_MM:  140,
  WALL_SCAN_STD_MM:      90,
  LEG_SCAN_SPAN_DEG:     80,
  LEG_SCAN_OPEN_FRAC:   0.10,
  LEG_SCAN_SPREAD_MM:   220,
  LEG_SCAN_MIN_ASYM_SAMPLES: 1,
  LEG_SCAN_MAX_HIT_FRAC: 1.00,

  // Speeds (m/s at the wheel contact)
  SPEED_WANDER:   0.25,
  SPEED_APPROACH: 0.14,
  SPEED_ESCAPE:   0.20,

  // Timing
  WANDER_TURN_MIN_S: 15.0,    // longer straight movement before turning
  WANDER_TURN_MAX_S: 30.0,   // can drive straight for up to 30 seconds
  DEPOSIT_PAUSE_MIN_S: 2.0,
  DEPOSIT_PAUSE_MAX_S: 4.0,
  ESCAPE_BACK_S:  1.0,        // time to reverse ~30 cm at SPEED_ESCAPE
  ESCAPE_TURN_MIN_DEG: 70,
  ESCAPE_TURN_MAX_DEG: 140,
  // Stronger avoidance when we believe we're facing a wall or after deposit
  WALL_ESCAPE_BACK_S:  1.3,
  WALL_ESCAPE_TURN_MIN_DEG: 120,
  WALL_ESCAPE_TURN_MAX_DEG: 175,
  ESCAPE_TURN_SPEED: 0.20,

  // Simulation speed control (timescale)
  SIM_SPEED_MIN: 0.25,
  SIM_SPEED_MAX: 3.0,
  SIM_SPEED_ACCEL: 4.0,   // 1/s smoothing toward target

  // Eggs
  EGGS_START: 30,
};


// ─────────────────────────────────────────────
//  Geometry helpers (2-D, all in metres)
// ─────────────────────────────────────────────

/**
 * Ray–segment intersection.
 * Ray: origin (ox,oy), unit direction (dx,dy).
 * Segment: (ax,ay)→(bx,by).
 * Returns t ≥ 0 (distance along ray) or null.
 */
function raySegment(ox, oy, dx, dy, ax, ay, bx, by) {
  const ex = bx - ax, ey = by - ay;
  const denom = dx * ey - dy * ex;
  if (Math.abs(denom) < 1e-10) return null;       // parallel
  const fx = ax - ox, fy = ay - oy;
  const t = (fx * ey - fy * ex) / denom;
  const u = (fx * dy - fy * dx) / denom;
  if (t >= 0 && u >= 0 && u <= 1) return t;
  return null;
}

/**
 * Ray–circle intersection.
 * Returns the smaller positive t, or null if no hit in front of ray.
 */
function rayCircle(ox, oy, dx, dy, cx, cy, r) {
  const fx = ox - cx, fy = oy - cy;
  const a = dx * dx + dy * dy;          // should be 1 for unit ray
  const b = 2 * (fx * dx + fy * dy);
  const c = fx * fx + fy * fy - r * r;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  const sqrtDisc = Math.sqrt(disc);
  const t1 = (-b - sqrtDisc) / (2 * a);
  const t2 = (-b + sqrtDisc) / (2 * a);
  if (t1 >= 0) return t1;
  if (t2 >= 0) return t2;
  return null;
}

/**
 * Box–Muller: Gaussian sample with mean=0, stddev=sigma.
 */
function gaussianNoise(sigma) {
  const u1 = Math.random(), u2 = Math.random();
  return sigma * Math.sqrt(-2 * Math.log(u1 + 1e-12)) * Math.cos(2 * Math.PI * u2);
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}


// ─────────────────────────────────────────────
//  World  –  static geometry + visitor legs
// ─────────────────────────────────────────────
class World {
  constructor() {
    // Room walls as 4 line segments: [ax,ay, bx,by] in metres
    this.walls = [
      [0, 0, CFG.ROOM_W, 0],                         // bottom
      [CFG.ROOM_W, 0, CFG.ROOM_W, CFG.ROOM_H],       // right
      [CFG.ROOM_W, CFG.ROOM_H, 0, CFG.ROOM_H],       // top
      [0, CFG.ROOM_H, 0, 0],                          // left
    ];

    // Visitor legs: two cylinders. Updated every frame from mouse.
    this.legCentres = [
      { x: -999, y: -999 },   // hidden off-screen initially
      { x: -999, y: -999 },
    ];

    // Pinned legs: placed by user clicks, persist on canvas
    this.pinnedLegs = [];
    this._nextLegPairId = 1;

    // Placed props (obstacles)
    this.bags = [];       // { x, y }
    this.pedestals = [];  // { x, y }

    // Whether the mouse pointer is inside the canvas
    this.legsVisible = false;

    // "Alive" props behaviour
    this._time = 0;
    this._aliveEnabled = false;
  }

  _configureLegGait(leg) {
    // Base (anchor) position for oscillations.
    if (leg.ax === undefined) leg.ax = leg.x;
    if (leg.ay === undefined) leg.ay = leg.y;

    // Drift velocity of the anchor.
    if (leg.vx === undefined) leg.vx = 0;
    if (leg.vy === undefined) leg.vy = 0;

    // Preferred "forward" direction of the person.
    if (leg.fwdX === undefined || leg.fwdY === undefined) {
      const theta = Math.random() * Math.PI * 2;
      leg.fwdX = Math.cos(theta);
      leg.fwdY = Math.sin(theta);
    } else {
      const n = Math.sqrt(leg.fwdX * leg.fwdX + leg.fwdY * leg.fwdY) || 1;
      leg.fwdX /= n;
      leg.fwdY /= n;
    }

    if (leg.stepOffset === undefined) leg.stepOffset = 0;
    if (leg.stepHz === undefined) leg.stepHz = 0.65 + Math.random() * 0.75; // 0.65–1.40 Hz
    if (leg.stepPhase === undefined) leg.stepPhase = Math.random() * Math.PI * 2;
    if (leg.swayAmp === undefined) leg.swayAmp = 0.010 + Math.random() * 0.014; // 1.0–2.4 cm
    if (leg.strideAmp === undefined) {
      leg.strideAmp = Math.random() < 0.55 ? (0.006 + Math.random() * 0.016) : 0; // 0–2.2 cm
    }

    // Occasional short forward/back shuffles (anchor motion).
    if (leg.walkTimer === undefined) leg.walkTimer = 0;
    if (leg.walkVel === undefined) leg.walkVel = 0;
    if (leg.walkNextAt === undefined) leg.walkNextAt = this._time + 0.9 + Math.random() * 3.2;
  }

  setAliveEnabled(enabled) {
    this._aliveEnabled = !!enabled;
    if (this._aliveEnabled) {
      // Mark only some pinned legs as mobile (even if they were placed before enabling).
      let anyMobile = false;
      for (const leg of this.pinnedLegs) {
        leg.mobile = Math.random() < 0.40;
        anyMobile ||= leg.mobile;
        this._configureLegGait(leg);
        leg.vx = 0;
        leg.vy = 0;
      }
      if (!anyMobile && this.pinnedLegs.length > 0) {
        const i = Math.floor(Math.random() * this.pinnedLegs.length);
        this.pinnedLegs[i].mobile = true;
      }

      // Ensure bag timers exist.
      for (const bag of this.bags) {
        bag.hidden = bag.hidden ?? false;
        bag.hiddenUntil = bag.hiddenUntil ?? 0;
        const minS = CFG.BAG_MOVE_MIN_S ?? 12.0;
        const maxS = CFG.BAG_MOVE_MAX_S ?? 28.0;
        bag.nextMoveAt = bag.nextMoveAt ?? (this._time + minS + Math.random() * Math.max(0, maxS - minS));
      }
    } else {
      // Stop motion cleanly.
      for (const leg of this.pinnedLegs) {
        this._configureLegGait(leg);
        leg.vx = 0;
        leg.vy = 0;
        leg.walkTimer = 0;
        leg.walkVel = 0;
        // Freeze in place without oscillation jump.
        leg.ax = leg.x;
        leg.ay = leg.y;
      }
    }
  }

  update(dt) {
    this._time += dt;
    if (!this._aliveEnabled) return;

    // Pinned legs: some drift + stepping and small forward/back shuffles.
    const margin = CFG.LEG_RADIUS;
    const accel = 0.55;      // m/s^2
    const maxV = 0.08;       // m/s
    const dampK = 3.5;       // 1/s
    const damp = Math.exp(-dampK * dt);

    for (const leg of this.pinnedLegs) {
      if (!leg.mobile) continue;
      this._configureLegGait(leg);

      // Step oscillation (weight shift + slight stride).
      leg.stepPhase += (Math.PI * 2) * leg.stepHz * dt;

      const ax = (Math.random() - 0.5) * accel;
      const ay = (Math.random() - 0.5) * accel;
      leg.vx = (leg.vx ?? 0) + ax * dt;
      leg.vy = (leg.vy ?? 0) + ay * dt;

      // Damping + cap.
      leg.vx *= damp;
      leg.vy *= damp;
      const sp = Math.sqrt(leg.vx * leg.vx + leg.vy * leg.vy) || 0;
      if (sp > maxV) {
        leg.vx = (leg.vx / sp) * maxV;
        leg.vy = (leg.vy / sp) * maxV;
      }

      // Short forward/back "shuffle" bursts on the anchor.
      if (leg.walkTimer <= 0 && this._time >= leg.walkNextAt) {
        const sign = Math.random() < 0.5 ? 1 : -1;
        leg.walkVel = sign * (0.025 + Math.random() * 0.060); // m/s
        leg.walkTimer = 0.20 + Math.random() * 0.55;
        leg.walkNextAt = this._time + 1.2 + Math.random() * 4.5;
      }
      if (leg.walkTimer > 0) {
        leg.ax += leg.fwdX * leg.walkVel * dt;
        leg.ay += leg.fwdY * leg.walkVel * dt;
        leg.walkTimer -= dt;
        if (leg.walkTimer <= 0) leg.walkVel = 0;
      }

      // Random anchor drift (small).
      leg.ax += leg.vx * dt;
      leg.ay += leg.vy * dt;

      const sideX = -leg.fwdY;
      const sideY =  leg.fwdX;
      const sway = Math.sin(leg.stepPhase + leg.stepOffset);
      const stride = Math.sin(leg.stepPhase * 0.70 + leg.stepOffset + 1.05);
      const offX = sideX * leg.swayAmp * sway + leg.fwdX * leg.strideAmp * stride;
      const offY = sideY * leg.swayAmp * sway + leg.fwdY * leg.strideAmp * stride;

      let x = leg.ax + offX;
      let y = leg.ay + offY;

      // Keep inside room, soft bounce.
      if (x < margin) { x = margin; leg.ax = x - offX; leg.vx *= -0.25; }
      if (x > CFG.ROOM_W - margin) { x = CFG.ROOM_W - margin; leg.ax = x - offX; leg.vx *= -0.25; }
      if (y < margin) { y = margin; leg.ay = y - offY; leg.vy *= -0.25; }
      if (y > CFG.ROOM_H - margin) { y = CFG.ROOM_H - margin; leg.ay = y - offY; leg.vy *= -0.25; }

      leg.x = x;
      leg.y = y;
    }

    // Bags: periodically disappear and respawn elsewhere.
    for (const bag of this.bags) {
      bag.hidden = bag.hidden ?? false;
      bag.hiddenUntil = bag.hiddenUntil ?? 0;
      const moveMinS = CFG.BAG_MOVE_MIN_S ?? 12.0;
      const moveMaxS = CFG.BAG_MOVE_MAX_S ?? 28.0;
      const hideMinS = CFG.BAG_HIDE_MIN_S ?? 0.6;
      const hideMaxS = CFG.BAG_HIDE_MAX_S ?? 1.6;
      bag.nextMoveAt = bag.nextMoveAt ?? (this._time + moveMinS + Math.random() * Math.max(0, moveMaxS - moveMinS));

      if (bag.hidden) {
        if (this._time >= bag.hiddenUntil) {
          const r = CFG.BAG_RADIUS;
          bag.x = r + Math.random() * (CFG.ROOM_W - 2 * r);
          bag.y = r + Math.random() * (CFG.ROOM_H - 2 * r);
          bag.hidden = false;
          bag.nextMoveAt = this._time + moveMinS + Math.random() * Math.max(0, moveMaxS - moveMinS);
        }
      } else if (this._time >= bag.nextMoveAt) {
        bag.hidden = true;
        bag.hiddenUntil = this._time + hideMinS + Math.random() * Math.max(0, hideMaxS - hideMinS);
      }
    }
  }

  /**
   * Place leg cylinders centred on (wx, wy) in world coordinates.
   * The two legs are offset perpendicular to the viewing direction (horizontal).
   */
  setLegsAt(wx, wy) {
    // Keep legs inside the room; otherwise the robot will correctly hit the wall first
    // (but visually it looks like it should be approaching the legs).
    const marginX = CFG.LEG_RADIUS;
    const marginY = CFG.LEG_RADIUS;
    const cx = clamp(wx, marginX, CFG.ROOM_W - marginX);
    const cy = clamp(wy, marginY, CFG.ROOM_H - marginY);

    const half = CFG.LEG_SPACING / 2;
    const lx0 = clamp(cx - half, marginX, CFG.ROOM_W - marginX);
    const lx1 = clamp(cx + half, marginX, CFG.ROOM_W - marginX);
    this.legCentres[0] = { x: lx0, y: cy };
    this.legCentres[1] = { x: lx1, y: cy };
    this.legsVisible = true;
  }

  hideLegs() {
    this.legCentres[0] = { x: -999, y: -999 };
    this.legCentres[1] = { x: -999, y: -999 };
    this.legsVisible = false;
  }

  /**
   * Add a pinned leg at world position (wx, wy).
   */
  addPinnedLeg(wx, wy) {
    const marginX = CFG.LEG_RADIUS;
    const marginY = CFG.LEG_RADIUS;
    const cx = clamp(wx, marginX, CFG.ROOM_W - marginX);
    const cy = clamp(wy, marginY, CFG.ROOM_H - marginY);
    this.pinnedLegs.push({
      x: cx,
      y: cy,
      ax: cx,
      ay: cy,
      mobile: this._aliveEnabled ? (Math.random() < 0.40) : false,
      vx: 0,
      vy: 0,
    });
  }

  /**
   * Add a pinned pair of legs centred near (wx, wy) with random spacing and direction.
   * Both legs are kept inside the room.
   */
  addPinnedLegPair(wx, wy) {
    const spacing = 0.14 + Math.random() * 0.14; // 0.14–0.28 m
    const theta = Math.random() * Math.PI * 2;
    const half = spacing / 2;

    const marginX = CFG.LEG_RADIUS + half;
    const marginY = CFG.LEG_RADIUS + half;
    const cx = clamp(wx, marginX, CFG.ROOM_W - marginX);
    const cy = clamp(wy, marginY, CFG.ROOM_H - marginY);

    const dx = Math.cos(theta);
    const dy = Math.sin(theta);
    const pairId = this._nextLegPairId++;
    const mobile = this._aliveEnabled ? (Math.random() < 0.40) : false;
    const fwdSign = Math.random() < 0.5 ? 1 : -1;
    const fwdX = -dy * fwdSign;
    const fwdY =  dx * fwdSign;
    this.pinnedLegs.push({
      x: cx - dx * half,
      y: cy - dy * half,
      ax: cx - dx * half,
      ay: cy - dy * half,
      pairId,
      stepOffset: 0,
      fwdX,
      fwdY,
      mobile,
      vx: 0,
      vy: 0,
    });
    this.pinnedLegs.push({
      x: cx + dx * half,
      y: cy + dy * half,
      ax: cx + dx * half,
      ay: cy + dy * half,
      pairId,
      stepOffset: Math.PI,
      fwdX,
      fwdY,
      mobile,
      vx: 0,
      vy: 0,
    });
  }

  /**
   * Add a bag (circular obstacle) at (wx, wy). Clamped to room interior.
   */
  addBag(wx, wy) {
    const r = CFG.BAG_RADIUS;
    const cx = clamp(wx, r, CFG.ROOM_W - r);
    const cy = clamp(wy, r, CFG.ROOM_H - r);
    const moveMinS = CFG.BAG_MOVE_MIN_S ?? 12.0;
    const moveMaxS = CFG.BAG_MOVE_MAX_S ?? 28.0;
    this.bags.push({
      x: cx,
      y: cy,
      hidden: false,
      hiddenUntil: 0,
      nextMoveAt: this._time + moveMinS + Math.random() * Math.max(0, moveMaxS - moveMinS),
    });
  }

  /**
   * Add a circular pedestal (can be placed partially outside the room).
   */
  addPedestal(wx, wy) {
    this.pedestals.push({ x: wx, y: wy });
  }

  clearPlaced() {
    this.pinnedLegs = [];
    this.bags = [];
    this.pedestals = [];
  }

  /**
   * Remove a pinned leg at position (x, y) if one exists nearby.
   * Returns true if a leg was removed.
   */
  removePinnedLeg(x, y) {
    const threshold = CFG.LEG_RADIUS * 1.5;  // touch threshold
    for (let i = 0; i < this.pinnedLegs.length; i++) {
      const leg = this.pinnedLegs[i];
      const dist = Math.sqrt((leg.x - x) ** 2 + (leg.y - y) ** 2);
      if (dist < threshold) {
        this.pinnedLegs.splice(i, 1);
        return true;
      }
    }
    return false;
  }

  /**
   * Get pinned leg near position (x, y), or null if none found.
   */
  getPinnedLegAt(x, y) {
    const threshold = CFG.LEG_RADIUS * 1.5;
    for (const leg of this.pinnedLegs) {
      const dist = Math.sqrt((leg.x - x) ** 2 + (leg.y - y) ** 2);
      if (dist < threshold) {
        return leg;
      }
    }
    return null;
  }

  /**
   * Cast a single ray from (ox,oy) in direction angle (radians).
   * Returns distance in metres to the nearest surface (wall or leg cylinder).
   * Returns CFG.TOF_MAX_MM/1000 if nothing is hit within range.
   */
  castRay(ox, oy, angle) {
    const maxDist = CFG.TOF_MAX_MM / 1000;
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    let nearest = maxDist;

    // Test walls
    for (const [ax, ay, bx, by] of this.walls) {
      const t = raySegment(ox, oy, dx, dy, ax, ay, bx, by);
      if (t !== null && t < nearest) nearest = t;
    }

    // Test cursor leg cylinders
    for (const leg of this.legCentres) {
      const t = rayCircle(ox, oy, dx, dy, leg.x, leg.y, CFG.LEG_RADIUS);
      if (t !== null && t < nearest) nearest = t;
    }

    // Test pinned leg cylinders
    for (const leg of this.pinnedLegs) {
      const t = rayCircle(ox, oy, dx, dy, leg.x, leg.y, CFG.LEG_RADIUS);
      if (t !== null && t < nearest) nearest = t;
    }

    // Test bags (circular obstacles)
    for (const bag of this.bags) {
      if (bag.hidden) continue;
      const t = rayCircle(ox, oy, dx, dy, bag.x, bag.y, CFG.BAG_RADIUS);
      if (t !== null && t < nearest) nearest = t;
    }

    // Test pedestals (circular obstacles)
    for (const p of this.pedestals) {
      const t = rayCircle(ox, oy, dx, dy, p.x, p.y, CFG.PEDESTAL_RADIUS);
      if (t !== null && t < nearest) nearest = t;
    }

    return nearest;
  }
}
