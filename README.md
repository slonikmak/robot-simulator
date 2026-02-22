# Exhibition Simulator

This is a simple HTML/JS simulation of an exhibition robot.

## Running the simulator

Because most browsers restrict local file access for `canvas` and scripts, it's easiest to serve the files with a static HTTP server.

### Using Python 3 (most systems)

```bash
cd "c:\Users\kp\Documents\projects\exhibition-simulator"
python -m http.server 8000
```

Then open `http://localhost:8000` in your browser.

### Using Node.js

```bash
# install a simple static server if you don't have one
npm install -g serve
cd "c:\Users\kp\Documents\projects\exhibition-simulator"
serve -l 8000
```

### Using VS Code Live Server extension

1. Install the 'Live Server' extension.
2. Open this folder in VS Code and click "Go Live" in the status bar.
3. The simulator will open in your default browser.

Once the server is running, move your mouse over the canvas to simulate visitor legs. Use the scroll wheel to zoom and the slider in the UI to speed up time.

> **Sensor model**: the robot reads only a single distance value from a simulated
> ultrasonic sensor (like an HC‑SR04), exactly as a real Arduino robot would.
> The firmware has no access to the cursor coordinates; it only reacts based on
> the measured distance, so walls and legs are indistinguishable when they are
> within range.
