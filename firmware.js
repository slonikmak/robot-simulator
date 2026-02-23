'use strict';

// ── New behaviour: territory + shove (servo ultrasonic + line) ─────────────
const STATE = {
  PATROL:      'PATROL',
  ACQUIRE:     'ACQUIRE',
  SHOVE:       'SHOVE',
  BLOCK:       'BLOCK',
  LINE_AVOID:  'LINE_AVOID',
  PANIC:       'PANIC',
  RECOVER:     'RECOVER',
};

const STATE_LABELS = {
  PATROL:     '🧭 Патруль',
  ACQUIRE:    '🎯 Наведение',
  SHOVE:      '⚠️ Отгон',
  BLOCK:      '⛔ Блокирует',
  LINE_AVOID: '🟨 Граница',
  PANIC:      '🛑 Аварийно',
  RECOVER:    '😮‍💨 Отпускает',
};

function clampLocal(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

function median3(a, b, c) {
  if (a > b) { const t = a; a = b; b = t; }
  if (b > c) { const t = b; b = c; c = t; }
  if (a > b) { const t = a; a = b; b = t; }
  return b;
}

function normaliseCmFromMeters(m) {
  if (!Number.isFinite(m)) return CFG.ULTRASONIC_NO_ECHO_CM;
  const cm = m * 100;
  const c = clampLocal(cm, CFG.ULTRASONIC_MIN_CM, CFG.ULTRASONIC_MAX_CM);
  return c;
}

function mean2(a, b) { return (a + b) * 0.5; }

const BEHAV = {
  // Distances (cm)
  D_DETECT: 100,
  D_ENGAGE: 80,
  D_HOLD:   65,
  D_SAFE:   50,
  D_PANIC:  35,

  // Patrol motion
  V_PATROL:     0.35,
  V_APPROACH:   0.45,
  V_PUSH:       0.55,
  V_PULL:       0.40,
  V_PANIC_REV:  0.60,

  // Turning
  K_THETA:      0.015,
  TURN_LIM:     0.35,

  // Scan / ping
  FRONT_PING_DT: 0.13,
  FULL_SCAN_DT:  1.2,
  PING_GAP_DT:   0.025,

  // Wall vs target heuristics
  FLAT_N:    4,
  FLAT_T_CM: 15,
};

function scanAnglesDeg() {
  const a = [];
  for (let d = -60; d <= 60; d += 10) a.push(d);
  return a;
}

function countTrue(arr) {
  let n = 0;
  for (let i = 0; i < arr.length; i++) if (arr[i]) n++;
  return n;
}

const RobotFirmware = {

  _ensureRuntime(robot) {
    if (robot._fw) return;
    robot._fw = {
      // scanning
      scan: {
        angles: scanAnglesDeg(),
        mode: 'idle', // 'idle'|'full'
        idx: 0,
        stage: 'move', // move|ping1|gap|ping2
        pingGap: 0,
        pings: [],
        raw: [],
        filtered: null,
        lastFullAt: -999,
        requestedFull: true,

        // front / target tracking
        lastFrontAt: -999,
        lastFrontSeq: -1,
        frontCm: CFG.ULTRASONIC_NO_ECHO_CM,
        frontHist: [false, false, false, false, false],
        frontHistIdx: 0,

        targetCm: CFG.ULTRASONIC_NO_ECHO_CM,
        targetThetaDeg: 0,
        targetIsWall: false,
        fullHist: [false, false, false],
        fullHistIdx: 0,
      },

      // stateful behaviour
      returnState: STATE.PATROL,
      patrolWiggleT: 0,
      patrolWiggleRem: 0,
      patrolWiggleDir: 1,

      shove: {
        phase: 'PUSH',
        phaseT: 0,
        cyclesDone: 0,
        cyclesTarget: 4,
        farT: 0,
        closePersistT: 0,
        snapStep: 0,
      },

      block: {
        fakeLungeT: 0,
        farT: 0,
        lungeRem: 0,
      },

      panic: {
        phase: 'STOP',
        t: 0,
        cooldown: 0,
      },
    };
  },

  enter(robot, newState) {
    this._ensureRuntime(robot);
    robot.state = newState;
    robot.stateTimer = 0;

    const fw = robot._fw;
    if (newState === STATE.PATROL) {
      fw.scan.requestedFull = true;
    }
    if (newState === STATE.ACQUIRE) {
      fw.scan.requestedFull = true;
    }
    if (newState === STATE.SHOVE) {
      fw.shove.phase = 'PUSH';
      fw.shove.phaseT = 0;
      fw.shove.cyclesDone = 0;
      fw.shove.cyclesTarget = 3 + (Math.random() * 4) | 0; // 3..6
      fw.shove.farT = 0;
      fw.shove.closePersistT = 0;
      fw.shove.snapStep = 0;
      fw.scan.requestedFull = true; // on entry, get a fresh theta
    }
    if (newState === STATE.BLOCK) {
      fw.block.fakeLungeT = 1.0;
      fw.block.farT = 0;
      fw.block.lungeRem = 0;
    }
    if (newState === STATE.LINE_AVOID) {
      // keep fw.returnState from caller
    }
    if (newState === STATE.PANIC) {
      fw.panic.phase = 'STOP';
      fw.panic.t = 0;
      fw.panic.cooldown = 0;
    }
    if (newState === STATE.RECOVER) {
      if (robot.servo) robot.servo.setTargetDeg(0);
    }
  },

  _startFullScan(robot) {
    const scan = robot._fw.scan;
    scan.mode = 'full';
    scan.idx = 0;
    scan.stage = 'move';
    scan.pingGap = 0;
    scan.pings = [];
    scan.raw = new Array(scan.angles.length).fill(CFG.ULTRASONIC_NO_ECHO_CM);
    scan.filtered = null;
    scan.lastFullAt = 0;
  },

  _applyAngleMedianFilter(raw) {
    const n = raw.length;
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      const a = raw[Math.max(0, i - 1)];
      const b = raw[i];
      const c = raw[Math.min(n - 1, i + 1)];
      out[i] = median3(a, b, c);
    }
    return out;
  },

  _isFlatSegment(filtered, startIdx, len) {
    let minD = Infinity, maxD = -Infinity, sum = 0;
    for (let i = 0; i < len; i++) {
      const v = filtered[startIdx + i];
      minD = Math.min(minD, v);
      maxD = Math.max(maxD, v);
      sum += v;
    }
    const mean = sum / len;
    return (maxD - minD) < BEHAV.FLAT_T_CM && mean < 200;
  },

  _classifyTargetFromScan(robot) {
    const scan = robot._fw.scan;
    const angles = scan.angles;
    const d = scan.filtered;
    if (!d) return;

    // Find minimum in [-40..+40]
    let bestIdx = -1;
    let bestD = Infinity;
    for (let i = 0; i < angles.length; i++) {
      const a = angles[i];
      if (a < -40 || a > 40) continue;
      if (d[i] < bestD) { bestD = d[i]; bestIdx = i; }
    }

    scan.targetCm = bestIdx >= 0 ? bestD : CFG.ULTRASONIC_NO_ECHO_CM;
    scan.targetThetaDeg = bestIdx >= 0 ? angles[bestIdx] : 0;

    // Determine if around the best index we have a flat segment (wall-like)
    let isWall = false;
    if (bestIdx >= 0) {
      const N = BEHAV.FLAT_N;
      const startMin = Math.max(0, bestIdx - (N - 1));
      const startMax = Math.min(d.length - N, bestIdx);
      for (let s = startMin; s <= startMax; s++) {
        if (this._isFlatSegment(d, s, N) && bestIdx >= s && bestIdx < s + N) {
          isWall = true;
          break;
        }
      }
    }
    scan.targetIsWall = isWall;

    const present = (scan.targetCm < BEHAV.D_DETECT) && !isWall;
    scan.fullHist[scan.fullHistIdx] = present;
    scan.fullHistIdx = (scan.fullHistIdx + 1) % scan.fullHist.length;

    // percept (debug)
    if (scan.targetCm >= BEHAV.D_DETECT) robot.percept = 'empty';
    else robot.percept = isWall ? 'wall' : 'legs';
  },

  _updateFullScan(robot, dt) {
    const scan = robot._fw.scan;
    if (scan.mode !== 'full') return;

    const angles = scan.angles;
    const i = scan.idx;

    if (i >= angles.length) {
      scan.mode = 'idle';
      scan.filtered = this._applyAngleMedianFilter(scan.raw);
      scan.lastFullAt = 0;
      this._classifyTargetFromScan(robot);
      return;
    }

    const thetaDeg = angles[i];
    if (robot.servo) robot.servo.setTargetDeg(thetaDeg);

    // Servo settle is handled by UltrasonicSensor.ping() (it refuses too early)
    if (scan.stage === 'move') {
      scan.pings.length = 0;
      scan.stage = 'ping1';
    }

    if (scan.stage === 'ping1') {
      const before = robot.ultrasonic.seq;
      robot.ultrasonic.ping();
      if (robot.ultrasonic.seq !== before) {
        scan.pings.push(normaliseCmFromMeters(robot.ultrasonic.lastMeasurement));
        scan.pingGap = 0;
        scan.stage = 'gap';
      }
    } else if (scan.stage === 'gap') {
      scan.pingGap += dt;
      if (scan.pingGap >= BEHAV.PING_GAP_DT) {
        scan.stage = 'ping2';
      }
    } else if (scan.stage === 'ping2') {
      const before = robot.ultrasonic.seq;
      robot.ultrasonic.ping();
      if (robot.ultrasonic.seq !== before) {
        scan.pings.push(normaliseCmFromMeters(robot.ultrasonic.lastMeasurement));
        const a = scan.pings[0] ?? CFG.ULTRASONIC_NO_ECHO_CM;
        const b = scan.pings[1] ?? a;
        scan.raw[i] = mean2(a, b);
        scan.idx++;
        scan.stage = 'move';
      }
    }
  },

  _updateFrontPing(robot, dt, servoDeg) {
    const scan = robot._fw.scan;
    if (scan.mode === 'full') {
      robot.percept = 'scanning';
      return;
    }

    if (robot.servo) robot.servo.setTargetDeg(servoDeg);

    if (scan.lastFrontAt < BEHAV.FRONT_PING_DT) return;
    scan.lastFrontAt = 0;

    const before = robot.ultrasonic.seq;
    robot.ultrasonic.ping();
    if (robot.ultrasonic.seq === before) return;

    const cm = normaliseCmFromMeters(robot.ultrasonic.lastMeasurement);
    scan.frontCm = cm;
    const present = cm < BEHAV.D_DETECT;
    scan.frontHist[scan.frontHistIdx] = present;
    scan.frontHistIdx = (scan.frontHistIdx + 1) % scan.frontHist.length;
  },

  _turnFromTheta(thetaDeg) {
    const turn = clampLocal(BEHAV.K_THETA * thetaDeg, -BEHAV.TURN_LIM, BEHAV.TURN_LIM);
    return turn;
  },

  _drive(robot, forward, turn) {
    robot.pwmLeft  = clampLocal(forward - turn, -1, 1);
    robot.pwmRight = clampLocal(forward + turn, -1, 1);
  },

  _lineDetected(robot) {
    return robot.colorSensor && robot.colorSensor.read(CFG.ZONE_RADIUS);
  },

  updateBehavior(robot, dt) {
    this._ensureRuntime(robot);
    robot.stateTimer += dt;
    const fw = robot._fw;
    const scan = fw.scan;

    // Start / run scans
    if (scan.requestedFull && scan.mode !== 'full') {
      this._startFullScan(robot);
      scan.requestedFull = false;
    }
    if (scan.mode === 'full') {
      robot.percept = 'scanning';
      this._updateFullScan(robot, dt);
    }

    // Update timers while not in a full scan
    if (scan.mode !== 'full') {
      scan.lastFullAt += dt;
      scan.lastFrontAt += dt;
    }

    // Line avoidance is absolute priority
    if (robot.state !== STATE.LINE_AVOID && this._lineDetected(robot)) {
      fw.returnState = robot.state;
      this.enter(robot, STATE.LINE_AVOID);
    }

    // Convenience values (from last scan/track)
    const targetCm = scan.targetCm;
    const thetaDeg = scan.targetThetaDeg;
    const confirmedByFull = countTrue(scan.fullHist) >= 2;
    const confirmedByFront = countTrue(scan.frontHist) >= 3;
    const hasTarget = (targetCm < BEHAV.D_DETECT) && !scan.targetIsWall;

    switch (robot.state) {
      case STATE.PATROL: {
        // Scheduled full scan
        if (scan.lastFullAt >= BEHAV.FULL_SCAN_DT) {
          scan.requestedFull = true;
        }

        // Fast front check between full scans
        this._updateFrontPing(robot, dt, 0);
        if (scan.frontCm < BEHAV.D_DETECT) {
          this.enter(robot, STATE.ACQUIRE);
          break;
        }

        // Choose direction of free corridor based on last filtered scan
        let desiredTheta = 0;
        if (scan.filtered) {
          let bestScore = -Infinity;
          for (let i = 0; i < scan.angles.length; i++) {
            const a = scan.angles[i];
            if (a < -40 || a > 40) continue;
            const dist = scan.filtered[i];
            const score = dist - 0.8 * Math.abs(a);
            if (score > bestScore) { bestScore = score; desiredTheta = a; }
          }
        }

        // Occasional wiggle
        if (fw.patrolWiggleT <= 0) {
          fw.patrolWiggleT = 3 + Math.random() * 4;
          fw.patrolWiggleDir = Math.random() < 0.5 ? -1 : 1;
          if (scan.frontCm > 80) fw.patrolWiggleRem = 0.5;
        } else {
          fw.patrolWiggleT -= dt;
        }

        let wiggleBias = 0;
        if (fw.patrolWiggleRem > 0) {
          fw.patrolWiggleRem -= dt;
          wiggleBias = fw.patrolWiggleDir * 10;
        }

        const turn = this._turnFromTheta(desiredTheta + wiggleBias);
        this._drive(robot, BEHAV.V_PATROL, turn);
        break;
      }

      case STATE.ACQUIRE: {
        // Keep quick pings while we rotate to face the target.
        this._updateFrontPing(robot, dt, thetaDeg);

        // On acquire, insist on full scan(s) for classification.
        if (scan.lastFullAt >= 0.9 && scan.mode !== 'full') {
          scan.requestedFull = true;
        }

        // Face the target (no forward motion)
        const turn = this._turnFromTheta(thetaDeg);
        this._drive(robot, 0, turn);
        if (robot.servo) robot.servo.setTargetDeg(thetaDeg);

        if ((hasTarget && (confirmedByFull || confirmedByFront)) || (targetCm < BEHAV.D_ENGAGE && !scan.targetIsWall)) {
          this.enter(robot, STATE.SHOVE);
          break;
        }

        if (robot.stateTimer > 1.5 && !(confirmedByFront || hasTarget)) {
          this.enter(robot, STATE.PATROL);
        }
        break;
      }

      case STATE.SHOVE: {
        // Keep doing quick target pings at the last known target angle
        this._updateFrontPing(robot, dt, thetaDeg);
        const dNow = Math.min(targetCm, scan.frontCm);
        if (dNow < BEHAV.D_PANIC) {
          this.enter(robot, STATE.PANIC);
          break;
        }

        // if target seems gone, recover
        if (dNow > 110) fw.shove.farT += dt;
        else fw.shove.farT = 0;
        if (fw.shove.farT >= 1.2) {
          this.enter(robot, STATE.RECOVER);
          break;
        }

        if (dNow < 90) fw.shove.closePersistT += dt;
        else fw.shove.closePersistT = 0;

        const turn = this._turnFromTheta(thetaDeg);
        const shove = fw.shove;
        shove.phaseT += dt;

        if (shove.phase === 'PUSH') {
          const canPush = dNow > (BEHAV.D_HOLD + 10) && dNow > (BEHAV.D_SAFE + 10);
          if (dNow <= BEHAV.D_SAFE) {
            this.enter(robot, STATE.PANIC);
            break;
          }
          if (canPush && shove.phaseT <= 0.7) {
            this._drive(robot, BEHAV.V_PUSH, turn);
          } else {
            shove.phase = 'SNAP';
            shove.phaseT = 0;
            shove.snapStep = 0;
            this._drive(robot, 0, 0);
          }
        } else if (shove.phase === 'SNAP') {
          // stop ~200ms + small servo gesture
          this._drive(robot, 0, 0);
          if (robot.servo) {
            if (shove.snapStep === 0) {
              robot.servo.setTargetDeg(thetaDeg);
              shove.snapStep = 1;
            } else if (shove.snapStep === 1 && shove.phaseT > 0.08) {
              robot.servo.setTargetDeg(thetaDeg + (Math.random() < 0.5 ? -10 : 10));
              shove.snapStep = 2;
            } else if (shove.snapStep === 2 && shove.phaseT > 0.16) {
              robot.servo.setTargetDeg(thetaDeg);
              shove.snapStep = 3;
            }
          }
          if (shove.phaseT >= 0.2) {
            shove.phase = 'PULL';
            shove.phaseT = 0;
          }
        } else if (shove.phase === 'PULL') {
          // fixed pull duration or until distance relaxed
          const done = shove.phaseT >= 0.35 || dNow > (BEHAV.D_HOLD + 25);
          this._drive(robot, -BEHAV.V_PULL, turn * 0.3);
          if (done) {
            shove.cyclesDone++;
            if (shove.cyclesDone >= shove.cyclesTarget) {
              // Evaluate: if still close and "pressing" for a while → block
              if (fw.shove.closePersistT >= 1.2) this.enter(robot, STATE.BLOCK);
              else shove.cyclesDone = 0;
            }
            shove.phase = 'PUSH';
            shove.phaseT = 0;
          }
        }
        break;
      }

      case STATE.BLOCK: {
        // Quick pings while keeping target centered
        this._updateFrontPing(robot, dt, thetaDeg);
        const dNow = Math.min(targetCm, scan.frontCm);
        if (dNow < BEHAV.D_PANIC) {
          this.enter(robot, STATE.PANIC);
          break;
        }

        // exit if target far for 2s
        if (dNow > 150) fw.block.farT += dt;
        else fw.block.farT = 0;
        if (fw.block.farT >= 2.0) {
          this.enter(robot, STATE.RECOVER);
          break;
        }

        // Distance hold around D_HOLD
        const e = dNow - BEHAV.D_HOLD;
        const fwd = clampLocal(e / 80, -0.25, 0.25);

        // Arc sideways based on target side
        let side = 0;
        if (thetaDeg > 10) side = 0.18;
        else if (thetaDeg < -10) side = -0.18;

        // Occasional fake lunge
        fw.block.fakeLungeT -= dt;
        if (fw.block.fakeLungeT <= 0) {
          fw.block.fakeLungeT = 2 + Math.random();
          fw.block.lungeRem = 0.22;
        }
        if (fw.block.lungeRem > 0) {
          fw.block.lungeRem -= dt;
          if (dNow > (BEHAV.D_SAFE + 10)) {
            this._drive(robot, BEHAV.V_APPROACH * 0.6, this._turnFromTheta(thetaDeg));
            break;
          }
        }

        this._drive(robot, fwd, side + this._turnFromTheta(thetaDeg) * 0.6);
        break;
      }

      case STATE.LINE_AVOID: {
        // Immediate stop + short retreat + turn + forward lockout
        const t = robot.stateTimer;
        if (t < 0.02) {
          this._drive(robot, 0, 0);
          break;
        }
        if (t < 0.37) {
          this._drive(robot, -0.45, 0);
          break;
        }
        if (t < 0.87) {
          // Choose turn direction using last scan: more space side wins
          let sumL = 0, sumR = 0;
          if (scan.filtered) {
            for (let i = 0; i < scan.angles.length; i++) {
              const a = scan.angles[i];
              const v = scan.filtered[i];
              if (a < 0) sumL += v;
              else sumR += v;
            }
          }
          const dir = sumR >= sumL ? 1 : -1;
          this._drive(robot, 0, dir * 0.35);
          break;
        }
        if (t < 1.57) {
          // lockout (no forward)
          this._drive(robot, 0, 0);
          break;
        }

        // return to previous state (if target still present)
        const stillNear = (scan.frontCm < BEHAV.D_DETECT) || (targetCm < BEHAV.D_DETECT);
        if (stillNear && (fw.returnState === STATE.SHOVE || fw.returnState === STATE.BLOCK)) {
          this.enter(robot, fw.returnState);
        } else {
          this.enter(robot, STATE.PATROL);
        }
        break;
      }

      case STATE.PANIC: {
        const p = fw.panic;
        p.t += dt;

        if (p.phase === 'STOP') {
          this._drive(robot, 0, 0);
          if (p.t >= 0.05) { p.phase = 'REVERSE'; p.t = 0; }
          break;
        }
        if (p.phase === 'REVERSE') {
          this._drive(robot, -BEHAV.V_PANIC_REV, 0);
          if (p.t >= 0.4) { p.phase = 'TURN'; p.t = 0; }
          break;
        }
        if (p.phase === 'TURN') {
          // turn toward open space
          let dir = 1;
          if (scan.filtered) {
            let sumL = 0, sumR = 0;
            for (let i = 0; i < scan.angles.length; i++) {
              const a = scan.angles[i];
              const v = scan.filtered[i];
              if (a < 0) sumL += v; else sumR += v;
            }
            dir = sumR >= sumL ? 1 : -1;
          }
          this._drive(robot, 0, dir * 0.35);
          if (p.t >= 0.5) { p.phase = 'COOLDOWN'; p.t = 0; p.cooldown = 2.0; }
          break;
        }
        if (p.phase === 'COOLDOWN') {
          p.cooldown -= dt;
          // slow patrol, no shove
          this._updateFrontPing(robot, dt, 0);
          const turn = this._turnFromTheta(0);
          this._drive(robot, BEHAV.V_PATROL, turn);
          if (p.cooldown <= 0) this.enter(robot, STATE.PATROL);
          break;
        }
        break;
      }

      case STATE.RECOVER: {
        this._drive(robot, 0, 0);
        if (robot.servo) robot.servo.setTargetDeg(0);
        if (robot.stateTimer >= 0.4) this.enter(robot, STATE.PATROL);
        break;
      }
    }
  },
};
