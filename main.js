'use strict';

// ─────────────────────────────────────────────
//  p5.js sketch — simulation loop, rendering,
//  input handling, and UI updates.
//  All world-to-screen transforms go through
//  worldToScreen() so zoom/pan is consistent.
// ─────────────────────────────────────────────

// Simulation objects (initialised in setup)
let world, robot, firmware;

// debug log buffer
const DEBUG = true;
let debugLog = [];
function dbg(msg) {
  if (DEBUG) {
    console.log('[DBG]', msg);
    debugLog.push(msg);
    if (debugLog.length > 40) debugLog.shift();
  }
}

// ── Tools ─────────────────────────────────────

const TOOL = {
  CURSOR: 'cursor',       // dynamic legs follow mouse
  LEGS: 'legs',           // place a pinned pair of legs
  BAGS: 'bags',           // place a bag obstacle
  PEDESTALS: 'pedestals', // place a round pedestal
};

let activeTool = TOOL.CURSOR;

let simSpeedTarget = 1.0;
let simSpeed = 1.0;

function setTool(tool) {
  if (!Object.values(TOOL).includes(tool)) return;
  activeTool = tool;

  const btns = document.querySelectorAll('.tool-btn[data-tool]');
  for (const b of btns) {
    b.classList.toggle('is-active', b.dataset.tool === tool);
  }
}

function initToolsUI() {
  const btns = document.querySelectorAll('.tool-btn[data-tool]');
  for (const b of btns) {
    b.addEventListener('click', () => setTool(b.dataset.tool));
  }

  const clearBtn = document.getElementById('tool-clear');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      world.clearPlaced();
      dbg('cleared placed props');
    });
  }

  const aliveToggle = document.getElementById('toggle-alive');
  if (aliveToggle) {
    aliveToggle.addEventListener('change', () => {
      world.setAliveEnabled(!!aliveToggle.checked);
      dbg(`alive props: ${aliveToggle.checked ? 'on' : 'off'}`);
    });
  }

  const speedVal = document.getElementById('sim-speed');
  const speedSlider = document.getElementById('speed-slider');
  if (speedSlider) {
    speedSlider.min = String(CFG.SIM_SPEED_MIN ?? 0.25);
    speedSlider.max = String(CFG.SIM_SPEED_MAX ?? 3.0);
    speedSlider.step = '0.05';
    speedSlider.value = '1';

    const update = () => {
      const v = Number(speedSlider.value);
      if (Number.isFinite(v)) simSpeedTarget = v;
      if (speedVal) speedVal.textContent = `${(simSpeedTarget ?? 1).toFixed(2)}×`;
    };
    speedSlider.addEventListener('input', update);
    update();
  }
}

// View transform
let ppm    = 40;   // pixels per metre (zoom)
let camX   = 0;    // camera offset in world metres (pan)
let camY   = 0;
let isPanning = false;
let panStartX, panStartY, panCamX0, panCamY0;

// Touch pan/pinch state (mobile)
let touchPanActive = false;
let touchPanStartX, touchPanStartY, touchPanCamX0, touchPanCamY0;
let pinchStartDist = 0, pinchStartPpm = 0;
let pinchMidX = 0, pinchMidY = 0, pinchCamX0 = 0, pinchCamY0 = 0;

// Mouse world position
let mouseWorldX = 0;
let mouseWorldY = 0;

// ── p5 lifecycle ─────────────────────────────

function setup() {
  const cnv = createCanvas(windowWidth, windowHeight);
  cnv.parent('canvas-wrapper');
  cnv.elt.addEventListener('wheel',      onWheel,       { passive: false });
  cnv.elt.addEventListener('touchstart',  onTouchStart,  { passive: false });
  cnv.elt.addEventListener('touchmove',   onTouchMove,   { passive: false });
  cnv.elt.addEventListener('touchend',    onTouchEnd,    { passive: false });

  // Centre the room in the viewport initially
  const scaleX = (windowWidth  * 0.85) / CFG.ROOM_W;
  const scaleY = (windowHeight * 0.85) / CFG.ROOM_H;
  ppm = Math.min(scaleX, scaleY);
  camX = CFG.ROOM_W / 2;
  camY = CFG.ROOM_H / 2;

  // Create simulation objects
  world    = new World();
  robot    = new Robot(CFG.ROOM_W / 2, CFG.ROOM_H / 2, 0);
  firmware = new Firmware(robot);
  initToolsUI();
  setTool(activeTool);

  // Hide default cursor on canvas
  noCursor();
  frameRate(60);
  textFont('monospace');
}

function draw() {
  const dtRaw = Math.min(deltaTime / 1000, 0.05);  // cap at 50 ms

  // ── Update mouse world position ──
  mouseWorldX = screenToWorld(mouseX, mouseY).x;
  mouseWorldY = screenToWorld(mouseX, mouseY).y;

  // ── Update world (visitor legs follow mouse) ──
  if (activeTool === TOOL.CURSOR) {
    if (mouseX > 0 && mouseX < width && mouseY > 0 && mouseY < height) {
      const insideRoom =
        mouseWorldX >= 0 && mouseWorldX <= CFG.ROOM_W &&
        mouseWorldY >= 0 && mouseWorldY <= CFG.ROOM_H;
      if (insideRoom) {
        world.setLegsAt(mouseWorldX, mouseWorldY);
      } else {
        world.hideLegs();
      }
    } else {
      world.hideLegs();
    }
  } else {
    world.hideLegs();
  }

  // ── Simulation step (with speed slider + acceleration) ──
  const accel = CFG.SIM_SPEED_ACCEL ?? 4.0;
  const alpha = 1 - Math.exp(-accel * dtRaw);
  simSpeed += (simSpeedTarget - simSpeed) * alpha;
  simSpeed = Math.max(CFG.SIM_SPEED_MIN ?? 0.25, Math.min(CFG.SIM_SPEED_MAX ?? 3.0, simSpeed));

  const simDt = dtRaw * simSpeed;
  const maxStep = 0.02;
  let remaining = simDt;
  let sensors = robot.sensors;
  while (remaining > 1e-8) {
    const step = Math.min(remaining, maxStep);
    world.update(step);
    sensors = robot.readSensors(world);
    firmware.update(step, sensors);
    robot.update(step, world);
    remaining -= step;
  }

  // ── Render ──
  background(30, 30, 46);
  render();

  // ── UI ──
  updatePanel(sensors);
  drawCursor();

  if (DEBUG && window.innerWidth > 768) drawDebugOverlay();
}


// ── Rendering ───────────────────────────────

function render() {
  // Floor (room interior)
  const topLeft = worldToScreen(0, 0);
  const botRight = worldToScreen(CFG.ROOM_W, CFG.ROOM_H);
  fill(38, 38, 58);
  noStroke();
  rect(topLeft.x, topLeft.y, botRight.x - topLeft.x, botRight.y - topLeft.y);

  // Floor grid (subtle)
  stroke(50, 50, 70, 80);
  strokeWeight(1);
  for (let x = 0; x <= CFG.ROOM_W; x++) {
    const a = worldToScreen(x, 0);
    const b = worldToScreen(x, CFG.ROOM_H);
    line(a.x, a.y, b.x, b.y);
  }
  for (let y = 0; y <= CFG.ROOM_H; y++) {
    const a = worldToScreen(0, y);
    const b = worldToScreen(CFG.ROOM_W, y);
    line(a.x, a.y, b.x, b.y);
  }

  // Room walls
  stroke(180, 180, 200);
  strokeWeight(3);
  noFill();
  rect(topLeft.x, topLeft.y, botRight.x - topLeft.x, botRight.y - topLeft.y);

  // Room dimensions label
  noStroke();
  fill(120, 120, 150);
  textSize(12);
  textAlign(CENTER, TOP);
  const mid = worldToScreen(CFG.ROOM_W / 2, 0);
  text(`${CFG.ROOM_W} m × ${CFG.ROOM_H} m`, mid.x, mid.y - 18);

  // Deposited eggs on floor
  drawEggsOnFloor();

  // Placed obstacles / props
  drawProps();

  // Sensor rays
  drawSensorRays();

  // Throw animations
  drawThrowAnimations();

  // Visitor legs
  drawLegs();

  // Robot (ladybug)
  drawRobot();

  // Scale bar
  drawScaleBar();
}

function drawEggsOnFloor() {
  for (const egg of robot.eggs) {
    const p = worldToScreen(egg.x, egg.y);
    // Outer glow
    noStroke();
    fill(120, 200, 100, 60);
    ellipse(p.x, p.y, 18, 18);
    fill(160, 230, 120);
    ellipse(p.x, p.y, 10, 10);
    // Sheen
    fill(220, 255, 200, 180);
    ellipse(p.x - 2, p.y - 2, 4, 4);
  }
}

function drawSensorRays() {
  const angles = CFG.TOF_ANGLES;
  const keys   = ['front', 'left', 'right'];
  const colors = [
    [80, 180, 255],
    [80, 255, 180],
    [255, 180, 80],
  ];

  for (let i = 0; i < 3; i++) {
    const mm = robot.sensors[keys[i]];
    if (mm === null) continue;

    const angle  = robot.heading + angles[i];
    const dist   = mm / 1000;
    const ox     = robot.x;
    const oy     = robot.y;
    const hx     = ox + Math.cos(angle) * dist;
    const hy     = oy + Math.sin(angle) * dist;

    const pA = worldToScreen(ox, oy);
    const pH = worldToScreen(hx, hy);

    // Ray line (dim)
    stroke(colors[i][0], colors[i][1], colors[i][2], 70);
    strokeWeight(1.5);
    line(pA.x, pA.y, pH.x, pH.y);

    // Hit dot (bright)
    noStroke();
    fill(colors[i][0], colors[i][1], colors[i][2], 220);
    ellipse(pH.x, pH.y, 6, 6);

    // Distance label (small)
    fill(colors[i][0], colors[i][1], colors[i][2], 160);
    textSize(10);
    textAlign(LEFT);
    text(`${mm}mm`, pH.x + 5, pH.y + 3);
  }
}

function drawThrowAnimations() {
  for (const ev of robot.throwEvents) {
    const t = ev.age / ev.duration;          // 0 → 1
    // Parabolic arc
    const ix = lerp(ev.fromX, ev.toX, t);
    const iy = lerp(ev.fromY, ev.toY, t);
    // Arc height in screen pixels converted to world offset
    const arcHeight = 0.3 * Math.sin(Math.PI * t);  // metres

    // Perpendicular to direction
    const dx = ev.toX - ev.fromX;
    const dy = ev.toY - ev.fromY;
    const len = Math.sqrt(dx * dx + dy * dy) + 1e-6;
    const px = -dy / len;
    const py =  dx / len;

    const wx = ix + px * arcHeight;
    const wy = iy + py * arcHeight;

    const p = worldToScreen(wx, wy);
    const alpha = (1 - t) * 255;

    noStroke();
    fill(180, 255, 100, alpha);
    const sz = (1 - t * 0.5) * 10;
    ellipse(p.x, p.y, sz, sz);
  }
}

function drawLegs() {
  // Draw cursor legs (if visible)
  if (world.legsVisible) {
    for (const leg of world.legCentres) {
      drawLegCircle(leg.x, leg.y, false);
    }
  }

  // Draw pinned legs
  for (const leg of world.pinnedLegs) {
    drawLegCircle(leg.x, leg.y, true);
  }
}

function drawProps() {
  drawPedestals();
  drawBags();
}

function drawBags() {
  for (const bag of world.bags) {
    if (bag.hidden) continue;
    const p = worldToScreen(bag.x, bag.y);
    const r = CFG.BAG_RADIUS * ppm;

    // Shadow
    noStroke();
    fill(0, 0, 0, 55);
    ellipse(p.x + 4, p.y + 5, r * 2.0, r * 1.6);

    // Bag body
    stroke(30, 40, 55, 180);
    strokeWeight(2);
    fill(35, 55, 70, 220);
    ellipse(p.x, p.y, r * 2.0, r * 1.6);

    // Strap / highlight
    noStroke();
    fill(210, 230, 255, 90);
    ellipse(p.x - r * 0.25, p.y - r * 0.15, r * 0.8, r * 0.5);

    stroke(170, 190, 220, 140);
    strokeWeight(1.5);
    noFill();
    arc(p.x, p.y - r * 0.15, r * 1.2, r * 0.9, Math.PI * 1.1, Math.PI * 1.9);
  }
}

function drawPedestals() {
  for (const ped of world.pedestals) {
    const p = worldToScreen(ped.x, ped.y);
    const r = CFG.PEDESTAL_RADIUS * ppm;

    // Shadow
    noStroke();
    fill(0, 0, 0, 60);
    ellipse(p.x + 6, p.y + 8, r * 2.02, r * 2.02);

    // Base
    stroke(180, 185, 200, 220);
    strokeWeight(3);
    fill(120, 125, 140, 180);
    ellipse(p.x, p.y, r * 2, r * 2);

    // Top highlight
    noStroke();
    fill(220, 225, 240, 90);
    ellipse(p.x - r * 0.18, p.y - r * 0.20, r * 1.0, r * 1.0);

    // Rim
    stroke(230, 235, 250, 160);
    strokeWeight(1.5);
    noFill();
    ellipse(p.x, p.y, r * 1.65, r * 1.65);
  }
}

function drawLegCircle(wx, wy, isPinned) {
  const p = worldToScreen(wx, wy);
  const r = CFG.LEG_RADIUS * ppm;

  // Shadow
  noStroke();
  fill(0, 0, 0, 60);
  ellipse(p.x + 3, p.y + 3, r * 2 + 4, r * 2 + 4);

  if (isPinned) {
    // Pinned leg: stronger outline, different color
    stroke(255, 200, 80);  // golden outline
    strokeWeight(3);
    fill(180, 120, 40);     // darker/warmer brown
    ellipse(p.x, p.y, r * 2, r * 2);

    // Shoe highlight
    noStroke();
    fill(255, 220, 120, 180);
    ellipse(p.x - r * 0.25, p.y - r * 0.25, r * 0.8, r * 0.6);

    // Indicator that this leg is pinned (small cross or mark)
    stroke(255, 200, 80, 220);
    strokeWeight(1.5);
    line(p.x - r * 0.3, p.y, p.x + r * 0.3, p.y);
    line(p.x, p.y - r * 0.3, p.x, p.y + r * 0.3);
  } else {
    // Cursor leg: regular appearance
    stroke(200, 180, 140);
    strokeWeight(2);
    fill(140, 110, 80);
    ellipse(p.x, p.y, r * 2, r * 2);

    // Shoe highlight
    noStroke();
    fill(200, 170, 120, 140);
    ellipse(p.x - r * 0.25, p.y - r * 0.25, r * 0.8, r * 0.6);
  }
}

function drawRobot() {
  const p = worldToScreen(robot.x, robot.y);
  const r = CFG.ROBOT_RADIUS * ppm;

  push();
  translate(p.x, p.y);
  rotate(robot.heading);

  // ── Body shadow ──
  noStroke();
  fill(0, 0, 0, 60);
  ellipse(3, 4, r * 2 + 4, r * 2 + 4);

  // ── Wing cases (elytra) ──
  const bodyColor = stateBodyColor();
  fill(...bodyColor);
  stroke(20, 10, 10, 180);
  strokeWeight(1.5);
  // Left elytron
  arc(0, 0, r * 2, r * 2, Math.PI * 0.1, Math.PI * 1.0);
  // Right elytron
  arc(0, 0, r * 2, r * 2, Math.PI * 1.0, Math.PI * 2.0 - 0.1);
  // Centre seam line
  stroke(20, 10, 10, 200);
  strokeWeight(1);
  line(r * 0.15, -r * 0.85, r * 0.15, r * 0.9);
  line(-r * 0.15, -r * 0.85, -r * 0.15, r * 0.9);

  // ── Head ──
  noStroke();
  fill(30, 20, 20);
  ellipse(r * 0.7, 0, r * 0.6, r * 0.5);

  // ── Eyes ──
  fill(255, 255, 200);
  ellipse(r * 0.85, -r * 0.15, r * 0.15, r * 0.15);
  ellipse(r * 0.85,  r * 0.15, r * 0.15, r * 0.15);
  fill(20, 20, 20);
  ellipse(r * 0.90, -r * 0.14, r * 0.08, r * 0.08);
  ellipse(r * 0.90,  r * 0.14, r * 0.08, r * 0.08);

  // ── Black spots on elytra ──
  fill(20, 15, 15, 220);
  noStroke();
  const spots = [
    [ 0.15, -0.55, 0.28],
    [ 0.15,  0.55, 0.28],
    [ 0.15, -0.2,  0.22],
    [ 0.15,  0.2,  0.22],
    [-0.35, -0.45, 0.24],
    [-0.35,  0.45, 0.24],
  ];
  for (const [sx, sy, sr] of spots) {
    ellipse(sx * r, sy * r, sr * r * 2, sr * r * 2);
  }

  // ── Transparent window: show carried eggs ──
  if (robot.eggsCarried > 0) {
    noStroke();
    fill(255, 255, 255, 25);
    ellipse(-0.15 * r, 0, r * 1.1, r * 1.0);

    // Egg cluster inside body
    const eggPositions = [
      [-0.05, -0.3], [-0.05, 0], [-0.05, 0.3],
      [-0.35, -0.15], [-0.35, 0.15],
      [-0.60, 0],
    ];
    for (let i = 0; i < robot.eggsCarried && i < eggPositions.length; i++) {
      const [ex, ey] = eggPositions[i];
      fill(160, 230, 120, 200);
      ellipse(ex * r, ey * r, r * 0.22, r * 0.22);
      fill(220, 255, 200, 150);
      ellipse(ex * r - r * 0.04, ey * r - r * 0.04, r * 0.07, r * 0.07);
    }
  }

  // ── Sensor direction indicator (small arrow on head) ──
  stroke(255, 255, 255, 80);
  strokeWeight(1);
  line(r * 0.6, 0, r * 1.1, 0);

  pop();
}

function stateBodyColor() {
  switch (firmware.state) {
    case STATE.WANDER:          return [200,  40,  35];
    case STATE.SCAN_CLUSTER:    return [230, 120,  30];
    case STATE.VERIFY_NOT_WALL: return [ 80, 180, 220];
    case STATE.APPROACH:        return [230, 200,  20];
    case STATE.DEPOSIT:         return [160,  60, 220];
    case STATE.ESCAPE:          return [230,  60,  60];
    default:                    return [200,  40,  35];
  }
}

function drawScaleBar() {
  // 1 m bar
  const barWorldLen = 1; // metres
  const barPixLen   = barWorldLen * ppm;
  const bx = 20, by = height - 28;

  stroke(200);
  strokeWeight(1.5);
  line(bx, by, bx + barPixLen, by);
  line(bx, by - 4, bx, by + 4);
  line(bx + barPixLen, by - 4, bx + barPixLen, by + 4);

  noStroke();
  fill(200);
  textSize(11);
  textAlign(CENTER, BOTTOM);
  text('1 m', bx + barPixLen / 2, by - 6);
}

function drawCursor() {
  // Crosshair only
  const mx = mouseX, my = mouseY;
  const col =
    activeTool === TOOL.LEGS ? [255, 200, 80, 140] :
    activeTool === TOOL.BAGS ? [140, 200, 255, 140] :
    activeTool === TOOL.PEDESTALS ? [220, 220, 255, 140] :
    [255, 255, 255, 120];
  stroke(...col);
  strokeWeight(1);
  line(mx - 12, my, mx + 12, my);
  line(mx, my - 12, mx, my + 12);
}

// ── Debug overlay ───────────────────────────

function drawDebugOverlay() {
  push();
  translate(10, height - 10);
  textSize(11);
  textAlign(LEFT, BOTTOM);
  noStroke();
  fill(255, 255, 255, 180);
  for (let i = debugLog.length - 1; i >= 0; i--) {
    text(debugLog[i], 0, -12 * (debugLog.length - 1 - i));
  }
  pop();
}

// ── Coordinate transforms ────────────────────

function worldToScreen(wx, wy) {
  return {
    x: (wx - camX) * ppm + width  / 2,
    y: (wy - camY) * ppm + height / 2,
  };
}

function screenToWorld(sx, sy) {
  return {
    x: (sx - width  / 2) / ppm + camX,
    y: (sy - height / 2) / ppm + camY,
  };
}

function isUiEvent(e) {
  const t = e?.target;
  if (!t || typeof t.closest !== 'function') return false;
  return !!t.closest('#state-panel');
}

// ── Input handlers ──────────────────────────

function mousePressed(e) {
  if (isUiEvent(e)) return;
  // Middle-button or right-button → pan
  if (mouseButton === CENTER || mouseButton === RIGHT) {
    isPanning   = true;
    panStartX   = mouseX;
    panStartY   = mouseY;
    panCamX0    = camX;
    panCamY0    = camY;
    return false;
  }

  // Left-button → tool action
  if (mouseButton === LEFT) {
    const insideRoom =
      mouseWorldX >= 0 && mouseWorldX <= CFG.ROOM_W &&
      mouseWorldY >= 0 && mouseWorldY <= CFG.ROOM_H;

    if (activeTool === TOOL.LEGS) {
      if (insideRoom) {
        world.addPinnedLegPair(mouseWorldX, mouseWorldY);
        dbg(`placed legs at (${mouseWorldX.toFixed(2)}, ${mouseWorldY.toFixed(2)})`);
      }
    } else if (activeTool === TOOL.BAGS) {
      if (insideRoom) {
        world.addBag(mouseWorldX, mouseWorldY);
        dbg(`placed bag at (${mouseWorldX.toFixed(2)}, ${mouseWorldY.toFixed(2)})`);
      }
    } else if (activeTool === TOOL.PEDESTALS) {
      world.addPedestal(mouseWorldX, mouseWorldY);
      dbg(`placed pedestal at (${mouseWorldX.toFixed(2)}, ${mouseWorldY.toFixed(2)})`);
    }
    return false;
  }
}

function mouseReleased(e) {
  if (isUiEvent(e)) return;
  isPanning = false;
}

function keyPressed() {
  if (keyCode === ESCAPE) {
    setTool(TOOL.CURSOR);
    return false;
  }
}

function mouseDragged() {
  if (isPanning) {
    camX = panCamX0 - (mouseX - panStartX) / ppm;
    camY = panCamY0 - (mouseY - panStartY) / ppm;
    clampCamera();
  }
}

// Must be attached as passive:false to prevent default scroll behaviour
function onWheel(e) {
  e.preventDefault();
  const factor = e.deltaY < 0 ? 1.1 : 0.9;
  // Zoom toward mouse position
  const mw = screenToWorld(mouseX, mouseY);
  ppm = constrain(ppm * factor, getMinPpm(), 300);
  // Re-anchor so that mouse world point stays under cursor
  const mwAfter = screenToWorld(mouseX, mouseY);
  camX += mw.x - mwAfter.x;
  camY += mw.y - mwAfter.y;
  clampCamera();
}

// ── Mobile touch handlers ──────────────────────────

function getMinPpm() {
  if (window.innerWidth > 768) return 5; // desktop: free zoom
  // Mobile: don't allow zooming out past whole-room view
  return Math.min(windowWidth * 0.85 / CFG.ROOM_W, windowHeight * 0.85 / CFG.ROOM_H);
}

function clampCamera() {
  const halfW = width  / (2 * ppm);
  const halfH = height / (2 * ppm);
  // When zoomed in enough, clamp so room edges don't leave the screen
  if (CFG.ROOM_W >= 2 * halfW) {
    camX = constrain(camX, halfW, CFG.ROOM_W - halfW);
  } else {
    camX = CFG.ROOM_W / 2; // room fits — keep centred
  }
  if (CFG.ROOM_H >= 2 * halfH) {
    camY = constrain(camY, halfH, CFG.ROOM_H - halfH);
  } else {
    camY = CFG.ROOM_H / 2;
  }
}

function onTouchStart(e) {
  e.preventDefault();
  if (e.touches.length === 1) {
    touchPanActive  = true;
    touchPanStartX  = e.touches[0].clientX;
    touchPanStartY  = e.touches[0].clientY;
    touchPanCamX0   = camX;
    touchPanCamY0   = camY;
  } else if (e.touches.length === 2) {
    touchPanActive  = false;
    const t0 = e.touches[0], t1 = e.touches[1];
    pinchStartDist  = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
    pinchStartPpm   = ppm;
    pinchMidX       = (t0.clientX + t1.clientX) / 2;
    pinchMidY       = (t0.clientY + t1.clientY) / 2;
    // world point under pinch centre — stays fixed during pinch
    const wm        = screenToWorld(pinchMidX, pinchMidY);
    pinchCamX0      = wm.x;
    pinchCamY0      = wm.y;
  }
}

function onTouchMove(e) {
  e.preventDefault();
  if (e.touches.length === 1 && touchPanActive) {
    const dx = e.touches[0].clientX - touchPanStartX;
    const dy = e.touches[0].clientY - touchPanStartY;
    camX = touchPanCamX0 - dx / ppm;
    camY = touchPanCamY0 - dy / ppm;
    clampCamera();
  } else if (e.touches.length === 2) {
    const t0 = e.touches[0], t1 = e.touches[1];
    const dist = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
    if (pinchStartDist > 0) {
      const newPpm = constrain(pinchStartPpm * dist / pinchStartDist, getMinPpm(), 300);
      const curMidX = (t0.clientX + t1.clientX) / 2;
      const curMidY = (t0.clientY + t1.clientY) / 2;
      ppm  = newPpm;
      // Keep the original world point anchored under the pinch centre
      camX = pinchCamX0 - (curMidX - width  / 2) / ppm;
      camY = pinchCamY0 - (curMidY - height / 2) / ppm;
      clampCamera();
    }
  }
}

function onTouchEnd(e) {
  e.preventDefault();
  if (e.touches.length === 0) {
    touchPanActive = false;
  } else if (e.touches.length === 1) {
    // Finger lifted from a pinch — resume single-finger pan
    touchPanActive = true;
    touchPanStartX = e.touches[0].clientX;
    touchPanStartY = e.touches[0].clientY;
    touchPanCamX0  = camX;
    touchPanCamY0  = camY;
  }
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
}

// ── State panel DOM update ───────────────────

function updatePanel(sensors) {
  const stateEl = document.getElementById('state-badge');
  const fmtMM   = v => v === null ? '— mm' : `${v} mm`;

  if (stateEl) {
    const s = firmware.state;
    stateEl.textContent  = s;
    stateEl.className    = 'badge ' + s.toLowerCase().replace(/_/g, '-');
  }

  const setCell = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  };

  setCell('sensor-front',  fmtMM(sensors.front));
  setCell('sensor-left',   fmtMM(sensors.left));
  setCell('sensor-right',  fmtMM(sensors.right));
  setCell('eggs-carried',  robot.eggsCarried);
  setCell('eggs-deposited', robot.eggs.length);
  setCell('sim-speed',     `${simSpeed.toFixed(2)}×`);
  setCell('zoom-level',    `${Math.round(ppm)} px/m`);
}
