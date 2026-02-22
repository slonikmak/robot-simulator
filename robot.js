'use strict';

// ── Single Egg ────────────────────────────────────────────────
class Egg {
  constructor(x, y) {
    this.pos = new Vec2(x, y);
    this.alpha = 0;      // fade-in animation
    this.age   = 0;
    this.radius = randBetween(0.012, 0.022); // visual size in metres
    this.color = `hsl(${randBetween(80, 130)|0}, 60%, 55%)`;
  }
  update(dt) {
    this.age += dt;
    this.alpha = Math.min(1, this.alpha + dt * 3);
  }
}

// ── Clutch (group of eggs) ────────────────────────────────────
class Clutch {
  constructor(x, y) {
    this.center = new Vec2(x, y);
    this.eggs   = [];
    this.done   = false;
  }
  // Called once per egg as it "lands"
  addEgg() {
    const a = Math.random() * 2 * Math.PI;
    const r = Math.random() * CFG.EGG_SPREAD;
    this.eggs.push(new Egg(
      this.center.x + Math.cos(a) * r,
      this.center.y + Math.sin(a) * r
    ));
  }
  update(dt) { this.eggs.forEach(e => e.update(dt)); }
}

// ── Flying-egg animation particle ─────────────────────────────
class EggParticle {
  constructor(from, to) {
    this.from = from.clone();
    this.to   = to.clone();
    this.t    = 0;
    this.dur  = randBetween(0.35, 0.6);
    this.done = false;
    this.arcHeight = randBetween(0.08, 0.18);
    this.r    = randBetween(0.013, 0.020);
  }
  update(dt) {
    this.t = Math.min(1, this.t + dt / this.dur);
    if (this.t >= 1) this.done = true;
  }
  get pos() {
    const t = this.t;
    const x = lerp(this.from.x, this.to.x, t);
    const y = lerp(this.from.y, this.to.y, t);
    // Parabolic arc (in screen space, +y is down, so subtract)
    const arc = -4 * this.arcHeight * t * (1 - t);
    return new Vec2(x, y + arc);
  }
}

// ── Ultrasonic Sensor model ────────────────────────────────────
class UltrasonicSensor {
  constructor(robot) {
    this._robot   = robot;
    this._lastVal = Infinity;
    this._timer   = 0;
    this._interval = 1 / CFG.ULTRASONIC_HZ;
  }
  // dt in *sim* seconds; legsPos = Vec2 cursor position; obstacles = RectObstacle[]
  update(dt, legsPos, obstacles) {
    this._timer += dt;
    if (this._timer >= this._interval) {
      this._timer -= this._interval;

      const origin = this._robot.pos;
      const halfFov = CFG.ULTRASONIC_FOV * 0.5;
      const rayOffsets = [
        -halfFov,
        -halfFov * 0.5,
        0,
        halfFov * 0.5,
        halfFov,
      ];

      let best = Infinity;
      for (const off of rayOffsets) {
        const dir = Vec2.fromAngle(this._robot.heading + off, 1);

        // legs hit
        const tLeg = rayIntersectCircle(origin, dir, legsPos, CFG.LEGS_RADIUS);
        if (tLeg < best) best = tLeg;

        // obstacles hit
        for (const o of (obstacles || [])) {
          const t = rayIntersectAABB(origin, dir, o.minX, o.minY, o.maxX, o.maxY);
          if (t < best) best = t;
        }
      }

      if (best <= CFG.ULTRASONIC_RANGE) {
        const noise = (Math.random() * 2 - 1) * CFG.ULTRASONIC_NOISE;
        this._lastVal = Math.max(0, best + noise);
      } else {
        this._lastVal = Infinity;
      }
    }
    return this._lastVal;
  }
  get lastMeasurement() { return this._lastVal; }
}

// ── Colour sensor (floor line detection) ─────────────────────
class ColorSensor {
  constructor(robot) { this._robot = robot; }
  // Returns true when the sensor (slightly ahead of robot) is
  // near or outside the zone boundary
  read(zoneRadius) {
    const sensorPos = this._robot.pos.add(
      Vec2.fromAngle(this._robot.heading, CFG.COLOR_SENSOR_DIST)
    );
    return sensorPos.len() >= zoneRadius - 0.02;
  }
}

// ── Differential Drive ────────────────────────────────────────
class DifferentialDrive {
  // pwmLeft / pwmRight in range [-1, +1]
  // Returns { linVel, angVel }
  static pwmToVelocity(pwmLeft, pwmRight) {
    const vL = pwmLeft  * CFG.MAX_LIN_SPEED;
    const vR = pwmRight * CFG.MAX_LIN_SPEED;
    return {
      linVel: (vR + vL) / 2,
      angVel: (vR - vL) / CFG.WHEEL_BASE,
    };
  }
}

// ── Robot ─────────────────────────────────────────────────────
class Robot {
  constructor(x, y) {
    this.pos     = new Vec2(x, y);
    this.heading = -Math.PI / 2; // facing "up" initially
    this.linVel  = 0;
    this.angVel  = 0;

    // Motor commands
    this.pwmLeft  = 0;
    this.pwmRight = 0;

    // Sensors
    this.ultrasonic = new UltrasonicSensor(this);
    this.colorSensor = new ColorSensor(this);

    // FSM
    this.state     = STATE.IDLE_SAFE;
    this.stateTimer = 0; // how long in current state (sim seconds)

    // Safe cycle
    this.safeTimer  = 0; // counts toward next laying cycle

    // Egg management
    this.clutches         = [];     // all laid clutches
    this.activeClutchIdx  = -1;     // index of clutch being defended
    this.clutchesThisCycle = 0;     // how many laid this safety cycle

    // Laying sub-state
    this.layingStep       = 0;      // which clutch we're on (0,1,2)
    this.layingSubTimer   = 0;
    this.layingEggTimer   = 0;
    this.layingEggsLeft   = 0;
    this.currentLayingClutch = null;

    // Aggression sub-state
    this.lungeTarget      = null;
    this.lungePhase       = 'drive'; // 'drive' | 'back'
    this.lungeOrigin      = null;

    // Calming
    this.calmTimer        = 0;
    this.didPostCalmLay   = false;

    // Buzz animation
    this.buzzPhase = 0;
    this.isBuzzing = false;

    // Particles
    this.particles = [];

    // Guard jitter
    this.jitterTimer = 0;
    this.jitterTarget = null;

    // Visual
    this.vibrate = new Vec2(0, 0); // vibration offset
  }

  // ── Main FSM update ───────────────────────────────────────
  update(dt, legsPos, obstacles) {
    // Environment updates the sensor using world legs position.
    this.ultrasonic.update(dt, legsPos, obstacles);

    // Firmware sees only sensor readings (no absolute legs position).
    RobotFirmware.updateBehavior(this, dt);

    // ── Boundary override (colour sensor) ──────────────
    if (this.state !== STATE.SLEEP) {
      RobotFirmware.applyBoundaryRepulsion(this);
    }

    // ── Integrate differential drive kinematics ─────────
    const { linVel, angVel } = DifferentialDrive.pwmToVelocity(this.pwmLeft, this.pwmRight);
    const maxAng = CFG.MAX_ANG_SPEED;
    const clampedAng = clamp(angVel, -maxAng, maxAng);

    this.heading += clampedAng * dt;
    this.heading  = normaliseAngle(this.heading);
    this.pos.x   += Math.cos(this.heading) * linVel * dt;
    this.pos.y   += Math.sin(this.heading) * linVel * dt;

    // Hard clamp inside zone
    if (this.pos.len() > CFG.ZONE_RADIUS - CFG.ROBOT_RADIUS) {
      this.pos.set(this.pos.norm().scale(CFG.ZONE_RADIUS - CFG.ROBOT_RADIUS));
    }

    // Obstacle collisions (simple circle vs AABB)
    if (obstacles && obstacles.length) {
      // A couple of passes to keep zone clamp + obstacles stable.
      for (let pass = 0; pass < 2; pass++) {
        for (const o of obstacles) {
          resolveCircleVsAABB(this.pos, CFG.ROBOT_RADIUS, o.minX, o.minY, o.maxX, o.maxY);
        }
        if (this.pos.len() > CFG.ZONE_RADIUS - CFG.ROBOT_RADIUS) {
          this.pos.set(this.pos.norm().scale(CFG.ZONE_RADIUS - CFG.ROBOT_RADIUS));
        }
      }
    }

    // ── Update children ──────────────────────────────────
    this.clutches.forEach(c => c.update(dt));
    this.particles = this.particles.filter(p => { p.update(dt); return !p.done; });

    // Buzz oscillation
    this.buzzPhase += dt * 42;
    if (this.isBuzzing) {
      const bAmp = 0.007;
      this.vibrate.x = Math.sin(this.buzzPhase * 1.7) * bAmp;
      this.vibrate.y = Math.cos(this.buzzPhase)       * bAmp;
    } else {
      this.vibrate.x = lerp(this.vibrate.x, 0, dt * 8);
      this.vibrate.y = lerp(this.vibrate.y, 0, dt * 8);
    }
  }
}
