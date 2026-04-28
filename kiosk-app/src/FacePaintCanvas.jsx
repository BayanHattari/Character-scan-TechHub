import React, {
  useRef,
  useEffect,
  useImperativeHandle,
  forwardRef,
  useState,
  useCallback,
} from 'react'

class OneEuroFilter {
  constructor(minCutoff = 1.0, beta = 0.0, dcutoff = 1.0) {
    this.minCutoff = minCutoff
    this.beta = beta
    this.dcutoff = dcutoff
    this.xPrev = null
    this.dxPrev = null
    this.tPrev = null
  }

  filter(x, t) {
    if (this.tPrev === null) {
      this.xPrev = x
      this.dxPrev = 0
      this.tPrev = t
      return x
    }
    const dt = (t - this.tPrev) / 1000
    this.tPrev = t
    if (dt <= 0) return this.xPrev
    const dx = (x - this.xPrev) / dt
    const edx = this._smooth(dx, this.dxPrev, dt, this.dcutoff)
    const cutoff = this.minCutoff + this.beta * Math.abs(edx)
    const result = this._smooth(x, this.xPrev, dt, cutoff)
    this.xPrev = result
    this.dxPrev = edx
    return result
  }

  _smooth(a, b, dt, cutoff) {
    const tau = 1.0 / (2.0 * Math.PI * cutoff)
    const alpha = 1.0 / (1.0 + tau / dt)
    return alpha * a + (1.0 - alpha) * b
  }
}

const CW_X = 110
const CW_Y = 440
const CW_R = 80
const PREDICT = 0.65
const ERASE_R = 30

const STREAMLINE_K        = 0.4
const TAPER_MIN           = 0.35
const RDP_EPS_LIVE        = 2
const RDP_EPS_CAPTURE     = 5
const SHAPE_CIRCLE_THRESH = 0.9
const SHAPE_LINE_THRESH   = 0.02
const SHAPE_RADIUS_CV     = 0.15
const SHAPE_MIN_POINTS    = 8
const SHAPE_MIN_LENGTH    = 80

function rdp(points, eps) {
  if (points.length < 3) return points.slice()
  const eps2 = eps * eps
  const keep = new Uint8Array(points.length)
  keep[0] = 1
  keep[points.length - 1] = 1
  const stack = [[0, points.length - 1]]
  while (stack.length) {
    const [a, b] = stack.pop()
    const ax = points[a].x, ay = points[a].y
    const bx = points[b].x, by = points[b].y
    const dx = bx - ax, dy = by - ay
    const len2 = dx * dx + dy * dy
    let maxD2 = 0, maxI = -1
    for (let i = a + 1; i < b; i++) {
      const px = points[i].x - ax, py = points[i].y - ay
      const cross = px * dy - py * dx
      const d2 = len2 > 0 ? (cross * cross) / len2 : px * px + py * py
      if (d2 > maxD2) { maxD2 = d2; maxI = i }
    }
    if (maxI !== -1 && maxD2 > eps2) {
      keep[maxI] = 1
      stack.push([a, maxI], [maxI, b])
    }
  }
  const out = []
  for (let i = 0; i < points.length; i++) if (keep[i]) out.push(points[i])
  return out
}

function strokeBounds(pts) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const p of pts) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y
  }
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY }
}

function strokeLength(pts) {
  let L = 0
  for (let i = 1; i < pts.length; i++) {
    L += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
  }
  return L
}

function detectCircle(pts) {
  if (pts.length < SHAPE_MIN_POINTS) return null
  const b = strokeBounds(pts)
  const diag = Math.hypot(b.w, b.h)
  if (diag < SHAPE_MIN_LENGTH) return null
  const start = pts[0], end = pts[pts.length - 1]
  const closure = Math.hypot(start.x - end.x, start.y - end.y)
  if (closure > diag * 0.35) return null
  let cx = 0, cy = 0
  for (const p of pts) { cx += p.x; cy += p.y }
  cx /= pts.length; cy /= pts.length
  let meanR = 0
  const radii = new Array(pts.length)
  for (let i = 0; i < pts.length; i++) {
    const r = Math.hypot(pts[i].x - cx, pts[i].y - cy)
    radii[i] = r
    meanR += r
  }
  meanR /= pts.length
  if (meanR < 20) return null
  let varR = 0
  for (const r of radii) varR += (r - meanR) * (r - meanR)
  varR /= pts.length
  const cv = Math.sqrt(varR) / meanR
  if (cv > SHAPE_RADIUS_CV) return null
  const L = strokeLength(pts)
  const A = Math.PI * meanR * meanR
  const iso = (4 * Math.PI * A) / (L * L)
  if (iso < SHAPE_CIRCLE_THRESH) return null
  return { cx, cy, r: meanR }
}

function detectLine(pts) {
  if (pts.length < 4) return null
  const start = pts[0], end = pts[pts.length - 1]
  const chord = Math.hypot(end.x - start.x, end.y - start.y)
  if (chord < SHAPE_MIN_LENGTH) return null
  let n = 0, sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0
  for (const p of pts) {
    n++; sumX += p.x; sumY += p.y
    sumXY += p.x * p.y; sumX2 += p.x * p.x; sumY2 += p.y * p.y
  }
  const mx = sumX / n, my = sumY / n
  const sxx = sumX2 - n * mx * mx
  const syy = sumY2 - n * my * my
  const sxy = sumXY - n * mx * my
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy)
  const nx = -Math.sin(theta), ny = Math.cos(theta)
  const tx = Math.cos(theta), ty = Math.sin(theta)
  let rms = 0, tMin = Infinity, tMax = -Infinity
  for (const p of pts) {
    const dx = p.x - mx, dy = p.y - my
    const perp = dx * nx + dy * ny
    rms += perp * perp
    const along = dx * tx + dy * ty
    if (along < tMin) tMin = along
    if (along > tMax) tMax = along
  }
  rms = Math.sqrt(rms / n)
  const length = tMax - tMin
  if (length < SHAPE_MIN_LENGTH) return null
  if (rms / length > SHAPE_LINE_THRESH) return null
  return {
    ax: mx + tMin * tx, ay: my + tMin * ty,
    bx: mx + tMax * tx, by: my + tMax * ty,
  }
}

function rasterizeCircle(cx, cy, r, n = 48) {
  const out = []
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2
    out.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r })
  }
  return out
}

function polishStroke(pts, eps) {
  const simplified = rdp(pts, eps)
  if (simplified.length < 3) return simplified
  const circle = detectCircle(simplified)
  if (circle) return rasterizeCircle(circle.cx, circle.cy, circle.r)
  const line = detectLine(simplified)
  if (line) return [{ x: line.ax, y: line.ay }, { x: line.bx, y: line.by }]
  return simplified
}

function strokePathOn(ctx, pts, w) {
  if (pts.length < 2) return
  const N = pts.length
  const taper = (i) => {
    const s = N > 1 ? i / (N - 1) : 0
    return TAPER_MIN + (1 - TAPER_MIN) * Math.sin(Math.PI * s)
  }
  if (N === 2) {
    ctx.beginPath()
    ctx.lineWidth = w * 0.5 * (taper(0) + taper(1))
    ctx.moveTo(pts[0].x, pts[0].y)
    ctx.lineTo(pts[1].x, pts[1].y)
    ctx.stroke()
    return
  }
  for (let i = 1; i < N - 1; i++) {
    const mxPrev = i === 1 ? pts[0].x : (pts[i - 1].x + pts[i].x) / 2
    const myPrev = i === 1 ? pts[0].y : (pts[i - 1].y + pts[i].y) / 2
    const mx = (pts[i].x + pts[i + 1].x) / 2
    const my = (pts[i].y + pts[i + 1].y) / 2
    ctx.beginPath()
    ctx.lineWidth = w * 0.5 * (taper(i - 1) + taper(i))
    ctx.moveTo(mxPrev, myPrev)
    ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my)
    ctx.stroke()
  }
  const last = pts[N - 1]
  const prevMx = (pts[N - 2].x + last.x) / 2
  const prevMy = (pts[N - 2].y + last.y) / 2
  ctx.beginPath()
  ctx.lineWidth = w * 0.5 * (taper(N - 2) + taper(N - 1))
  ctx.moveTo(prevMx, prevMy)
  ctx.lineTo(last.x, last.y)
  ctx.stroke()
}

const FacePaintCanvas = forwardRef(function FacePaintCanvas({ onCapture, onUserActivity, onStrokeComplete, onUiAction, mode = 'paint' }, ref){
  const isChallenge = mode === 'circle'
  const videoRef      = useRef(null)
  const drawCanvasRef = useRef(null)
  const uiCanvasRef   = useRef(null)
  const cursorRef     = useRef(null)
  const containerRef  = useRef(null)
  

  const [lockedUI,    setLockedUI]    = useState(false)
  const [brushSizeUI, setBrushSizeUI] = useState(6)
  const [ready,       setReady]       = useState(false)
  const [polishing,   setPolishing]   = useState(false)

  const lines         = useRef([])
  const curPts        = useRef([])
  const drawing       = useRef(false)
  const isCapturingRef = useRef(false)
  const color         = useRef('#00ff00')
  const bSize         = useRef(6)
  const undoStack     = useRef([])
  const wasErasing    = useRef(false)
  const locked        = useRef(false)
  const colorLocked   = useRef(false)
  const peaceF        = useRef(0)
  const openF         = useRef(0)
  const lastPinchEnd  = useRef(0)
  const prevAction    = useRef('hover')
  const lastClick     = useRef(0)
  const lastLock      = useRef(0)
  const lastRaw       = useRef({ x: 0, y: 0 })
  const actNose       = useRef({ x: window.innerWidth / 2, y: window.innerHeight / 2 })
  const actTilt       = useRef(0)
  const ancNose       = useRef({ x: window.innerWidth / 2, y: window.innerHeight / 2 })
  const ancTilt       = useRef(0)
  const fx            = useRef(new OneEuroFilter(1.0, 0.03))
  const fy            = useRef(new OneEuroFilter(1.0, 0.03))
  const lastGood      = useRef({ x: 0, y: 0, t: 0 })
  const streamPt      = useRef({ x: 0, y: 0, init: false })
  const onStrokeCompleteRef = useRef(onStrokeComplete)
  onStrokeCompleteRef.current = onStrokeComplete
  const onUiActionRef = useRef(onUiAction)
  onUiActionRef.current = onUiAction

  useImperativeHandle(ref, () => ({
    exportImage: () =>
      new Promise((resolve) => {
        const video = videoRef.current
        const dc    = drawCanvasRef.current
        if (!dc) return resolve(null)

        setPolishing(true)

        setTimeout(() => {
          try {
            const tmp = document.createElement('canvas')
            tmp.width  = dc.width
            tmp.height = dc.height
            const ctx  = tmp.getContext('2d')

            if (video && video.readyState >= 2) {
              ctx.save()
              ctx.translate(tmp.width, 0)
              ctx.scale(-1, 1)
              ctx.drawImage(video, 0, 0, tmp.width, tmp.height)
              ctx.restore()
            }

            ctx.save()
            if (locked.current) {
              ctx.translate(actNose.current.x, actNose.current.y)
              ctx.rotate(actTilt.current - ancTilt.current)
              ctx.translate(-ancNose.current.x, -ancNose.current.y)
            }
            ctx.lineCap = 'round'
            ctx.lineJoin = 'round'
            for (const line of lines.current) {
              const polished = polishStroke(line.points, RDP_EPS_CAPTURE)
              if (polished.length < 2) continue
              ctx.strokeStyle = line.color
              strokePathOn(ctx, polished, line.size || 6)
            }
            ctx.restore()

            tmp.toBlob((blob) => {
              setPolishing(false)
              resolve(blob)
            }, 'image/png')
          } catch (err) {
            setPolishing(false)
            console.error('Capture polish error:', err)
            resolve(null)
          }
        }, 16)
      }),

    resetSession: () => {
      lines.current     = []
      curPts.current    = []
      undoStack.current = []
      drawing.current   = false
      wasErasing.current = false
      streamPt.current.init = false
      const dc = drawCanvasRef.current
      if (dc) dc.getContext('2d').clearRect(0, 0, dc.width, dc.height)
    },

    isReady: () => ready,
  }), [ready])

  const drawUI = useCallback(() => {
    const uc = uiCanvasRef.current
    if (!uc) return
    const ctx = uc.getContext('2d')
    ctx.clearRect(0, 0, uc.width, uc.height)
    if (isChallenge) return

    for (let a = 0; a <= 360; a++) {
      ctx.beginPath()
      ctx.moveTo(CW_X, CW_Y)
      ctx.arc(CW_X, CW_Y, CW_R, (a - 1.5) * Math.PI / 180, (a + 0.5) * Math.PI / 180)
      ctx.closePath()
      ctx.fillStyle = `hsl(${a},100%,50%)`
      ctx.fill()
    }
    const g = ctx.createRadialGradient(CW_X, CW_Y, 0, CW_X, CW_Y, CW_R)
    g.addColorStop(0, 'rgba(255,255,255,1)')
    g.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = g
    ctx.beginPath()
    ctx.arc(CW_X, CW_Y, CW_R, 0, Math.PI * 2)
    ctx.fill()
    ctx.lineWidth = 4
    ctx.strokeStyle = 'rgba(255,255,255,0.8)'
    ctx.beginPath()
    ctx.arc(CW_X, CW_Y, CW_R, 0, Math.PI * 2)
    ctx.stroke()
    ctx.fillStyle = 'white'
    ctx.font = 'bold 16px sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText('🎨 Pick Color', CW_X, CW_Y + CW_R + 30)
  }, [isChallenge])

  const mapToScreen = useCallback((nx, ny) => {
    const video = videoRef.current
    const dc    = drawCanvasRef.current
    if (!dc) return { x: (1 - nx) * window.innerWidth, y: ny * window.innerHeight }

    const vW = video?.videoWidth  || 0
    const vH = video?.videoHeight || 0
    if (!vW || !vH) return { x: (1 - nx) * dc.width, y: ny * dc.height }

    const vR  = vW / vH
    const sR  = dc.width / dc.height
    let rW    = dc.width
    let rH    = dc.height
    let ox    = 0
    let oy    = 0
    if (sR > vR) { rH = dc.width / vR;  oy = (rH - dc.height) / 2 }
    else          { rW = dc.height * vR; ox = (rW - dc.width)  / 2 }

    return { x: ((1 - nx) * rW) - ox, y: (ny * rH) - oy }
  }, [])

  const toggleLock = useCallback(() => {
    const next = !locked.current
    locked.current = next
    if (next) {
      ancNose.current = { x: actNose.current.x, y: actNose.current.y }
      ancTilt.current = actTilt.current
    }
    setLockedUI(next)
  }, [])

  useEffect(() => {
    const dc = drawCanvasRef.current
    const uc = uiCanvasRef.current
    const onResize = () => {
      dc.width = window.innerWidth;  dc.height = window.innerHeight
      uc.width = window.innerWidth;  uc.height = window.innerHeight
      drawUI()
    }
    onResize()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [drawUI])

  useEffect(() => {
    let stream = null
    let animationFrameId = null
    let isActive = true
    const video = videoRef.current
    const dc    = drawCanvasRef.current
    const cur   = cursorRef.current
    const cont  = containerRef.current
    if (!video || !dc || !cur) return

    const drawCtx = dc.getContext('2d')

    const setCursor = (props) => {
      Object.assign(cur.style, {
        display: 'block', transition: 'width 0.1s, height 0.1s',
        ...props
      })
    }
    const hideCursor = () => { cur.style.display = 'none' }

    const finalizeStroke = () => {
      if (!curPts.current.length) return
      const simplified = rdp(curPts.current, RDP_EPS_LIVE)
      lines.current.push({ points: simplified, color: color.current, size: bSize.current })
      const cb = onStrokeCompleteRef.current
      if (cb) cb(simplified, color.current, bSize.current)
    }

    const onResults = (results) => {
      let rightFound = false
      let action     = 'hover'
      let rawX = null, rawY = null

      if (results.multiHandLandmarks?.length) {
         if (typeof onUserActivity === "function") {
    onUserActivity();
          }

        results.multiHandedness.forEach((h, i) => {
          const lm    = results.multiHandLandmarks[i]
          const label = h.label

          if (label === 'Right') {
            rightFound = true
            const pos = mapToScreen(lm[8].x, lm[8].y)
            rawX = pos.x; rawY = pos.y
          }

          if (label === 'Left') {
            const w = lm[0], th = lm[4], ix = lm[8], mx = lm[12]
            const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y)
            const pinch = d(ix, th)
            const fDist = d(mx, w)
            const fold  = (t, p) => d(lm[t], w) < d(lm[p], w)
            const ext   = (t, p) => d(lm[t], w) > d(lm[p], w)
            const peace = ext(8,5) && ext(12,9) && fold(16,13) && fold(20,17)
                        && pinch > 0.08 && d(lm[8], lm[12]) > 0.04
            peaceF.current = peace ? peaceF.current + 1 : 0
            openF.current  = (fDist > 0.3) ? openF.current + 1 : 0
            if      (pinch < 0.04)          action = 'pinch'
            else if (peaceF.current > 5)    action = 'peace'
            else if (openF.current  > 6)    action = 'open'
          }
        })
      }

      const now = Date.now()
      if (prevAction.current === 'pinch' && action !== 'pinch') lastPinchEnd.current = now
      if (action === 'open' && now - lastPinchEnd.current < 600) action = 'hover'
      prevAction.current = action
      if (action !== 'open')  wasErasing.current  = false
      if (action !== 'pinch') colorLocked.current = false

      if (action === 'peace') {
        if (drawing.current) {
          drawing.current = false
          streamPt.current.init = false
          finalizeStroke()
          curPts.current = []
        }
        if (now - lastLock.current > 2000) { toggleLock(); lastLock.current = now }
      }

      if (rightFound && rawX !== null) {
        // Velocity-clamp rather than freeze. A single-frame MediaPipe mislabel
        // jumps out and back: the cursor takes one capped step toward the bad
        // sample, then one capped step back, netting near zero. Real fast hand
        // sweeps catch up over a few frames at MAX_SPEED, with no visible
        // freeze/snap-back artifact.
        const MAX_SPEED = 6000  // px/s
        const dt = (now - lastGood.current.t) / 1000 || 0.016
        const dx = rawX - lastGood.current.x
        const dy = rawY - lastGood.current.y
        const dist = Math.hypot(dx, dy)
        const maxStep = MAX_SPEED * dt
        let gx, gy
        if (lastGood.current.t === 0 || dist <= maxStep) {
          gx = rawX; gy = rawY
        } else {
          const ratio = maxStep / dist
          gx = lastGood.current.x + dx * ratio
          gy = lastGood.current.y + dy * ratio
        }
        lastGood.current = { x: gx, y: gy, t: now }

        const vx = gx - lastRaw.current.x
        const vy = gy - lastRaw.current.y
        const sx = fx.current.filter(gx + vx * PREDICT, now)
        const sy = fy.current.filter(gy + vy * PREDICT, now)
        lastRaw.current = { x: gx, y: gy }

        let bx = sx, by = sy
        if (locked.current) {
          const dRot = actTilt.current - ancTilt.current
          const tx = sx - actNose.current.x
          const ty = sy - actNose.current.y
          const c  = Math.cos(-dRot), s = Math.sin(-dRot)
          bx = tx * c - ty * s + ancNose.current.x
          by = tx * s + ty * c + ancNose.current.y
        }

        const dWheel    = Math.hypot(sx - CW_X, sy - CW_Y)
        const onWheel   = !isChallenge && dWheel <= CW_R
        const rect      = cont?.getBoundingClientRect() || { left: 0, top: 0 }
        const el        = document.elementFromPoint(rect.left + sx, rect.top + sy)
        const onBtn     = el?.closest('.air-btn')

        document.querySelectorAll('.air-btn').forEach(b => {
          b.style.transform = b === onBtn ? 'scale(1.1)' : 'scale(1)'
        })

        if (action === 'peace') {
          setCursor({ left:`${sx}px`, top:`${sy}px`, width:'40px', height:'40px',
            backgroundColor:'transparent', borderColor:'cyan', borderWidth:'4px' })

        } else if (action === 'pinch') {
          if (onWheel && !drawing.current) {
            if (!colorLocked.current) {
              let deg = Math.atan2(sy - CW_Y, sx - CW_X) * 180 / Math.PI
              if (deg < 0) deg += 360
              const l = 100 - (Math.min(dWheel, CW_R) / CW_R) * 50
              color.current = `hsl(${deg},100%,${l}%)`
              colorLocked.current = true
            }
            setCursor({ left:`${sx}px`, top:`${sy}px`, width:'40px', height:'40px',
              backgroundColor: color.current, borderColor:'#00ff00', borderWidth:'4px' })

          } else if (onBtn && !drawing.current) {
            cur.style.display = 'block'
            if (now - lastClick.current > 500) {
              if (onBtn.dataset.size) {
                const ns = parseInt(onBtn.dataset.size)
                bSize.current = ns
                setBrushSizeUI(ns)
                document.querySelectorAll('.air-btn[data-size]').forEach(b => b.style.borderColor = 'white')
                onBtn.style.borderColor = '#00ff00'

              } else if (onBtn.dataset.action === 'lock') {
                if (now - lastLock.current > 2000) { toggleLock(); lastLock.current = now }

              } else if (onBtn.dataset.action === 'undo') {
                lines.current = undoStack.current.length > 0 ? undoStack.current.pop() : []
                onBtn.style.backgroundColor = 'white'
                onBtn.style.color = 'black'
                setTimeout(() => {
                  onBtn.style.backgroundColor = 'rgba(0,0,0,0.6)'
                  onBtn.style.color = 'white'
                }, 200)

              } else if (onBtn.dataset.action === 'capture') {
                onBtn.style.transform = 'scale(0.85)'
                onBtn.style.backgroundColor = '#ddd'
                setTimeout(() => {
                  onBtn.style.transform = 'scale(1)'
                  onBtn.style.backgroundColor = 'white'
                }, 200)

                if (typeof onCapture === 'function') {
                  onCapture();
                } else {
                  console.error("Error: 'onCapture' function is missing!");
                }

              } else if (onBtn.dataset.action) {
                const cb = onUiActionRef.current
                if (cb) cb(onBtn.dataset.action, onBtn)
              }

              lastClick.current = now
            }

          } else if (locked.current) {
            drawing.current = false
            setCursor({ left:`${sx}px`, top:`${sy}px`, width:'30px', height:'30px',
              backgroundColor:'transparent', borderColor:'red', borderWidth:'4px' })

          } else {
            if (!drawing.current) {
              undoStack.current.push(JSON.parse(JSON.stringify(lines.current)))
              drawing.current = true
              curPts.current  = []
              streamPt.current = { x: bx, y: by, init: true }
            }
            if (!streamPt.current.init) {
              streamPt.current.x = bx
              streamPt.current.y = by
              streamPt.current.init = true
            } else {
              streamPt.current.x += (bx - streamPt.current.x) * STREAMLINE_K
              streamPt.current.y += (by - streamPt.current.y) * STREAMLINE_K
            }
            const np = { x: streamPt.current.x, y: streamPt.current.y }
            if (!curPts.current.length) {
              curPts.current.push(np)
            } else {
              const last = curPts.current[curPts.current.length - 1]
              if (Math.hypot(np.x - last.x, np.y - last.y) > 5) curPts.current.push(np)
            }
            hideCursor()
          }

        } else if (action === 'open') {
          if (drawing.current) {
            drawing.current = false
            streamPt.current.init = false
            finalizeStroke()
            curPts.current = []
          }
          if (locked.current) {
            setCursor({ left:`${sx}px`, top:`${sy}px`, width:'30px', height:'30px',
              backgroundColor:'transparent', borderColor:'red', borderWidth:'4px' })
          } else {
            let erased = false
            const newLines = []
            for (const line of lines.current) {
              let segment = []
              let cut = false
              for (const p of line.points) {
                if (Math.hypot(p.x - bx, p.y - by) < ERASE_R) {
                  cut = true
                  if (segment.length > 1) newLines.push({ points: segment, color: line.color, size: line.size })
                  segment = []
                } else {
                  segment.push(p)
                }
              }
              if (cut) {
                erased = true
                if (segment.length > 1) newLines.push({ points: segment, color: line.color, size: line.size })
              } else {
                newLines.push(line)
              }
            }
            if (erased) {
              if (!wasErasing.current) {
                undoStack.current.push(JSON.parse(JSON.stringify(lines.current)))
                wasErasing.current = true
              }
              lines.current = newLines
            }
            setCursor({ left:`${sx}px`, top:`${sy}px`, width:'60px', height:'60px',
              backgroundColor:'transparent', borderColor:'hotpink', borderWidth:'4px' })
          }

        } else {
          if (drawing.current) {
            drawing.current = false
            streamPt.current.init = false
            finalizeStroke()
            curPts.current = []
          }
          cur.style.display    = 'block'
          cur.style.borderWidth = '2px'
          cur.style.left       = `${sx}px`
          cur.style.top        = `${sy}px`
          if (onWheel) {
            let deg = Math.atan2(sy - CW_Y, sx - CW_X) * 180 / Math.PI
            if (deg < 0) deg += 360
            const l = 100 - (Math.min(dWheel, CW_R) / CW_R) * 50
            cur.style.backgroundColor = `hsl(${deg},100%,${l}%)`
            cur.style.width = '30px'; cur.style.height = '30px'
            cur.style.borderColor = 'white'
          } else if (onBtn) {
            cur.style.backgroundColor = color.current
            cur.style.width = '20px'; cur.style.height = '20px'
            cur.style.borderColor = 'white'
          } else if (locked.current) {
            cur.style.backgroundColor = 'transparent'
            cur.style.borderColor = 'red'
            cur.style.width = '20px'; cur.style.height = '20px'
          } else {
            cur.style.backgroundColor = color.current
            cur.style.width  = `${bSize.current * 2.5}px`
            cur.style.height = `${bSize.current * 2.5}px`
            cur.style.borderColor = 'white'
          }
        }

      } else {
        hideCursor()
        if (drawing.current) {
          drawing.current = false
          streamPt.current.init = false
          finalizeStroke()
          curPts.current = []
        }
      }

      drawCtx.clearRect(0, 0, dc.width, dc.height)
      drawCtx.save()
      if (locked.current) {
        drawCtx.translate(actNose.current.x, actNose.current.y)
        drawCtx.rotate(actTilt.current - ancTilt.current)
        drawCtx.translate(-ancNose.current.x, -ancNose.current.y)
      }
      drawCtx.lineCap = 'round'; drawCtx.lineJoin = 'round'

      lines.current.forEach(line => {
        drawCtx.strokeStyle = line.color
        strokePathOn(drawCtx, line.points, line.size || 6)
      })

      if (curPts.current.length > 1) {
        drawCtx.strokeStyle = color.current
        strokePathOn(drawCtx, curPts.current, bSize.current)
      }
      drawCtx.restore()
    }

    const onFaceResults = (results) => {
      if (!results.multiFaceLandmarks?.length) return
      const face = results.multiFaceLandmarks[0]
      const nose = mapToScreen(face[1].x,   face[1].y)
      const lEye = mapToScreen(face[263].x,  face[263].y)
      const rEye = mapToScreen(face[33].x,   face[33].y)
      const ang  = Math.atan2(rEye.y - lEye.y, rEye.x - lEye.x)
      actNose.current.x = actNose.current.x * 0.4 + nose.x * 0.6
      actNose.current.y = actNose.current.y * 0.4 + nose.y * 0.6
      actTilt.current   = actTilt.current   * 0.4 + ang    * 0.6
    }

    const hands = new window.Hands({
      locateFile: (f) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${f}`
    })
    hands.setOptions({ maxNumHands: 2, modelComplexity: 1,
      minDetectionConfidence: 0.6, minTrackingConfidence: 0.6 })
    hands.onResults(onResults)

    const faceMesh = new window.FaceMesh({
      locateFile: (f) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${f}`
    })
    faceMesh.setOptions({ maxNumFaces: 1, refineLandmarks: false,
      minDetectionConfidence: 0.6, minTrackingConfidence: 0.6 })
    faceMesh.onResults(onFaceResults)

    ;(async () => {
      try {
        const devs  = await navigator.mediaDevices.enumerateDevices()
        const vDevs = devs.filter(d => d.kind === 'videoinput')
        const camo  = vDevs.find(d => d.label.toLowerCase().includes('camo'))
         stream = await navigator.mediaDevices.getUserMedia({
          video: { width: 1920, height: 1080,
            deviceId: camo ? { exact: camo.deviceId } : undefined }
        })
      video.srcObject = stream;
        
        const playPromise = video.play();
        if (playPromise !== undefined) {
          playPromise.catch(error => {
            if (error.name !== 'AbortError') {
              console.error('Video play error:', error);
            }
          });
        }

        const loop = async () => {
          if (!isActive) return
          try {
            if (!video.paused && !video.ended && !isCapturingRef.current) {
              await hands.send({ image: video })
              await faceMesh.send({ image: video })
            }
          } catch {}
          animationFrameId = requestAnimationFrame(loop)
        }
        video.onloadeddata = () => { setReady(true); loop() }
      } catch (err) {
        console.error('Camera error:', err)
      }
    })()
    return () => {
  isActive = false

  if (animationFrameId) {
    cancelAnimationFrame(animationFrameId)
  }

  if (videoRef.current?.srcObject) {
    videoRef.current.srcObject.getTracks().forEach(track => track.stop())
    videoRef.current.srcObject = null
  }

  if (stream) {
    stream.getTracks().forEach(track => track.stop())
  }
}
  }, [mapToScreen, toggleLock, drawUI])

  return (
    <div ref={containerRef} style={{
      position: 'relative', width: '100vw', height: '100vh',
      background: '#000', overflow: 'hidden'
    }}>
      <video ref={videoRef} playsInline style={{
        position: 'absolute', top: 0, left: 0,
        width: '100%', height: '100%',
        objectFit: 'cover', opacity: 0.6,
        transform: 'scaleX(-1)'
      }} />

      <canvas ref={drawCanvasRef} style={{
        position: 'absolute', top: 0, left: 0,
        width: '100%', height: '100%',
        pointerEvents: 'none', zIndex: 5
      }} />

      <canvas ref={uiCanvasRef} style={{
        position: 'absolute', top: 0, left: 0,
        width: '100%', height: '100%',
        pointerEvents: 'none', zIndex: 10
      }} />

      <div ref={cursorRef} style={{
        position: 'absolute', width: '20px', height: '20px',
        border: '2px solid white', backgroundColor: '#00ff00',
        borderRadius: '50%', transform: 'translate(-50%, -50%)',
        pointerEvents: 'none', zIndex: 30,
        boxShadow: '0 0 10px rgba(0,0,0,0.5)', display: 'none'
      }} />

      {!isChallenge && (
        <div style={{
          position: 'absolute', top: 20, left: 20,
          display: 'flex', gap: '10px', zIndex: 20
        }}>
          <button className="air-btn" data-action="lock" style={{
            background: lockedUI ? 'cyan' : 'rgba(0,0,0,0.6)',
            border: '2px solid cyan', color: lockedUI ? 'black' : 'white',
            padding: '8px 15px', fontSize: '14px', borderRadius: '20px',
            fontWeight: 'bold', cursor: 'pointer', backdropFilter: 'blur(5px)',
            transition: 'transform 0.1s'
          }}>
            ✌️ Lock: {lockedUI ? 'ON' : 'OFF'}
          </button>
          <button className="air-btn" data-action="undo" style={{
            background: 'rgba(0,0,0,0.6)', border: '2px solid orange',
            color: 'white', padding: '8px 15px', fontSize: '14px', borderRadius: '20px',
            fontWeight: 'bold', cursor: 'pointer', backdropFilter: 'blur(5px)',
            transition: 'transform 0.1s'
          }}>
            ↩️ Undo
          </button>
        </div>
      )}

      {!isChallenge && (
        <div style={{
          position: 'absolute', top: 70, left: 20, zIndex: 20, color: 'white'
        }}>
          <div style={{
            background: 'rgba(0,0,0,0.65)', padding: '12px',
            borderRadius: '12px', backdropFilter: 'blur(8px)',
            border: '1px solid rgba(255,255,255,0.1)',
            lineHeight: '1.5', fontSize: '13px'
          }}>
            <h3 style={{ marginTop: 0, marginBottom: 8, fontSize: '16px' }}>Air Canvas ✏️</h3>
            <div>🎯 <b>Left Index:</b> Cursor</div>
            <div>🤏 <b>Right Pinch:</b> Draw / Click</div>
            <div>✋ <b>Right Palm:</b> Swipe to Erase</div>
            <div>✌️ <b>Peace Sign:</b> Lock Canvas</div>
            <div>↩️ <b>Undo:</b> Hover + Pinch</div>
            <div>🎨 <b>Color Wheel:</b> Pinch to Pick</div>
          </div>
        </div>
      )}

      {!isChallenge && (
        <div style={{
          position: 'absolute', top: 260, left: 20,
          display: 'flex', gap: '8px', zIndex: 20
        }}>
          {[3, 6, 12].map(sz => (
            <button key={sz} className="air-btn" data-size={sz} style={{
              background: 'rgba(0,0,0,0.6)',
              border: `2px solid ${brushSizeUI === sz ? '#00ff00' : 'white'}`,
              color: 'white', padding: '6px 12px', borderRadius: '20px',
              fontSize: '13px', fontWeight: 'bold', cursor: 'pointer',
              backdropFilter: 'blur(5px)', transition: 'transform 0.1s, border-color 0.2s'
            }}>
              🖌️ {sz === 3 ? 'Small' : sz === 6 ? 'Medium' : 'Large'}
            </button>
          ))}
        </div>
      )}

      {!ready && (
        <div style={{
          position: 'absolute', inset: 0, display: 'flex',
          alignItems: 'center', justifyContent: 'center',
          background: 'rgba(0,0,0,0.8)', zIndex: 50, color: 'white',
          fontSize: '24px', flexDirection: 'column', gap: '16px'
        }}>
          <div style={{ fontSize: 48 }}>⏳</div>
          <div>Loading Camera & MediaPipe...</div>
        </div>
      )}

      {polishing && (
        <div style={{
          position: 'absolute', inset: 0, display: 'flex',
          alignItems: 'center', justifyContent: 'center',
          background: 'rgba(0,0,0,0.65)', zIndex: 60, color: 'white',
          fontSize: '24px', flexDirection: 'column', gap: '16px',
          backdropFilter: 'blur(4px)'
        }}>
          <div style={{ fontSize: 48 }}>✨</div>
          <div>Polishing your sketch…</div>
        </div>
      )}
    </div>
  )
})

export default FacePaintCanvas;