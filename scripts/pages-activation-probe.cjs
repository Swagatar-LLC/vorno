#!/usr/bin/env electron
/**
 * ADR-0033 / SUV-0065 — the opaque-iframe activation experiment, as a script.
 *
 * ADR-0033 §3 records an UNVERIFIED premise and refuses to build on it until it
 * is measured: it is unknown whether a click inside the opaque `srcDoc` Page
 * iframe grants usable parent-window activation, and even a positive result
 * would not prove the click landed in the frame rather than elsewhere in the
 * window. This probe measures it, so the record is an observation instead of an
 * assumption. It ships in the repo because the claim it settles is security
 * load-bearing and a reviewer must be able to re-run it rather than trust a
 * paragraph.
 *
 * It reproduces the real Page sandbox — `sandbox="allow-scripts allow-forms"`,
 * no `allow-same-origin`, srcDoc content, opaque origin — and then, for each
 * trial, reports four independent readings:
 *
 *   frameActivation   navigator.userActivation.isActive INSIDE the frame
 *   parentActivation  navigator.userActivation.isActive in the PARENT document
 *   mainObserved      whether the main process saw the gesture at all
 *   mainFrameHint     whether anything main observed says WHICH frame was hit
 *
 * The last two are the ones that matter for the design: main-process
 * observation is the only reading a renderer cannot forge, and `mainFrameHint`
 * is the question ADR-0033 actually asks — if it is null, no main-observed
 * signal distinguishes a click in the Page from a click on the app's own chrome,
 * and frame-level proof is unavailable at any trust level.
 *
 * Trials:
 *   in-frame       click the button inside the sandboxed iframe
 *   outside-frame  click the parent document, far from the iframe
 *   no-click       read both activation values with no gesture at all (control)
 *
 * Run:  node_modules/electron/dist/Electron.app/Contents/MacOS/Electron scripts/pages-activation-probe.cjs
 * (add --show to watch it; default is an offscreen-free hidden window so the
 * probe does not take over the screen of whoever runs it)
 *
 * Output is one JSON document on stdout. Exit code is 0 when every trial
 * produced a reading, 1 when the probe could not run — an unrunnable probe must
 * not be mistakable for a negative result.
 */

const { app, BrowserWindow, ipcMain } = require('electron')

const SHOW = process.argv.includes('--show')

/** Geometry is fixed so the click coordinates are known rather than measured. */
const WINDOW = { width: 800, height: 600 }
const FRAME = { x: 40, y: 200, width: 400, height: 200 }
const BUTTON_CLICK = { x: FRAME.x + 100, y: FRAME.y + 40 }
const OUTSIDE_CLICK = { x: 600, y: 60 }

/**
 * The page inside the sandbox. Identical posture to PageFrame: opaque origin,
 * scripts allowed, same-origin NOT allowed, content delivered via srcDoc.
 */
const FRAME_SRCDOC = `<!doctype html>
<html><body style="margin:0">
<button id="b" style="width:100%;height:100%;font-size:24px">click</button>
<script>
  var report = function (probe) {
    parent.postMessage({
      probe: probe,
      frameActivation: navigator.userActivation ? navigator.userActivation.isActive : null,
    }, '*')
  }
  // Announcing readiness is what lets the report distinguish "the frame said
  // nothing because nothing hit it" from "the frame never loaded" — without it
  // a silent in-frame trial is indistinguishable from a broken harness.
  report('frame-ready')
  // Three listeners, not one: a synthesized sequence can deliver the low-level
  // events without Chromium ever synthesizing the high-level 'click', and a
  // probe that only watched 'click' would report "the frame was never hit"
  // when the frame was hit.
  ;['pointerdown', 'mousedown', 'click'].forEach(function (name) {
    document.getElementById('b').addEventListener(name, function () { report('frame-' + name) })
  })
</script>
</body></html>`

const HOST_HTML = `<!doctype html>
<html><body style="margin:0;background:#eee">
<div id="outside" style="position:absolute;left:500px;top:0;width:300px;height:120px">parent area</div>
<iframe id="f" sandbox="allow-scripts allow-forms" referrerpolicy="no-referrer"
        style="position:absolute;left:${FRAME.x}px;top:${FRAME.y}px;width:${FRAME.width}px;height:${FRAME.height}px;border:0"
        srcdoc="${FRAME_SRCDOC.replace(/"/g, '&quot;')}"></iframe>
<script>
  const { ipcRenderer } = require('electron')
  let frameReady = false
  let frameEvents = []
  let lastFrameMessage = null
  window.addEventListener('message', (e) => {
    // Same checks PageFrame makes: this frame's window, opaque origin.
    const frameWindow = document.getElementById('f').contentWindow
    if (e.source !== frameWindow || e.origin !== 'null') return
    if (e.data && e.data.probe === 'frame-ready') { frameReady = true; return }
    frameEvents.push(e.data.probe)
    lastFrameMessage = e.data
  })
  document.getElementById('outside').addEventListener('click', () => { lastFrameMessage = null; frameEvents = [] })
  ipcRenderer.on('probe:read', (_e, trial) => {
    const rect = document.getElementById('f').getBoundingClientRect()
    const hit = document.elementFromPoint(${BUTTON_CLICK.x}, ${BUTTON_CLICK.y})
    ipcRenderer.send('probe:reading', {
      trial,
      parentActivation: navigator.userActivation ? navigator.userActivation.isActive : null,
      frameReady,
      // What the parent document believes is at the in-frame click point. If
      // this is not IFRAME the trial is geometry-broken, and no conclusion
      // about in-frame clicks may be drawn from it.
      hitTestTag: hit ? hit.tagName : null,
      // Reported, not assumed: a trial that clicked outside the frame's real
      // rect proves nothing about in-frame clicks, and this is how a reader
      // checks that the fixed coordinates above actually landed in it.
      frameRect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      frameMessage: lastFrameMessage,
      frameEvents: frameEvents.slice(),
    })
  })
</script>
</body></html>`

/** Input types that represent a real activating gesture, not passive movement. */
const ACTIVATING = new Set(['mouseDown', 'keyDown', 'rawKeyDown', 'touchStart'])

async function main() {
  const win = new BrowserWindow({
    ...WINDOW,
    show: SHOW,
    webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false },
  })

  /**
   * Everything the main process can see about a gesture. `keys` is captured
   * verbatim so the report states what Electron actually offered rather than
   * what this script expected — a future Electron that adds frame routing to
   * `input-event` would show up here without an edit.
   */
  const observed = []
  win.webContents.on('input-event', (_event, inputEvent) => {
    if (!ACTIVATING.has(inputEvent.type)) return
    observed.push({ type: inputEvent.type, keys: Object.keys(inputEvent).sort() })
  })

  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(HOST_HTML)}`)
  // srcDoc children load after the parent's load event resolves.
  await new Promise(resolve => setTimeout(resolve, 500))

  const read = (trial) => new Promise((resolve) => {
    ipcMain.once('probe:reading', (_e, reading) => resolve(reading))
    win.webContents.send('probe:read', trial)
  })

  /**
   * CDP input, attempted first. `sendInputEvent` synthesizes at the widget
   * level; `Input.dispatchMouseEvent` enters through the same browser-side
   * pipeline real input uses, so it is the faithful path for a question about
   * how real clicks route to a sandboxed child frame. Falling back rather than
   * failing keeps the probe runnable where the debugger cannot attach, and the
   * report names which path produced each reading.
   */
  let cdp = null
  try {
    win.webContents.debugger.attach('1.3')
    cdp = win.webContents.debugger
  } catch { /* reported as inputPath: 'sendInputEvent' below */ }

  const cdpClick = async (point) => {
    const base = { x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1 }
    await cdp.sendCommand('Input.dispatchMouseEvent', { ...base, type: 'mouseMoved', buttons: 0, clickCount: 0 })
    await cdp.sendCommand('Input.dispatchMouseEvent', { ...base, type: 'mousePressed' })
    await cdp.sendCommand('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased' })
    await new Promise(resolve => setTimeout(resolve, 200))
  }

  const click = async (point) => {
    if (cdp) return cdpClick(point)
    return sendInputClick(point)
  }

  const sendInputClick = async (point) => {
    // The move is not decoration. Chromium routes mouse input to a child frame
    // using a hit-test target it establishes from pointer movement; a bare
    // synthesized mouseDown lands on the root frame and the sandboxed child
    // never sees it, which reads in the report as "the frame said nothing" and
    // would quietly turn the in-frame trial into a second outside-frame one.
    const common = { x: point.x, y: point.y, globalX: point.x, globalY: point.y, button: 'left' }
    win.webContents.sendInputEvent({ type: 'mouseMove', ...common, clickCount: 0 })
    await new Promise(resolve => setTimeout(resolve, 50))
    win.webContents.sendInputEvent({ type: 'mouseDown', ...common, clickCount: 1 })
    win.webContents.sendInputEvent({ type: 'mouseUp', ...common, clickCount: 1 })
    await new Promise(resolve => setTimeout(resolve, 200))
  }

  const trials = []

  // Control first: activation must read false before anything is clicked, or
  // every later reading is meaningless.
  trials.push({ trial: 'no-click', observedBefore: observed.length, ...(await read('no-click')) })

  const beforeInFrame = observed.length
  await click(BUTTON_CLICK)
  trials.push({ trial: 'in-frame', observedDuring: observed.length - beforeInFrame, ...(await read('in-frame')) })

  // Activation is transient; let it lapse so the next trial is not reading the
  // previous click's residue.
  await new Promise(resolve => setTimeout(resolve, 6000))

  const beforeOutside = observed.length
  await click(OUTSIDE_CLICK)
  trials.push({ trial: 'outside-frame', observedDuring: observed.length - beforeOutside, ...(await read('outside-frame')) })

  const report = {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    platform: process.platform,
    windowShown: SHOW,
    inputPath: cdp ? 'cdp:Input.dispatchMouseEvent' : 'webContents.sendInputEvent',
    hitTestTagAtInFramePoint: trials[0] ? trials[0].hitTestTag : null,
    observedGestureShape: observed[0] ? observed[0].keys : null,
    frameLoaded: trials.every(t => t.frameReady),
    frameRect: trials[0] ? trials[0].frameRect : null,
    clickPoints: { inFrame: BUTTON_CLICK, outsideFrame: OUTSIDE_CLICK },
    trials: trials.map(t => ({
      trial: t.trial,
      frameActivation: t.frameMessage ? t.frameMessage.frameActivation : null,
      parentActivation: t.parentActivation,
      mainObservedGestures: t.observedDuring ?? 0,
      frameEvents: t.frameEvents,
      frameReportedClick: !!t.frameMessage,
    })),
    // The ADR's actual question. `input-event` carries no frame identity, so a
    // null here means main-observed gestures cannot attribute a click to the
    // Page frame — stated as a measured absence, not an assumption.
    mainFrameHint: observed[0] && observed[0].keys.some(k => /frame/i.test(k)) ? 'present' : null,
  }

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  win.destroy()
  app.exit(0)
}

app.whenReady().then(() => {
  main().catch((error) => {
    process.stderr.write(`probe failed: ${error && error.stack ? error.stack : error}\n`)
    app.exit(1)
  })
})
