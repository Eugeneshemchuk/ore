import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { Component, useMemo, useRef, useState, useEffect, type CSSProperties, type ReactNode, type RefObject } from 'react'
import * as THREE from 'three'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { Soundscape } from './sound'

// Alien runes plus half-width katakana (mirrored at draw time, as in the film) for the digital rain atlas.
const RUNES = [...'ᚫϟ⊹ᛟ⌁⋔ᚢϞ⊙ᚨ⌇⟐ᛉ∴']
const KATAKANA = [...'ﾊﾐﾋｰｳｼﾅﾓﾆｻﾜﾂｵﾘｱﾎﾃﾏｹﾒｴｶｷﾑﾕﾗｾﾈｽﾀﾇﾍ']
const ATLAS_COLUMNS = 8
const RAIN_CELL_PX = window.innerWidth < 720 ? 15 : 19

// Scene progress across the four chapters, rewinding to 0 while the looped
// copy of Signal scrolls in. The page repeats every loop period.
function rawChapterPhase() {
  const start = document.getElementById('signal')?.offsetTop ?? 0
  const voidScene = (document.getElementById('void')?.offsetTop ?? 0) - start
  const mind = (document.getElementById('mind')?.offsetTop ?? 0) - start
  const potential = (document.getElementById('potential')?.offsetTop ?? 0) - start
  const period = Math.max(1, (document.getElementById('loop')?.offsetTop ?? 0) - start)
  const y = (((window.scrollY - start) % period) + period) % period
  if (y < voidScene) return y / Math.max(1, voidScene)
  if (y < mind) return 1 + (y - voidScene) / Math.max(1, mind - voidScene)
  if (y < potential) return 2 + (y - mind) / Math.max(1, potential - mind)
  return 3 + (y - potential) / Math.max(1, period - potential)
}

// A single eased timeline keeps all WebGL layers in step, including at the loop seam.
let visualPhase: number | null = null
function chapterPhase() {
  return visualPhase ?? rawChapterPhase()
}

function ScrollMotion({ reducedMotion }: { reducedMotion: boolean }) {
  const speed = useRef(0)
  const lastBlur = useRef(-1)
  const shell = useRef<HTMLElement | null>(null)
  const blurDevice = useMemo(() => window.matchMedia('(min-width: 721px) and (hover: hover) and (pointer: fine)'), [])
  const mobile = useMemo(() => window.matchMedia('(max-width: 720px)'), [])
  useEffect(() => {
    visualPhase = rawChapterPhase()
    shell.current = document.querySelector<HTMLElement>('.webgl-shell')
    return () => {
      visualPhase = null
      if (shell.current) shell.current.style.filter = ''
    }
  }, [reducedMotion])
  useFrame((_, delta) => {
    const target = rawChapterPhase()
    const dt = Math.min(delta, 0.1)
    const current = visualPhase ?? target
    // Choose the shortest path across the 0/4 boundary instead of rotating through all chapters.
    const difference = ((target - current + 6) % 4) - 2
    const next = reducedMotion ? target : current + difference * (1 - Math.exp(-dt * (mobile.matches ? 7 : 12)))
    visualPhase = (next + 4) % 4

    // A small velocity-driven softening suggests motion without blurring text or burdening mobile GPUs.
    if (!shell.current) return
    const allowBlur = !reducedMotion && blurDevice.matches
    const targetSpeed = allowBlur && dt > 0 ? Math.min(1, Math.abs(difference) / dt * 0.035) : 0
    speed.current += (targetSpeed - speed.current) * (1 - Math.exp(-dt * 9))
    const blur = speed.current < 0.02 ? 0 : Math.round(speed.current * 8) / 10
    if (blur !== lastBlur.current) {
      shell.current.style.filter = blur ? `blur(${blur}px)` : ''
      lastBlur.current = blur
    }
  }, -100)
  return null
}

// A tiny ping-pong post pass keeps only the cursor's local render history.
// It gives a moving particle field a soft afterimage without blurring type,
// the static scene, or the glyph-rain opening.
function MaskedInteractionTrails({ motion, reducedMotion }: { motion: RefObject<SwarmMotion>; reducedMotion: boolean }) {
  const { gl, scene, camera, size } = useThree()
  const targets = useRef<{ read: THREE.WebGLRenderTarget; write: THREE.WebGLRenderTarget; current: THREE.WebGLRenderTarget } | null>(null)
  const trailStrength = useRef(0)
  const screenScene = useMemo(() => new THREE.Scene(), [])
  const screenCamera = useMemo(() => new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1), [])
  const geometry = useMemo(() => new THREE.PlaneGeometry(2, 2), [])
  const composite = useMemo(() => new THREE.ShaderMaterial({
    uniforms: {
      tCurrent: { value: null }, tHistory: { value: null },
      uPointer: { value: new THREE.Vector2(9, 9) }, uAspect: { value: 1 }, uMask: { value: 0 }, uPotential: { value: 0 },
    },
    vertexShader: /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D tCurrent, tHistory;
      uniform vec2 uPointer;
      uniform float uAspect, uMask, uPotential;
      varying vec2 vUv;
      void main() {
        vec4 current = texture2D(tCurrent, vUv);
        vec4 history = texture2D(tHistory, vUv);
        vec2 pointerUv = uPointer * 0.5 + 0.5;
        vec2 cursorOffset = vUv - pointerUv;
        float distanceToPointer = length(cursorOffset * vec2(uAspect, 1.0));
        // Potential gets a compact, portrait-shaped cursor window: narrower
        // across than it is tall, instead of the earlier circular bloom.
        float potentialDistance = length(cursorOffset * vec2(uAspect / 0.58, 1.0 / 1.32));
        float roundMask = 1.0 - smoothstep(0.055, 0.31, distanceToPointer);
        float potentialMask = 1.0 - smoothstep(0.034, 0.17, potentialDistance);
        float mask = mix(roundMask, potentialMask, uPotential) * uMask;
        // The alpha channel stores the decaying interaction mask. It allows
        // earlier cursor positions to leave a short trail, not a full frame blur.
        float historyMask = history.a * 0.84;
        // Store only the masked interaction contribution. The unmodified
        // scene renders straight to screen, preserving its normal color path.
        vec3 color = current.rgb * mask + history.rgb * historyMask * 0.64;
        gl_FragColor = vec4(color, max(mask, historyMask));
      }`,
    depthTest: false,
    depthWrite: false,
  }), [])
  const overlay = useMemo(() => new THREE.ShaderMaterial({
    uniforms: { tTrail: { value: null } },
    vertexShader: /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D tTrail;
      varying vec2 vUv;
      void main() {
        vec4 trail = texture2D(tTrail, vUv);
        gl_FragColor = vec4(trail.rgb * 0.46, trail.a * 0.56);
      }`,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthTest: false,
    depthWrite: false,
  }), [])
  const quad = useMemo(() => new THREE.Mesh<THREE.PlaneGeometry, THREE.Material>(geometry, composite), [composite, geometry])

  useEffect(() => {
    screenScene.add(quad)
    return () => { screenScene.remove(quad) }
  }, [quad, screenScene])
  useEffect(() => () => {
    targets.current?.read.dispose()
    targets.current?.write.dispose()
    targets.current?.current.dispose()
    geometry.dispose()
    composite.dispose()
    overlay.dispose()
  }, [composite, geometry, overlay])
  useEffect(() => {
    const width = Math.max(1, Math.floor(size.width * gl.getPixelRatio()))
    const height = Math.max(1, Math.floor(size.height * gl.getPixelRatio()))
    targets.current?.read.dispose()
    targets.current?.write.dispose()
    targets.current?.current.dispose()
    targets.current = {
      read: new THREE.WebGLRenderTarget(width, height, { depthBuffer: false }),
      write: new THREE.WebGLRenderTarget(width, height, { depthBuffer: false }),
      current: new THREE.WebGLRenderTarget(width, height, { depthBuffer: false }),
    }
    return () => {
      targets.current?.read.dispose()
      targets.current?.write.dispose()
      targets.current?.current.dispose()
      targets.current = null
    }
  }, [gl, size.height, size.width])

  useFrame((_, delta) => {
    const currentTargets = targets.current
    const phase = chapterPhase()
    const supported = !reducedMotion && size.width >= 721 && currentTargets
    if (!supported) {
      gl.setRenderTarget(null)
      gl.render(scene, camera)
      return
    }
    const dt = Math.min(delta, 0.1)
    const active = motion.current.active && phase > 0.96 && phase < 3.9
    const desired = active ? 0.6 + motion.current.energy * 0.4 : 0
    trailStrength.current = THREE.MathUtils.lerp(trailStrength.current, desired, 1 - Math.exp(-dt * 7))

    // The direct render retains exactly the same ACES/tone-mapping and
    // color-space route as the unprocessed canvas.
    gl.setRenderTarget(null)
    gl.render(scene, camera)

    gl.setRenderTarget(currentTargets.current)
    gl.clear()
    gl.render(scene, camera)

    composite.uniforms.tCurrent.value = currentTargets.current.texture
    composite.uniforms.tHistory.value = currentTargets.read.texture
    composite.uniforms.uPointer.value.copy(motion.current.pointer)
    composite.uniforms.uAspect.value = size.width / Math.max(size.height, 1)
    composite.uniforms.uMask.value = trailStrength.current
    composite.uniforms.uPotential.value = phase > 2.72 && phase < 3.56 ? 1 : 0
    gl.setRenderTarget(currentTargets.write)
    gl.clear()
    gl.render(screenScene, screenCamera)

    overlay.uniforms.tTrail.value = currentTargets.write.texture
    quad.material = overlay
    gl.setRenderTarget(null)
    gl.render(screenScene, screenCamera)
    quad.material = composite

    const swap = currentTargets.read
    currentTargets.read = currentTargets.write
    currentTargets.write = swap
  }, 1)
  return null
}

function loopProgress() {
  const phase = chapterPhase()
  return phase <= 3 ? phase / 3 : 4 - phase
}

// The same bridge runs backwards at the loop seam, connecting signal directly to crystal.
function signalDeparture(phase: number) {
  return phase < 1 ? phase : phase > 3 ? 4 - phase : 1
}

const rainVertexShader = /* glsl */ `
  uniform vec2 uCells;
  uniform float uFocusTime;
  varying vec2 vUv;
  varying vec2 vFocus;
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  void main() {
    vUv = uv;
    // Find a real, visible drop head near the centre. Compute this only at the
    // plane's vertices, using the exact same hash and timing as the rain shader.
    float best = 1000.0;
    vFocus = vec2(0.6, 0.5);
    for (int i = -12; i <= 12; i++) {
      float column = floor(uCells.x * 0.6) + float(i);
      for (int j = 0; j < 2; j++) {
        float salt = float(j) * 41.0;
        float speed = 7.0 + hash(vec2(column, salt)) * 13.0;
        float trail = 8.0 + hash(vec2(column, salt + 7.0)) * 22.0;
        float period = uCells.y + trail + hash(vec2(column, salt + 3.0)) * uCells.y;
        float head = floor(mod(uFocusTime * speed + hash(vec2(column, salt + 1.0)) * period, period));
        vec2 candidate = vec2((column + 0.5) / uCells.x, 1.0 - (head + 0.5) / uCells.y);
        float distanceToCenter = length((candidate - vec2(0.6, 0.5)) * vec2(1.0, 1.2));
        if (candidate.x > 0.1 && candidate.x < 0.9 && candidate.y > 0.15 && candidate.y < 0.85 && distanceToCenter < best) {
          best = distanceToCenter;
          vFocus = candidate;
        }
      }
    }
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`

// Each column carries two independent drops; a drop is a bright leading glyph trailing a fading tail of decaying symbols.
const rainFragmentShader = /* glsl */ `
  uniform sampler2D uAtlas;
  uniform vec2 uAtlasGrid;
  uniform float uGlyphCount;
  uniform vec2 uCells;
  uniform float uTime;
  uniform float uOpacity;
  uniform float uZoom;
  uniform float uPixelation;
  uniform float uDissolve;
  uniform vec2 uPointer;
  varying vec2 vUv;
  varying vec2 vFocus;

  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

  // Returns distance (in rows) behind the drop's head, or -1 when this cell is outside the drop.
  float drop(float column, float row, float salt, float rows) {
    float speed = 7.0 + hash(vec2(column, salt)) * 13.0;
    float trail = 8.0 + hash(vec2(column, salt + 7.0)) * 22.0;
    float period = rows + trail + hash(vec2(column, salt + 3.0)) * rows;
    float head = floor(mod(uTime * speed + hash(vec2(column, salt + 1.0)) * period, period));
    float behind = head - row;
    return behind >= 0.0 && behind < trail ? behind / trail : -1.0;
  }

  void main() {
    vec2 rainUv = (vUv - vFocus) / uZoom + vFocus;
    vec2 activeCells = uCells;
    vec2 grid = rainUv * activeCells;
    vec2 cell = floor(grid);
    vec2 local = fract(grid);
    float row = activeCells.y - 1.0 - cell.y;

    float a = drop(cell.x, row, 0.0, activeCells.y);
    float b = drop(cell.x, row, 41.0, activeCells.y);
    float t = a < 0.0 ? b : (b < 0.0 ? a : min(a, b));

    float near = smoothstep(0.22, 0.0, length((vUv - uPointer) * vec2(uCells.x / uCells.y, 1.0)));
    if (t < 0.0 && near < 0.01) discard;

    // Symbols mutate, faster near the head of a drop.
    float rate = mix(9.0, 1.2, clamp(t, 0.0, 1.0)) * (0.4 + hash(cell));
    float glyph = floor(hash(cell + floor(uTime * rate) * 0.137) * uGlyphCount);
    vec2 atlasCell = vec2(mod(glyph, uAtlasGrid.x), floor(glyph / uAtlasGrid.x));
    vec2 pixelLocal = (floor(local * 24.0) + 0.5) / 24.0;
    vec2 sampledLocal = mix(local, pixelLocal, uPixelation);
    vec2 atlasUv = (atlasCell + vec2(sampledLocal.x, 1.0 - sampledLocal.y)) / uAtlasGrid;
    vec2 gradient = rainUv * activeCells / uAtlasGrid;
    float ink = textureGrad(uAtlas, vec2(atlasUv.x, 1.0 - atlasUv.y), dFdx(gradient), dFdy(gradient)).a;

    float leader = t >= 0.0 ? step(t, 0.02) : 0.0;
    float tail = t >= 0.0 ? pow(1.0 - t, 1.6) : 0.0;
    vec3 orange = vec3(1.0, 0.24, 0.025);
    vec3 color = orange * tail * 0.85 + vec3(1.0, 0.68, 0.34) * leader * 1.4 + orange * near * 0.35;
    float glow = exp(-dot(local - 0.5, local - 0.5) * 9.0) * leader * 0.18 * (1.0 - uPixelation);
    vec2 pixelEdge = abs(fract(local * 24.0) - 0.5);
    float block = 1.0 - smoothstep(0.4, 0.5, max(pixelEdge.x, pixelEdge.y));
    ink *= mix(1.0, block, uPixelation);
    // Let the enlarged pixels dissolve at slightly different moments, instead
    // of cutting the entire glyph away as the network appears behind it.
    float pixelSeed = hash(cell * 31.0 + floor(local * 24.0));
    float dissolve = smoothstep(uDissolve - 0.16, uDissolve + 0.16, pixelSeed);
    ink *= mix(1.0, dissolve, smoothstep(0.0, 0.15, uDissolve));
    gl_FragColor = vec4(color * ink + orange * glow, 1.0) * uOpacity;
  }
`

const oreVertexShader = /* glsl */ `
  varying vec3 vObjectPosition;
  varying vec3 vWorldPosition;
  varying vec3 vWorldNormal;
  void main() {
    vObjectPosition = position;
    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
    vWorldPosition = worldPosition.xyz;
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * worldPosition;
  }
`

const oreFragmentShader = /* glsl */ `
  uniform float uTime;
  uniform float uOpacity;
  varying vec3 vObjectPosition;
  varying vec3 vWorldPosition;
  varying vec3 vWorldNormal;

  float hash(vec3 p) { p = fract(p * .3183099 + .1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
  float noise(vec3 x) {
    vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x), mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y), mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x), mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
  }
  float fbm(vec3 p) { float f = 0.0; f += noise(p) * .55; p *= 2.03; f += noise(p) * .28; p *= 2.01; f += noise(p) * .12; return f; }
  void main() {
    float mineral = fbm(vObjectPosition * 4.6);
    float strata = sin(vObjectPosition.x * 15.0 + vObjectPosition.z * 12.0 + mineral * 13.0);
    float vein = smoothstep(.88, .985, abs(strata)) * smoothstep(.44, .68, mineral);
    vec3 darkRock = vec3(.055, .067, .061);
    vec3 paleRock = vec3(.33, .38, .34);
    vec3 gold = vec3(.77, .54, .20);
    vec3 color = mix(darkRock, paleRock, mineral * .82);
    color = mix(color, gold, vein * (.78 + sin(uTime * 1.3 + vObjectPosition.y * 7.0) * .12));
    vec3 viewDirection = normalize(cameraPosition - vWorldPosition);
    float fresnel = pow(1.0 - max(dot(normalize(vWorldNormal), viewDirection), 0.0), 2.6);
    color += fresnel * vec3(.18, .22, .20);
    gl_FragColor = vec4(color, uOpacity);
  }
`

function glyphAtlas() {
  const glyphs = [...RUNES, ...KATAKANA]
  const size = 64
  const rows = Math.ceil(glyphs.length / ATLAS_COLUMNS)
  const canvas = document.createElement('canvas')
  canvas.width = ATLAS_COLUMNS * size
  canvas.height = rows * size
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#fff'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.font = `${size * 0.72}px "Apple Symbols", "Segoe UI Historic", "Noto Sans Runic", "Hiragino Sans", "MS Gothic", monospace`
  glyphs.forEach((glyph, i) => {
    const x = (i % ATLAS_COLUMNS) * size + size / 2
    const y = Math.floor(i / ATLAS_COLUMNS) * size + size / 2
    ctx.save()
    ctx.translate(x, y)
    if (i >= RUNES.length) ctx.scale(-1, 1)
    ctx.fillText(glyph, 0, 0)
    ctx.restore()
  })
  const texture = new THREE.CanvasTexture(canvas)
  texture.anisotropy = 4
  return { texture, grid: new THREE.Vector2(ATLAS_COLUMNS, rows), count: glyphs.length }
}

function DigitalRain({ reducedMotion }: { reducedMotion: boolean }) {
  const material = useRef<THREE.ShaderMaterial>(null)
  const pointer = useRef(new THREE.Vector2(9, 9))
  const cursorTarget = useRef(new THREE.Vector2())
  const focusTime = useRef<number | null>(null)
  const { size, pointer: cursor } = useThree()
  const atlas = useMemo(glyphAtlas, [])
  const columns = Math.max(1, Math.round(size.width / RAIN_CELL_PX))
  const cells = useMemo(() => new THREE.Vector2(columns, Math.max(1, Math.round(columns * size.height / size.width / 1.3))), [columns, size.width, size.height])
  const uniforms = useMemo(() => ({
    uAtlas: { value: atlas.texture },
    uAtlasGrid: { value: atlas.grid },
    uGlyphCount: { value: atlas.count },
    uCells: { value: new THREE.Vector2() },
    uTime: { value: 0 },
    uFocusTime: { value: 0 },
    uOpacity: { value: 1 },
    uZoom: { value: 1 },
    uPixelation: { value: 0 },
    uDissolve: { value: 0 },
    uPointer: { value: new THREE.Vector2(9, 9) },
  }), [atlas])
  useEffect(() => () => atlas.texture.dispose(), [atlas])

  useFrame(({ clock }) => {
    if (!material.current) return
    const departure = signalDeparture(chapterPhase())
    const visible = 1 - THREE.MathUtils.smoothstep(departure, reducedMotion ? 0.35 : 0.68, reducedMotion ? 0.65 : 0.97)
    const time = clock.getElapsedTime()
    // Lock only the location chosen at the start of the move; the rain itself
    // keeps evolving, even if that area becomes empty while we zoom through it.
    if (!reducedMotion && departure > 0.04 && departure < 0.98) {
      if (focusTime.current === null) focusTime.current = time
    } else {
      focusTime.current = null
    }
    pointer.current.lerp(cursorTarget.current.set(cursor.x / 2 + 0.5, cursor.y / 2 + 0.5), 0.08)
    // The material holds its own copy of the uniforms, so write through it rather than the memoized object.
    const live = material.current.uniforms
    live.uTime.value = time
    live.uFocusTime.value = focusTime.current ?? time
    live.uOpacity.value = visible * 0.82
    live.uZoom.value = reducedMotion ? 1 : 1 + Math.pow(THREE.MathUtils.smoothstep(departure, 0.04, 0.94), 2) * 120
    live.uPixelation.value = reducedMotion ? 0 : THREE.MathUtils.smoothstep(departure, 0.42, 0.72)
    live.uDissolve.value = reducedMotion ? 0 : THREE.MathUtils.smoothstep(departure, 0.55, 0.97)
    live.uCells.value.copy(cells)
    live.uPointer.value.copy(pointer.current)
    material.current.visible = visible > 0.001
  })

  return <mesh renderOrder={100} frustumCulled={false}>
    <planeGeometry args={[2, 2]} />
    <shaderMaterial ref={material} transparent depthTest={false} depthWrite={false} blending={THREE.AdditiveBlending} uniforms={uniforms} vertexShader={rainVertexShader} fragmentShader={rainFragmentShader} />
  </mesh>
}

const NEURON_ANCHOR = new THREE.Vector3(0, 0, 0.9)

type RepulsionUniforms = {
  uRepelPointer: { value: THREE.Vector2 }
  uRepelAspect: { value: number }
  uRepelStrength: { value: number }
  uMindGlow: { value: number }
}

// Work in screen space so particles at different depths all respond around the
// cursor. Applying the same displacement to link endpoints keeps them attached.
function configureRepulsion(shader: THREE.WebGLProgramParametersWithUniforms, uniforms: RepulsionUniforms) {
  Object.assign(shader.uniforms, uniforms)
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>
      uniform vec2 uRepelPointer;
      uniform float uRepelAspect;
      uniform float uRepelStrength;
      uniform float uMindGlow;
      varying float vMindGlow;`)
    .replace('#include <project_vertex>', `#include <project_vertex>
      if (gl_Position.w > 0.0) {
        vec2 screen = gl_Position.xy / gl_Position.w;
        vec2 delta = (screen - uRepelPointer) * vec2(uRepelAspect, 1.0);
        float distanceToPointer = length(delta);
        float influence = 1.0 - smoothstep(0.0, 0.28, distanceToPointer);
        vMindGlow = influence * uMindGlow;
        vec2 direction = delta / max(distanceToPointer, 0.001);
        gl_Position.xy += direction / vec2(uRepelAspect, 1.0)
          * influence * 0.16 * uRepelStrength * gl_Position.w;
      }`)
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>
      varying float vMindGlow;`)
    .replace('#include <output_fragment>', `#include <output_fragment>
      gl_FragColor.rgb *= 1.0 + vMindGlow * 0.05;`)
}

function RepulsionController({ uniforms, reducedMotion }: { uniforms: RepulsionUniforms; reducedMotion: boolean }) {
  const target = useRef(new THREE.Vector2(0, 0))
  const active = useRef(false)
  const { size } = useThree()
  useEffect(() => {
    const move = (event: PointerEvent) => {
      if (event.pointerType === 'touch') { active.current = false; return }
      target.current.set(event.clientX / window.innerWidth * 2 - 1, 1 - event.clientY / window.innerHeight * 2)
      active.current = true
    }
    const leave = (event: PointerEvent) => { if (!event.relatedTarget) active.current = false }
    const blur = () => { active.current = false }
    window.addEventListener('pointermove', move, { passive: true })
    window.addEventListener('pointerout', leave)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerout', leave)
      window.removeEventListener('blur', blur)
    }
  }, [])
  useFrame((_, delta) => {
    const damping = 1 - Math.exp(-Math.min(delta, 0.1) * 9)
    uniforms.uRepelPointer.value.lerp(target.current, damping)
    uniforms.uRepelAspect.value = size.width / Math.max(1, size.height)
    const phase = chapterPhase()
    const mindChapter = phase > 1.98 && phase < 2.96
    const sceneStrength = THREE.MathUtils.smoothstep(signalDeparture(phase), 0.65, 0.95)
    // Mind responds as a soft local illumination, not a force that creates a
    // black-hole-like gap in the neural field.
    const desired = active.current && !reducedMotion && !mindChapter ? sceneStrength : 0
    uniforms.uRepelStrength.value = THREE.MathUtils.lerp(uniforms.uRepelStrength.value, desired, damping)
    uniforms.uMindGlow.value = THREE.MathUtils.lerp(uniforms.uMindGlow.value, active.current && !reducedMotion && mindChapter ? 1 : 0, damping)
  })
  return null
}

function NeuralNetwork({ group, repulsion, reducedMotion }: { group: RefObject<THREE.Group | null>; repulsion: RepulsionUniforms; reducedMotion: boolean }) {
  const nodeMaterial = useRef<THREE.PointsMaterial>(null)
  const lineMaterial = useRef<THREE.LineBasicMaterial>(null)
  const [addedNodes, setAddedNodes] = useState<THREE.Vector3[]>([])
  const { camera } = useThree()
  const raycaster = useMemo(() => new THREE.Raycaster(), [])
  const clickPlane = useMemo(() => new THREE.Plane(), [])
  const clickPoint = useMemo(() => new THREE.Vector3(), [])
  const previousFold = useRef<number | null>(null)
  const drag = useRef({ active: false, x: 0, y: 0, moved: false })
  const userRotation = useRef(new THREE.Vector2())
  const rotationVelocity = useRef(new THREE.Vector2())
  const networkEmber = useMemo(() => new THREE.Color('#67d7ff'), [])
  const networkLine = useMemo(() => new THREE.Color('#4ea9ff'), [])
  const mineralLight = useMemo(() => new THREE.Color('#c8e4ed'), [])
  const repelShader = useMemo(() => (shader: THREE.WebGLProgramParametersWithUniforms) => configureRepulsion(shader, repulsion), [repulsion])
  const nodeTexture = useMemo(() => {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 64
    const ctx = canvas.getContext('2d')!
    const glow = ctx.createRadialGradient(32, 32, 1, 32, 32, 32)
    glow.addColorStop(0, 'rgba(255,255,255,1)')
    glow.addColorStop(0.22, 'rgba(255,255,255,0.95)')
    glow.addColorStop(0.55, 'rgba(255,255,255,0.25)')
    glow.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = glow
    ctx.fillRect(0, 0, 64, 64)
    return new THREE.CanvasTexture(canvas)
  }, [])
  useEffect(() => () => nodeTexture.dispose(), [nodeTexture])
  const { nodes, links, original, folded, edges } = useMemo(() => {
    const positions: THREE.Vector3[] = [NEURON_ANCHOR.clone()]
    const seed = (index: number) => {
      // A broad cerebral silhouette: two asymmetric hemispheres, a clear
      // central fissure and a shallow, living depth. It borrows the reference
      // image's branching brain mass rather than reading as a round graph.
      const lobeIndex = Math.floor(index / 2)
      const side = index % 2 === 0 ? -1 : 1
      const angle = lobeIndex * 2.3999632297
      const radius = Math.sqrt(lobeIndex / 180)
      const crown = 0.82 + Math.sin(angle * 1.7) * 0.18
      const lobeWidth = 0.24 + radius * (1.26 + Math.sin(lobeIndex * 2.7) * 0.13)
      return new THREE.Vector3(
        side * lobeWidth * crown,
        Math.sin(angle) * radius * 1.16 + (1 - radius) * 0.24,
        Math.cos(angle * 1.43) * radius * 0.76 + Math.sin(lobeIndex * 17.1) * 0.12,
      )
    }
    // Keep both hemispheres so the field can sit in the mask's crown as a
    // recognisable neural brain, rather than reading as a graph beside it.
    for (let i = 0; i < 420; i += 1) positions.push(seed(i))
    const originalCount = positions.length
    positions.push(...addedNodes)
    const linkData: number[] = []
    const edgeData: number[] = []
    positions.forEach((from, i) => {
      const candidates = positions
        .map((to, j) => ({ j, d: from.distanceToSquared(to) }))
        .filter(({ j, d }) => j > i && d < 1.75)
        .sort((a, b) => a.d - b.d)
        .slice(0, 3)
      candidates.forEach(({ j }) => { edgeData.push(i, j); linkData.push(from.x, from.y, from.z, positions[j].x, positions[j].y, positions[j].z) })
    })
    // Visitor-created nodes integrate into the existing graph rather than
    // floating independently after a click.
    for (let i = originalCount; i < positions.length; i += 1) {
      positions.slice(0, i).map((to, j) => ({ j, d: positions[i].distanceToSquared(to) }))
        .sort((a, b) => a.d - b.d).slice(0, 3).forEach(({ j }) => {
          edgeData.push(i, j)
          linkData.push(positions[i].x, positions[i].y, positions[i].z, positions[j].x, positions[j].y, positions[j].z)
        })
    }
    // The camera target is an ordinary node, sharing the same material and size.
    const nodeGeometry = new THREE.BufferGeometry().setFromPoints(positions)
    const linkGeometry = new THREE.BufferGeometry()
    linkGeometry.setAttribute('position', new THREE.Float32BufferAttribute(linkData, 3))
    const targets = positions.map((p, i) => {
      const direction = p.clone().add(new THREE.Vector3(0.001, 0.002, 0.003)).normalize()
      // Fill the irregular rock volume while keeping enough nodes near its surface to read the silhouette.
      const depth = 0.55 + ((i * 73) % 100) / 100 * 0.45
      return direction.multiplyScalar(rockRadius(direction) * depth)
    })
    return { nodes: nodeGeometry, links: linkGeometry, original: positions, folded: targets, edges: edgeData }
  }, [addedNodes])

  useEffect(() => {
    const beginDrag = (event: PointerEvent) => {
      const phase = chapterPhase()
      if (event.pointerType === 'touch' || event.button !== 0 || phase < 1.94 || phase > 2.78
        || (event.target instanceof Element && event.target.closest('a, button, input, select, textarea'))) return
      drag.current = { active: true, x: event.clientX, y: event.clientY, moved: false }
      rotationVelocity.current.set(0, 0)
      document.body.style.cursor = 'grabbing'
    }
    const dragNetwork = (event: PointerEvent) => {
      if (!drag.current.active) return
      const dx = event.clientX - drag.current.x
      const dy = event.clientY - drag.current.y
      if (Math.hypot(dx, dy) > 3) drag.current.moved = true
      drag.current.x = event.clientX
      drag.current.y = event.clientY
      userRotation.current.y += dx * 0.006
      userRotation.current.x = THREE.MathUtils.clamp(userRotation.current.x + dy * 0.005, -0.62, 0.62)
      rotationVelocity.current.set(dy * 0.005, dx * 0.006)
    }
    const endDrag = (event: PointerEvent) => {
      if (!drag.current.active) return
      const networkGroup = group.current
      const shouldAddNode = !drag.current.moved && event.pointerType !== 'touch' && networkGroup
      if (shouldAddNode && networkGroup) {
        raycaster.setFromCamera(new THREE.Vector2(event.clientX / window.innerWidth * 2 - 1, 1 - event.clientY / window.innerHeight * 2), camera)
        networkGroup.getWorldPosition(clickPoint)
        clickPlane.setFromNormalAndCoplanarPoint(camera.getWorldDirection(new THREE.Vector3()), clickPoint)
        const hit = raycaster.ray.intersectPlane(clickPlane, new THREE.Vector3())
        if (hit) {
          networkGroup.worldToLocal(hit)
          setAddedNodes(previous => [...previous.slice(-79), hit])
        }
      }
      drag.current.active = false
      document.body.style.cursor = ''
    }
    const cancelDrag = () => {
      if (!drag.current.active) return
      drag.current.active = false
      document.body.style.cursor = ''
    }
    window.addEventListener('pointerdown', beginDrag)
    window.addEventListener('pointermove', dragNetwork, { passive: true })
    window.addEventListener('pointerup', endDrag)
    window.addEventListener('pointercancel', endDrag)
    window.addEventListener('blur', cancelDrag)
    return () => {
      window.removeEventListener('pointerdown', beginDrag)
      window.removeEventListener('pointermove', dragNetwork)
      window.removeEventListener('pointerup', endDrag)
      window.removeEventListener('pointercancel', endDrag)
      window.removeEventListener('blur', cancelDrag)
      if (drag.current.active) document.body.style.cursor = ''
    }
  }, [camera, clickPlane, clickPoint, group, raycaster])
  useEffect(() => {
    previousFold.current = null
    return () => { nodes.dispose(); links.dispose() }
  }, [nodes, links])

  useFrame(({ clock }, delta) => {
    const phase = chapterPhase()
    // The mind rises out of the crown before the camera enters it. It fades
    // behind the viewer after the flythrough instead of folding into the ore.
    const fold = 0
    const arrival = THREE.MathUtils.smoothstep(phase, 1.46, 2.12)
    const nodeVisibility = arrival * (1 - THREE.MathUtils.smoothstep(phase, 2.94, 3.16))
    const lineVisibility = arrival * (1 - THREE.MathUtils.smoothstep(phase, 2.86, 3.06))
    if (group.current) {
      // Reset every Euler component before blending: the previous frame's
      // slerp can otherwise leak its Z rotation back into the next frame.
      const maskTurn = reducedMotion ? 0 : THREE.MathUtils.smoothstep(phase, 1.54, 2.28) * Math.PI
      // Anchor the network inside the upper headpiece, behind the face's
      // particle relief. It inherits the mask's turn, so the reveal reads as
      // a mind contained by the mask instead of a second object beside it.
      if (!drag.current.active) {
        userRotation.current.add(rotationVelocity.current)
        rotationVelocity.current.multiplyScalar(Math.exp(-Math.min(delta, 0.1) * 4.8))
      }
      userRotation.current.x = THREE.MathUtils.clamp(userRotation.current.x, -0.62, 0.62)
      group.current.rotation.set(
        userRotation.current.x + Math.sin(clock.getElapsedTime() * 0.11) * 0.035,
        maskTurn * 0.92 + userRotation.current.y + clock.getElapsedTime() * 0.014,
        0,
      )
      group.current.scale.setScalar(1.02 + arrival * 0.1)
      group.current.position.set(0, 1.62, -4.68)
    }
    const nodePositions = nodes.getAttribute('position') as THREE.BufferAttribute
    const linkPositions = links.getAttribute('position') as THREE.BufferAttribute
    if (previousFold.current !== fold) {
      original.forEach((p, i) => {
        const target = folded[i]
        nodePositions.setXYZ(i, THREE.MathUtils.lerp(p.x, target.x, fold), THREE.MathUtils.lerp(p.y, target.y, fold), THREE.MathUtils.lerp(p.z, target.z, fold))
      })
      edges.forEach((node, i) => linkPositions.setXYZ(i, nodePositions.getX(node), nodePositions.getY(node), nodePositions.getZ(node)))
      nodePositions.needsUpdate = true
      linkPositions.needsUpdate = true
      previousFold.current = fold
    }
    if (nodeMaterial.current) {
      nodeMaterial.current.opacity = nodeVisibility * 0.9
      nodeMaterial.current.size = 0.055 + Math.sin(clock.getElapsedTime() * 2.1) * 0.007
      nodeMaterial.current.color.lerpColors(networkEmber, mineralLight, THREE.MathUtils.smoothstep(fold, 0.18, 0.72))
    }
    if (lineMaterial.current) {
      lineMaterial.current.opacity = lineVisibility * 0.48
      lineMaterial.current.color.lerpColors(networkLine, mineralLight, THREE.MathUtils.smoothstep(fold, 0.08, 0.54))
    }
  })

  return <group ref={group} position={[0, 1.62, -4.68]}>
    <lineSegments geometry={links} frustumCulled={false}>
      <lineBasicMaterial ref={lineMaterial} color="#4ea9ff" transparent opacity={0} depthWrite={false} onBeforeCompile={repelShader} />
    </lineSegments>
    <points geometry={nodes} frustumCulled={false}>
      <pointsMaterial ref={nodeMaterial} map={nodeTexture} color="#67d7ff" transparent opacity={0} size={0.055} sizeAttenuation depthWrite={false} blending={THREE.AdditiveBlending} onBeforeCompile={repelShader} />
    </points>
  </group>
}

function CosmicParticles({ repulsion }: { repulsion: RepulsionUniforms }) {
  const mobile = useThree((state) => state.size.width < 720)
  const field = useRef<THREE.Points>(null)
  const material = useRef<THREE.PointsMaterial>(null)
  const mindField = useRef<THREE.Points>(null)
  const mindMaterial = useRef<THREE.PointsMaterial>(null)
  // The camera flies through this dust, so cap each point's size and draw it
  // as a disc; otherwise nearby specks swell into flat grey squares.
  const dustShader = useMemo(() => (shader: THREE.WebGLProgramParametersWithUniforms) => {
    configureRepulsion(shader, repulsion)
    shader.vertexShader = shader.vertexShader.replace('#include <fog_vertex>', `#include <fog_vertex>
      gl_PointSize = min(gl_PointSize, 4.5);`)
    shader.fragmentShader = shader.fragmentShader.replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
      if (length(gl_PointCoord - 0.5) > 0.5) discard;`)
  }, [repulsion])
  const geometry = useMemo(() => {
    const positions = new Float32Array(620 * 3)
    for (let i = 0; i < 620; i += 1) {
      const i3 = i * 3
      positions[i3] = (Math.random() - 0.5) * 15
      positions[i3 + 1] = (Math.random() - 0.5) * 9
      positions[i3 + 2] = -2 - Math.random() * 8
    }
    const result = new THREE.BufferGeometry()
    result.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    return result
  }, [])
  const mindGeometry = useMemo(() => {
    const count = mobile ? 600 : 1875
    const positions = new Float32Array(count * 3)
    for (let i = 0; i < count; i += 1) {
      positions[i * 3] = (Math.random() - 0.5) * 15
      positions[i * 3 + 1] = (Math.random() - 0.5) * 9
      positions[i * 3 + 2] = -2 - Math.random() * 8
    }
    const result = new THREE.BufferGeometry()
    result.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    return result
  }, [mobile])
  useEffect(() => () => geometry.dispose(), [geometry])
  useEffect(() => () => mindGeometry.dispose(), [mindGeometry])
  useFrame(({ clock }) => {
    const p = loopProgress()
    if (field.current) {
      field.current.rotation.y = clock.getElapsedTime() * 0.012
      field.current.rotation.z = Math.sin(clock.getElapsedTime() * 0.07) * 0.03
      if (mindField.current) mindField.current.rotation.copy(field.current.rotation)
    }
    const phase = chapterPhase()
    const networkMask = 1 - THREE.MathUtils.smoothstep(phase, 1.55, 1.9) * (1 - THREE.MathUtils.smoothstep(phase, 2.9, 3.12))
    if (material.current) material.current.opacity = (0.14 + THREE.MathUtils.smoothstep(p, 0.52, 0.88) * 0.42) * networkMask
    if (mindMaterial.current) mindMaterial.current.opacity = 0.42 * THREE.MathUtils.smoothstep(phase, 1.55, 1.9) * (1 - THREE.MathUtils.smoothstep(phase, 2.9, 3.12))
  })
  return <>
    <points ref={field} geometry={geometry}>
      <pointsMaterial ref={material} color="#d7e2e2" size={0.024} sizeAttenuation transparent opacity={0.14} depthWrite={false} onBeforeCompile={dustShader} />
    </points>
    <points ref={mindField} geometry={mindGeometry}>
      <pointsMaterial ref={mindMaterial} color="#d7e2e2" size={0.03} sizeAttenuation transparent opacity={0} depthWrite={false} onBeforeCompile={dustShader} />
    </points>
  </>
}

// The Void is a single reusable particle rig: first a deep mineral field, then
// a directed swarm, and eventually the jade face. Density is tiered so the
// desktop view can feel immense without making phones render desktop counts.
function VoidField({ motion, reducedMotion }: { motion: RefObject<SwarmMotion>; reducedMotion: boolean }) {
  const { size, gl } = useThree()
  const mobile = size.width < 720
  const material = useRef<THREE.ShaderMaterial>(null)
  const faceDrag = useRef({ active: false, x: 0, y: 0 })
  const faceRotation = useRef(new THREE.Vector2())
  const faceVelocity = useRef(new THREE.Vector2())
  const neuralEcho = useRef({ origin: new THREE.Vector2(), age: 9, active: false, tracking: false })
  const tier = useMemo(() => {
    const device = navigator as Navigator & { deviceMemory?: number }
    const memory = device.deviceMemory ?? 8
    const cores = navigator.hardwareConcurrency ?? 8
    if (mobile) return memory <= 4 || cores <= 4 ? 'mobile-light' : 'mobile-rich'
    if (memory <= 4 || cores <= 4) return 'desktop-light'
    if (memory <= 8 || cores <= 8) return 'desktop-balanced'
    return 'desktop-rich'
  }, [mobile])
  const geometry = useMemo(() => {
    const countByTier = {
      'mobile-light': 1050,
      'mobile-rich': 1750,
      'desktop-light': 3500,
      'desktop-balanced': 6100,
      'desktop-rich': 8600,
    }
    const count = reducedMotion ? Math.min(1800, countByTier[tier]) : countByTier[tier]
    const positions = new Float32Array(count * 3)
    const seeds = new Float32Array(count)
    const faceTargets = new Float32Array(count * 3)
    const faceFeatures = new Float32Array(count)
    const eyeRadii = new Float32Array(count)

    const pickFaceTarget = (index: number) => {
      let randomState = 0
      const random = () => {
        randomState += 0.61803398875
        const value = Math.sin((index + 1) * 91.739 + randomState * 43758.5453) * 43758.5453
        return value - Math.floor(value)
      }

      // The face is sculpted as a deep particle relief derived from the
      // Calakmul jade mask's visible construction: tessellated stone plates,
      // angular brows and eye-rims, a raised nose, spiral ear ornaments,
      // copper mouth crescents, and pale fracture seams. It deliberately
      // remains a particle interpretation, rather than copying a bitmap.
      const featureRoll = random()
      if (featureRoll < 0.06) {
        // Two small particle discs occupy the deliberately open eye sockets.
        // They are irises only—there is no added eyeball surface—so their
        // glow stays embedded in the jade mask rather than feeling cartoonish.
        const side = random() > 0.5 ? 1 : -1
        const angle = random() * Math.PI * 2
        const radius = Math.sqrt(random())
        // One shallow plane per eye makes a true iris disc rather than a
        // little blue sphere embedded in the mask.
        const x = side * (0.84 + Math.cos(angle) * 0.185 * radius)
        const y = 0.62 + Math.sin(angle) * 0.185 * radius
        return [x, y, -3.505 + (random() - 0.5) * 0.012, 4] as const
      }
      if (featureRoll < 0.12) {
        const side = random() > 0.5 ? 1 : -1
        // Two-and-a-half turns create the characteristic coiled jade ear
        // discs, with the relief advancing toward the camera at the centre.
        const turn = random() * Math.PI * 5.1
        const radius = 0.12 + turn / (Math.PI * 5.1) * 0.67
        const x = side * (2.05 + Math.cos(turn) * radius)
        const y = -0.04 + Math.sin(turn) * radius * 0.88
        return [x, y, -4.08 + (1 - radius) * 0.3, 1] as const
      }
      if (featureRoll < 0.18) {
        // The stepped side pieces behind each ear make the silhouette read
        // like a sculpted mask instead of a floating oval.
        const side = random() > 0.5 ? 1 : -1
        const row = Math.floor(random() * 4)
        const x = side * (2.47 + random() * 0.42)
        const y = 0.88 - row * 0.38 + (random() - 0.5) * 0.13
        return [x, y, -4.5 + random() * 0.14, 1] as const
      }
      if (featureRoll < 0.28) {
        const side = random() > 0.5 ? 1 : -1
        const t = random()
        // An asymmetric, sloped polygonal brow followed by the sharp eye
        // rim. A small gold fraction recalls the original eye inlays.
        const brow = random() > 0.42
        const x = side * (brow ? 0.32 + t * 1.22 : 0.42 + t * 0.94)
        const y = brow
          ? 0.98 - t * 0.3 - Math.abs(t - 0.5) * 0.2
          : 0.56 + Math.sin(t * Math.PI) * 0.18 - t * 0.12
        return [x, y, -3.78 + (brow ? 0.06 : 0.18), random() > 0.82 ? 2 : 3] as const
      }
      if (featureRoll < 0.38) {
        // The nose is a tall faceted wedge: narrow high up, rounded and
        // strongly raised toward its lower point.
        const y = -0.42 + random() * 1.72
        const lower = 1 - (y + 0.42) / 1.72
        const width = 0.1 + lower * 0.38
        const x = (random() - 0.5) * width * 2
        return [x, y, -3.44 + lower * 0.2 + Math.abs(x) * 0.22, 1] as const
      }
      if (featureRoll < 0.46) {
        const side = random() > 0.5 ? 1 : -1
        const t = random()
        const ornament = random() > 0.43
        // Copper is reserved for the split moustache bar and the two lower
        // crescents, keeping the warm metal details precise rather than noisy.
        const x = side * (ornament ? 0.44 + Math.sin(t * Math.PI) * 0.52 : 0.08 + t * 0.48)
        const y = ornament ? -1.12 - Math.sin(t * Math.PI) * 0.25 : -0.48 + Math.sin(t * Math.PI) * 0.1
        return [x, y, -3.7 + Math.cos(t * Math.PI) * 0.07, 2] as const
      }
      if (featureRoll < 0.56) {
        // Fine pale seams across individual jade plates. The points align on
        // deliberate broken paths, not random noise, so the fragmentation
        // reads at distance while still resolving up close.
        const segments = [
          [-1.82, 1.52, -0.98, 1.2], [-0.98, 1.2, -0.36, 1.5], [0.38, 1.5, 1.22, 1.17], [1.22, 1.17, 1.86, 0.78],
          [-1.96, 0.72, -1.24, 0.42], [-1.24, 0.42, -1.58, -0.14], [1.94, 0.66, 1.22, 0.3], [1.22, 0.3, 1.58, -0.26],
          [-1.82, -0.52, -1.16, -0.75], [-1.16, -0.75, -1.42, -1.42], [1.8, -0.5, 1.14, -0.78], [1.14, -0.78, 1.46, -1.48],
          [-1.36, -1.72, -0.62, -2.1], [-0.62, -2.1, 0.0, -1.86], [0.0, -1.86, 0.72, -2.12], [0.72, -2.12, 1.45, -1.64],
          [-0.7, 0.08, -1.15, -0.28], [0.72, 0.08, 1.15, -0.28], [-0.88, -1.38, -0.36, -1.6], [0.88, -1.38, 0.36, -1.6],
        ]
        const segment = segments[Math.floor(random() * segments.length)]
        const t = random()
        const x = THREE.MathUtils.lerp(segment[0], segment[2], t) + (random() - 0.5) * 0.035
        const y = THREE.MathUtils.lerp(segment[1], segment[3], t) + (random() - 0.5) * 0.035
        return [x, y, -3.67 + random() * 0.075, 3] as const
      }
      if (featureRoll < 0.69) {
        // The rear headpiece is intentionally set back from the facial
        // relief. It has an arched crown, a broad cross-band and a small
        // central crest—the forms visible from the rear and side references.
        const mode = random()
        if (mode < 0.48) {
          const angle = 0.08 + random() * (Math.PI - 0.16)
          const radius = 0.78 + random() * 0.5
          return [Math.cos(angle) * radius * 1.16, 2.02 + Math.sin(angle) * radius, -4.82 + random() * 0.1, 0] as const
        }
        if (mode < 0.8) {
          return [(random() - 0.5) * 2.9, 2.0 + (random() - 0.5) * 0.3, -4.88 + random() * 0.1, 0] as const
        }
        return [(random() - 0.5) * 0.72, 2.6 + random() * 0.76, -4.94 + random() * 0.1, 0] as const
      }
      if (featureRoll < 0.78) {
        // A deep lower collar/chin is a separate layer, not part of the face
        // oval. This makes the headpiece read convincingly from a turn.
        const y = -2.12 - random() * 0.82
        const width = 1.3 - Math.abs(y + 2.42) * 0.6
        const x = (random() - 0.5) * Math.max(0.5, width * 2)
        return [x, y, -4.66 + random() * 0.13, random() > 0.82 ? 3 : 0] as const
      }

      let x = 0
      let y = 0
      let eye = false
      let mouth = false
      for (let attempt = 0; attempt < 12; attempt += 1) {
        const angle = random() * Math.PI * 2
        const radius = Math.sqrt(random())
        // A narrower chin and broader forehead make the base silhouette
        // closer to the original mask than a regular ellipse.
        const rawY = Math.sin(angle) * radius * 2.32
        const width = 1.45 + Math.max(0, rawY + 0.35) * 0.26 - Math.max(0, -rawY - 1.35) * 0.42
        x = Math.cos(angle) * radius * width
        y = rawY
        const eyeLevel = 0.52 + (Math.abs(x) - 0.76) * 0.07
        const eyeWidth = Math.abs(x) > 0.45 && Math.abs(x) < 1.31
        eye = eyeWidth && Math.abs(y - eyeLevel) < (0.1 + (1.3 - Math.abs(x)) * 0.075)
        mouth = (x / 0.64) ** 2 + ((y + 0.86) / 0.2) ** 2 < 1
        if (!eye && !mouth) break
      }
      const radial = Math.min(1, (x / 2.05) ** 2 + (y / 2.58) ** 2)
      const depth = -4.58 + (1 - radial) * 0.62 + (random() - 0.5) * 0.12
      return [x, y, depth, 0] as const
    }
    for (let i = 0; i < count; i += 1) {
      const layer = i % 13
      const depth = -0.35 - layer * 1.28 - Math.random() * 1.65
      positions[i * 3] = (Math.random() - 0.5) * (8.8 + layer * 0.55)
      positions[i * 3 + 1] = (Math.random() - 0.5) * (5.8 + layer * 0.34)
      positions[i * 3 + 2] = depth
      seeds[i] = Math.random()
      const [x, y, z, feature] = pickFaceTarget(i)
      faceTargets.set([x, y, z], i * 3)
      faceFeatures[i] = feature
      if (feature === 4) eyeRadii[i] = Math.min(1, Math.hypot((Math.abs(x) - 0.84) / 0.185, (y - 0.62) / 0.185))
    }
    const result = new THREE.BufferGeometry()
    result.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    result.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1))
    result.setAttribute('aFaceTarget', new THREE.BufferAttribute(faceTargets, 3))
    result.setAttribute('aFaceFeature', new THREE.BufferAttribute(faceFeatures, 1))
    result.setAttribute('aEyeRadius', new THREE.BufferAttribute(eyeRadii, 1))
    return result
  }, [reducedMotion, tier])
  const uniforms = useMemo(() => ({
    uTime: { value: 0 }, uOpacity: { value: 0 }, uDpr: { value: 1 },
    uPointer: { value: new THREE.Vector2() }, uPointerActive: { value: 0 }, uEyeOpen: { value: 0 }, uFaceDrift: { value: 0 },
    uEchoOrigin: { value: new THREE.Vector2() }, uEchoAge: { value: 9 },
    uSwirl: { value: 0 }, uEnergy: { value: 0 }, uTravel: { value: 0 }, uFace: { value: 0 },
    uFaceRotation: { value: new THREE.Vector2() }, uFaceDisturb: { value: 0 },
  }), [])
  useEffect(() => () => geometry.dispose(), [geometry])
  useEffect(() => {
    const down = (event: PointerEvent) => {
      const phase = chapterPhase()
      if (event.pointerType === 'touch' || event.button !== 0 || phase < 1.14 || phase > 1.88
        || (event.target instanceof Element && event.target.closest('a, button, input, select, textarea'))) return
      faceDrag.current = { active: true, x: event.clientX, y: event.clientY }
      faceVelocity.current.set(0, 0)
      document.body.style.cursor = 'grabbing'
    }
    const move = (event: PointerEvent) => {
      if (!faceDrag.current.active) return
      const dx = event.clientX - faceDrag.current.x
      const dy = event.clientY - faceDrag.current.y
      faceDrag.current.x = event.clientX
      faceDrag.current.y = event.clientY
      faceRotation.current.x = THREE.MathUtils.clamp(faceRotation.current.x + dy * 0.0042, -0.52, 0.52)
      faceRotation.current.y += dx * 0.0048
      faceVelocity.current.set(dy * 0.0042, dx * 0.0048)
    }
    const up = () => {
      if (!faceDrag.current.active) return
      faceDrag.current.active = false
      document.body.style.cursor = ''
    }
    window.addEventListener('pointerdown', down)
    window.addEventListener('pointermove', move, { passive: true })
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    window.addEventListener('blur', up)
    return () => {
      window.removeEventListener('pointerdown', down)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      window.removeEventListener('blur', up)
      if (faceDrag.current.active) document.body.style.cursor = ''
    }
  }, [])
  useFrame(({ clock }, delta) => {
    if (!material.current) return
    const phase = chapterPhase()
    const dt = Math.min(delta, 0.1)
    const live = material.current.uniforms
    const entering = THREE.MathUtils.smoothstep(phase, 0.42, 0.9)
    // Preserve the mask while the camera passes through it, then let the
    // particles disperse into the following scene.
    const leaving = 1 - THREE.MathUtils.smoothstep(phase, 2.26, 2.56)
    live.uTime.value = reducedMotion ? 0 : clock.getElapsedTime()
    live.uOpacity.value = entering * leaving
    live.uDpr.value = gl.getPixelRatio()
    live.uPointer.value.copy(motion.current.pointer)
    live.uSwirl.value = reducedMotion ? 0 : motion.current.swirl
    live.uEnergy.value = reducedMotion ? 0 : motion.current.energy
    live.uTravel.value = reducedMotion ? 0 : THREE.MathUtils.smoothstep(phase, 0.72, 1.5)
    live.uFace.value = THREE.MathUtils.smoothstep(phase, 1.08, 1.68)
      * (1 - THREE.MathUtils.smoothstep(phase, 2.08, 2.36))
    // The two irises bloom from their pupils toward the rim, like eyelids
    // lifting. Keeping this separate from the mask gather lets it feel alive.
    live.uEyeOpen.value = THREE.MathUtils.smoothstep(phase, 1.33, 1.53)
      * (1 - THREE.MathUtils.smoothstep(phase, 2.04, 2.22))
    live.uPointerActive.value = THREE.MathUtils.lerp(live.uPointerActive.value, motion.current.active && !reducedMotion ? 1 : 0, 1 - Math.exp(-Math.min(delta, 0.1) * 3))
    if (!faceDrag.current.active) {
      faceRotation.current.add(faceVelocity.current)
      faceVelocity.current.multiplyScalar(Math.exp(-dt * 4.8))
    }
    faceRotation.current.x = THREE.MathUtils.clamp(faceRotation.current.x, -0.52, 0.52)
    faceRotation.current.y = THREE.MathUtils.euclideanModulo(faceRotation.current.y + Math.PI, Math.PI * 2) - Math.PI
    // A full, slow reveal lets the neural field emerge through the forehead
    // before the mask presents its reverse. Hand rotation remains additive.
    const presentationTurn = reducedMotion ? 0 : THREE.MathUtils.smoothstep(phase, 1.54, 2.28) * Math.PI
    live.uFaceRotation.value.set(
      reducedMotion ? 0 : faceRotation.current.x + Math.sin(clock.getElapsedTime() * 0.27) * 0.026,
      reducedMotion ? 0 : faceRotation.current.y + presentationTurn + Math.sin(clock.getElapsedTime() * 0.19) * 0.05,
    )
    const faceActive = phase > 1.12 && phase < 2.14 && motion.current.active && !reducedMotion
    live.uFaceDisturb.value = THREE.MathUtils.lerp(live.uFaceDisturb.value, faceActive ? 1 : 0, 1 - Math.exp(-dt * 20))
    const echo = neuralEcho.current
    if (faceActive) {
      if (!echo.tracking) {
        echo.origin.copy(motion.current.pointer)
        echo.age = 0
        echo.active = true
        echo.tracking = true
      } else {
        // The emission point follows the hand smoothly rather than waiting for
        // a distance threshold, keeping the whole interaction continuously alive.
        echo.origin.lerp(motion.current.pointer, 1 - Math.exp(-dt * 7))
        echo.age += dt
        if (echo.age > 4.8) echo.age = 0
      }
    } else {
      echo.tracking = false
      if (echo.active) echo.age = Math.min(9, echo.age + dt)
    }
    if (!faceActive && echo.age > 4.8) echo.active = false
    live.uEchoOrigin.value.copy(echo.origin)
    live.uEchoAge.value = echo.age
    // Leave a little momentum in the field when the pointer stops: disturbed
    // particles keep slowly settling at the last interaction point.
    const driftTarget = echo.active ? 1 : 0
    live.uFaceDrift.value = THREE.MathUtils.lerp(live.uFaceDrift.value, driftTarget, 1 - Math.exp(-dt * (echo.active ? 2.8 : 0.72)))
  })
  return <points geometry={geometry} frustumCulled={false}>
    <shaderMaterial ref={material} transparent depthWrite={false} blending={THREE.AdditiveBlending} uniforms={uniforms} vertexShader={/* glsl */ `
      attribute float aSeed;
      attribute vec3 aFaceTarget;
      attribute float aFaceFeature;
      attribute float aEyeRadius;
      uniform float uTime, uDpr, uPointerActive, uSwirl, uEnergy, uTravel, uFace, uFaceDisturb, uEyeOpen, uFaceDrift, uEchoAge;
      uniform vec2 uPointer, uEchoOrigin;
      uniform vec2 uFaceRotation;
      varying float vMix;
      varying float vFace;
      varying float vFaceFeature;
      varying float vHover;
      varying float vEyeRadius;
      varying float vEyeOpen;
      void main() {
        vec3 p = position;
        float wave = uTime * (0.17 + aSeed * 0.15);
        float stream = sin(p.z * 0.23 + aSeed * 18.0 + wave);
        float angle = (uSwirl * (0.16 + aSeed * 0.26) + p.z * 0.052 + wave * 0.12) * (0.42 + uTravel * 0.72);
        mat2 rotation = mat2(cos(angle), sin(angle), -sin(angle), cos(angle));
        p.xy = rotation * p.xy;
        p.z += uTravel * (1.65 + aSeed * 1.75) + stream * (0.08 + uEnergy * 0.1);
        p.x += sin(wave + p.z * 0.38) * (0.06 + aSeed * 0.11);
        p.y += cos(wave * 1.23 + p.x * 0.42) * (0.05 + aSeed * 0.085);
        // Each particle receives its own small arrival offset. The face is
        // therefore assembled as a travelling compression, never a switch.
        float gather = smoothstep(0.0, 1.0, uFace * 1.32 - aSeed * 0.32);
        vec3 faceTarget = aFaceTarget;
        // A shallow 3D turn makes the target read as a relief rather than a
        // flat screen of particles. Drag rotation is intentionally bounded.
        faceTarget.z += 4.24;
        mat2 yaw = mat2(cos(uFaceRotation.y), sin(uFaceRotation.y), -sin(uFaceRotation.y), cos(uFaceRotation.y));
        mat2 pitch = mat2(cos(uFaceRotation.x), sin(uFaceRotation.x), -sin(uFaceRotation.x), cos(uFaceRotation.x));
        faceTarget.xz = yaw * faceTarget.xz;
        faceTarget.yz = pitch * faceTarget.yz;
        faceTarget.z -= 4.24;
        float vibration = sin(uTime * (1.2 + aSeed * 1.8) + aSeed * 51.0) * 0.016;
        faceTarget += vec3(cos(aSeed * 39.0), sin(aSeed * 71.0), sin(aSeed * 23.0)) * vibration;
        p = mix(p, faceTarget, gather);
        vec4 view = modelViewMatrix * vec4(p, 1.0);
        vec4 clip = projectionMatrix * view;
        vec2 faceScreen = clip.xy / max(clip.w, 0.001);
        vec2 echoVector = (faceScreen - uEchoOrigin) * vec2(1.35, 1.0);
        // Warp the propagation space independently for each particle. The
        // resulting cross keeps its directional energy but its edges fragment
        // and wander like a signal travelling through an uneven material.
        vec2 signalSpace = echoVector + vec2(
          sin(echoVector.y * 10.0 + aSeed * 61.0) * 0.065,
          sin(echoVector.x * 12.0 + aSeed * 47.0) * 0.06
        );
        vec2 echoDirection = normalize(signalSpace + vec2(0.0001));
        // One slow, broken cross opens from the charged contact point. The
        // separate horizontal and vertical arms take different irregular paths
        // across the mask rather than creating a recognisable circular ripple.
        float front = uEchoAge * 0.29;
        float horizontalArm = exp(-pow((abs(signalSpace.x) - front) / 0.12, 2.0))
          * (1.0 - smoothstep(0.16, 0.78, abs(signalSpace.y)));
        float verticalArm = exp(-pow((abs(signalSpace.y) - front) / 0.13, 2.0))
          * (1.0 - smoothstep(0.14, 0.72, abs(signalSpace.x)));
        float brokenness = 0.6 + 0.4 * sin(aSeed * 91.0 + signalSpace.x * 24.0 - signalSpace.y * 19.0);
        float signal = max(horizontalArm, verticalArm) * brokenness * gather;
        float settle = signal * uFaceDrift;
        vec2 tangent = vec2(-echoDirection.y, echoDirection.x);
        view.xy += echoDirection * signal * (0.008 + aSeed * 0.012);
        view.xy += tangent * signal * sin(aSeed * 47.0) * 0.005;
        view.z += signal * (0.014 + 0.01 * sin(aSeed * 37.0));
        // A low-frequency, per-particle offset has a long tail. It feels
        // like the field is drifting back through vacuum after being moved.
        view.xy += vec2(sin(uTime * 1.35 + aSeed * 67.0), cos(uTime * 1.08 + aSeed * 41.0)) * settle * (0.018 + aSeed * 0.024);
        view.z += sin(uTime * 1.7 + aSeed * 29.0) * settle * 0.035;
        clip = projectionMatrix * view;
        gl_Position = clip;
        float seamPoint = step(2.5, aFaceFeature) * (1.0 - step(3.5, aFaceFeature));
        float irisPoint = step(3.5, aFaceFeature);
        float irisReveal = smoothstep(aEyeRadius - 0.06, aEyeRadius + 0.22, uEyeOpen - aSeed * 0.055);
        gl_PointSize = clamp((2.2 + aSeed * 4.8) * uDpr * 7.1 * mix(1.0, 1.0 + signal * 0.5, gather) * mix(1.0, 0.58, seamPoint) * mix(1.0, 1.18 * irisReveal, irisPoint) / max(0.75, -view.z), 1.0 * uDpr, 13.0 * uDpr);
        vMix = clamp(aSeed + stream * 0.11, 0.0, 1.0);
        vFace = gather;
        vFaceFeature = aFaceFeature;
        vEyeRadius = aEyeRadius;
        vEyeOpen = irisReveal;
        vHover = signal;
      }`} fragmentShader={/* glsl */ `
      uniform float uOpacity;
      varying float vMix;
      varying float vFace;
      varying float vFaceFeature;
      varying float vHover;
      varying float vEyeRadius;
      varying float vEyeOpen;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        float core = 1.0 - smoothstep(0.0, 0.32, d);
        float halo = exp(-d * d * 10.0) * 0.42;
        vec3 jade = mix(vec3(0.10, 0.30, 0.27), vec3(0.48, 0.78, 0.61), vMix);
        vec3 patina = mix(jade, vec3(0.94, 0.54, 0.22), smoothstep(0.92, 1.0, vMix) * 0.18);
        // Dark fractured jade, pale jade ornaments, and modest copper
        // details mirror the supplied mask references without a bitmap asset.
        float facet = floor(vMix * 6.0) / 5.0;
        vec3 jadeFace = mix(vec3(0.035, 0.24, 0.20), vec3(0.25, 0.58, 0.47), facet);
        jadeFace = mix(jadeFace, vec3(0.44, 0.71, 0.56), smoothstep(0.76, 1.0, vMix) * 0.42);
        vec3 paleJade = mix(vec3(0.22, 0.42, 0.34), vec3(0.52, 0.69, 0.55), vMix);
        vec3 copper = mix(vec3(0.38, 0.16, 0.07), vec3(0.88, 0.52, 0.23), vMix);
        float paleFeature = step(0.5, vFaceFeature) * (1.0 - step(1.5, vFaceFeature));
        float copperFeature = step(1.5, vFaceFeature) * (1.0 - step(2.5, vFaceFeature));
        float seamFeature = step(2.5, vFaceFeature);
        float irisFeature = step(3.5, vFaceFeature);
        vec3 maskColor = mix(jadeFace, paleJade, paleFeature);
        maskColor = mix(maskColor, copper, copperFeature);
        maskColor = mix(maskColor, vec3(0.38, 0.62, 0.53), seamFeature);
        // A cyan-blue rim, lighter inner fibres and a dark centre give the
        // otherwise abstract particle discs a more convincing iris read.
        float irisRim = smoothstep(0.52, 0.94, vEyeRadius);
        float pupil = 1.0 - smoothstep(0.18, 0.36, vEyeRadius);
        vec3 irisBlue = mix(vec3(0.06, 0.31, 0.62), vec3(0.12, 0.72, 1.0), irisRim);
        irisBlue = mix(irisBlue, vec3(0.008, 0.022, 0.045), pupil);
        maskColor = mix(maskColor, irisBlue, irisFeature);
        // A cool local flash keeps the interaction readable against the
        // ambient glow without recolouring the resting mask.
        maskColor = mix(maskColor, vec3(0.56, 0.91, 1.0), clamp(vHover * 0.05, 0.0, 0.05));
        vec3 color = mix(patina, maskColor, vFace);
        float eyeFade = mix(1.0, vEyeOpen, irisFeature);
        gl_FragColor = vec4(color * (core + halo * mix(1.0, 1.8, vFace)) * (1.0 + vHover * 0.05) * mix(1.0, 1.9, irisFeature), (core + halo) * uOpacity * (0.32 + vMix * 0.74) * mix(1.0, 1.34, vFace) * eyeFade);
      }`} />
  </points>
}

type SwarmMotion = { pointer: THREE.Vector2; active: boolean; energy: number; swirl: number }

// A separate, lightweight field complements the existing repelling network:
// these particles drift toward the cursor while the network keeps its effect.
function ParticleSwarm({ motion, reducedMotion }: { motion: RefObject<SwarmMotion>; reducedMotion: boolean }) {
  const { size, gl } = useThree()
  const mobile = size.width < 720
  const material = useRef<THREE.ShaderMaterial>(null)
  const target = useRef(new THREE.Vector2())
  const input = useRef({ active: false, pointerEnergy: 0, scrollEnergy: 0, scrollY: window.scrollY })
  const geometry = useMemo(() => {
    const count = mobile ? 900 : 4000
    const positions = new Float32Array(count * 3)
    const seeds = new Float32Array(count)
    for (let i = 0; i < count; i += 1) {
      positions[i * 3] = (Math.random() - 0.5) * 14
      positions[i * 3 + 1] = (Math.random() - 0.5) * 9
      positions[i * 3 + 2] = -8 + Math.random() * 13
      seeds[i] = Math.random()
    }
    const result = new THREE.BufferGeometry()
    result.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    result.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1))
    return result
  }, [mobile])
  const uniforms = useMemo(() => ({
    uTime: { value: 0 }, uSwirl: { value: 0 }, uEnergy: { value: 0 },
    uPointer: { value: new THREE.Vector2() }, uRepel: { value: 0 }, uRepelRadius: { value: 1 },
    uAspect: { value: 1 }, uDpr: { value: 1 }, uOpacity: { value: 0 },
  }), [])
  useEffect(() => {
    const move = (event: PointerEvent) => {
      if (event.pointerType === 'touch') { input.current.active = false; return }
      const x = event.clientX / window.innerWidth * 2 - 1
      const y = 1 - event.clientY / window.innerHeight * 2
      input.current.pointerEnergy = Math.min(1, input.current.pointerEnergy + Math.hypot(x - target.current.x, y - target.current.y) * 2)
      target.current.set(x, y)
      input.current.active = true
    }
    const leave = (event: PointerEvent) => { if (!event.relatedTarget) input.current.active = false }
    const blur = () => { input.current.active = false }
    const scroll = () => {
      const delta = window.scrollY - input.current.scrollY
      input.current.scrollY = window.scrollY
      // The infinite-scroll seam is a jump, not a gesture.
      if (Math.abs(delta) > window.innerHeight * 1.5) return
      input.current.scrollEnergy = Math.min(1, input.current.scrollEnergy + Math.abs(delta) / Math.max(window.innerHeight, 1) * 3)
      motion.current.swirl += Math.abs(delta) / Math.max(window.innerHeight, 1) * 0.22
    }
    window.addEventListener('pointermove', move, { passive: true })
    window.addEventListener('pointerout', leave)
    window.addEventListener('blur', blur)
    window.addEventListener('scroll', scroll, { passive: true })
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerout', leave)
      window.removeEventListener('blur', blur)
      window.removeEventListener('scroll', scroll)
      geometry.dispose()
    }
  }, [geometry, motion])
  useFrame(({ clock }, delta) => {
    const dt = Math.min(delta, 0.1)
    motion.current.pointer.lerp(target.current, 1 - Math.exp(-dt * 20))
    motion.current.active = input.current.active && !reducedMotion
    input.current.pointerEnergy *= Math.exp(-dt * 2.5)
    input.current.scrollEnergy *= Math.exp(-dt * 2)
    motion.current.energy = Math.max(input.current.pointerEnergy, input.current.scrollEnergy)
    if (!material.current) return
    // R3F can hold its own uniform objects; update the live material directly.
    const live = material.current.uniforms
    live.uTime.value = reducedMotion ? 0 : clock.getElapsedTime()
    live.uSwirl.value = reducedMotion ? 0 : motion.current.swirl
    live.uEnergy.value = reducedMotion ? 0 : motion.current.energy
    live.uPointer.value.copy(motion.current.pointer)
    live.uRepel.value = THREE.MathUtils.lerp(live.uRepel.value, motion.current.active ? 1 : 0, 1 - Math.exp(-dt * 3.4))
    live.uAspect.value = size.width / Math.max(size.height, 1)
    live.uDpr.value = gl.getPixelRatio()
    const phase = chapterPhase()
    // Potential uses a compact cursor sphere so the interaction stays on the
    // specimen rather than opening across most of the frame.
    live.uRepelRadius.value = phase > 2.7 && phase < 3.58 ? 0.45 : 1
    live.uOpacity.value = THREE.MathUtils.smoothstep(phase, 3.12, 3.36) * (1 - THREE.MathUtils.smoothstep(phase, 3.53, 3.97))
  })
  return <points geometry={geometry} frustumCulled={false}>
    <shaderMaterial ref={material} transparent depthWrite={false} blending={THREE.AdditiveBlending} uniforms={uniforms} vertexShader={/* glsl */ `
      attribute float aSeed;
      uniform float uTime, uSwirl, uEnergy, uRepel, uRepelRadius, uAspect, uDpr;
      uniform vec2 uPointer;
      varying float vGlow;
      void main() {
        vec3 p = position;
        float angle = -uSwirl * (0.45 + aSeed * 0.55);
        mat2 rotation = mat2(cos(angle), sin(angle), -sin(angle), cos(angle));
        p.xy = rotation * p.xy;
        p.xy += vec2(sin(uTime * 0.18 + aSeed * 20.0), cos(uTime * 0.13 + aSeed * 17.0)) * (0.08 + uEnergy * 0.15);
        vec4 view = modelViewMatrix * vec4(p, 1.0);
        vec4 clip = projectionMatrix * view;
        vec2 screen = clip.xy / max(clip.w, 0.001);
        vec2 toward = (uPointer - screen) * vec2(uAspect, 1.0);
        float distanceToPointer = length(toward);
        float repel = 1.0 - smoothstep(0.06 * uRepelRadius, 0.92 * uRepelRadius, distanceToPointer);
        vec2 direction = toward / max(distanceToPointer, 0.001);
        // The previous force pulled the field inward like a black hole. This
        // is a clean, broad outward pressure with a little energy on movement.
        vec2 displacement = -direction * repel * (0.18 + uEnergy * 0.2);
        clip.xy += displacement / vec2(uAspect, 1.0) * uRepel * clip.w;
        gl_Position = clip;
        gl_PointSize = clamp((3.5 + aSeed * 3.5) * uDpr * 7.0 / max(1.0, -view.z), 2.0 * uDpr, 10.0 * uDpr);
        vGlow = 0.55 + aSeed * 0.45;
      }`} fragmentShader={/* glsl */ `
      uniform float uOpacity;
      varying float vGlow;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        float glow = exp(-d * d * 14.0) * (1.0 - smoothstep(0.35, 0.5, d));
        gl_FragColor = vec4(vec3(1.0, 0.58, 0.3), glow * vGlow * uOpacity);
      }`} />
  </points>
}

// A second expression of the new particle language belongs to the specimen:
// a restrained mineral halo that follows the rotating asteroid without hiding
// its smoky crystal forms. Keeping this local to the ore group also preserves
// the Void portrait as its own chapter rather than reusing its silhouette.
function CrystalParticleAura({ reducedMotion }: { reducedMotion: boolean }) {
  const { size, gl } = useThree()
  const mobile = size.width < 720
  const material = useRef<THREE.ShaderMaterial>(null)
  const geometry = useMemo(() => {
    const count = mobile ? 320 : 1200
    const positions = new Float32Array(count * 3)
    const seeds = new Float32Array(count)
    const tones = new Float32Array(count)
    for (let i = 0; i < count; i += 1) {
      const angle = Math.random() * Math.PI * 2
      const radius = 1.28 + Math.pow(Math.random(), 0.62) * 1.55
      positions[i * 3] = Math.cos(angle) * radius * (0.78 + Math.random() * 0.32)
      positions[i * 3 + 1] = (Math.random() - 0.46) * (1.7 + radius * 0.76)
      positions[i * 3 + 2] = Math.sin(angle) * radius * (0.42 + Math.random() * 0.56)
      seeds[i] = Math.random()
      tones[i] = Math.random()
    }
    const result = new THREE.BufferGeometry()
    result.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    result.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1))
    result.setAttribute('aTone', new THREE.BufferAttribute(tones, 1))
    return result
  }, [mobile])
  const uniforms = useMemo(() => ({ uTime: { value: 0 }, uOpacity: { value: 0 }, uDpr: { value: 1 } }), [])
  useEffect(() => () => geometry.dispose(), [geometry])
  useFrame(({ clock }) => {
    if (!material.current) return
    const phase = chapterPhase()
    const entering = THREE.MathUtils.smoothstep(phase, 3.14, 3.36)
    const leaving = 1 - THREE.MathUtils.smoothstep(phase, 3.54, 3.94)
    material.current.uniforms.uTime.value = reducedMotion ? 0 : clock.getElapsedTime()
    material.current.uniforms.uDpr.value = gl.getPixelRatio()
    material.current.uniforms.uOpacity.value = entering * leaving * (mobile ? 0.58 : 0.76)
  })
  return <points geometry={geometry} frustumCulled={false} renderOrder={3}>
    <shaderMaterial ref={material} transparent depthWrite={false} blending={THREE.AdditiveBlending} uniforms={uniforms} toneMapped={false} vertexShader={/* glsl */ `
      attribute float aSeed;
      attribute float aTone;
      uniform float uTime, uDpr;
      varying float vTone;
      void main() {
        vec3 p = position;
        float turn = uTime * (0.105 + aSeed * 0.11) + aSeed * 6.28318;
        mat2 orbit = mat2(cos(turn), sin(turn), -sin(turn), cos(turn));
        p.xz = orbit * p.xz;
        p.y += sin(uTime * (0.46 + aSeed * 0.36) + aSeed * 37.0) * (0.08 + aSeed * 0.12);
        p += normalize(position) * sin(uTime * 0.6 + aSeed * 52.0) * 0.055;
        vec4 view = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * view;
        gl_PointSize = clamp((1.6 + aSeed * 3.2) * uDpr * 7.0 / max(1.0, -view.z), 1.0 * uDpr, 10.0 * uDpr);
        vTone = aTone;
      }
    `} fragmentShader={/* glsl */ `
      uniform float uOpacity;
      varying float vTone;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        float core = 1.0 - smoothstep(0.0, 0.3, d);
        float halo = exp(-d * d * 12.0) * 0.34;
        vec3 ice = mix(vec3(0.44, 0.67, 0.71), vec3(0.83, 0.94, 0.98), vTone);
        vec3 ember = vec3(0.92, 0.40, 0.17);
        vec3 color = mix(ice, ember, smoothstep(0.91, 1.0, vTone));
        gl_FragColor = vec4(color * (core + halo), (core + halo) * uOpacity);
      }
    `} />
  </points>
}


function CameraDirector({ reducedMotion, oreGroup, motion }: { reducedMotion: boolean; oreGroup: RefObject<THREE.Group | null>; motion: RefObject<SwarmMotion> }) {
  const { camera } = useThree()
  const currentLook = useRef(new THREE.Vector3())
  const targetPosition = useRef(new THREE.Vector3())
  const targetLook = useRef(new THREE.Vector3())
  const voidPosition = useMemo(() => new THREE.Vector3(0, 0.05, 2.9), [])
  // Frame the complete mask—rear crown through lower collar—once it has
  // gathered. The nearby camera is still used during the travelling swarm.
  const facePosition = useMemo(() => new THREE.Vector3(0, 0.28, 4.15), [])
  // Hold the mask and brain together, then continue forward through the
  // neural volume toward the specimen waiting in the same direction.
  const mindPosition = useMemo(() => new THREE.Vector3(0, 1.02, 4.12), [])
  const mindApproachPosition = useMemo(() => new THREE.Vector3(0.08, 1.5, 1.45), [])
  const mindInnerPosition = useMemo(() => new THREE.Vector3(-0.14, 1.62, -2.65), [])
  const mindCrossPosition = useMemo(() => new THREE.Vector3(0.16, 1.54, -4.82), [])
  const mindExitPosition = useMemo(() => new THREE.Vector3(-0.16, 1.32, -7.55), [])
  const asteroidDistantPosition = useMemo(() => new THREE.Vector3(-0.06, 1.32, -7.62), [])
  const asteroidNearPosition = useMemo(() => new THREE.Vector3(0.48, 1.06, -17.66), [])
  const signalPosition = useMemo(() => new THREE.Vector3(0, 0, 6.3), [])
  const signalLook = useMemo(() => new THREE.Vector3(0, 0, 0), [])
  const voidLook = useMemo(() => new THREE.Vector3(0, 0, -5.8), [])
  const faceLook = useMemo(() => new THREE.Vector3(0, 0.24, -4.25), [])
  const mindLook = useMemo(() => new THREE.Vector3(0, 1.62, -4.68), [])
  const mindApproachLook = useMemo(() => new THREE.Vector3(0.02, 1.6, -4.72), [])
  const mindInnerLook = useMemo(() => new THREE.Vector3(-0.08, 1.58, -5.0), [])
  const mindCrossLook = useMemo(() => new THREE.Vector3(0.12, 1.48, -5.7), [])
  const mindExitLook = useMemo(() => new THREE.Vector3(0.42, 1.12, -19.5), [])
  const oreLook = useMemo(() => new THREE.Vector3(0.42, 1.12, -19.5), [])
  const oreCenter = useMemo(() => new THREE.Vector3(), [])
  useFrame(({ clock }, delta) => {
    const phase = chapterPhase()
    const transitionVoid = THREE.MathUtils.smoothstep(phase, 0.32, 0.94)
    const faceFocus = THREE.MathUtils.smoothstep(phase, 1.14, 1.58)
      * (1 - THREE.MathUtils.smoothstep(phase, 2.08, 2.3))
    const transitionMind = THREE.MathUtils.smoothstep(phase, 2.08, 2.32)
    const transitionOre = THREE.MathUtils.smoothstep(phase, 3.0, 3.14)
    const returnToSignal = THREE.MathUtils.smoothstep(phase, 3.82, 4)
    targetPosition.current.copy(signalPosition).lerp(voidPosition, transitionVoid).lerp(mindPosition, transitionMind).lerp(asteroidDistantPosition, transitionOre).lerp(signalPosition, returnToSignal)
    targetLook.current.copy(signalLook).lerp(voidLook, transitionVoid).lerp(mindLook, transitionMind).lerp(oreLook, transitionOre).lerp(signalLook, returnToSignal)
    targetPosition.current.lerp(facePosition, faceFocus)
    targetLook.current.lerp(faceLook, faceFocus)
    if (!reducedMotion) {
      // A continuous forward flight: crown, neural interior, exit, then the
      // distant asteroid. Every position now shares the same depth axis.
      if (phase > 2.32 && phase < 3.02) {
        const tour = THREE.MathUtils.clamp((phase - 2.32) / 0.7, 0, 1)
        if (tour < 0.24) {
          const amount = THREE.MathUtils.smoothstep(tour, 0, 0.24)
          targetPosition.current.copy(mindPosition).lerp(mindApproachPosition, amount)
          targetLook.current.copy(mindLook).lerp(mindApproachLook, amount)
        } else if (tour < 0.56) {
          const amount = THREE.MathUtils.smoothstep(tour, 0.24, 0.56)
          targetPosition.current.copy(mindApproachPosition).lerp(mindInnerPosition, amount)
          targetLook.current.copy(mindApproachLook).lerp(mindInnerLook, amount)
        } else if (tour < 0.82) {
          const amount = THREE.MathUtils.smoothstep(tour, 0.56, 0.82)
          targetPosition.current.copy(mindInnerPosition).lerp(mindCrossPosition, amount)
          targetLook.current.copy(mindInnerLook).lerp(mindCrossLook, amount)
        } else {
          const amount = THREE.MathUtils.smoothstep(tour, 0.82, 1)
          targetPosition.current.copy(mindCrossPosition).lerp(mindExitPosition, amount)
          targetLook.current.copy(mindCrossLook).lerp(mindExitLook, amount)
        }
      }
      let closeUp = 0
      if (phase >= 3 && phase < 3.82 && oreGroup.current) {
        // The asteroid begins as a small far object. Scroll advances the
        // camera toward its real rotating world position until it fills frame.
        oreGroup.current.getWorldPosition(oreCenter)
        const oreCloseUp = THREE.MathUtils.smoothstep(phase, 3.02, 3.66)
        targetPosition.current.copy(asteroidDistantPosition).lerp(asteroidNearPosition, oreCloseUp)
        targetLook.current.copy(oreLook).lerp(oreCenter, 0.72)
        closeUp = oreCloseUp
      }
      const pointer = motion.current.pointer
      const parallax = motion.current.active ? 1 : 0
      // In Potential, move the viewpoint around the specimen while keeping the
      // camera aimed near it. Different position/look offsets create depth
      // instead of simply sliding the entire composition across the screen.
      const voidParallax = THREE.MathUtils.smoothstep(phase, 0.62, 1.08) * (1 - THREE.MathUtils.smoothstep(phase, 1.78, 2.05))
      const oreParallax = THREE.MathUtils.smoothstep(phase, 3.02, 3.32) * (1 - returnToSignal)
      const voidTravel = THREE.MathUtils.smoothstep(phase, 0.74, 1.38)
        * (1 - THREE.MathUtils.smoothstep(phase, 1.36, 1.66)) * (1 - faceFocus)
      targetPosition.current.z -= voidTravel * 1.15
      targetPosition.current.x += pointer.x * 0.9 * voidParallax * parallax
      targetPosition.current.y += pointer.y * 0.58 * voidParallax * parallax
      targetLook.current.x += pointer.x * 0.4 * voidParallax * parallax
      targetLook.current.y += pointer.y * 0.27 * voidParallax * parallax
      targetPosition.current.x += pointer.x * THREE.MathUtils.lerp(0.36, 1.05, oreParallax) * parallax * (1 - closeUp)
      targetPosition.current.y += (pointer.y * THREE.MathUtils.lerp(0.24, 0.7, oreParallax) * parallax + Math.sin(phase * Math.PI / 2) * 0.25) * (1 - closeUp)
      targetLook.current.x += pointer.x * THREE.MathUtils.lerp(0.16, 0.12, oreParallax) * parallax * (1 - closeUp)
      targetLook.current.y += pointer.y * THREE.MathUtils.lerp(0.1, 0.08, oreParallax) * parallax * (1 - closeUp)
      targetPosition.current.z += Math.sin(clock.getElapsedTime() * 0.45) * 0.13 * (1 - closeUp)
    }
    // Keep the camera's easing consistent at different frame rates.
    const damping = reducedMotion ? 1 : 1 - Math.exp(-Math.min(delta, 0.1) * 6.3)
    camera.position.lerp(targetPosition.current, damping)
    currentLook.current.lerp(targetLook.current, damping)
    camera.lookAt(currentLook.current)
  })
  return null
}

// Faceted hexagonal crystal: prism body with a pyramidal tip, lathed with six segments so every face stays flat.
function crystalGeometry(radius: number, height: number) {
  const tip = radius * 1.7
  const points = [new THREE.Vector2(0, -height / 2), new THREE.Vector2(radius * 0.86, -height / 2), new THREE.Vector2(radius, height / 2 - tip), new THREE.Vector2(0, height / 2)]
  const geometry = new THREE.LatheGeometry(points, 6).toNonIndexed()
  geometry.computeVertexNormals()
  // Smoky quartz: a lighter translucent root and a darker, glassy termination.
  const pos = geometry.attributes.position
  const colors = new Float32Array(pos.count * 4)
  const base = new THREE.Color('#9b8e7c')
  const tipColor = new THREE.Color('#20211f')
  const c = new THREE.Color()
  for (let i = 0; i < pos.count; i += 1) {
    const t = THREE.MathUtils.smoothstep(pos.getY(i), -height / 2, height / 2)
    c.lerpColors(base, tipColor, Math.pow(t, 0.8))
    colors.set([c.r, c.g, c.b, THREE.MathUtils.lerp(0.58, 0.9, t)], i * 4)
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 4))
  return geometry
}

// Object-space mineral variation avoids UV seams and texture downloads. The
// metallic traces are deliberately sparse so the specimen remains mostly rock.
type OreScanUniforms = {
  uScans: { value: THREE.Vector4[] }
  uScanStrength: { value: number }
}

const ORE_RIPPLE_COUNT = 12
const ORE_RIPPLE_LIFETIME = 2.1
const ORE_RIPPLE_SPACING = 48 // CSS pixels travelled between waves

// A fine triangular surface lattice and expanding pulse follow the real
// raycast hit, rather than being projected onto a sphere around the ore.
function configureOreScan(shader: THREE.WebGLProgramParametersWithUniforms, uniforms: OreScanUniforms) {
  Object.assign(shader.uniforms, uniforms)
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nvarying vec3 vScanWorld;\nvarying vec3 vScanLocal;\nvarying vec3 vScanNormal;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvScanWorld = (modelMatrix * vec4(position, 1.0)).xyz;\nvScanLocal = position;\nvScanNormal = normal;')
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>
      varying vec3 vScanWorld;
      varying vec3 vScanLocal;
      varying vec3 vScanNormal;
      uniform vec4 uScans[12];
      uniform float uScanStrength;
      float scanGrid(vec2 p) {
        // Smoothly warp the lattice in both directions so its cells vary in
        // size and angle, without making the travelling ripples jitter.
        vec2 bend = vec2(
          sin(p.y * 0.58 + sin(p.x * 0.21)) + 0.4 * sin(p.x * 0.39 + p.y * 0.28),
          sin(p.x * 0.49 - sin(p.y * 0.24)) + 0.4 * sin(p.y * 0.37 - p.x * 0.19)
        );
        p += bend * 0.28;
        vec3 cell = abs(fract(vec3(p.x, p.y, p.x + p.y) + 0.5) - 0.5);
        float edge = min(cell.x, min(cell.y, cell.z));
        float width = max(fwidth(edge), 0.006);
        return 1.0 - smoothstep(0.012, 0.012 + width, edge);
      }`)
    .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
      float scanArea = 0.0;
      float pulse = 0.0;
      for (int i = 0; i < 12; i++) {
        float age = uScans[i].w;
        vec3 offset = vScanWorld - uScans[i].xyz;
        // A compact, upright ellipsoid follows the real hit point. Keeping
        // the vertical axis longer makes the cursor scan read as a portrait
        // ellipse on the mineral instead of a large spherical bloom.
        float scanDistance = length(offset / vec3(0.58, 1.12, 0.66));
        float fade = smoothstep(0.0, 0.08, age) * (1.0 - smoothstep(0.24, ${ORE_RIPPLE_LIFETIME.toFixed(1)}, age));
        float scanRadius = age * 0.38;
        float ringDistance = (scanDistance - scanRadius) / 0.06;
        float ring = exp(-ringDistance * ringDistance);
        pulse = max(pulse, ring * fade);
        float reached = 1.0 - smoothstep(scanRadius, scanRadius + 0.12, scanDistance);
        scanArea = max(scanArea, reached * fade * (1.0 - smoothstep(0.32, 0.82, scanDistance)));
      }
      vec3 scanWeights = pow(abs(normalize(vScanNormal)), vec3(4.0));
      scanWeights /= max(scanWeights.x + scanWeights.y + scanWeights.z, 0.001);
      vec3 scanCoord = vScanLocal * 15.0;
      float lattice = scanGrid(scanCoord.yz) * scanWeights.x
                    + scanGrid(scanCoord.xz) * scanWeights.y
                    + scanGrid(scanCoord.xy) * scanWeights.z;
      totalEmissiveRadiance += vec3(0.72, 0.82, 0.90) * uScanStrength
        * lattice * (scanArea * 0.12 + pulse * 0.72);`)
}

function configureRockMaterial(shader: THREE.WebGLProgramParametersWithUniforms, uniforms: OreScanUniforms) {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nvarying vec3 vRockPosition;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRockPosition = position;')
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>
      varying vec3 vRockPosition;
      float oreHash(vec3 p) {
        p = fract(p * 0.1031);
        p += dot(p, p.yzx + 33.33);
        return fract((p.x + p.y) * p.z);
      }
      float oreNoise(vec3 p) {
        vec3 cell = floor(p);
        vec3 f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(
          mix(mix(oreHash(cell), oreHash(cell + vec3(1, 0, 0)), f.x),
              mix(oreHash(cell + vec3(0, 1, 0)), oreHash(cell + vec3(1, 1, 0)), f.x), f.y),
          mix(mix(oreHash(cell + vec3(0, 0, 1)), oreHash(cell + vec3(1, 0, 1)), f.x),
              mix(oreHash(cell + vec3(0, 1, 1)), oreHash(cell + vec3(1, 1, 1)), f.x), f.y), f.z);
      }`)
    .replace('#include <color_fragment>', `#include <color_fragment>
      float stone = oreNoise(vRockPosition * 15.0);
      float grain = oreNoise(vRockPosition * 42.0 + 8.0);
      float seam = abs(oreNoise(vRockPosition * 5.0 + vec3(4.0, 1.0, 7.0)) - 0.53);
      float seamWidth = max(fwidth(seam), 0.004);
      float mineral = (1.0 - smoothstep(0.012, 0.012 + seamWidth * 2.0, seam))
        * smoothstep(0.52, 0.74, stone);
      float flecks = smoothstep(0.73, 0.86, grain) * smoothstep(0.5, 0.68, stone) * 0.35;
      float metalTrace = clamp(mineral * 0.6 + flecks, 0.0, 0.65);
      diffuseColor.rgb *= mix(0.67, 1.3, stone) * mix(0.83, 1.15, grain);
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.30, 0.32, 0.31), metalTrace);`)
    .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
      roughnessFactor = mix(roughnessFactor, 0.36, metalTrace);`)
    .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
      metalnessFactor = mix(metalnessFactor, 0.82, metalTrace);`)
  configureOreScan(shader, uniforms)
}

// Continuous deterministic noise keeps the surface connected as it rotates and
// also lets the existing crystals follow the newly irregular rock silhouette.
function rockNoise(x: number, y: number, z: number) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z)
  const smooth = (v: number) => v * v * (3 - 2 * v)
  const fx = smooth(x - ix), fy = smooth(y - iy), fz = smooth(z - iz)
  const hash = (a: number, b: number, c: number) => {
    const value = Math.sin(a * 127.1 + b * 311.7 + c * 74.7) * 43758.5453
    return value - Math.floor(value)
  }
  const layer = (k: number) => THREE.MathUtils.lerp(
    THREE.MathUtils.lerp(hash(ix, iy, k), hash(ix + 1, iy, k), fx),
    THREE.MathUtils.lerp(hash(ix, iy + 1, k), hash(ix + 1, iy + 1, k), fx), fy,
  )
  return THREE.MathUtils.lerp(layer(iz), layer(iz + 1), fz) * 2 - 1
}

// Several scales of erosion and narrow fracture channels break up the rounded
// asteroid into an asymmetrical, single piece of exposed volcanic rock.
function rockRadius(d: THREE.Vector3) {
  const broad = rockNoise(d.x * 2.3 + 4, d.y * 2.3 - 2, d.z * 2.3 + 7)
  const medium = rockNoise(d.x * 5.2 - 3, d.y * 5.2 + 6, d.z * 5.2)
  const fine = rockNoise(d.x * 12 + 8, d.y * 12, d.z * 12 - 5)
  const fractureA = Math.abs(d.x * 0.68 + d.y * 0.48 + d.z * 0.55 + medium * 0.07 - 0.24)
  const fractureB = Math.abs(d.x * -0.43 + d.y * 0.82 + d.z * 0.37 + broad * 0.09 + 0.27)
  const cracks = (1 - THREE.MathUtils.smoothstep(fractureA, 0.015, 0.11)) * 0.095
    + (1 - THREE.MathUtils.smoothstep(fractureB, 0.012, 0.075)) * 0.065
  return 1.19 + broad * 0.29 + medium * 0.13 + fine * 0.045 - cracks
}

function OreCrystal({ group, crystalTip, reducedMotion }: { group: RefObject<THREE.Group | null>; crystalTip: RefObject<THREE.Object3D | null>; reducedMotion: boolean }) {
  const outer = useRef<THREE.Group>(null)
  const glint = useRef<THREE.Sprite>(null)
  const crystalHalos = useRef<THREE.SpriteMaterial[]>([])
  const oreKeyLight = useRef<THREE.PointLight>(null)
  const oreRimLight = useRef<THREE.PointLight>(null)
  const materials = useRef<THREE.Material[]>([])
  const rubbleMaterials = useRef<THREE.Material[]>([])
  const hit = useRef(false)
  const mouse = useRef(new THREE.Vector2(9, 9))
  const pointerKind = useRef('mouse')
  const scanState = useRef({ pointerRevision: 0, emittedRevision: 0, next: 0, lastEmission: -1, lastMotion: -1, distance: 0, pointerX: 0, pointerY: 0, hasPointer: false })
  // Drag-to-rotate: accumulated user spin plus a velocity that decays for a little inertia after release.
  const drag = useRef({ active: false, x: 0, y: 0 })
  const spin = useRef(new THREE.Vector2())
  const spinVelocity = useRef(new THREE.Vector2())
  const raycaster = useMemo(() => new THREE.Raycaster(), [])
  const scanOrigins = useMemo(() => Array.from({ length: ORE_RIPPLE_COUNT }, () => new THREE.Vector3()), [])
  const scanTimes = useMemo(() => new Float64Array(ORE_RIPPLE_COUNT).fill(-1000), [])
  const scanTarget = useMemo(() => new THREE.Vector3(), [])
  const scanSmoothed = useMemo(() => new THREE.Vector3(), [])
  const scanWorld = useMemo(() => new THREE.Vector3(), [])
  const scanUniforms = useMemo<OreScanUniforms>(() => ({
    uScans: { value: Array.from({ length: ORE_RIPPLE_COUNT }, () => new THREE.Vector4(0, 0, 0, 10)) },
    uScanStrength: { value: 0 },
  }), [])
  const rockShader = useMemo(() => (shader: THREE.WebGLProgramParametersWithUniforms) => configureRockMaterial(shader, scanUniforms), [scanUniforms])
  const crystalShader = useMemo(() => (shader: THREE.WebGLProgramParametersWithUniforms) => {
    configureOreScan(shader, scanUniforms)
    shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>
      // Subtle cloudy inclusions, anchored to the mineral as it rotates.
      float smoke = sin(vScanLocal.y * 11.0 + sin(vScanLocal.x * 18.0 + vScanLocal.z * 13.0) * 1.8);
      smoke *= sin(vScanLocal.y * 6.0 - vScanLocal.z * 20.0);
      diffuseColor.rgb *= 0.88 + 0.12 * smoke;
    `)
  }, [scanUniforms])
  const { size, gl } = useThree()
  const mobile = size.width < 720
  const haloTexture = useMemo(() => {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 128
    const context = canvas.getContext('2d')!
    const gradient = context.createRadialGradient(64, 64, 0, 64, 64, 64)
    gradient.addColorStop(0, 'rgba(195, 204, 211, 0.35)')
    gradient.addColorStop(0.22, 'rgba(173, 183, 193, 0.12)')
    gradient.addColorStop(1, 'rgba(173, 183, 193, 0)')
    context.fillStyle = gradient
    context.fillRect(0, 0, 128, 128)
    const texture = new THREE.CanvasTexture(canvas)
    texture.colorSpace = THREE.SRGBColorSpace
    return texture
  }, [])
  const glintTexture = useMemo(() => {
    const canvas = document.createElement('canvas')
    // Draw at higher resolution so the fine ray edges survive a close-up.
    canvas.width = canvas.height = 512
    const context = canvas.getContext('2d')!
    context.scale(4, 4)
    const glow = context.createRadialGradient(64, 64, 0, 64, 64, 63)
    glow.addColorStop(0, 'rgba(255,255,255,0.85)')
    glow.addColorStop(0.07, 'rgba(220,237,255,0.52)')
    glow.addColorStop(0.28, 'rgba(180,211,255,0.15)')
    glow.addColorStop(1, 'rgba(160,200,255,0)')
    context.fillStyle = glow
    context.fillRect(0, 0, 128, 128)
    // A narrow, opaque core sits on top of the diffuse halo.
    context.fillStyle = 'rgba(255,255,255,0.98)'
    context.beginPath()
    context.moveTo(64, 4); context.lineTo(65.3, 62.7); context.lineTo(112, 64)
    context.lineTo(65.3, 65.3); context.lineTo(64, 124); context.lineTo(62.7, 65.3)
    context.lineTo(16, 64); context.lineTo(62.7, 62.7); context.closePath()
    context.fill()
    const texture = new THREE.CanvasTexture(canvas)
    texture.colorSpace = THREE.SRGBColorSpace
    return texture
  }, [])
  const envMap = useMemo(() => {
    const pmrem = new THREE.PMREMGenerator(gl)
    const texture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
    pmrem.dispose()
    return texture
  }, [gl])
  const scene = useMemo(() => {
    const rock = new THREE.IcosahedronGeometry(1, 18)
    const pos = rock.attributes.position
    const v = new THREE.Vector3()
    for (let i = 0; i < pos.count; i += 1) {
      v.fromBufferAttribute(pos, i).normalize()
      v.multiplyScalar(rockRadius(v))
      pos.setXYZ(i, v.x, v.y, v.z)
    }
    rock.computeVertexNormals()
    // Crystals: a dense vein bursting from the upper side plus scattered growths along the surface normals.
    const crystals = Array.from({ length: 22 }, (_, i) => {
      const vein = i < 9
      const a = i * 2.4
      const spread = vein ? 0.12 + (i % 4) * 0.1 : 0.9
      const dir = vein
        ? new THREE.Vector3(Math.cos(a) * spread + 0.25, 1, Math.sin(a) * spread + 0.2).normalize()
        : new THREE.Vector3(Math.cos(a) * Math.sin(i * 1.7), Math.cos(i * 1.7) * 0.8, Math.sin(a) * Math.sin(i * 1.7)).normalize()
      const height = vein ? (i === 0 ? 2.2 : 0.9 + ((i * 7) % 5) * 0.26) : 0.3 + (i % 4) * 0.12
      const radius = vein ? (i === 0 ? 0.3 : 0.13 + (i % 3) * 0.05) : 0.06 + (i % 3) * 0.03
      return {
        geometry: crystalGeometry(radius, height),
        height,
        radius,
        position: dir.clone().multiplyScalar(rockRadius(dir) * 0.9 + height * 0.36),
        quaternion: new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir),
        tint: new THREE.Color().setHSL(0.09, 0.04, 0.94 - (i % 4) * 0.025),
      }
    })
    const rubble = Array.from({ length: 7 }, (_, i) => ({
      position: new THREE.Vector3(Math.cos(i * 0.9) * (1.9 + (i % 3) * 0.25), Math.sin(i * 1.9) * 0.9, Math.sin(i * 0.9) * 1.6),
      scale: 0.07 + (i % 3) * 0.05,
    }))
    return { rock, crystals, rubble }
  }, [])

  useEffect(() => {
    // The canvas ignores pointer events (content sits above it), so track the cursor and drags on the window.
    const move = (e: PointerEvent) => {
      const scan = scanState.current
      if (hit.current && scan.hasPointer && e.pointerType !== 'touch') scan.distance += Math.hypot(e.clientX - scan.pointerX, e.clientY - scan.pointerY)
      scan.pointerX = e.clientX
      scan.pointerY = e.clientY
      scan.hasPointer = true
      mouse.current.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1)
      pointerKind.current = e.pointerType
      scanState.current.pointerRevision += 1
      scanState.current.lastMotion = performance.now() / 1000
      if (!drag.current.active) return
      const dx = (e.clientX - drag.current.x) * 0.008
      const dy = (e.clientY - drag.current.y) * 0.008
      drag.current.x = e.clientX
      drag.current.y = e.clientY
      spin.current.x += dy
      spin.current.y += dx
      spinVelocity.current.set(dy, dx)
    }
    const down = (e: PointerEvent) => {
      // Touch gestures belong to native scrolling; dragging the rock is a mouse interaction.
      if (e.pointerType === 'touch' || !hit.current) return
      e.preventDefault()
      drag.current = { active: true, x: e.clientX, y: e.clientY }
      spinVelocity.current.set(0, 0)
      document.body.style.cursor = 'grabbing'
    }
    const up = () => {
      if (!drag.current.active) return
      drag.current.active = false
      document.body.style.cursor = hit.current ? 'grab' : ''
    }
    const leave = (e: PointerEvent) => {
      if (!e.relatedTarget) mouse.current.set(100, 100)
    }
    const blur = () => { mouse.current.set(100, 100) }
    window.addEventListener('pointermove', move, { passive: true })
    window.addEventListener('pointerout', leave)
    window.addEventListener('blur', blur)
    window.addEventListener('pointerdown', down)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerout', leave)
      window.removeEventListener('blur', blur)
      window.removeEventListener('pointerdown', down)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      document.body.style.cursor = ''
      envMap.dispose()
      glintTexture.dispose()
      haloTexture.dispose()
      scene.rock.dispose()
      scene.crystals.forEach((c) => c.geometry.dispose())
    }
  }, [envMap, glintTexture, haloTexture, scene])

  useFrame(({ clock, camera }, delta) => {
    const phase = chapterPhase()
    const p = Math.min(phase / 3, 1)
    const visible = THREE.MathUtils.smoothstep(phase, 2.98, 3.16) * (1 - THREE.MathUtils.smoothstep(phase, 3.8, 3.98))
    const t = clock.getElapsedTime()
    if (glint.current) {
      // Peak at the closest point of the crystal-tip camera move, fading in
      // and out with scroll progress (including when scrolling backwards).
      const sparkle = reducedMotion ? 0 : THREE.MathUtils.smoothstep(phase, 3.18, 3.28) * (1 - THREE.MathUtils.smoothstep(phase, 3.36, 3.48))
      const material = glint.current.material as THREE.SpriteMaterial
      material.opacity = sparkle * visible * 0.9
      glint.current.scale.setScalar(0.16 + sparkle * 0.14)
      glint.current.visible = material.opacity > 0.001
    }
    const now = performance.now() / 1000
    if (group.current && outer.current) {
      if (!drag.current.active) {
        spin.current.add(spinVelocity.current)
        spinVelocity.current.multiplyScalar(0.94)
      }
      spin.current.x = THREE.MathUtils.clamp(spin.current.x, -1.2, 1.2)
      const scrollTurn = reducedMotion ? 0 : THREE.MathUtils.smoothstep(phase, 3.04, 3.7)
      group.current.rotation.y = t * 0.12 + p * Math.PI * 1.5 + scrollTurn * Math.PI * 1.35 + spin.current.y
      group.current.rotation.x = 0.12 + Math.sin(t * 0.3) * 0.06 + (p - 0.8) * 0.4 + scrollTurn * 0.25 + spin.current.x
      const revealDrift = reducedMotion ? 0 : THREE.MathUtils.smoothstep(phase, 3.06, 3.23) * (1 - THREE.MathUtils.smoothstep(phase, 3.34, 3.52))
      outer.current.position.x = (mobile ? 0.32 : 0.48) - revealDrift * 0.18
      outer.current.position.y = 1.12 + Math.sin(t * 0.6) * 0.08
      outer.current.scale.setScalar((mobile ? 0.74 : 1.1) * (0.7 + visible * 0.3))
      raycaster.setFromCamera(mouse.current, camera)
      const wasHit = hit.current
      const intersections = phase >= 3.08 && visible > 0.5 ? raycaster.intersectObject(group.current, true) : []
      hit.current = intersections.length > 0
      if (hit.current && !wasHit && pointerKind.current !== 'touch') window.dispatchEvent(new Event('ore-crystal-hover'))
      if (!hit.current && wasHit) window.dispatchEvent(new Event('ore-crystal-leave'))
      const scan = scanState.current
      if (hit.current && !wasHit) scan.distance = ORE_RIPPLE_SPACING
      if (!hit.current && wasHit) scan.distance = 0
      if (hit.current) {
        group.current.updateWorldMatrix(true, false)
        scanTarget.copy(intersections[0].point)
        group.current.worldToLocal(scanTarget)
        // Avoid a jump when the pointer first lands; then damp its path in 3D.
        if (!wasHit) scanSmoothed.copy(scanTarget)
        else scanSmoothed.lerp(scanTarget, 1 - Math.exp(-Math.min(delta, 0.1) * 16))
      }
      if (hit.current && !reducedMotion && pointerKind.current !== 'touch'
        && scan.distance >= ORE_RIPPLE_SPACING && scan.pointerRevision !== scan.emittedRevision && now - scan.lastMotion < 0.3 && now - scan.lastEmission >= 0.3) {
        // Never reuse an active ripple: if the pool is full, wait for one to
        // finish instead of cutting a travelling wave short.
        for (let offset = 0; offset < scanOrigins.length; offset += 1) {
          const slot = (scan.next + offset) % scanOrigins.length
          if (now - scanTimes[slot] < ORE_RIPPLE_LIFETIME) continue
          scanOrigins[slot].copy(scanSmoothed)
          scanTimes[slot] = now
          scan.next = (slot + 1) % scanOrigins.length
          scan.lastEmission = now
          scan.emittedRevision = scan.pointerRevision
          scan.distance = 0
          window.dispatchEvent(new Event('ore-ripple'))
          break
        }
      }
      // Keep older ripple origins attached to the rotating object while they fade.
      for (let i = 0; i < scanOrigins.length; i += 1) {
        const age = Math.min(10, Math.max(0, now - scanTimes[i]))
        scanWorld.copy(scanOrigins[i])
        if (age < ORE_RIPPLE_LIFETIME) group.current.localToWorld(scanWorld)
        scanUniforms.uScans.value[i].set(scanWorld.x, scanWorld.y, scanWorld.z, age)
      }
      if (hit.current !== wasHit && !drag.current.active) document.body.style.cursor = hit.current ? 'grab' : ''
    }
    materials.current.forEach((material) => {
      material.opacity = visible
      material.visible = visible > 0.001
    })
    crystalHalos.current.forEach((material) => { material.opacity = visible * 0.24 })
    // Small fragments can fill the frame from the close-up camera. Introduce
    // them only as the specimen pulls back into its inspectable final view.
    rubbleMaterials.current.forEach((material) => {
      material.opacity = visible * THREE.MathUtils.smoothstep(phase, 2.75, 2.98)
    })
    // Fade in the rear light only with the specimen; retain the original key
    // light elsewhere so this pass does not change the other chapters.
    if (oreKeyLight.current) oreKeyLight.current.intensity = THREE.MathUtils.lerp(7, 4.8, visible)
    if (oreRimLight.current) oreRimLight.current.intensity = 16 * visible
    scanUniforms.uScanStrength.value = reducedMotion || pointerKind.current === 'touch' ? 0 : visible
  })

  const keep = (material: THREE.Material | null) => { if (material && !materials.current.includes(material)) materials.current.push(material) }
  return <group ref={outer} position={[mobile ? 0.32 : 0.48, 1.12, -19.5]}>
    <group ref={group}>
      <mesh geometry={scene.rock}>
        <meshStandardMaterial ref={keep} color="#262827" envMap={envMap} envMapIntensity={0.35} roughness={0.94} metalness={0.08} onBeforeCompile={rockShader} flatShading transparent opacity={0} />
      </mesh>
      {scene.crystals.map((c, index) => <mesh key={index} geometry={c.geometry} position={c.position} quaternion={c.quaternion}>
        <meshPhysicalMaterial ref={keep} color={c.tint} vertexColors envMap={envMap} envMapIntensity={1.4} metalness={0.08} roughness={0.12} ior={1.54} clearcoat={0.65} clearcoatRoughness={0.08} onBeforeCompile={crystalShader} flatShading depthWrite={false} transparent opacity={0} />
        {index < 3 && <sprite position={[0, c.height * 0.24, 0]} scale={[c.radius * 4, c.height * 0.9, 1]} raycast={() => null}>
          <spriteMaterial ref={(material) => { if (material) crystalHalos.current[index] = material }} map={haloTexture} transparent opacity={0} depthWrite={false} blending={THREE.AdditiveBlending} />
        </sprite>}
        {index === 0 && <object3D ref={crystalTip} position={[0, c.height / 2, 0]}>
          <sprite ref={glint} raycast={() => null} visible={false}>
            <spriteMaterial map={glintTexture} transparent opacity={0} depthWrite={false} depthTest={false} blending={THREE.AdditiveBlending} toneMapped={false} />
          </sprite>
        </object3D>}
      </mesh>)}
      {scene.rubble.map((r, index) => <mesh key={index} position={r.position} scale={r.scale} rotation={[index, index * 2, 0]}>
        <dodecahedronGeometry args={[1, 0]} />
        <meshStandardMaterial ref={(material) => { keep(material); if (material) rubbleMaterials.current[index] = material }} color="#4a4f52" roughness={0.9} metalness={0.3} flatShading transparent opacity={0} />
      </mesh>)}
      <CrystalParticleAura reducedMotion={reducedMotion} />
    </group>
    <pointLight ref={oreKeyLight} position={[1.4, 2.4, 2.2]} intensity={7} color="#eef4ff" distance={7} />
    <pointLight ref={oreRimLight} position={[-1.7, 1.1, -1.7]} intensity={0} color="#b7d8f2" distance={5.5} decay={2} />
  </group>
}

function RawOre({ progress }: { progress: number }) {
  const group = useRef<THREE.Group>(null)
  const rockMaterial = useRef<THREE.ShaderMaterial>(null)
  const coreMaterial = useRef<THREE.MeshStandardMaterial>(null)
  const shardMaterials = useRef<THREE.MeshStandardMaterial[]>([])
  const { size } = useThree()
  const { ore, shards } = useMemo(() => {
    const oreGeometry = new THREE.IcosahedronGeometry(1.6, 5)
    const position = oreGeometry.attributes.position
    const vertex = new THREE.Vector3()
    for (let i = 0; i < position.count; i += 1) {
      vertex.fromBufferAttribute(position, i)
      const r = vertex.length()
      const ridge = Math.sin(vertex.x * 10.1) * Math.sin(vertex.y * 8.4) * Math.sin(vertex.z * 7.2)
      vertex.multiplyScalar(1 + ridge * 0.13 + (Math.random() - 0.5) * 0.12)
      position.setXYZ(i, vertex.x, vertex.y, vertex.z)
      if (r < 0.01) position.setXYZ(i, 0, 0, 0)
    }
    position.needsUpdate = true
    oreGeometry.computeVertexNormals()
    const shardGeometry = new THREE.DodecahedronGeometry(0.12, 0)
    const fragments = Array.from({ length: 18 }, (_, i) => ({
      position: new THREE.Vector3((Math.random() - 0.5) * 7, (Math.random() - 0.5) * 4.6, (Math.random() - 0.5) * 2),
      scale: 0.35 + Math.random() * 1.1,
      rotation: [Math.random() * 2, Math.random() * 2, Math.random() * 2] as [number, number, number],
      speed: 0.2 + i * 0.013,
    }))
    return { ore: oreGeometry, shards: { geometry: shardGeometry, fragments } }
  }, [])

  useFrame(({ clock }) => {
    const pageProgress = loopProgress()
    const visible = THREE.MathUtils.smoothstep(pageProgress, 0.68, 0.84)
    if (group.current) {
      group.current.rotation.y = clock.getElapsedTime() * 0.17
      group.current.rotation.x = Math.sin(clock.getElapsedTime() * 0.23) * 0.18
      group.current.position.y = Math.sin(clock.getElapsedTime() * 0.7) * 0.12
      group.current.scale.setScalar(0.5 + visible * 0.65)
    }
    if (rockMaterial.current) {
      rockMaterial.current.uniforms.uOpacity.value = visible
      rockMaterial.current.uniforms.uTime.value = clock.getElapsedTime()
    }
    if (coreMaterial.current) {
      coreMaterial.current.opacity = visible * 0.78
      coreMaterial.current.emissiveIntensity = 0.2 + Math.sin(clock.getElapsedTime() * 1.8) * 0.08
    }
    shardMaterials.current.forEach((material) => { material.opacity = visible * 0.55 })
  })

  return <group ref={group} position={[size.width < 720 ? 1.25 : 2.6, -0.05, 0]}>
    <mesh geometry={ore}>
      <shaderMaterial ref={rockMaterial} transparent uniforms={{ uTime: { value: 0 }, uOpacity: { value: 0 } }} vertexShader={oreVertexShader} fragmentShader={oreFragmentShader} />
    </mesh>
    <mesh position={[0.32, 0.15, 1.08]} rotation={[0.3, -0.6, 0.2]} scale={[0.72, 0.52, 0.24]}>
      <icosahedronGeometry args={[1, 2]} />
      <meshStandardMaterial ref={coreMaterial} color="#c89b56" emissive="#7f421c" emissiveIntensity={0.25} metalness={0.9} roughness={0.22} transparent opacity={0} />
    </mesh>
    {shards.fragments.map((fragment, index) => <mesh key={index} geometry={shards.geometry} position={fragment.position} rotation={fragment.rotation} scale={fragment.scale}>
      <meshStandardMaterial ref={(material) => { if (material) shardMaterials.current[index] = material }} color="#77807d" roughness={0.9} metalness={0.42} transparent opacity={0} />
    </mesh>)}
  </group>
}

function RenderOnScroll({ enabled }: { enabled: boolean }) {
  const invalidate = useThree((state) => state.invalidate)
  useEffect(() => {
    if (!enabled) return
    const update = () => invalidate()
    window.addEventListener('scroll', update, { passive: true })
    window.addEventListener('resize', update)
    invalidate()
    return () => {
      window.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
    }
  }, [enabled, invalidate])
  return null
}

class CanvasBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  render() {
    return this.state.failed ? <div className="canvas-fallback" /> : this.props.children
  }
}

function SignalCanvas({ reducedMotion, documentVisible }: { reducedMotion: boolean; documentVisible: boolean }) {
  const [contextLost, setContextLost] = useState(false)
  const neuralGroup = useRef<THREE.Group>(null)
  const oreGroup = useRef<THREE.Group>(null)
  const crystalTip = useRef<THREE.Object3D>(null)
  const swarmMotion = useRef<SwarmMotion>({ pointer: new THREE.Vector2(), active: false, energy: 0, swirl: 0 })
  const repulsion = useMemo<RepulsionUniforms>(() => ({
    uRepelPointer: { value: new THREE.Vector2() },
    uRepelAspect: { value: 1 },
    uRepelStrength: { value: 0 },
    uMindGlow: { value: 0 },
  }), [])
  if (contextLost) return <div className="canvas-fallback" />
  return (
    <Canvas
      dpr={[1, window.innerWidth < 720 ? 1.25 : 2]}
      frameloop={!documentVisible ? 'never' : reducedMotion ? 'demand' : 'always'}
      camera={{ position: [0, 0, 6.3], fov: 44 }}
      gl={{ antialias: false, powerPreference: 'high-performance', toneMapping: THREE.ACESFilmicToneMapping }}
      onCreated={({ gl }) => gl.domElement.addEventListener('webglcontextlost', () => setContextLost(true), { once: true })}
      fallback={<div className="canvas-fallback" />}
    >
      <color attach="background" args={['#070809']} />
      <fog attach="fog" args={['#070809', 3.5, 12]} />
      <ambientLight intensity={0.25} color="#b7c5ca" />
      <pointLight position={[3, 2, 4]} intensity={14} color="#f06e4e" distance={10} />
      <pointLight position={[-4, -2, 2]} intensity={8} color="#b9d6df" distance={10} />
      <ScrollMotion reducedMotion={reducedMotion} />
      <DigitalRain reducedMotion={reducedMotion} />
      <RepulsionController uniforms={repulsion} reducedMotion={reducedMotion} />
      <VoidField motion={swarmMotion} reducedMotion={reducedMotion} />
      <ParticleSwarm motion={swarmMotion} reducedMotion={reducedMotion} />
      <CosmicParticles repulsion={repulsion} />
      <OreCrystal group={oreGroup} crystalTip={crystalTip} reducedMotion={reducedMotion} />
      <NeuralNetwork group={neuralGroup} repulsion={repulsion} reducedMotion={reducedMotion} />
      <CameraDirector reducedMotion={reducedMotion} oreGroup={oreGroup} motion={swarmMotion} />
      <RenderOnScroll enabled={reducedMotion && documentVisible} />
    </Canvas>
  )
}

function useScrollProgress() {
  useEffect(() => {
    // Potential is copied above Signal and Signal below Potential, so the page can jump
    // by one loop period at either seam without a visible change and without ever reaching the document edges.
    const seams = () => {
      const start = document.getElementById('signal')?.offsetTop ?? 0
      const wrap = document.getElementById('loop')?.offsetTop ?? 0
      return { start, period: wrap - start }
    }
    const update = () => {
      const { start, period } = seams()
      const y = window.scrollY
      if (period > 0 && y >= start + period) window.scrollTo({ top: y - period, behavior: 'instant' })
      else if (period > 0 && y < start) window.scrollTo({ top: y + period, behavior: 'instant' })
    }
    if ('scrollRestoration' in history) history.scrollRestoration = 'manual'
    // Always begin at the opening, even if the browser restored a later
    // chapter or the page was reloaded with a chapter hash in its URL.
    history.replaceState(history.state, '', `${location.pathname}${location.search}`)
    window.scrollTo({ top: seams().start, behavior: 'instant' })
    visualPhase = 0
    update()
    window.addEventListener('scroll', update, { passive: true })
    window.addEventListener('resize', update)
    return () => {
      window.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
    }
  }, [])
}

// A slow idle journey, never a replacement for the visitor's own navigation.
function useIdleJourney(reducedMotion: boolean) {
  useEffect(() => {
    if (reducedMotion) return
    let lastInteraction = performance.now()
    let lastFrame = 0
    let frame = 0
    const pause = () => { lastInteraction = performance.now() }
    const tick = (now: number) => {
      const dt = lastFrame ? Math.min((now - lastFrame) / 1000, 0.05) : 0
      lastFrame = now
      const focused = document.activeElement instanceof HTMLElement && document.activeElement !== document.body
      if (!document.hidden && !focused && now - lastInteraction > 5000) {
        // Keep the idle journey sub-pixel and time-based. Rounding it to
        // whole pixels made the automatic travel—and sticky text—appear to
        // advance in little frames on high-refresh displays.
        window.scrollBy({ top: dt * 7.5, behavior: 'instant' })
      }
      frame = requestAnimationFrame(tick)
    }
    const events = ['wheel', 'touchstart', 'touchmove', 'pointerdown', 'keydown'] as const
    events.forEach(event => window.addEventListener(event, pause, { passive: true }))
    document.addEventListener('visibilitychange', pause)
    frame = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(frame)
      events.forEach(event => window.removeEventListener(event, pause))
      document.removeEventListener('visibilitychange', pause)
    }
  }, [reducedMotion])
}

function useRenderPreferences() {
  const [reducedMotion, setReducedMotion] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  const [documentVisible, setDocumentVisible] = useState(() => !document.hidden)
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    const onMotionChange = () => setReducedMotion(media.matches)
    const onVisibilityChange = () => setDocumentVisible(!document.hidden)
    onMotionChange()
    onVisibilityChange()
    media.addEventListener('change', onMotionChange)
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      media.removeEventListener('change', onMotionChange)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [])
  return { reducedMotion, documentVisible }
}

function SoundToggle() {
  const sound = useRef<Soundscape | null>(null)
  const [enabled, setEnabled] = useState(false)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState(false)
  const [showSoundHint, setShowSoundHint] = useState(true)

  useEffect(() => () => { void sound.current?.close(); sound.current = null }, [])
  useEffect(() => {
    const timer = window.setTimeout(() => setShowSoundHint(false), 3000)
    return () => window.clearTimeout(timer)
  }, [])
  useEffect(() => {
    if (!enabled) return
    const motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)')
    let lastAudioPhase = chapterPhase()
    let lastCrystalZoom = -Infinity
    const update = () => {
      const phase = chapterPhase()
      sound.current?.update(phase)
      const closeUpReached = (lastAudioPhase < 2.75 && phase >= 2.75 && phase < 3)
        || (lastAudioPhase > 2.82 && phase <= 2.82 && phase > 2)
      if (closeUpReached && !motionPreference.matches && !document.hidden && performance.now() - lastCrystalZoom > 2000) {
        sound.current?.crystalZoom()
        lastCrystalZoom = performance.now()
      }
      const difference = Math.abs(((phase - lastAudioPhase + 6) % 4) - 2)
      const departure = signalDeparture(phase)
      const presence = THREE.MathUtils.smoothstep(departure, 0.12, 0.42) * (1 - THREE.MathUtils.smoothstep(departure, 0.8, 0.98))
      sound.current?.glyphZoom(motionPreference.matches || document.hidden ? 0 : presence * Math.min(1, difference * 90))
      lastAudioPhase = phase
    }
    const music = window.setInterval(() => sound.current?.note(chapterPhase()), 1700)
    const ambience = window.setInterval(update, 250)
    const crystal = () => sound.current?.cue('crystal')
    const asteroidEnter = () => sound.current?.asteroidHover(true)
    const asteroidLeave = () => sound.current?.asteroidHover(false)
    let lastPointer: { x: number; y: number; time: number } | null = null
    let lastNetworkMotion = 0
    const networkMove = (event: PointerEvent) => {
      if (event.pointerType === 'touch' || motionPreference.matches || document.hidden) return
      const now = performance.now()
      const phase = chapterPhase()
      if (lastPointer && phase >= 1.75 && phase <= 2.45) {
        const distance = Math.hypot(event.clientX - lastPointer.x, event.clientY - lastPointer.y)
        const elapsed = now - lastPointer.time
        if (distance > 0 && elapsed < 250) {
          sound.current?.networkMovement(Math.min(1, 0.2 + distance / Math.max(8, elapsed) * 0.6))
          lastNetworkMotion = now
        }
      }
      lastPointer = { x: event.clientX, y: event.clientY, time: now }
    }
    const stopNetwork = () => {
      lastPointer = null
      lastNetworkMotion = 0
      sound.current?.networkMovement(0)
    }
    const networkIdle = window.setInterval(() => {
      const phase = chapterPhase()
      if (lastNetworkMotion && (performance.now() - lastNetworkMotion > 220 || phase < 1.75 || phase > 2.45 || motionPreference.matches)) stopNetwork()
    }, 100)
    const pointerLeave = (event: PointerEvent) => { if (!event.relatedTarget) stopNetwork() }
    const thresholds = [0.55, 1.52, 2.52, 3.55]
    const armed = thresholds.map(() => true)
    let previousPhase = rawChapterPhase()
    let lastTransition = 0
    const transition = () => {
      const phase = rawChapterPhase()
      let delta = phase - previousPhase
      // The loop seam goes from 4 back to 0, not across the whole timeline.
      if (delta > 2) delta -= 4
      if (delta < -2) delta += 4
      const next = previousPhase + delta
      thresholds.forEach((threshold, index) => {
        const distance = Math.abs(phase - threshold)
        if (Math.min(distance, 4 - distance) > 0.12) armed[index] = true
        const crossed = [-4, 0, 4].some((offset) => {
          const boundary = threshold + offset
          return delta > 0 ? previousPhase < boundary && next >= boundary : previousPhase > boundary && next <= boundary
        })
        if (crossed && armed[index] && !document.hidden && performance.now() - lastTransition > 900) {
          sound.current?.transition(index, delta > 0)
          lastTransition = performance.now()
          armed[index] = false
        }
      })
      previousPhase = phase
    }
    const click = (event: MouseEvent) => {
      if (event.target instanceof Element && event.target.closest('header a, .cta')) sound.current?.cue('navigation')
    }
    const visibility = () => {
      const current = sound.current
      if (!current) return
      if (document.hidden) { stopNetwork(); asteroidLeave(); void current.suspend() }
      else void current.resume().catch(() => setError(true))
    }
    // iOS can interrupt audio independently of page visibility. Retry only on
    // a genuine user gesture, while the visitor has opted in to sound.
    const recoverAudio = () => {
      const current = sound.current
      if (current && !current.isRunning && !document.hidden) void current.resume().catch(() => setError(true))
    }
    update()
    window.addEventListener('ore-ripple', crystal)
    window.addEventListener('ore-crystal-hover', crystal)
    window.addEventListener('ore-crystal-hover', asteroidEnter)
    window.addEventListener('ore-crystal-leave', asteroidLeave)
    window.addEventListener('pointermove', networkMove, { passive: true })
    window.addEventListener('pointerout', pointerLeave)
    window.addEventListener('blur', stopNetwork)
    window.addEventListener('blur', asteroidLeave)
    window.addEventListener('scroll', transition, { passive: true })
    window.addEventListener('pointerdown', recoverAudio, { passive: true })
    document.addEventListener('click', click)
    document.addEventListener('visibilitychange', visibility)
    return () => {
      window.clearInterval(music)
      window.clearInterval(ambience)
      window.clearInterval(networkIdle)
      window.removeEventListener('ore-ripple', crystal)
      window.removeEventListener('ore-crystal-hover', crystal)
      window.removeEventListener('ore-crystal-hover', asteroidEnter)
      window.removeEventListener('ore-crystal-leave', asteroidLeave)
      window.removeEventListener('pointermove', networkMove)
      window.removeEventListener('pointerout', pointerLeave)
      window.removeEventListener('blur', stopNetwork)
      window.removeEventListener('blur', asteroidLeave)
      window.removeEventListener('scroll', transition)
      window.removeEventListener('pointerdown', recoverAudio)
      document.removeEventListener('click', click)
      document.removeEventListener('visibilitychange', visibility)
    }
  }, [enabled])

  const toggle = async () => {
    setError(false)
    if (enabled) {
      const current = sound.current
      sound.current = null
      setEnabled(false)
      if (current) await current.close()
      return
    }
    setStarting(true)
    let current: Soundscape | null = null
    try {
      current = new Soundscape()
      await current.start()
      sound.current = current
      setEnabled(true)
    } catch {
      if (current) void current.close()
      setError(true)
    } finally {
      setStarting(false)
    }
  }

  return <div className="sound-control">
    <button type="button" className="sound-toggle" aria-pressed={enabled} aria-label={enabled ? 'Turn sound off' : 'Turn sound on'} disabled={starting} onClick={() => { setShowSoundHint(false); void toggle() }}>
      <span className="sound-indicator" aria-hidden="true" /> Sound {enabled ? 'on' : 'off'}
    </button>
    {showSoundHint && <span className="sound-hint" aria-hidden="true">Better with sound</span>}
    {error && <span className="sound-error" role="status">Sound unavailable</span>}
  </div>
}

const CHAPTERS = ['Signal', 'Void', 'Mind', 'Potential']

// Highlight the chapter in view. The tail of Potential is the loop back into
// Signal, so it already counts as Signal.
function useActiveChapter() {
  const [active, setActive] = useState(0)
  useEffect(() => {
    const update = () => {
      const phase = rawChapterPhase()
      setActive(phase >= 3.82 ? 0 : Math.floor(phase))
    }
    update()
    window.addEventListener('scroll', update, { passive: true })
    window.addEventListener('resize', update)
    return () => {
      window.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
    }
  }, [])
  return active
}

export function Experience() {
  useScrollProgress()
  const activeChapter = useActiveChapter()
  const { reducedMotion, documentVisible } = useRenderPreferences()
  useIdleJourney(reducedMotion)
  return (
    <main>
      <div className="webgl-shell" aria-hidden="true"><CanvasBoundary><SignalCanvas reducedMotion={reducedMotion} documentVisible={documentVisible} /></CanvasBoundary></div>
      <header className="chrome">
        <a className="brand" href="#signal" aria-label="Claude Expert home">claude<span>.expert</span></a>
        <div className="chrome-controls">
          <nav aria-label="Chapters">
            {CHAPTERS.map((chapter, index) => <a key={chapter} className={index === activeChapter ? 'is-active' : undefined} aria-current={index === activeChapter ? 'location' : undefined} href={`#${chapter.toLowerCase()}`}>{chapter}</a>)}
          </nav>
          <SoundToggle />
        </div>
      </header>

      <PotentialChapter id="lead" hidden />
      <SignalChapter id="signal" />

      <section id="void" className="chapter void" aria-label="Chapter two: Void">
      </section>

      <section id="mind" className="chapter mind" aria-label="Chapter three: Mind">
        <p>Mind</p>
        <div><RainHeadline lines={['Connect', 'the dots']} /></div>
      </section>
      <PotentialChapter id="potential" />
      <SignalChapter id="loop" hidden />
    </main>
  )
}

function RainHeadline({ lines, hero = false, onReveal }: { lines: string[]; hero?: boolean; onReveal?: () => void }) {
  const heading = useRef<HTMLHeadingElement>(null)
  const [revealed, setRevealed] = useState(false)
  useEffect(() => {
    const element = heading.current
    if (!element) return
    const reveal = () => { setRevealed(true); onReveal?.() }
    if (!('IntersectionObserver' in window)) { reveal(); return }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) { reveal(); observer.disconnect() }
    }, { threshold: 0.2 })
    observer.observe(element)
    return () => observer.disconnect()
  }, [onReveal])
  const rainLetters = (text: string, offset: number) => [...text].map((letter, index) => {
    if (letter === ' ') return <span key={index} className="rain-space">&nbsp;</span>
    const sequence = offset + index
    return <span key={index} className="rain-letter" data-letter={letter} style={{ '--glyph-delay': `${-((sequence * 0.61) % 7)}s`, '--reveal-delay': `${sequence * 65}ms`, '--neural-delay': `${Math.floor(sequence / 3) * 115 + (sequence % 3) * 20}ms`, '--exit-delay': `${(sequence % 7) * 35}ms`, '--shard-direction': sequence % 2 ? '-1' : '1' } as CSSProperties}>
      <span className="rain-resolved"><span>{letter}</span></span>
    </span>
  })
  const content = <span aria-hidden="true">{lines.map((line, index) => <span key={index} className="rain-line">{rainLetters(line, lines.slice(0, index).reduce((sum, previous) => sum + [...previous].length + 1, 0))}</span>)}</span>
  const label = lines.join(' ')
  const className = `rain-headline ${hero ? 'headline-fall' : onReveal ? 'headline-crystal' : 'headline-neural'} ${revealed ? 'is-revealed' : 'is-waiting'}`
  return hero ? <h1 ref={heading} className={className} aria-label={label}>{content}</h1> : <h2 ref={heading} className={className} aria-label={label}>{content}</h2>
}

// Chapter one, rendered twice: once at the top and once after Potential as the seam for the infinite loop.
function SignalChapter({ id, hidden = false }: { id: string; hidden?: boolean }) {
  return (
      <section id={id} className="chapter signal" aria-hidden={hidden || undefined}>
        <div className="chapter-index">Signal</div>
        <div className="hero-copy">
          <RainHeadline hero lines={['Learn to build', 'this in one day']} />
          <p className="deck">Every breakthrough starts as a small, living pattern inside the noise.</p>
        </div>
        <div className="scroll-prompt">Scroll to decode</div>
      </section>
  )
}

// Potential is rendered twice: once in place and once above Signal as the seam for scrolling upward.
function PotentialChapter({ id, hidden = false }: { id: string; hidden?: boolean }) {
  const [titleRevealed, setTitleRevealed] = useState(false)
  const revealTitle = useMemo(() => () => setTitleRevealed(true), [])
  return (
      <section id={id} className="chapter potential" aria-label={hidden ? undefined : 'Chapter four: Potential'} aria-hidden={hidden || undefined} inert={hidden || undefined}>
        <p>Potential</p>
        <div className="potential-copy"><RainHeadline lines={['Learn to Create', 'Web Experiences', 'like this']} onReveal={revealTitle} />{!hidden && <span className="cta-anchor"><a className={`cta ${titleRevealed ? 'cta-arriving' : 'cta-waiting'}`} href="https://claude-expert.pages.dev/"><span className="cta-sweep" aria-hidden="true" /><span className="cta-glyphs" aria-hidden="true">ᚫ ⊹ ᛟ ⌁</span><span className="cta-label">become claude.expert</span><span className="cta-arrow" aria-hidden="true">↗︎</span></a></span>}</div>
      </section>
  )
}
