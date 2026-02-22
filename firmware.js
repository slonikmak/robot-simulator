'use strict';

// ── State machine states (Arduino-style firmware) ─────────────
const STATE = {
  SLEEP:       'SLEEP',
  IDLE_SAFE:   'IDLE_SAFE',
  LAYING:      'LAYING',
  AGGRESSION:  'AGGRESSION',
  RETREATING:  'RETREATING',
  GUARD:       'GUARD',
  CALMING:     'CALMING',
};

const STATE_LABELS = {
  SLEEP:      '😴 Сон',
  IDLE_SAFE:  '✅ Спокойно',
  LAYING:     '🥚 Откладывает икру',
  AGGRESSION: '⚔️ Агрессия',
  RETREATING: '🔙 Отступает к кладке',
  GUARD:      '🛡 Охраняет кладку',
  CALMING:    '😮‍💨 Успокаивается',
};

// ── Threat classification (no map, HC-SR04-like distance only) ─────────────
// We assume the sensor returns only distance (or Infinity). We distinguish
// legs vs static walls/obstacles using temporal signatures and a short
// active-probing micro-rotation.
const THREAT_CFG = {
  SAMPLE_DT: 1 / CFG.ULTRASONIC_HZ,
  RING_N: 8,

  NEAR_DIST: CFG.WAKE_DIST_FROM_BOUNDARY,

  PROBE_DUR: 0.85,
  PROBE_TOGGLE: 0.18,
  PROBE_PWM: 0.22,

  COOLDOWN_DUR: 2.0,
  WALL_AVOID_DUR: 0.9,

  // Heuristics tuned for metres and ULTRASONIC_NOISE ~ 0.02.
  MOVING_ABS_DERIV: 0.07,    // m/sample, when robot is nearly stationary
  PROBE_DROPOUT_RATE: 0.20,  // % of samples that became Infinity during probe
  PROBE_SPREAD: 0.14,        // max-min during probe

  SUSPECT_DUR: 0.35,
};

const RobotFirmware = {

  _ensureThreatState(robot) {
    if (robot._threat) return;
    robot._threat = {
      sampleTimer: 0,
      ring: new Array(THREAT_CFG.RING_N).fill(Infinity),
      ringIdx: 0,
      ringCount: 0,

      phase: 'idle', // idle | probing | cooldown
      cooldown: 0,
      wallAvoid: 0,
      suspect: 0,

      probeTimer: 0,
      probeToggleTimer: 0,
      probeSampleTimer: 0,
      probeDir: 1,
      probeSamples: 0,
      probeInf: 0,
      probeMin: Infinity,
      probeMax: 0,
      probeLastFinite: null,
      probeAbsDerivSum: 0,
    };
  },

  _pushThreatSample(threat, dist) {
    threat.ring[threat.ringIdx] = dist;
    threat.ringIdx = (threat.ringIdx + 1) % THREAT_CFG.RING_N;
    threat.ringCount = Math.min(THREAT_CFG.RING_N, threat.ringCount + 1);
  },

  _ringStats(threat) {
    const n = threat.ringCount;
    if (n <= 0) return null;

    let finiteN = 0;
    let infN = 0;
    let min = Infinity;
    let max = 0;
    let sum = 0;
    let lastFinite = null;
    let absDerivSum = 0;

    for (let i = 0; i < n; i++) {
      const v = threat.ring[i];
      if (!Number.isFinite(v)) {
        infN++;
        continue;
      }
      finiteN++;
      sum += v;
      if (v < min) min = v;
      if (v > max) max = v;
      if (lastFinite != null) absDerivSum += Math.abs(v - lastFinite);
      lastFinite = v;
    }

    const mean = finiteN ? (sum / finiteN) : Infinity;
    const absDerivMean = (finiteN >= 2) ? (absDerivSum / (finiteN - 1)) : 0;
    return {
      n,
      finiteN,
      infN,
      min,
      max,
      mean,
      absDerivMean,
      dropoutRate: n ? (infN / n) : 1,
      spread: (finiteN ? (max - min) : 0),
    };
  },

  _updateThreatClassifier(robot, dt) {
    this._ensureThreatState(robot);
    const threat = robot._threat;

    // Defensive: if dt spikes (tab inactive) or becomes non-finite, avoid
    // unbounded catch-up loops that can freeze the UI.
    const dtSample = Number.isFinite(dt) ? Math.min(dt, 0.25) : 0;

    // Timers
    if (threat.cooldown > 0) threat.cooldown = Math.max(0, threat.cooldown - dt);
    if (threat.wallAvoid > 0) threat.wallAvoid = Math.max(0, threat.wallAvoid - dt);
    if (threat.suspect > 0) threat.suspect = Math.max(0, threat.suspect - dt);

    const dist = robot.ultrasonic.lastMeasurement;
    const near = Number.isFinite(dist) && dist < THREAT_CFG.NEAR_DIST;

    // Keep a sensor-rate ring buffer (so we don't overweight render-frame dt).
    threat.sampleTimer += dtSample;
    if (threat.sampleTimer >= THREAT_CFG.SAMPLE_DT) {
      threat.sampleTimer = 0;
      this._pushThreatSample(threat, dist);
    }

    // If already in aggression, classifier is irrelevant.
    if (robot.state === STATE.AGGRESSION) {
      threat.phase = 'idle';
      threat.probeTimer = 0;
      threat.probeSamples = 0;
      return { threat: true, override: false, enterAggression: false };
    }

    // Wall avoidance (post-classification) – short and bounded.
    if (threat.wallAvoid > 0) {
      // Only apply avoid in states where motion is OK.
      if (robot.state === STATE.IDLE_SAFE || robot.state === STATE.GUARD || robot.state === STATE.CALMING) {
        robot.pwmLeft  = -0.55;
        robot.pwmRight = -0.25;
        return { threat: false, override: true, enterAggression: false };
      }
    }

    // Suspect window: hold still briefly to observe real target motion.
    if (threat.suspect > 0) {
      robot.pwmLeft  = 0;
      robot.pwmRight = 0;

      const stats = this._ringStats(threat);
      if (near && stats && stats.finiteN >= 3 && stats.absDerivMean >= THREAT_CFG.MOVING_ABS_DERIV) {
        threat.suspect = 0;
        return { threat: true, override: false, enterAggression: true };
      }

      // If suspect expires without movement, ignore as non-threat.
      if (threat.suspect <= 0) {
        threat.cooldown = THREAT_CFG.COOLDOWN_DUR;
      }
      return { threat: false, override: true, enterAggression: false };
    }

    // Probing phase (micro-rotation) to differentiate a small target vs a flat/static surface.
    if (threat.phase === 'probing') {
      threat.probeTimer += dt;
      threat.probeToggleTimer += dt;
      if (threat.probeToggleTimer >= THREAT_CFG.PROBE_TOGGLE) {
        threat.probeToggleTimer = 0;
        threat.probeDir *= -1;
      }

      // Sample at sensor rate during probe.
      threat.probeSampleTimer += dtSample;
      if (threat.probeSampleTimer >= THREAT_CFG.SAMPLE_DT) {
        threat.probeSampleTimer = 0;
        // Note: dist is the latest measurement; sensor model updates independently.
        // We'll treat Infinity as a dropout.
        if (Number.isFinite(dist)) {
          threat.probeSamples++;
          if (dist < threat.probeMin) threat.probeMin = dist;
          if (dist > threat.probeMax) threat.probeMax = dist;
          if (threat.probeLastFinite != null) {
            threat.probeAbsDerivSum += Math.abs(dist - threat.probeLastFinite);
          }
          threat.probeLastFinite = dist;
        } else {
          threat.probeSamples++;
          threat.probeInf++;
        }
      }

      // Override motion: rotate in place.
      const p = THREAT_CFG.PROBE_PWM * threat.probeDir;
      robot.pwmLeft  = -p;
      robot.pwmRight =  p;

      if (threat.probeTimer < THREAT_CFG.PROBE_DUR) {
        return { threat: false, override: true, enterAggression: false };
      }

      // Decide
      const n = Math.max(1, threat.probeSamples);
      const dropoutRate = threat.probeInf / n;
      const spread = (Number.isFinite(threat.probeMin) && Number.isFinite(threat.probeMax)) ? (threat.probeMax - threat.probeMin) : 0;

      let legsScore = 0;
      if (dropoutRate >= THREAT_CFG.PROBE_DROPOUT_RATE) legsScore++;
      if (spread >= THREAT_CFG.PROBE_SPREAD) legsScore++;

      // Reset probe state
      threat.phase = 'idle';
      threat.probeTimer = 0;
      threat.probeToggleTimer = 0;
      threat.probeSampleTimer = 0;
      threat.probeDir = 1;
      threat.probeSamples = 0;
      threat.probeInf = 0;
      threat.probeMin = Infinity;
      threat.probeMax = 0;
      threat.probeLastFinite = null;
      threat.probeAbsDerivSum = 0;

      if (legsScore >= 1) {
        // Not a wall-like surface (small/edge target). Do NOT attack yet:
        // require real motion in the distance stream (R-011).
        threat.suspect = THREAT_CFG.SUSPECT_DUR;
        return { threat: false, override: true, enterAggression: false };
      }

      // Classified as static surface (wall/obstacle) – apply cooldown & optional avoid.
      threat.cooldown = THREAT_CFG.COOLDOWN_DUR;
      threat.wallAvoid = THREAT_CFG.WALL_AVOID_DUR;
      return { threat: false, override: true, enterAggression: false };
    }

    // Not probing.
    if (!near) return { threat: false, override: false, enterAggression: false };
    if (threat.cooldown > 0) return { threat: false, override: false, enterAggression: false };

    // Fast-path: if the distance stream changes a lot while the robot is nearly
    // stationary, it's likely a moving target (legs).
    const stats = this._ringStats(threat);
    if (stats && stats.finiteN >= 3) {
      const nearlyStationary = Math.abs(robot.pwmLeft) < 0.18 && Math.abs(robot.pwmRight) < 0.18;
      if (nearlyStationary && stats.absDerivMean >= THREAT_CFG.MOVING_ABS_DERIV) {
        return { threat: true, override: false, enterAggression: true };
      }
    }

    // In states where the robot should remain stationary, do not initiate an
    // active probe: rely only on the movement signature above.
    if (robot.state === STATE.SLEEP || robot.state === STATE.LAYING) {
      return { threat: false, override: false, enterAggression: false };
    }

    // Otherwise start probe.
    threat.phase = 'probing';
    threat.probeTimer = 0;
    threat.probeToggleTimer = 0;
    threat.probeSampleTimer = 0;
    threat.probeDir = 1;
    threat.probeSamples = 0;
    threat.probeInf = 0;
    threat.probeMin = Infinity;
    threat.probeMax = 0;
    threat.probeLastFinite = null;
    threat.probeAbsDerivSum = 0;
    // Immediately override this tick.
    const p = THREAT_CFG.PROBE_PWM;
    robot.pwmLeft  = -p;
    robot.pwmRight =  p;
    return { threat: false, override: true, enterAggression: false };
  },

  enter(robot, newState) {
    robot.state      = newState;
    robot.stateTimer = 0;

    if (newState === STATE.AGGRESSION) {
      robot.lungePhase   = null;
      robot.lungeTimer   = 0;
      robot.lungeDriveTime = 0;
    }
    if (newState === STATE.GUARD) {
      robot.jitterTimer  = 0;
    }
    if (newState === STATE.LAYING) {
      robot.layingStep      = 0;
      robot.layingSubTimer  = 0;
      robot.layingEggTimer  = 0;
      robot.layingEggsLeft  = CFG.EGGS_PER_CLUTCH;
      robot.isBuzzing       = true;
      this.startNextClutch(robot);
    }
    if (newState === STATE.CALMING) {
      robot.calmTimer       = 0;
      robot.didPostCalmLay  = false;
    }
    if (newState === STATE.IDLE_SAFE) {
      robot.isBuzzing = false;
    }
    if (newState === STATE.SLEEP) {
      robot.isBuzzing = false;
      robot.pwmLeft   = 0;
      robot.pwmRight  = 0;
    }
  },

  startNextClutch(robot) {
    // Lay clutch at current position (relative logic)
    robot.currentLayingClutch = new Clutch(robot.pos.x, robot.pos.y);
    robot.clutches.push(robot.currentLayingClutch);
    robot.activeClutchIdx = robot.clutches.length - 1;
    robot.layingEggsLeft  = CFG.EGGS_PER_CLUTCH;
    robot.layingEggTimer  = 0;

    this.spawnEggParticles(robot, robot.currentLayingClutch.center, 4);
  },

  spawnEggParticles(robot, target, n) {
    for (let i = 0; i < n; i++) {
      const offset = Vec2.fromAngle(Math.random() * 2 * Math.PI, CFG.ROBOT_RADIUS * 1.1);
      robot.particles.push(new EggParticle(robot.pos.add(offset), target));
    }
  },

  layPostCalmClutch(robot) {
    if (robot.activeClutchIdx < 0) return;

    // Lay clutch at current position
    const clutch = new Clutch(robot.pos.x, robot.pos.y);
    for (let i = 0; i < CFG.EGGS_PER_CLUTCH; i++) clutch.addEgg();
    robot.clutches.push(clutch);
    robot.activeClutchIdx = robot.clutches.length - 1;

    this.spawnEggParticles(robot, clutch.center, 6);
  },

  applyBoundaryRepulsion(robot, dt) {
    if (robot.boundaryAvoidTimer > 0) {
      robot.boundaryAvoidTimer -= dt;
      robot.pwmLeft  = -0.6;
      robot.pwmRight = -0.2;
      return true;
    }
    if (robot.colorSensor.read(CFG.ZONE_RADIUS)) {
      robot.boundaryAvoidTimer = 1.5;
      robot.pwmLeft  = -0.6;
      robot.pwmRight = -0.2;
      return true;
    }
    return false;
  },

  updateBehavior(robot, dt) {
    robot.stateTimer += dt;

    const threatDecision = this._updateThreatClassifier(robot, dt);
    if (threatDecision.enterAggression && robot.state !== STATE.AGGRESSION) {
      this.enter(robot, STATE.AGGRESSION);
    }
    if (threatDecision.override && robot.state !== STATE.AGGRESSION) {
      // Probing/avoidance takes control for this tick.
      return;
    }

    switch (robot.state) {
      case STATE.SLEEP:
        robot.pwmLeft  = 0;
        robot.pwmRight = 0;
        // Threat classifier handles transition to AGGRESSION.
        break;

      case STATE.IDLE_SAFE:
        // Threat classifier handles transition to AGGRESSION.
        robot.safeTimer += dt;
        if (robot.safeTimer >= CFG.SAFE_CYCLE_PERIOD) {
          robot.safeTimer = 0;
          robot.clutchesThisCycle = 0;
          this.enter(robot, STATE.LAYING);
        }
        // Wander slowly
        robot.pwmLeft  = 0.3;
        robot.pwmRight = 0.3;
        if (Math.random() < 0.02) {
          robot.pwmLeft += (Math.random() - 0.5) * 0.4;
          robot.pwmRight += (Math.random() - 0.5) * 0.4;
        }
        break;

      case STATE.LAYING:
        // Threat classifier handles transition to AGGRESSION.
        
        robot.pwmLeft  = 0;
        robot.pwmRight = 0;

        robot.layingEggTimer += dt;
        if (robot.layingEggsLeft > 0 && robot.layingEggTimer >= 0.18) {
          robot.layingEggTimer -= 0.18;
          robot.currentLayingClutch.addEgg();
          robot.layingEggsLeft--;
          const offset = Vec2.fromAngle(Math.random() * 2 * Math.PI, CFG.ROBOT_RADIUS * 0.9);
          robot.particles.push(new EggParticle(robot.pos.add(offset), robot.currentLayingClutch.center));
        }

        if (robot.layingEggsLeft <= 0) {
          robot.layingSubTimer += dt;
          if (robot.layingSubTimer >= CFG.INTER_CLUTCH_DELAY) {
            robot.layingSubTimer = 0;
            robot.layingStep++;
            if (robot.layingStep < CFG.CLUTCH_COUNT) {
              robot.clutchesThisCycle++;
              this.startNextClutch(robot);
            } else {
              robot.isBuzzing = false;
              this.enter(robot, STATE.SLEEP);
            }
          }
        }
        break;

      case STATE.AGGRESSION:
        if (robot.stateTimer >= CFG.AGGRESSION_DURATION) {
          this.enter(robot, STATE.RETREATING);
          break;
        }
        // If target is lost, rotate-search; classifier will re-trigger AGGRESSION if it re-acquires legs.
        const ultraDist = robot.ultrasonic.lastMeasurement;
        const legsVisibleNow = Number.isFinite(ultraDist) && ultraDist < THREAT_CFG.NEAR_DIST;
        if (!legsVisibleNow) {
          // Search behavior (rotation) when target is lost
          robot.pwmLeft = -0.5;
          robot.pwmRight = 0.5;
          if (robot.stateTimer > 3) {
            this.enter(robot, STATE.RETREATING);
          }
          break;
        }
        
        if (!robot.lungePhase || robot.lungePhase === 'done') {
          robot.lungePhase = 'drive';
          robot.lungeTimer = randBetween(0.5, 1.0);
          robot.lungeDriveTime = robot.lungeTimer;
        }
        
        if (robot.lungePhase === 'drive') {
          robot.lungeTimer -= dt;
          robot.pwmLeft = 1.0;
          robot.pwmRight = 1.0;
          if (robot.lungeTimer <= 0) {
            robot.lungePhase = 'back';
            robot.lungeTimer = robot.lungeDriveTime;
          }
        } else if (robot.lungePhase === 'back') {
          robot.lungeTimer -= dt;
          robot.pwmLeft = -0.8;
          robot.pwmRight = -0.8;
          if (robot.lungeTimer <= 0) {
            robot.lungePhase = 'done';
          }
        }
        break;

      case STATE.RETREATING:
        // Back up for a fixed time to return to the clutch area
        robot.pwmLeft = -0.6;
        robot.pwmRight = -0.6;
        if (robot.stateTimer > 2.0) {
          this.enter(robot, STATE.GUARD);
        }
        break;

      case STATE.GUARD:
        if (legsPresent) {
          this.enter(robot, STATE.AGGRESSION);
          break;
        }
        if (robot.stateTimer >= CFG.GUARD_DURATION) {
          this.enter(robot, STATE.CALMING);
          break;
        }
        // Jitter in place
        robot.jitterTimer -= dt;
        if (robot.jitterTimer <= 0) {
          robot.jitterTimer = randBetween(0.5, 1.5);
          robot.pwmLeft = (Math.random() - 0.5) * 0.8;
          robot.pwmRight = (Math.random() - 0.5) * 0.8;
        }
        break;

      case STATE.CALMING:
        if (legsPresent) {
          this.enter(robot, STATE.AGGRESSION);
          break;
        }
        robot.calmTimer += dt;
        robot.pwmLeft = 0;
        robot.pwmRight = 0;
        
        if (robot.calmTimer >= CFG.CALM_WAIT && !robot.didPostCalmLay) {
          robot.didPostCalmLay = true;
          this.layPostCalmClutch(robot);
        }
        if (robot.calmTimer >= CFG.CALM_WAIT + 2) {
          robot.safeTimer = 0;
          this.enter(robot, STATE.IDLE_SAFE);
        }
        break;
    }
  },
};
