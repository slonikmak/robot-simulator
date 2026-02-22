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

const RobotFirmware = {

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

    const ultraDist = robot.ultrasonic.lastMeasurement;
    const legsPresent = ultraDist < CFG.WAKE_DIST_FROM_BOUNDARY;

    if (legsPresent && robot.state !== STATE.AGGRESSION) {
      this.enter(robot, STATE.AGGRESSION);
    }

    switch (robot.state) {
      case STATE.SLEEP:
        robot.pwmLeft  = 0;
        robot.pwmRight = 0;
        if (legsPresent) this.enter(robot, STATE.AGGRESSION);
        break;

      case STATE.IDLE_SAFE:
        if (legsPresent) {
          this.enter(robot, STATE.AGGRESSION);
          break;
        }
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
        if (legsPresent) {
          robot.isBuzzing = false;
          this.enter(robot, STATE.AGGRESSION);
          break;
        }
        
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
  },
};
