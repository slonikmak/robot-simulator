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

    this._seq = 0;

    // Environment snapshot (set by Robot.update)
    this._legsPos   = null;
    this._obstacles = null;

    // Ping gating (simulate minimum sensor cycle time)
    this._sincePing = Infinity;
  }
  // dt in *sim* seconds; legsPos = Vec2 cursor position; obstacles = RectObstacle[]
  update(dt, legsPos, obstacles) {
    this._legsPos   = legsPos;
    this._obstacles = obstacles;

    this._sincePing += dt;
    this._timer += dt;
    if (this._timer >= this._interval) {
      this._timer -= this._interval;
      this.ping();
    }
    return this._lastVal;
  }

  // Triggered ultrasonic ping (Arduino-style). Uses last environment snapshot.
  // Returns distance in metres or Infinity.
  ping() {
    if (this._sincePing < CFG.ULTRASONIC_PING_MIN_DT) return this._lastVal;
    if (!this._legsPos) return this._lastVal;

    // If servo just moved, readings are often unstable; keep last value.
    if (this._robot.servo && this._robot.servo.timeSinceMove < CFG.SERVO_SETTLE_S) {
      return this._lastVal;
    }

    this._sincePing = 0;

    const origin = this._robot.pos;
    const aim = this._robot.heading + (this._robot.servo ? this._robot.servo.angle : 0);
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
      const dir = Vec2.fromAngle(aim + off, 1);

      // legs hit
      const tLeg = rayIntersectCircle(origin, dir, this._legsPos, CFG.LEGS_RADIUS);
      if (tLeg < best) best = tLeg;

      // obstacles hit
      for (const o of (this._obstacles || [])) {
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
    this._seq++;
    return this._lastVal;
  }
  get lastMeasurement() { return this._lastVal; }
  get seq() { return this._seq; }
}

// ── Simple servo model (angle in radians) ─────────────────────
class Servo {
  constructor() {
    this.angle = 0;      // current angle (rad), relative to robot forward
    this.target = 0;     // target angle (rad)
    this.timeSinceMove = 999;
  }

  setTargetDeg(deg) {
    const lim = CFG.SERVO_LIMIT_DEG;
    const clamped = clamp(deg, -lim, lim);
    this.target = clamped * Math.PI / 180;
  }

  setTargetRad(rad) {
    const lim = CFG.SERVO_LIMIT_DEG * Math.PI / 180;
    this.target = clamp(rad, -lim, lim);
  }

  update(dt) {
    const maxSpeed = (CFG.SERVO_MAX_SPEED_DPS * Math.PI / 180); // rad/s
    const prev = this.angle;
    const diff = this.target - this.angle;
    const step = clamp(diff, -maxSpeed * dt, maxSpeed * dt);
    this.angle += step;

    if (Math.abs(this.angle - prev) > 1e-6) this.timeSinceMove = 0;
    else this.timeSinceMove += dt;
  }
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
    // Add some noise/unreliability to simulate real IR/color sensor
    if (Math.random() < 0.05) return false;
    const dx = sensorPos.x - CFG.ZONE_CENTER_X;
    const dy = sensorPos.y - CFG.ZONE_CENTER_Y;
    const distFromCenter = Math.sqrt(dx * dx + dy * dy);
    return distFromCenter >= zoneRadius - 0.02;
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
    this.servo = new Servo();
    this.ultrasonic = new UltrasonicSensor(this);
    this.colorSensor = new ColorSensor(this);

    // FSM
    this.state     = STATE.PATROL;
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
    this.lungePhase       = null;
    this.lungeTimer       = 0;
    this.lungeDriveTime   = 0;

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

    // Boundary avoidance timer
    this.boundaryAvoidTimer = 0;

    // Percept: what the robot currently thinks it sees ('empty'|'scanning'|'legs'|'wall')
    this.percept = 'empty';

    // Continuous head-scan oscillation (micro-rotation for constant spatial awareness)
    this.scanOscPhase = 0;
    this.scanOscFreq = 1.2; // Hz
    this.scanOscAmplitude = 0.25; // radians (~14°)

    // Visual
    this.vibrate = new Vec2(0, 0); // vibration offset
  }

  // ── Main FSM update ───────────────────────────────────────
  update(dt, legsPos, obstacles) {
    // Update actuator dynamics first
    this.servo.update(dt);

    // Environment updates the sensor using world legs position.
    this.ultrasonic.update(dt, legsPos, obstacles);

    // Firmware sees only sensor readings (no absolute legs position).
    RobotFirmware.updateBehavior(this, dt);

    // ── Integrate differential drive kinematics ─────────
    const { linVel, angVel } = DifferentialDrive.pwmToVelocity(this.pwmLeft, this.pwmRight);
    const maxAng = CFG.MAX_ANG_SPEED;
    const clampedAng = clamp(angVel, -maxAng, maxAng);

    this.heading += clampedAng * dt;
    this.heading  = normaliseAngle(this.heading);
    this.pos.x   += Math.cos(this.heading) * linVel * dt;
    this.pos.y   += Math.sin(this.heading) * linVel * dt;

    // Hard clamp inside zone
    const dx = this.pos.x - CFG.ZONE_CENTER_X;
    const dy = this.pos.y - CFG.ZONE_CENTER_Y;
    const distFromCenter = Math.sqrt(dx * dx + dy * dy);
    if (distFromCenter > CFG.ZONE_RADIUS - CFG.ROBOT_RADIUS) {
      const angle = Math.atan2(dy, dx);
      const maxDist = CFG.ZONE_RADIUS - CFG.ROBOT_RADIUS;
      this.pos.x = CFG.ZONE_CENTER_X + Math.cos(angle) * maxDist;
      this.pos.y = CFG.ZONE_CENTER_Y + Math.sin(angle) * maxDist;
    }

    // Obstacle collisions (simple circle vs AABB)
    if (obstacles && obstacles.length) {
      // A couple of passes to keep zone clamp + obstacles stable.
      for (let pass = 0; pass < 2; pass++) {
        for (const o of obstacles) {
          resolveCircleVsAABB(this.pos, CFG.ROBOT_RADIUS, o.minX, o.minY, o.maxX, o.maxY);
        }
        const dx = this.pos.x - CFG.ZONE_CENTER_X;
        const dy = this.pos.y - CFG.ZONE_CENTER_Y;
        const distFromCenter = Math.sqrt(dx * dx + dy * dy);
        if (distFromCenter > CFG.ZONE_RADIUS - CFG.ROBOT_RADIUS) {
          const angle = Math.atan2(dy, dx);
          const maxDist = CFG.ZONE_RADIUS - CFG.ROBOT_RADIUS;
          this.pos.x = CFG.ZONE_CENTER_X + Math.cos(angle) * maxDist;
          this.pos.y = CFG.ZONE_CENTER_Y + Math.sin(angle) * maxDist;
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
