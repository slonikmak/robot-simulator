'use strict';

// ============================================================
//  Exhibition Robot Simulator - Configuration
//  World and robot parameters
// ============================================================

const CFG = {
  // World
  ZONE_CENTER_X: 0.0,   // m – zone center X coordinate
  ZONE_CENTER_Y: 4.0,   // m – zone center Y coordinate (near upper wall, overlaps 0.5m)
  ZONE_RADIUS:   1.5,   // m  – habitat zone radius
  ROBOT_RADIUS:  0.15,  // m  – robot body radius (30 cm ⌀)
  WHEEL_BASE:    0.28,  // m  – distance between driven wheels

  // World boundaries
  ROOM_WIDTH:     20.0,  // m
  ROOM_HEIGHT:    10.0,  // m
  WALL_THICKNESS: 0.15,  // m

  // Legs (cursor) physical approximation (for ultrasonic ray hit)
  LEGS_RADIUS:    0.11,  // m – effective radius for ray intersection

  // Speeds (realistic Arduino/motor limits)
  MAX_LIN_SPEED: 0.25,  // m/s  forward/backward
  MAX_ANG_SPEED: 2.0,   // rad/s  rotation
  LINEAR_ACCEL:  0.5,   // m/s² acceleration limit
  LUNGE_SPEED:   0.35,  // m/s  aggression lunge speed

  // Timings (seconds, real-time; TIME_SCALE multiplies sim clock)
  AGGRESSION_DURATION:  30,
  GUARD_DURATION:       30,
  CALM_WAIT:            60,   // before extra clutch after legs leave
  SAFE_CYCLE_PERIOD:    180,  // 3 minutes before laying in safety
  INTER_CLUTCH_DELAY:   3.0,  // pause between clutches during laying

  // Eggs
  CLUTCH_COUNT:         3,    // clutches per safety cycle
  EGGS_PER_CLUTCH:      10,
  EGG_SPREAD:           0.07, // m – radius of egg scatter around drop point
  CLUTCH_OFFSET:        0.05, // m – shift for "post-calming" clutch

  // Sensor model
  ULTRASONIC_RANGE:     3.0,  // m
  ULTRASONIC_NOISE:     0.02, // m std-dev noise
  ULTRASONIC_HZ:        15,   // update frequency
  ULTRASONIC_FOV:       Math.PI * (15 / 180), // rad (15°) valid detection cone
  COLOR_SENSOR_DIST:    0.06, // m – sensor is this far ahead of robot center

  // Ultrasonic (realistic bounds + timing)
  ULTRASONIC_MIN_CM:        8,
  ULTRASONIC_MAX_CM:        250,
  ULTRASONIC_NO_ECHO_CM:    300,
  ULTRASONIC_PING_MIN_DT:   0.025, // s – minimum time between pings

  // Servo (ultrasonic mount)
  SERVO_LIMIT_DEG:          60,    // mechanical limit (matches scan sector)
  SERVO_MAX_SPEED_DPS:      600,   // deg/s
  SERVO_SETTLE_S:           0.04,  // s – wait after motion before trusting pings

  // Trigger distances (metres)
  WAKE_DIST_FROM_BOUNDARY:  1.5,  // legs this close → robot wakes/activates
  LUNGE_AMPLITUDE_MIN:      0.50,
  LUNGE_AMPLITUDE_MAX:      1.0,

  // Rendering
  PX_PER_METER_DEFAULT: 130,  // pixels per metre at zoom=1
  ZOOM_MIN:  0.3,
  ZOOM_MAX:  4.0,
  ZOOM_STEP: 0.001,
};
