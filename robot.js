'use strict';

// ─────────────────────────────────────────────
//  Robot  –  differential-drive physics + ToF sensor model
// ─────────────────────────────────────────────
class Robot {
  constructor(x, y, heading) {
    // Pose (metres, radians)
    this.x       = x;
    this.y       = y;
    this.heading = heading;       // 0 = facing +X (right)

    // Wheel speeds set by firmware (m/s, can be negative)
    this.vLeft  = 0;
    this.vRight = 0;

    // Egg inventory
    this.eggsCarried   = CFG.EGGS_START;
    this.eggs          = [];    // { x, y } world positions of deposited eggs

    // Last sensor readings (mm or null)
    this.sensors = { front: null, left: null, right: null };

    // Sensor update throttle (ToF runs at CFG.TOF_HZ, not every frame)
    this._sensorTimer = 0;

    // Egg throw animation events: array of { x, y, heading, age, duration }
    this.throwEvents = [];
  }

  // ── Called by firmware ──────────────────────

  setWheels(vLeft, vRight) {
    this.vLeft  = vLeft;
    this.vRight = vRight;
  }

  depositEgg() {
    if (this.eggsCarried <= 0) return false;
    // Place egg ~DEPOSIT_DIST_MM ahead of current position
    const dist = CFG.DEPOSIT_DIST_MM / 1000;
    const ex = this.x + Math.cos(this.heading) * dist;
    const ey = this.y + Math.sin(this.heading) * dist;
    this.eggs.push({ x: ex, y: ey });
    this.eggsCarried--;
    // Record throw event for animation
    this.throwEvents.push({
      fromX: this.x,
      fromY: this.y,
      toX: ex,
      toY: ey,
      age: 0,
      duration: 0.5,   // seconds
    });
    return true;
  }

  // ── Physics update ──────────────────────────

  /**
   * Integrate differential-drive kinematics for `dt` seconds.
   * Resolves wall + obstacle collisions.
   */
  update(dt, world) {
    const R  = CFG.ROBOT_RADIUS;
    const L  = CFG.WHEEL_BASE;
    const vL = this.vLeft;
    const vR = this.vRight;

    let dx, dy, dTheta;

    if (Math.abs(vR - vL) < 1e-6) {
      // Straight line (or stopped)
      const v = (vL + vR) / 2;
      dx     = Math.cos(this.heading) * v * dt;
      dy     = Math.sin(this.heading) * v * dt;
      dTheta = 0;
    } else {
      // Arc motion
      const v     = (vL + vR) / 2;
      const omega = (vR - vL) / L;
      dTheta = omega * dt;
      const arcR = v / omega;
      dx = arcR * (Math.sin(this.heading + dTheta) - Math.sin(this.heading));
      dy = arcR * (-Math.cos(this.heading + dTheta) + Math.cos(this.heading));
    }

    // Proposed new position
    let nx = this.x + dx;
    let ny = this.y + dy;

    // Wall collision: keep robot body inside room with radius margin
    const margin = R + 0.01; // small buffer
    let collided = false;

    if (nx < margin) {
      nx = margin;
      if (dx < 0) { this.vLeft  = -this.vLeft  * 0.3;
                    this.vRight = -this.vRight * 0.3; }
      collided = true;
    }
    if (nx > CFG.ROOM_W - margin) {
      nx = CFG.ROOM_W - margin;
      if (dx > 0) { this.vLeft  = -this.vLeft  * 0.3;
                    this.vRight = -this.vRight * 0.3; }
      collided = true;
    }
    if (ny < margin) {
      ny = margin;
      if (dy < 0) { this.vLeft  = -this.vLeft  * 0.3;
                    this.vRight = -this.vRight * 0.3; }
      collided = true;
    }
    if (ny > CFG.ROOM_H - margin) {
      ny = CFG.ROOM_H - margin;
      if (dy > 0) { this.vLeft  = -this.vLeft  * 0.3;
                    this.vRight = -this.vRight * 0.3; }
      collided = true;
    }

    // Obstacle collisions: bags + pedestals are treated as solid circles.
    // Keep the robot outside obstacles while also staying in-bounds.
    const obstacles = [];
    if (world) {
      if (Array.isArray(world.bags)) {
        for (const b of world.bags) {
          if (b.hidden) continue;
          obstacles.push({ x: b.x, y: b.y, r: CFG.BAG_RADIUS });
        }
      }
      if (Array.isArray(world.pedestals)) {
        for (const p of world.pedestals) obstacles.push({ x: p.x, y: p.y, r: CFG.PEDESTAL_RADIUS });
      }
    }

    if (obstacles.length) {
      const sep = 0.005; // 5 mm separation buffer

      for (let iter = 0; iter < 3; iter++) {
        let pushed = false;

        for (const o of obstacles) {
          const ox = o.x;
          const oy = o.y;
          const rr = R + o.r + sep;
          const vx = nx - ox;
          const vy = ny - oy;
          const d2 = vx * vx + vy * vy;
          if (d2 >= rr * rr) continue;

          const d = Math.sqrt(d2) || 1e-6;
          const overlap = rr - d;
          nx += (vx / d) * overlap;
          ny += (vy / d) * overlap;
          pushed = true;
          collided = true;
        }

        // Re-apply wall constraints after pushes (treat walls as hard bounds).
        if (nx < margin) nx = margin;
        if (nx > CFG.ROOM_W - margin) nx = CFG.ROOM_W - margin;
        if (ny < margin) ny = margin;
        if (ny > CFG.ROOM_H - margin) ny = CFG.ROOM_H - margin;

        if (!pushed) break;
      }
    }

    this.x = nx;
    this.y = ny;
    this.heading = this.heading + dTheta;

    // Normalise heading to (-π, π]
    this.heading = ((this.heading + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;

    // Advance throw animations
    this.throwEvents = this.throwEvents
      .map(e => ({ ...e, age: e.age + dt }))
      .filter(e => e.age < e.duration);

    this._sensorTimer += dt;
  }

  // ── ToF sensor model ────────────────────────

  /**
   * Read all 3 ToF sensors from the world.
   * Applies: Gaussian noise, outlier spikes, dropouts.
   * Throttled to CFG.TOF_HZ; returns cached values between updates.
   */
  readSensors(world) {
    const period = 1 / CFG.TOF_HZ;
    if (this._sensorTimer < period) return this.sensors;
    this._sensorTimer = 0;

    const keys   = ['front', 'left', 'right'];
    const angles = CFG.TOF_ANGLES;
    const fovRad = (CFG.TOF_FOV_DEG ?? 0) * Math.PI / 180;
    const rays   = Math.max(1, CFG.TOF_CONE_RAYS ?? 1);

    for (let i = 0; i < 3; i++) {
      // Dropout: sensor returns null
      if (Math.random() < CFG.TOF_DROPOUT_PROB) {
        this.sensors[keys[i]] = null;
        continue;
      }

      // True distance (metres)
      const beamAngle = this.heading + angles[i];
      let trueDist = CFG.TOF_MAX_MM / 1000;
      if (rays === 1 || fovRad <= 1e-6) {
        trueDist = world.castRay(this.x, this.y, beamAngle);
      } else {
        // Sample rays across the cone and take the nearest hit (typical ToF behaviour).
        for (let j = 0; j < rays; j++) {
          const t = rays === 1 ? 0.5 : j / (rays - 1);   // 0..1
          const offset = (t - 0.5) * fovRad;
          const d = world.castRay(this.x, this.y, beamAngle + offset);
          if (d < trueDist) trueDist = d;
        }
      }

      // Convert to mm, add noise
      let mm = trueDist * 1000;
      mm += gaussianNoise(CFG.TOF_NOISE_SIGMA_MM);

      // Outlier spike
      if (Math.random() < CFG.TOF_OUTLIER_PROB) {
        mm += (Math.random() < 0.5 ? 1 : -1) * CFG.TOF_OUTLIER_AMP_MM;
      }

      // Clamp to sensor range
      mm = Math.max(CFG.TOF_MIN_MM, Math.min(CFG.TOF_MAX_MM, mm));

      this.sensors[keys[i]] = Math.round(mm);
    }

    return this.sensors;
  }
}
