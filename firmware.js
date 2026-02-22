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
      robot.lungeTarget  = null;
      robot.lungeOrigin  = robot.pos.clone();
      robot.lungePhase   = 'drive';
    }
    if (newState === STATE.GUARD) {
      robot.jitterTimer  = 0;
      robot.jitterTarget = null;
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
    let cx, cy;
    if (robot.clutches.length === 0) {
      const a = Math.random() * 2 * Math.PI;
      const r = randBetween(0.4, 1.2);
      cx = Math.cos(a) * r;
      cy = Math.sin(a) * r;
    } else {
      const last = robot.clutches[robot.clutches.length - 1].center;
      const a = Math.random() * 2 * Math.PI;
      cx = last.x + Math.cos(a) * CFG.CLUTCH_OFFSET * (robot.layingStep + 1);
      cy = last.y + Math.sin(a) * CFG.CLUTCH_OFFSET * (robot.layingStep + 1);
    }

    const v = new Vec2(cx, cy);
    if (v.len() > CFG.ZONE_RADIUS - 0.3) v.set(v.norm().scale(CFG.ZONE_RADIUS - 0.3));

    robot.currentLayingClutch = new Clutch(v.x, v.y);
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

    const prev = robot.clutches[robot.activeClutchIdx].center;
    const a    = Math.random() * 2 * Math.PI;
    const cx   = prev.x + Math.cos(a) * CFG.CLUTCH_OFFSET;
    const cy   = prev.y + Math.sin(a) * CFG.CLUTCH_OFFSET;
    const v    = new Vec2(cx, cy);

    if (v.len() > CFG.ZONE_RADIUS - 0.25) v.set(v.norm().scale(CFG.ZONE_RADIUS - 0.25));

    const clutch = new Clutch(v.x, v.y);
    for (let i = 0; i < CFG.EGGS_PER_CLUTCH; i++) clutch.addEgg();
    robot.clutches.push(clutch);
    robot.activeClutchIdx = robot.clutches.length - 1;

    this.spawnEggParticles(robot, clutch.center, 6);
  },

  gotoPoint(robot, target, speed = 1.0, reverse = false) {
    const toTarget = target.sub(robot.pos);
    const dist     = toTarget.len();
    if (dist < 0.04) return { left: 0, right: 0, arrived: true };

    let desiredHeading = toTarget.angle();
    if (reverse) desiredHeading = normaliseAngle(desiredHeading + Math.PI);

    const headingErr = normaliseAngle(desiredHeading - robot.heading);
    const kP_ang     = 2.5;
    const angCmd     = clamp(headingErr * kP_ang, -1, 1);

    const forwardFraction = reverse ? -1 : 1;
    const fwdScale        = Math.max(0, 1 - Math.abs(headingErr) / (Math.PI * 0.6));
    const linCmd          = forwardFraction * speed * fwdScale;

    const left  = clamp(linCmd - angCmd * 0.5, -1, 1);
    const right = clamp(linCmd + angCmd * 0.5, -1, 1);
    return { left, right, arrived: false };
  },

  faceTarget(robot, target) {
    const toTarget     = target.sub(robot.pos);
    const desiredAngle = toTarget.angle();
    const err          = normaliseAngle(desiredAngle - robot.heading);
    const angCmd       = clamp(err * 3.0, -1, 1);
    return { left: -angCmd * 0.45, right: angCmd * 0.45 };
  },

  applyBoundaryRepulsion(robot) {
    if (robot.colorSensor.read(CFG.ZONE_RADIUS)) {
      const toCenter = new Vec2(-robot.pos.x, -robot.pos.y).norm();
      const desired  = toCenter.angle();
      const err      = normaliseAngle(desired - robot.heading);
      const ang      = clamp(err * 3.0, -1, 1);
      robot.pwmLeft  = clamp(-0.6 - ang * 0.5, -1, 1);
      robot.pwmRight = clamp(-0.6 + ang * 0.5, -1, 1);
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
        {
          const target = robot.activeClutchIdx >= 0
            ? robot.clutches[robot.activeClutchIdx].center
            : new Vec2(0, 0);
          const toDst = robot.pos.distTo(target);
          if (toDst > 0.35) {
            const m = this.gotoPoint(robot, target, 0.4);
            robot.pwmLeft  = m.left;
            robot.pwmRight = m.right;
          } else {
            robot.pwmLeft  = 0;
            robot.pwmRight = 0;
          }
        }
        break;

      case STATE.LAYING:
        if (legsPresent) {
          robot.isBuzzing = false;
          this.enter(robot, STATE.AGGRESSION);
          break;
        }
        {
          const tgt = robot.currentLayingClutch.center;
          const m   = this.gotoPoint(robot, tgt, 0.5);
          robot.pwmLeft  = m.left;
          robot.pwmRight = m.right;

          robot.layingEggTimer += dt;
          if (robot.layingEggsLeft > 0 && robot.layingEggTimer >= 0.18) {
            robot.layingEggTimer -= 0.18;
            robot.currentLayingClutch.addEgg();
            robot.layingEggsLeft--;
            const offset = Vec2.fromAngle(Math.random() * 2 * Math.PI, CFG.ROBOT_RADIUS * 0.9);
            robot.particles.push(new EggParticle(robot.pos.add(offset), tgt));
          }

          if (robot.layingEggsLeft <= 0) {
            robot.layingSubTimer += dt;
            robot.pwmLeft  = 0;
            robot.pwmRight = 0;
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
        }
        break;

      case STATE.AGGRESSION:
        if (robot.stateTimer >= CFG.AGGRESSION_DURATION) {
          this.enter(robot, STATE.RETREATING);
          break;
        }
        if (!legsPresent && robot.stateTimer > 3) {
          this.enter(robot, STATE.RETREATING);
          break;
        }
        if (!robot.lungeTarget || robot.lungePhase === 'done') {
          // without bearing info pick a random offset from current heading
          const baseAng = robot.heading;
          const spread  = Math.PI * 0.35;
          const a       = baseAng + randBetween(-spread, spread);
          const amp     = randBetween(CFG.LUNGE_AMPLITUDE_MIN, CFG.LUNGE_AMPLITUDE_MAX);
          const raw     = robot.pos.add(Vec2.fromAngle(a, amp));
          if (raw.len() > CFG.ZONE_RADIUS - 0.18) raw.set(raw.norm().scale(CFG.ZONE_RADIUS - 0.18));
          robot.lungeTarget = raw;
          robot.lungeOrigin = robot.pos.clone();
          robot.lungePhase  = 'drive';
        }
        if (robot.lungePhase === 'drive') {
          const m = this.gotoPoint(robot, robot.lungeTarget, CFG.LUNGE_SPEED / CFG.MAX_LIN_SPEED);
          robot.pwmLeft  = m.left;
          robot.pwmRight = m.right;
          if (m.arrived || robot.pos.distTo(robot.lungeTarget) < 0.07) {
            robot.lungePhase = 'back';
          }
        } else if (robot.lungePhase === 'back') {
          const m = this.gotoPoint(robot, robot.lungeOrigin, 0.8, true);
          robot.pwmLeft  = m.left;
          robot.pwmRight = m.right;
          if (m.arrived || robot.pos.distTo(robot.lungeOrigin) < 0.08) {
            robot.lungePhase = 'done';
            robot.lungeTarget = null;
          }
        }
        break;

      case STATE.RETREATING:
        {
          const clutch = robot.activeClutchIdx >= 0
            ? robot.clutches[robot.activeClutchIdx].center
            : new Vec2(0, 0);
          const m = this.gotoPoint(robot, clutch, 0.7, true);
          robot.pwmLeft  = m.left;
          robot.pwmRight = m.right;
          const dist = robot.pos.distTo(clutch);
          if (m.arrived || dist < 0.25) {
            this.enter(robot, STATE.GUARD);
          }
          if (robot.stateTimer > 15) this.enter(robot, STATE.GUARD);
        }
        break;

      case STATE.GUARD:
        if (legsPresent) {
          this.enter(robot, STATE.AGGRESSION);
          break;
        }
        if (robot.stateTimer >= CFG.GUARD_DURATION) {
          if (legsPresent) {
            this.enter(robot, STATE.AGGRESSION);
          } else {
            this.enter(robot, STATE.CALMING);
          }
          break;
        }
        {
          const clutch = robot.activeClutchIdx >= 0
            ? robot.clutches[robot.activeClutchIdx].center
            : new Vec2(0, 0);

          robot.jitterTimer += dt;
          if (!robot.jitterTarget || robot.jitterTimer > 0.8) {
            robot.jitterTimer = 0;
            const a = Math.random() * 2 * Math.PI;
            const r = randBetween(0.05, 0.22);
            const jx = clutch.x + Math.cos(a) * r;
            const jy = clutch.y + Math.sin(a) * r;
            const jv = new Vec2(jx, jy);
            if (jv.len() < CFG.ZONE_RADIUS - 0.2) robot.jitterTarget = jv;
          }

          const jTarget = robot.jitterTarget || clutch;
          const distToJitter = robot.pos.distTo(jTarget);
          if (distToJitter < 0.06) {
            if (legsPresent) {
              // no bearing info available; face forward
              const f = this.faceTarget(robot, robot.pos.add(Vec2.fromAngle(robot.heading, 1)));
              robot.pwmLeft  = f.left;
              robot.pwmRight = f.right;
            } else {
              robot.pwmLeft  = 0;
              robot.pwmRight = 0;
            }
          } else {
            const m = this.gotoPoint(robot, jTarget, 0.55);
            robot.pwmLeft  = m.left;
            robot.pwmRight = m.right;
          }
        }
        break;

      case STATE.CALMING:
        if (legsPresent) {
          this.enter(robot, STATE.AGGRESSION);
          break;
        }
        robot.calmTimer += dt;
        {
          const clutch = robot.activeClutchIdx >= 0
            ? robot.clutches[robot.activeClutchIdx].center
            : new Vec2(0, 0);
          const dist = robot.pos.distTo(clutch);
          if (dist > 0.3) {
            const m = this.gotoPoint(robot, clutch, 0.3);
            robot.pwmLeft  = m.left;
            robot.pwmRight = m.right;
          } else {
            robot.pwmLeft  = 0;
            robot.pwmRight = 0;
          }
        }
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
