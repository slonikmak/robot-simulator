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

// ── Threat classification ─────────────────────────────────────────────────────
// The robot mounts a fixed HC-SR04 (no servo). It cannot aim the sensor
// independently. Instead, the firmware deliberately oscillates the whole body
// (scan oscillation) and collects a ring-buffer of distance measurements over
// one full oscillation sweep. A narrow object like a human leg causes a large
// distance dispersion (beam sweeps past it → Infinity; hits it → close value).
// A flat wall causes nearly constant distance across the whole sweep.
//
// Detection criteria (computed from the scan window):
//   dropout_rate >= LEGS_DROPOUT  → beam "lost" the target at some angles  → leg-like
//   OR spread   >= LEGS_SPREAD    → large distance variation within sweep  → leg-like
const THREAT_CFG = {
  NEAR_DIST:     CFG.WAKE_DIST_FROM_BOUNDARY,
  COOLDOWN_DUR:  1.5,

  // Ring buffer: collect samples across one full oscillation period
  // At 15 Hz sensor rate, 1 oscillation ≈ 0.83 s → ~12-13 samples.
  RING_N:        14,
  SAMPLE_DT:     1 / CFG.ULTRASONIC_HZ,

  // Leg signature thresholds
  LEGS_DROPOUT:  0.30,   // fraction of samples that were Infinity
  LEGS_SPREAD:   0.25,   // m, max-min of finite readings
};

const RobotFirmware = {

  _ensureThreatState(robot) {
    if (robot._threat) return;
    robot._threat = {
      cooldown:    0,
      sampleTimer: 0,
      ring:        new Array(THREAT_CFG.RING_N).fill(Infinity),
      ringIdx:     0,
      ringCount:   0,
    };
  },

  _pushSample(threat, dist) {
    threat.ring[threat.ringIdx] = dist;
    threat.ringIdx = (threat.ringIdx + 1) % THREAT_CFG.RING_N;
    threat.ringCount = Math.min(THREAT_CFG.RING_N, threat.ringCount + 1);
  },

  _scanStats(threat) {
    const n = threat.ringCount;
    if (n < 4) return null;   // not enough data yet
    let finN = 0, infN = 0, minD = Infinity, maxD = 0;
    for (let i = 0; i < n; i++) {
      const idx = (threat.ringIdx - n + i + THREAT_CFG.RING_N) % THREAT_CFG.RING_N;
      const v = threat.ring[idx];
      if (Number.isFinite(v)) { finN++; if (v < minD) minD = v; if (v > maxD) maxD = v; }
      else infN++;
    }
    return {
      dropoutRate: infN / n,
      spread: finN >= 2 ? (maxD - minD) : 0,
    };
  },

  _updateThreatClassifier(robot, dt) {
    this._ensureThreatState(robot);
    const threat = robot._threat;

    if (threat.cooldown > 0) threat.cooldown = Math.max(0, threat.cooldown - dt);

    const dist = robot.ultrasonic.lastMeasurement;
    const near = Number.isFinite(dist) && dist < THREAT_CFG.NEAR_DIST;

    // Accumulate sensor readings at sensor rate into ring buffer
    threat.sampleTimer += dt;
    if (threat.sampleTimer >= THREAT_CFG.SAMPLE_DT) {
      threat.sampleTimer -= THREAT_CFG.SAMPLE_DT;
      // Only record samples when something is near; clear buffer when zone is empty
      if (near) {
        this._pushSample(threat, dist);
      } else {
        threat.ringCount = 0;
        threat.ringIdx   = 0;
      }
    }

    // Already in aggression?
    if (robot.state === STATE.AGGRESSION) {
      robot.percept = 'legs';
      return { threat: true, enterAggression: false };
    }

    if (!near) {
      robot.percept = 'empty';
      return { threat: false, enterAggression: false };
    }

    if (threat.cooldown > 0) {
      robot.percept = 'wall';
      return { threat: false, enterAggression: false };
    }

    // Wait until we have a full sweep's worth of data before deciding
    robot.percept = 'scanning';
    const stats = this._scanStats(threat);
    if (!stats) return { threat: false, enterAggression: false };

    // Leg signature: narrow object → beam misses it often OR large spread
    if (stats.dropoutRate >= THREAT_CFG.LEGS_DROPOUT || stats.spread >= THREAT_CFG.LEGS_SPREAD) {
      robot.percept = 'legs';
      threat.ringCount = 0;   // reset for next detection
      return { threat: true, enterAggression: true };
    }

    // Wall signature: near but uniform readings → apply cooldown
    robot.percept = 'wall';
    threat.cooldown = THREAT_CFG.COOLDOWN_DUR;
    threat.ringCount = 0;
    return { threat: false, enterAggression: false };
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

    const ultraDist   = robot.ultrasonic.lastMeasurement;
    const legsPresent  = Number.isFinite(ultraDist) && ultraDist < THREAT_CFG.NEAR_DIST;

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
        if (!legsPresent) {
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

    this._ensureConstantMotion(robot, dt);
  },

  _ensureConstantMotion(robot, dt) {
    if (robot.state === STATE.SLEEP || robot.state === STATE.LAYING) return;

    // Update head-scan oscillation phase
    robot.scanOscPhase += robot.scanOscFreq * 2 * Math.PI * dt;
    const scanBias = Math.sin(robot.scanOscPhase) * robot.scanOscAmplitude;

    const deadzone = 0.08;
    if (Math.abs(robot.pwmLeft) < deadzone && Math.abs(robot.pwmRight) < deadzone) {
      const baseForward = 0.28;
      const turn = (Math.random() - 0.5) * 0.16;
      robot.pwmLeft  = baseForward + turn - scanBias;
      robot.pwmRight = baseForward - turn + scanBias;
    } else {
      // Add scan oscillation to existing motion
      robot.pwmLeft  -= scanBias * 0.5;
      robot.pwmRight += scanBias * 0.5;
    }
  },
};
