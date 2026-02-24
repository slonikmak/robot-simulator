'use strict';

// ─────────────────────────────────────────────
//  FSM state enum
// ─────────────────────────────────────────────
const STATE = {
  WANDER:           'WANDER',
  SCAN_CLUSTER:     'SCAN_CLUSTER',
  VERIFY_NOT_WALL:  'VERIFY_NOT_WALL',
  APPROACH:         'APPROACH',
  DEPOSIT:          'DEPOSIT',
  ESCAPE:           'ESCAPE',
};


// ─────────────────────────────────────────────
//  Firmware  –  Arduino-style reactive FSM
//
//  Inputs:  sensor readings { front, left, right } in mm (or null)
//           elapsed time dt (seconds)
//  Outputs: calls robot.setWheels() and robot.depositEgg()
//
//  IMPORTANT: this code must not read robot.x / robot.y.
//             It only receives what real firmware would receive.
// ─────────────────────────────────────────────
class Firmware {
  constructor(robot) {
    this.robot = robot;
    this.state = STATE.WANDER;

    // Internal timers / counters (all in seconds unless noted)
    this._stateTimer    = 0;   // time spent in current state

    // WANDER sub-state
    this._wanderForwardTime  = 0;   // how long until next turn
    this._wanderTurnTime     = 0;   // duration of current turn
    this._wanderTurnDir      = 1;   // +1 right, -1 left
    this._inTurn             = false;

    // VERIFY_NOT_WALL
    this._verifyTimer   = 0;
    this._verifyBudget  = 0.4;  // seconds to wait for stable reading

    // DEPOSIT
    this._depositPause  = 0;
    this._deposited     = false;

    // ESCAPE
    this._escapePhase   = 'back';   // 'back' | 'turn'
    this._escapeTimer   = 0;
    this._escapeBackDur = CFG.ESCAPE_BACK_S;
    this._escapeTurnDur = 0;
    this._escapeTurnDir = 1;
    this._escapeReason  = 'default';

    // Target latch: once we verified a local object, keep approaching even if the
    // near-field pattern changes (e.g. both side sensors start seeing the legs).
    this._targetLocked = false;

    // Active scan (turn-in-place + classify signature)
    this._scanActive = false;
    this._scanDir = 1;          // +1 right, -1 left (matches _wanderTurnDir convention)
    this._scanTheta = 0;        // estimated rotation since scan start (rad)
    this._scanTimer = 0;
    this._scanSampleTimer = 0;
    this._scanSamples = [];     // { theta, f, l, r }
    this._scanCooldown = 0;
    this._scanPhase = 'sweep';  // 'sweep' | 'recenter'
    this._scanRecenterTheta = 0;
    this._scanRecenterTimer = 0;

    // Approach: brief loss hysteresis + reacquire turn
    this._approachLostTimer = 0;
    this._approachLastError = 0;

    // Initialise wander timing
    this._scheduleWanderTurn();

    // Cached last readings (for DEPOSIT guard)
    this._lastFLR = { f: CFG.TOF_MAX_MM, l: CFG.TOF_MAX_MM, r: CFG.TOF_MAX_MM };
  }

  // ── Public ──────────────────────────────────

  /** Call once per simulation frame with latest sensor data and dt. */
  update(dt, sensors) {
    const f = sensors.front ?? CFG.TOF_MAX_MM;
    const l = sensors.left  ?? CFG.TOF_MAX_MM;
    const r = sensors.right ?? CFG.TOF_MAX_MM;

    this._lastFLR = { f, l, r };

    this._stateTimer += dt;
    this._scanCooldown = Math.max(0, this._scanCooldown - dt);

    switch (this.state) {
      case STATE.WANDER:           this._stateWander(dt, f, l, r);          break;
      case STATE.SCAN_CLUSTER:     this._stateScanCluster(dt, f, l, r);     break;
      case STATE.VERIFY_NOT_WALL:  this._stateVerifyNotWall(dt, f, l, r);   break;
      case STATE.APPROACH:         this._stateApproach(dt, f, l, r);        break;
      case STATE.DEPOSIT:          this._stateDeposit(dt);                   break;
      case STATE.ESCAPE:           this._stateEscape(dt);                   break;
    }
  }

  // ── State handlers ───────────────────────────

  _stateWander(dt, f, l, r) {
    const dist = Math.min(f, l, r);

    // If we're already too close to something wall-like, don't waste time scanning — back off hard.
    if (this._isWallDetected(f, l, r) || (this._isWallLike(f, l, r) && dist < 800)) {
      this._scanCooldown = Math.max(this._scanCooldown, 0.8);
      this._startEscape('wall', f, l, r);
      return;
    }

    // Trigger scan on ANY sensor hit. We don't assume it is straight ahead.
    // Classification happens in SCAN_CLUSTER by turning and observing a short signature.
    if (this._scanCooldown <= 0 && dist < CFG.SCAN_DETECT_MM) {
      if (typeof dbg === 'function') dbg(`scan trigger dist=${dist} f=${f} l=${l} r=${r}`);
      this._beginScan(f, l, r);
      this._enterState(STATE.SCAN_CLUSTER);
      return;
    }

    // Obstacle too close straight ahead – nudge away if it's not a candidate.
    if (f < 250) {
      this.robot.setWheels(-CFG.SPEED_WANDER * 0.5, CFG.SPEED_WANDER * 0.5);
      return;
    }

    // Wander: alternate between straight and turns
    this._wanderForwardTime -= dt;
    if (this._inTurn) {
      this._wanderTurnTime -= dt;
      if (this._wanderTurnTime <= 0) {
        this._inTurn = false;
        this._scheduleWanderTurn();
      } else {
        // Spin in place
        const s = CFG.SPEED_WANDER * 0.8;
        this.robot.setWheels(-s * this._wanderTurnDir, s * this._wanderTurnDir);
        return;
      }
    } else if (this._wanderForwardTime <= 0) {
      // Start a turn
      this._inTurn         = true;
      this._wanderTurnDir  = Math.random() < 0.5 ? 1 : -1;
      
      // Turns are less frequent, so make fewer and smaller turns
      // Slightly prefer gentle turns over dramatic U-turns
      if (Math.random() < 0.08) {
        this._wanderTurnTime = 1.2 + Math.random() * 0.8;  // 1.2–2.0 s (wider turn, rare)
      } else {
        this._wanderTurnTime = 0.4 + Math.random() * 0.6;  // 0.4–1.0 s (normal turn)
      }
      this._scheduleWanderTurn();
    }

    // Drive forward with variable speed for natural movement
    const s = CFG.SPEED_WANDER;
    // Add more variation: sometimes slower, sometimes normal, sometimes slightly faster
    const speedVar = 0.85 + Math.random() * 0.30;  // 0.85–1.15x
    this.robot.setWheels(s * speedVar * 0.95, s * speedVar * 1.05);   // natural drift + speed variation
  }

  _stateScanCluster(dt, f, l, r) {
    // Active scan: rotate toward the side that first saw the closer return,
    // sample a short signature, and classify wall vs legs.
    if (!this._scanActive) this._beginScan(f, l, r);

    if (this._scanPhase === 'recenter') {
      // After a positive legs classification, rotate back toward the best hit angle
      // so we don't finish the scan pointed away from the target.
      const delta = this._scanRecenterTheta - this._scanTheta;
      const eps = 0.045; // ~2.6°
      if (Math.abs(delta) <= eps || this._scanRecenterTimer >= 0.7) {
        this._scanActive = false;
        this._scanPhase = 'sweep';
        this._targetLocked = true;
        this._scanCooldown = 0;
        this._enterState(STATE.APPROACH);
        return;
      }

      const dir = delta > 0 ? 1 : -1;
      const s = CFG.SCAN_TURN_SPEED * 0.75;
      this.robot.setWheels(-s * dir, s * dir);

      const omega = (2 * s * dir) / CFG.WHEEL_BASE; // rad/s (estimate)
      this._scanTheta += omega * dt;
      this._scanRecenterTimer += dt;
      return;
    }

    // Sweep phase
    const s = CFG.SCAN_TURN_SPEED;
    this.robot.setWheels(-s * this._scanDir, s * this._scanDir);

    const omega = (2 * s * this._scanDir) / CFG.WHEEL_BASE; // rad/s (estimate)
    this._scanTheta += omega * dt;
    this._scanTimer += dt;
    this._scanSampleTimer += dt;

    const samplePeriod = 1 / CFG.TOF_HZ;
    if (this._scanSampleTimer >= samplePeriod) {
      this._scanSampleTimer = 0;
      this._scanSamples.push({ theta: this._scanTheta, f, l, r });
    }

    const sweepRad = (CFG.SCAN_SWEEP_DEG * Math.PI) / 180;
    if (Math.abs(this._scanTheta) >= sweepRad || this._scanTimer >= CFG.SCAN_MAX_S) {
      const cls = this._classifyScan(this._scanSamples);
      if (typeof dbg === 'function') dbg(`scan classify=${cls} n=${this._scanSamples.length}`);

      if (cls === 'legs') {
        let best = this._scanSamples[0];
        let bestDist = Math.min(best.f, best.l, best.r);
        for (let i = 1; i < this._scanSamples.length; i++) {
          const s = this._scanSamples[i];
          const d = Math.min(s.f, s.l, s.r);
          if (d < bestDist) {
            best = s;
            bestDist = d;
          }
        }

        this._scanPhase = 'recenter';
        this._scanRecenterTheta = best.theta;
        this._scanRecenterTimer = 0;
        if (typeof dbg === 'function') dbg(`scan recenter theta=${best.theta.toFixed(2)} rad (bestDist=${bestDist.toFixed(0)}mm)`);
        return;
      }

      this._scanActive = false;
      this._scanPhase = 'sweep';

      if (cls === 'wall') {
        this._targetLocked = false;
        this._scanCooldown = Math.max(this._scanCooldown, CFG.SCAN_COOLDOWN_S);
        this._startEscape('wall', f, l, r);
      } else {
        this._targetLocked = false;
        this._scanCooldown = CFG.SCAN_COOLDOWN_S;
        this._enterState(STATE.WANDER);
      }
    }
  }

  _stateVerifyNotWall(dt, f, l, r) {
    this._verifyTimer += dt;
    this.robot.setWheels(CFG.SPEED_APPROACH * 0.5, CFG.SPEED_APPROACH * 0.5);

    // Wall detected: in new_behavior.md the hard rule is all three sensors close.
    // We also keep a softer "wall-like" check (similar readings) to avoid deposits near long walls.
    if (this._isWallDetected(f, l, r) || this._isWallLike(f, l, r)) {
      this._targetLocked = false;
      this._enterState(STATE.WANDER);
      return;
    }

    // Budget expired → confirmed local object → approach
    if (this._verifyTimer >= this._verifyBudget) {
      this._targetLocked = true;
      this._enterState(STATE.APPROACH);
    }
  }

  _stateApproach(dt, f, l, r) {
    const dist = Math.min(f, l, r);

    // Object disappeared or became wall-like → abort
    // After a positive scan, keep approaching up to the scan-detect range.
    // Otherwise we oscillate: scan→approach→wander because dist is ~1.2 m.
    const lostThresh = this._targetLocked ? CFG.SCAN_DETECT_MM : CFG.SCAN_FRONT_MM;
    if (dist >= lostThresh) {
      this._approachLostTimer += dt;

      // Briefly try to reacquire by turning in the last-known direction.
      const dir = this._approachLastError < 0 ? -1 : 1;
      const s = CFG.SCAN_TURN_SPEED * 0.7;
      this.robot.setWheels(s * -dir, s * dir);

      if (this._approachLostTimer >= 0.35) {
        if (typeof dbg === 'function') dbg(`approach lost dist=${dist} >= ${lostThresh} for ${this._approachLostTimer.toFixed(2)}s`);
        this._targetLocked = false;
        this._scanCooldown = Math.max(this._scanCooldown, 0.4);
        this._enterState(STATE.WANDER);
      }
      return;
    } else {
      this._approachLostTimer = 0;
    }
    if (this._isWallDetected(f, l, r) || this._isWallLike(f, l, r)) {
      this._targetLocked = false;
      this._scanCooldown = Math.max(this._scanCooldown, 0.6);
      this._startEscape('wall', f, l, r);
      return;
    }

    // Reached deposit distance — only deposit if it still looks like a local object,
    // not a wall/corner that we drifted into.
    if (dist <= CFG.APPROACH_STOP_MM) {
      // At close range, legs can occupy the full cone and look symmetric on L/R.
      // Rely on the earlier verification + wall checks.
      if (!this._targetLocked || this._isWallDetected(f, l, r) || this._isWallLike(f, l, r)) {
        const reason = (this._isWallDetected(f, l, r) || this._isWallLike(f, l, r)) ? 'wall' : 'default';
        this._startEscape(reason, f, l, r);
      } else {
        this._enterState(STATE.DEPOSIT);
      }
      return;
    }

    // Steer toward object: minimise |left − right|
    // NOTE: World coordinates are y-down, so positive ω=(vR-vL)/L turns RIGHT (clockwise).
    // If left is closer (smaller reading), object is to the left → turn LEFT → ω < 0.
    const error = l - r;   // negative when object is left
    this._approachLastError = error;
    const kP    = 0.0006;  // proportional gain (mm → m/s diff)
    let correction = kP * error;
    const s = CFG.SPEED_APPROACH;
    const maxCorr = s * 0.7;
    correction = Math.max(-maxCorr, Math.min(maxCorr, correction));
    if (typeof dbg === 'function') dbg(`approach steer error=${error.toFixed(1)} corr=${correction.toFixed(3)}`);
    this.robot.setWheels(s - correction, s + correction);
  }

  _stateDeposit(dt) {
    // Stop and "deposit eggs" (visual throw) after a short pause.
    // Once we commit to DEPOSIT, we don't abort based on changing sensor readings.
    this.robot.setWheels(0, 0);

    const f = this._lastFLR.f;
    const l = this._lastFLR.l;
    const r = this._lastFLR.r;

    if (!this._deposited) {
      const pauseTime = CFG.DEPOSIT_PAUSE_MIN_S +
        Math.random() * (CFG.DEPOSIT_PAUSE_MAX_S - CFG.DEPOSIT_PAUSE_MIN_S);
      this._depositPause = pauseTime;
      this._deposited    = true;
    }

    if (this._stateTimer >= this._depositPause) {
      this.robot.depositEgg();
      // After depositing, use a long cooldown to encourage exploring new areas
      this._scanCooldown = Math.max(this._scanCooldown, CFG.DEPOSIT_COOLDOWN_S ?? 3.5);
      // Use stronger escape pattern similar to wall avoidance (more vigorous turn)
      this._startEscape('deposit', f, l, r);
    }
  }

  _stateEscape(dt) {
    if (this._escapePhase === 'back') {
      this.robot.setWheels(-CFG.SPEED_ESCAPE, -CFG.SPEED_ESCAPE);

      if (this._escapeTimer >= this._escapeBackDur) {
        // Switch to turn phase
        this._escapePhase   = 'turn';
        this._escapeTimer   = 0;
      }
    } else {
      // Turn phase
      const s = CFG.ESCAPE_TURN_SPEED ?? CFG.SPEED_WANDER;
      this.robot.setWheels(
        -s * this._escapeTurnDir,
         s * this._escapeTurnDir
      );

      if (this._escapeTimer >= this._escapeTurnDur) {
        this._enterState(STATE.WANDER);
      }
    }

    this._escapeTimer += dt;
  }

  // ── Helpers ──────────────────────────────────

  _enterState(newState) {
    if (typeof dbg === 'function') dbg(`transition ${this.state} -> ${newState}`);
    this.state       = newState;
    this._stateTimer = 0;

    if (newState !== STATE.SCAN_CLUSTER) {
      this._scanActive = false;
    }

    if (newState === STATE.WANDER) {
      this._inTurn = false;
      this._scheduleWanderTurn();
      this._targetLocked = false;
      this._approachLostTimer = 0;
    }
    if (newState === STATE.ESCAPE) {
      this._escapePhase = 'back';
      this._escapeTimer = 0;
      this._targetLocked = false;
      this._scanCooldown = Math.max(this._scanCooldown, 0.4);
      this._approachLostTimer = 0;
      this._escapeBackDur = this._escapeBackDur ?? CFG.ESCAPE_BACK_S;
    }
    if (newState === STATE.DEPOSIT) {
      this._deposited = false;
      this._approachLostTimer = 0;
    }
  }

  _scheduleWanderTurn() {
    this._wanderForwardTime = CFG.WANDER_TURN_MIN_S +
      Math.random() * (CFG.WANDER_TURN_MAX_S - CFG.WANDER_TURN_MIN_S);
  }

  _startEscape(reason, f, l, r) {
    this._escapeReason = reason;
    this._enterState(STATE.ESCAPE);

    let awayDir;
    if (l - r > 60) awayDir = -1;        // right is closer
    else if (r - l > 60) awayDir = 1;    // left is closer
    else awayDir = Math.random() < 0.5 ? 1 : -1;
    const turnSpeed = CFG.ESCAPE_TURN_SPEED ?? CFG.SPEED_WANDER;
    const omega = (2 * turnSpeed) / CFG.WHEEL_BASE;

    if (reason === 'wall') {
      this._escapeBackDur = CFG.WALL_ESCAPE_BACK_S ?? (CFG.ESCAPE_BACK_S * 1.3);
      this._escapeTurnDir = awayDir;
      const minDeg = CFG.WALL_ESCAPE_TURN_MIN_DEG ?? 110;
      const maxDeg = CFG.WALL_ESCAPE_TURN_MAX_DEG ?? 175;
      const deg = minDeg + Math.random() * (maxDeg - minDeg);
      this._escapeTurnDur = (deg * Math.PI / 180) / omega;
    } else if (reason === 'deposit') {
      // After depositing eggs, make a vigorous escape to explore new areas
      this._escapeBackDur = CFG.WALL_ESCAPE_BACK_S ?? (CFG.ESCAPE_BACK_S * 1.2);
      this._escapeTurnDir = Math.random() < 0.5 ? 1 : -1;  // random direction for variety
      const minDeg = 100;  // fairly large turn
      const maxDeg = 160;
      const deg = minDeg + Math.random() * (maxDeg - minDeg);
      this._escapeTurnDur = (deg * Math.PI / 180) / omega;
    } else {
      this._escapeBackDur = CFG.ESCAPE_BACK_S;
      this._escapeTurnDir = Math.random() < 0.5 ? 1 : -1;
      const deg = CFG.ESCAPE_TURN_MIN_DEG +
        Math.random() * (CFG.ESCAPE_TURN_MAX_DEG - CFG.ESCAPE_TURN_MIN_DEG);
      this._escapeTurnDur = (deg * Math.PI / 180) / omega;
    }
  }

  _beginScan(f, l, r) {
    const dist = Math.min(f, l, r);
    if (dist === l) this._scanDir = -1;
    else if (dist === r) this._scanDir = 1;
    else this._scanDir = (l < r ? -1 : 1);

    this._scanActive = true;
    this._scanPhase = 'sweep';
    this._scanTheta = 0;
    this._scanTimer = 0;
    this._scanRecenterTimer = 0;
    this._scanSampleTimer = 0;
    this._scanSamples = [{ theta: 0, f, l, r }];
  }

  _stddev(vals) {
    if (vals.length < 2) return 0;
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const v = vals.reduce((acc, x) => acc + (x - mean) * (x - mean), 0) / (vals.length - 1);
    return Math.sqrt(v);
  }

  _classifyScan(samples) {
    const n = samples.length;
    if (n < 4) return 'unknown';

    let hitCount = 0;
    let openCount = 0;
    let asymCount = 0;
    let flatHitCount = 0;
    let maxSpread = 0;
    let firstHitTheta = null;
    let lastHitTheta = null;
    const hitDists = [];

    for (const s of samples) {
      const dMin = Math.min(s.f, s.l, s.r);
      const dMax = Math.max(s.f, s.l, s.r);
      const spread = dMax - dMin;
      if (spread > maxSpread) maxSpread = spread;

      const isHit = dMin < CFG.SCAN_HIT_MM;
      if (isHit) {
        hitCount++;
        hitDists.push(dMin);
        if (firstHitTheta === null) firstHitTheta = s.theta;
        lastHitTheta = s.theta;
        if (spread <= (CFG.WALL_SCAN_SPREAD_MM + 20)) flatHitCount++;
      }
      if (dMin > CFG.SCAN_FAR_MM) openCount++;

      // Strong "local object" signature: one direction is open while another sees a close hit.
      // Corners/walls usually do not have a truly open direction at ToF max range.
      if (isHit && dMax > CFG.SCAN_FAR_MM && spread > CFG.LEG_SCAN_SPREAD_MM) {
        asymCount++;
      }
    }

    if (hitCount === 0) return 'none';

    const hitFraction = hitCount / n;
    const openFraction = openCount / n;
    const hitSpanDeg = firstHitTheta === null ? 999 :
      (Math.abs(lastHitTheta - firstHitTheta) * 180) / Math.PI;
    const hitStd = this._stddev(hitDists);
    const flatHitFraction = flatHitCount / hitCount;

    if (typeof dbg === 'function') {
      dbg(`scan metrics hitFrac=${hitFraction.toFixed(2)} openFrac=${openFraction.toFixed(2)} asym=${asymCount} spanDeg=${hitSpanDeg.toFixed(1)} maxSpread=${maxSpread.toFixed(0)} hitStd=${hitStd.toFixed(0)} flatHitFrac=${flatHitFraction.toFixed(2)}`);
    }

    // Legs/bag: localized hit with asymmetry.
    // We prioritise this before "wall" because near legs can create long hit spans
    // due to cone width + sweep, but should still have some strong asymmetry samples.
    if (
      asymCount >= (CFG.LEG_SCAN_MIN_ASYM_SAMPLES ?? 1) &&
      hitSpanDeg <= CFG.LEG_SCAN_SPAN_DEG &&
      hitFraction <= (CFG.LEG_SCAN_MAX_HIT_FRAC ?? 1.00) &&
      maxSpread >= CFG.LEG_SCAN_SPREAD_MM &&
      flatHitFraction <= 0.45
    ) return 'legs';

    // Wall: requires low asymmetry; side walls are "always hit" with little spread.
    if (
      (
        flatHitFraction >= 0.60 ||
        asymCount === 0 &&
        (
        hitFraction >= CFG.WALL_SCAN_HIT_FRAC ||
        hitSpanDeg >= CFG.WALL_SCAN_MIN_SPAN_DEG ||
        (maxSpread <= CFG.WALL_SCAN_SPREAD_MM && hitStd <= CFG.WALL_SCAN_STD_MM) ||
        (openFraction <= 0.05 && hitFraction >= 0.50 && maxSpread <= (CFG.LEG_SCAN_SPREAD_MM - 20))
        )
      )
    ) return 'wall';

    return 'unknown';
  }



  _isWallDetected(f, l, r) {
    // Require both "all close" and "similar" to avoid misclassifying two legs
    // when the robot is very close to them.
    const maxV = Math.max(f, l, r);
    const minV = Math.min(f, l, r);
    const spread = maxV - minV;
    const res = f < CFG.WALL_ALL_MM && l < CFG.WALL_ALL_MM && r < CFG.WALL_ALL_MM && spread < 120;
    if (res && typeof dbg === 'function') dbg(`wallDetected check: f${f}<${CFG.WALL_ALL_MM} && l${l}<${CFG.WALL_ALL_MM} && r${r}<${CFG.WALL_ALL_MM}`);
    return res;
  }

  _isWallLike(f, l, r) {
    // similar readings across all three sensors
    const maxV = Math.max(f, l, r);
    const minV = Math.min(f, l, r);
    const spread = maxV - minV;
    const res = (maxV < 1000 && spread < 140) || this._isWallDetected(f, l, r);
    if (res && typeof dbg === 'function') dbg(`wallLike spread=${spread} maxV=${maxV}`);
    return res;
  }

  _isPossibleObject(f, l, r) {
    // Candidate object must be in front range
    if (f >= CFG.SCAN_FRONT_MM) {
      if (typeof dbg === 'function') dbg(`possibleObject: front too far ${f}`);
      return false;
    }

    // Reject very wall-like patterns
    if (this._isWallDetected(f, l, r)) {
      if (typeof dbg === 'function') dbg('possibleObject: rejected by wallDetected');
      return false;
    }

    // 1) Original rule from new_behavior.md (asymmetry)
    if (Math.abs(l - r) > CFG.SCAN_ASYM_MM) {
      if (typeof dbg === 'function') dbg(`possibleObject: asymmetry ${l}-${r}=${(l-r)}`);
      return true;
    }

    // 2) Front-only hit: typical for a small object centred ahead
    // (legs/bag can trigger only the front sensor while side sensors see open space)
    const far = 1200;
    if (l > far && r > far) {
      if (typeof dbg === 'function') dbg('possibleObject: front-only');
      return true;
    }

    // 3) Exactly one side sensor sees a closer object while the other is far
    // (still a local object signature)
    const oneSide = (l < 900 && r > far) || (r < 900 && l > far);
    if (oneSide) {
      if (typeof dbg === 'function') dbg('possibleObject: one-sided');
      return true;
    }

    // 4) Near-field cluster: as we get close to legs, more than one cone may see them.
    if (f < 650 && Math.min(l, r) < 850) {
      if (typeof dbg === 'function') dbg('possibleObject: near-field cluster');
      return true;
    }

    if (typeof dbg === 'function') dbg('possibleObject: none matched');
    return false;
  }
}
