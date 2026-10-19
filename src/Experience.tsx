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

// Scene progress 0..1 across the three chapters, rewinding to 0 while the looped copy of chapter one scrolls in.
// The page repeats every loop period, so positions in the lead-in copy of chapter three map onto the real one.
function rawChapterPhase() {
  const start = document.getElementById('signal')?.offsetTop ?? 0
  const mind = (document.getElementById('mind')?.offsetTop ?? 0) - start
  const potential = (document.getElementById('potential')?.offsetTop ?? 0) - start
  const period = Math.max(1, (document.getElementById('loop')?.offsetTop ?? 0) - start)
  const y = (((window.scrollY - start) % period) + period) % period
  if (y < mind) return y / Math.max(1, mind)
  if (y < potential) return 1 + (y - mind) / Math.max(1, potential - mind)
  return 2 + (y - potential) / Math.max(1, period - potential)
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
    // Choose the shortest path across the 0/3 boundary instead of rotating through all chapters.
    const difference = ((target - current + 4.5) % 3) - 1.5
    const next = reducedMotion ? target : current + difference * (1 - Math.exp(-dt * (mobile.matches ? 7 : 12)))
    visualPhase = (next + 3) % 3

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

function loopProgress() {
  const phase = chapterPhase()
  return phase <= 2 ? phase / 2 : 3 - phase
}

// The same bridge runs backwards at the loop seam, connecting signal directly to crystal.
function signalDeparture(phase: number) {
  return phase < 1 ? phase : phase > 2 ? 3 - phase : 1
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
}

// Work in screen space so particles at different depths all respond around the
// cursor. Applying the same displacement to link endpoints keeps them attached.
function configureRepulsion(shader: THREE.WebGLProgramParametersWithUniforms, uniforms: RepulsionUniforms) {
  Object.assign(shader.uniforms, uniforms)
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>
      uniform vec2 uRepelPointer;
      uniform float uRepelAspect;
      uniform float uRepelStrength;`)
    .replace('#include <project_vertex>', `#include <project_vertex>
      if (gl_Position.w > 0.0) {
        vec2 screen = gl_Position.xy / gl_Position.w;
        vec2 delta = (screen - uRepelPointer) * vec2(uRepelAspect, 1.0);
        float distanceToPointer = length(delta);
        float influence = 1.0 - smoothstep(0.0, 0.28, distanceToPointer);
        vec2 direction = delta / max(distanceToPointer, 0.001);
        gl_Position.xy += direction / vec2(uRepelAspect, 1.0)
          * influence * 0.16 * uRepelStrength * gl_Position.w;
      }`)
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
    const sceneStrength = THREE.MathUtils.smoothstep(signalDeparture(chapterPhase()), 0.65, 0.95)
    const desired = active.current && !reducedMotion ? sceneStrength : 0
    uniforms.uRepelStrength.value = THREE.MathUtils.lerp(uniforms.uRepelStrength.value, desired, damping)
  })
  return null
}

function NeuralNetwork({ group, oreGroup, repulsion, reducedMotion }: { group: RefObject<THREE.Group | null>; oreGroup: RefObject<THREE.Group | null>; repulsion: RepulsionUniforms; reducedMotion: boolean }) {
  const nodeMaterial = useRef<THREE.PointsMaterial>(null)
  const lineMaterial = useRef<THREE.LineBasicMaterial>(null)
  const [addedNodes, setAddedNodes] = useState<THREE.Vector3[]>([])
  const { camera } = useThree()
  const raycaster = useMemo(() => new THREE.Raycaster(), [])
  const clickPlane = useMemo(() => new THREE.Plane(), [])
  const clickPoint = useMemo(() => new THREE.Vector3(), [])
  const orePosition = useMemo(() => new THREE.Vector3(), [])
  const oreScale = useMemo(() => new THREE.Vector3(), [])
  const oreRotation = useMemo(() => new THREE.Quaternion(), [])
  const initialRotation = useMemo(() => new THREE.Quaternion(), [])
  const previousFold = useRef<number | null>(null)
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
      const angle = index * 2.3999632297
      const radius = Math.sqrt(index / 146) * 2.8
      return new THREE.Vector3(
        Math.cos(angle) * radius + (Math.sin(index * 91.7) * 0.5) * 0.35,
        Math.sin(angle * 1.63) * radius * 0.58,
        Math.sin(index * 43.31) * 1.25,
      )
    }
    for (let i = 0; i < 359; i += 1) positions.push(seed(i))
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
    // New nodes always connect to their nearest existing neighbours, even when clicked outside the original field.
    for (let i = 360; i < positions.length; i += 1) {
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
    const addNode = (event: PointerEvent) => {
      const phase = chapterPhase()
      if (event.pointerType === 'touch' || event.button !== 0 || phase < 0.85 || phase > 1.3 || !group.current || (event.target instanceof Element && event.target.closest('a, button, input, select, textarea'))) return
      raycaster.setFromCamera(new THREE.Vector2(event.clientX / window.innerWidth * 2 - 1, 1 - event.clientY / window.innerHeight * 2), camera)
      group.current.getWorldPosition(clickPoint)
      clickPlane.setFromNormalAndCoplanarPoint(camera.getWorldDirection(new THREE.Vector3()), clickPoint)
      const hit = raycaster.ray.intersectPlane(clickPlane, new THREE.Vector3())
      if (!hit) return
      group.current.worldToLocal(hit)
      setAddedNodes(previous => [...previous.slice(-79), hit])
    }
    window.addEventListener('pointerdown', addNode)
    return () => window.removeEventListener('pointerdown', addNode)
  }, [camera, clickPlane, clickPoint, group, raycaster])
  useEffect(() => {
    previousFold.current = null
    return () => { nodes.dispose(); links.dispose() }
  }, [nodes, links])

  useFrame(({ clock }) => {
    const phase = chapterPhase()
    const fold = reducedMotion ? 0 : THREE.MathUtils.smoothstep(phase, 1.16, 1.62)
    const arrival = THREE.MathUtils.smoothstep(phase, 0.36, 0.82)
    const nodeVisibility = arrival * (1 - THREE.MathUtils.smoothstep(phase, 1.43, 1.86))
    const lineVisibility = arrival * (1 - THREE.MathUtils.smoothstep(phase, 1.36, 1.78))
    if (group.current) {
      // Reset every Euler component before blending: the previous frame's
      // slerp can otherwise leak its Z rotation back into the next frame.
      group.current.rotation.set(Math.sin(clock.getElapsedTime() * 0.11) * 0.12, clock.getElapsedTime() * 0.06, 0)
      group.current.scale.setScalar(0.8 + arrival * 0.3)
      group.current.position.set(1.55, -0.1, -0.55)
      if (oreGroup.current && fold > 0) {
        oreGroup.current.updateWorldMatrix(true, false)
        oreGroup.current.matrixWorld.decompose(orePosition, oreRotation, oreScale)
        initialRotation.copy(group.current.quaternion)
        group.current.position.lerp(orePosition, fold)
        group.current.quaternion.slerpQuaternions(initialRotation, oreRotation, fold)
        group.current.scale.lerp(oreScale, fold)
      }
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
      nodeMaterial.current.opacity = nodeVisibility
      nodeMaterial.current.size = 0.065 + Math.sin(clock.getElapsedTime() * 2.1) * 0.01
    }
    if (lineMaterial.current) lineMaterial.current.opacity = lineVisibility * 0.55
  })

  return <group ref={group} position={[1.55, -0.1, -0.55]}>
    <lineSegments geometry={links} frustumCulled={false}>
      <lineBasicMaterial ref={lineMaterial} color="#d9e3e5" transparent opacity={0} depthWrite={false} onBeforeCompile={repelShader} />
    </lineSegments>
    <points geometry={nodes} frustumCulled={false}>
      <pointsMaterial ref={nodeMaterial} map={nodeTexture} color="#f06e4e" transparent opacity={0} size={0.065} sizeAttenuation depthWrite={false} blending={THREE.AdditiveBlending} onBeforeCompile={repelShader} />
    </points>
  </group>
}

function CosmicParticles({ repulsion }: { repulsion: RepulsionUniforms }) {
  const mobile = useThree((state) => state.size.width < 720)
  const field = useRef<THREE.Points>(null)
  const material = useRef<THREE.PointsMaterial>(null)
  const mindField = useRef<THREE.Points>(null)
  const mindMaterial = useRef<THREE.PointsMaterial>(null)
  const repelShader = useMemo(() => (shader: THREE.WebGLProgramParametersWithUniforms) => configureRepulsion(shader, repulsion), [repulsion])
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
    const networkMask = 1 - THREE.MathUtils.smoothstep(phase, 0.55, 0.9) * (1 - THREE.MathUtils.smoothstep(phase, 1.35, 1.8))
    if (material.current) material.current.opacity = (0.14 + THREE.MathUtils.smoothstep(p, 0.52, 0.88) * 0.42) * networkMask
    if (mindMaterial.current) mindMaterial.current.opacity = 0.42 * THREE.MathUtils.smoothstep(phase, 0.55, 0.9) * (1 - THREE.MathUtils.smoothstep(phase, 1.35, 1.8))
  })
  return <>
    <points ref={field} geometry={geometry}>
      <pointsMaterial ref={material} color="#d7e2e2" size={0.024} sizeAttenuation transparent opacity={0.14} depthWrite={false} onBeforeCompile={repelShader} />
    </points>
    <points ref={mindField} geometry={mindGeometry}>
      <pointsMaterial ref={mindMaterial} color="#d7e2e2" size={0.03} sizeAttenuation transparent opacity={0} depthWrite={false} onBeforeCompile={repelShader} />
    </points>
  </>
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
    uPointer: { value: new THREE.Vector2() }, uAttract: { value: 0 },
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
    motion.current.pointer.lerp(target.current, 1 - Math.exp(-dt * 2))
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
    live.uAttract.value = THREE.MathUtils.lerp(live.uAttract.value, motion.current.active ? 1 : 0, 1 - Math.exp(-dt * 2))
    live.uAspect.value = size.width / Math.max(size.height, 1)
    live.uDpr.value = gl.getPixelRatio()
    const phase = chapterPhase()
    live.uOpacity.value = THREE.MathUtils.smoothstep(phase, 1.35, 1.8) * (1 - THREE.MathUtils.smoothstep(phase, 2.53, 2.97))
  })
  return <points geometry={geometry} frustumCulled={false}>
    <shaderMaterial ref={material} transparent depthWrite={false} blending={THREE.AdditiveBlending} uniforms={uniforms} vertexShader={/* glsl */ `
      attribute float aSeed;
      uniform float uTime, uSwirl, uEnergy, uAttract, uAspect, uDpr;
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
        float influence = 1.0 - smoothstep(0.12, 1.15, distanceToPointer);
        float repel = 1.0 - smoothstep(0.0, 0.25, distanceToPointer);
        vec2 direction = toward / max(distanceToPointer, 0.001);
        vec2 displacement = toward * influence * (0.14 + uEnergy * 0.04) - direction * repel * 0.16;
        clip.xy += displacement / vec2(uAspect, 1.0) * uAttract * clip.w;
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


function CameraDirector({ reducedMotion, neuralGroup, oreGroup, crystalTip, motion }: { reducedMotion: boolean; neuralGroup: RefObject<THREE.Group | null>; oreGroup: RefObject<THREE.Group | null>; crystalTip: RefObject<THREE.Object3D | null>; motion: RefObject<SwarmMotion> }) {
  const { camera } = useThree()
  const currentLook = useRef(new THREE.Vector3())
  const targetPosition = useRef(new THREE.Vector3())
  const targetLook = useRef(new THREE.Vector3())
  const mindPosition = useMemo(() => new THREE.Vector3(1.1, 0.08, 4.15), [])
  const orePosition = useMemo(() => new THREE.Vector3(-0.42, 0.08, 7.2), [])
  const signalPosition = useMemo(() => new THREE.Vector3(0, 0, 6.3), [])
  const signalLook = useMemo(() => new THREE.Vector3(0, 0, 0), [])
  const mindLook = useMemo(() => new THREE.Vector3(2.05, 0, -0.65), [])
  const oreLook = useMemo(() => new THREE.Vector3(1.45, 0.45, 0), [])
  const anchorWorld = useMemo(() => new THREE.Vector3(), [])
  const closePosition = useMemo(() => new THREE.Vector3(), [])
  const closeOffset = useMemo(() => new THREE.Vector3(0.025, 0.015, 0.32), [])
  const oreCenter = useMemo(() => new THREE.Vector3(), [])
  const oreDirection = useMemo(() => new THREE.Vector3(), [])
  const oreDetail = useMemo(() => new THREE.Vector3(), [])
  const oreClosePosition = useMemo(() => new THREE.Vector3(), [])
  useFrame(({ clock }, delta) => {
    const phase = chapterPhase()
    const transitionOne = THREE.MathUtils.smoothstep(phase, 0.35, 0.95)
    const transitionTwo = THREE.MathUtils.smoothstep(phase, 1.2, 1.7)
    const returnToSignal = THREE.MathUtils.smoothstep(phase, 2.55, 3)
    targetPosition.current.copy(signalPosition).lerp(mindPosition, transitionOne).lerp(orePosition, transitionTwo).lerp(signalPosition, returnToSignal)
    targetLook.current.copy(signalLook).lerp(mindLook, transitionOne).lerp(oreLook, transitionTwo).lerp(signalLook, returnToSignal)
    if (!reducedMotion) {
      const bridge = signalDeparture(phase)
      const push = Math.sin(Math.PI * THREE.MathUtils.smoothstep(bridge, 0.1, 1))
      if (phase > 2) targetPosition.current.z -= push * 1.5
      let closeUp = 0
      if (phase < 1 && neuralGroup.current) {
        neuralGroup.current.updateWorldMatrix(true, false)
        anchorWorld.copy(NEURON_ANCHOR)
        neuralGroup.current.localToWorld(anchorWorld)
        closePosition.copy(anchorWorld).add(closeOffset)
        closeUp = THREE.MathUtils.smoothstep(phase, 0.32, 0.57) * (1 - THREE.MathUtils.smoothstep(phase, 0.67, 1.0))
        targetPosition.current.lerp(closePosition, closeUp)
        targetLook.current.lerp(anchorWorld, closeUp)
      }
      if (phase >= 1 && phase < 2 && oreGroup.current && crystalTip.current) {
        // Follow the real tip of the main crystal through the specimen's
        // rotation, then pull back into the established final composition.
        oreGroup.current.getWorldPosition(oreCenter)
        oreDirection.copy(orePosition).sub(oreCenter).normalize()
        crystalTip.current.getWorldPosition(oreDetail)
        oreDetail.y -= 0.14
        oreClosePosition.copy(oreDetail).addScaledVector(oreDirection, 1.35)
        const oreCloseUp = THREE.MathUtils.smoothstep(phase, 1.6, 1.76)
          * (1 - THREE.MathUtils.smoothstep(phase, 1.8, 2.0))
        targetPosition.current.lerp(oreClosePosition, oreCloseUp)
        targetLook.current.lerp(oreDetail, oreCloseUp)
        closeUp = Math.max(closeUp, oreCloseUp)
      }
      const pointer = motion.current.pointer
      const parallax = motion.current.active ? 1 : 0
      targetPosition.current.x += pointer.x * 0.36 * parallax * (1 - closeUp)
      targetPosition.current.y += (pointer.y * 0.24 * parallax + Math.sin(phase * Math.PI * 2 / 3) * 0.25) * (1 - closeUp)
      targetLook.current.x += pointer.x * 0.16 * parallax * (1 - closeUp)
      targetLook.current.y += pointer.y * 0.1 * parallax * (1 - closeUp)
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
const ORE_RIPPLE_LIFETIME = 3.7

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
        float scanDistance = distance(vScanWorld, uScans[i].xyz);
        float fade = smoothstep(0.0, 0.18, age) * (1.0 - smoothstep(0.37, ${ORE_RIPPLE_LIFETIME.toFixed(1)}, age));
        float scanRadius = age * 0.42;
        float ringDistance = (scanDistance - scanRadius) / 0.08;
        float ring = exp(-ringDistance * ringDistance);
        pulse = max(pulse, ring * fade);
        float reached = 1.0 - smoothstep(scanRadius, scanRadius + 0.18, scanDistance);
        scanArea = max(scanArea, reached * fade * (1.0 - smoothstep(0.45, 1.35, scanDistance)));
      }
      vec3 scanWeights = pow(abs(normalize(vScanNormal)), vec3(4.0));
      scanWeights /= max(scanWeights.x + scanWeights.y + scanWeights.z, 0.001);
      vec3 scanCoord = vScanLocal * 15.0;
      float lattice = scanGrid(scanCoord.yz) * scanWeights.x
                    + scanGrid(scanCoord.xz) * scanWeights.y
                    + scanGrid(scanCoord.xy) * scanWeights.z;
      totalEmissiveRadiance += vec3(1.0, 0.34, 0.08) * uScanStrength
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
  const scanState = useRef({ pointerRevision: 0, emittedRevision: 0, next: 0, lastEmission: -1, lastMotion: -1 })
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
    window.addEventListener('pointermove', move, { passive: true })
    window.addEventListener('pointerdown', down)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    return () => {
      window.removeEventListener('pointermove', move)
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
    const p = Math.min(phase / 2, 1)
    const visible = THREE.MathUtils.smoothstep(phase, 1.38, 1.84) * (1 - THREE.MathUtils.smoothstep(phase, 2.53, 2.97))
    const t = clock.getElapsedTime()
    if (glint.current) {
      // Peak at the closest point of the crystal-tip camera move, fading in
      // and out with scroll progress (including when scrolling backwards).
      const sparkle = reducedMotion ? 0 : THREE.MathUtils.smoothstep(phase, 1.64, 1.75) * (1 - THREE.MathUtils.smoothstep(phase, 1.82, 1.94))
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
      const scrollTurn = reducedMotion ? 0 : THREE.MathUtils.smoothstep(phase, 1.35, 2.55)
      group.current.rotation.y = t * 0.12 + p * Math.PI * 1.5 + scrollTurn * Math.PI * 1.35 + spin.current.y
      group.current.rotation.x = 0.12 + Math.sin(t * 0.3) * 0.06 + (p - 0.8) * 0.4 + scrollTurn * 0.25 + spin.current.x
      const revealDrift = reducedMotion ? 0 : THREE.MathUtils.smoothstep(phase, 1.25, 1.5) * (1 - THREE.MathUtils.smoothstep(phase, 1.65, 2))
      outer.current.position.x = (mobile ? 1.25 : 2.75) - revealDrift * 0.35
      outer.current.position.y = -0.38 + Math.sin(t * 0.6) * 0.08 + (0.8 - p) * 0.9
      outer.current.scale.setScalar((mobile ? 0.744 : 1.14) * (0.7 + visible * 0.3))
      raycaster.setFromCamera(mouse.current, camera)
      const wasHit = hit.current
      const intersections = phase >= 1.9 && visible > 0.5 ? raycaster.intersectObject(group.current, true) : []
      hit.current = intersections.length > 0
      if (hit.current && !wasHit && pointerKind.current !== 'touch') window.dispatchEvent(new Event('ore-crystal-hover'))
      const scan = scanState.current
      if (hit.current) {
        group.current.updateWorldMatrix(true, false)
        scanTarget.copy(intersections[0].point)
        group.current.worldToLocal(scanTarget)
        // Avoid a jump when the pointer first lands; then damp its path in 3D.
        if (!wasHit) scanSmoothed.copy(scanTarget)
        else scanSmoothed.lerp(scanTarget, 1 - Math.exp(-Math.min(delta, 0.1) * 16))
      }
      if (hit.current && !reducedMotion && pointerKind.current !== 'touch'
        && scan.pointerRevision !== scan.emittedRevision && now - scan.lastMotion < 0.3 && now - scan.lastEmission >= 0.3) {
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
      material.opacity = visible * THREE.MathUtils.smoothstep(phase, 1.75, 1.98)
    })
    // Fade in the rear light only with the specimen; retain the original key
    // light elsewhere so this pass does not change the other chapters.
    if (oreKeyLight.current) oreKeyLight.current.intensity = THREE.MathUtils.lerp(7, 4.8, visible)
    if (oreRimLight.current) oreRimLight.current.intensity = 16 * visible
    scanUniforms.uScanStrength.value = reducedMotion || pointerKind.current === 'touch' ? 0 : visible
  })

  const keep = (material: THREE.Material | null) => { if (material && !materials.current.includes(material)) materials.current.push(material) }
  return <group ref={outer} position={[mobile ? 1.25 : 2.75, -0.38, -0.35]}>
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

function OreButtonAnchor({ oreGroup, buttonAnchor }: { oreGroup: RefObject<THREE.Group | null>; buttonAnchor: RefObject<HTMLSpanElement | null> }) {
  const point = useMemo(() => new THREE.Vector3(), [])
  const dimensions = useRef({ width: 0, height: 0 })
  const position = useRef<THREE.Vector2 | null>(null)
  const motionPreference = useMemo(() => window.matchMedia('(prefers-reduced-motion: reduce)'), [])
  useEffect(() => {
    const element = buttonAnchor.current
    if (!element) return
    const measure = () => { dimensions.current = { width: element.offsetWidth, height: element.offsetHeight } }
    measure()
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null
    observer?.observe(element)
    window.addEventListener('resize', measure)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', measure)
      element.classList.remove('is-world-anchored')
      element.style.opacity = ''
      element.style.pointerEvents = ''
    }
  }, [buttonAnchor])
  useFrame(({ camera, size }, delta) => {
    const element = buttonAnchor.current
    if (!element || !oreGroup.current) return
    const phase = chapterPhase()
    const visibility = THREE.MathUtils.smoothstep(phase, 1.78, 1.98) * (1 - THREE.MathUtils.smoothstep(phase, 2.48, 2.7))
    element.classList.add('is-world-anchored')
    element.style.opacity = `${visibility}`
    element.style.pointerEvents = visibility > 0.95 ? 'auto' : 'none'
    const link = element.querySelector('a')
    if (link) link.tabIndex = visibility > 0.95 ? 0 : -1
    // A billboard-like point in world space beside the specimen. The DOM link
    // remains accessible and clickable while following the actual 3D camera.
    oreGroup.current.getWorldPosition(point)
    point.x += 0.2
    point.y -= size.width < 720 ? 0.55 : 0.35
    point.project(camera)
    const halfWidth = dimensions.current.width / 2 + 16
    const halfHeight = dimensions.current.height / 2 + (size.width < 720 ? 94 : 60)
    const x = THREE.MathUtils.clamp((point.x * 0.5 + 0.5) * size.width, halfWidth, size.width - halfWidth)
    const y = THREE.MathUtils.clamp((-point.y * 0.5 + 0.5) * size.height, halfHeight, size.height - halfHeight)
    if (!position.current) position.current = new THREE.Vector2(x, y)
    else if (visibility < 0.01 || motionPreference.matches) position.current.set(x, y)
    else {
      const damping = 1 - Math.exp(-Math.min(delta, 0.1) * 6)
      position.current.x = THREE.MathUtils.lerp(position.current.x, x, damping)
      position.current.y = THREE.MathUtils.lerp(position.current.y, y, damping)
    }
    element.style.setProperty('--world-x', `${position.current.x}px`)
    element.style.setProperty('--world-y', `${position.current.y}px`)
  })
  return null
}

function SignalCanvas({ reducedMotion, documentVisible, buttonAnchor }: { reducedMotion: boolean; documentVisible: boolean; buttonAnchor: RefObject<HTMLSpanElement | null> }) {
  const [contextLost, setContextLost] = useState(false)
  const neuralGroup = useRef<THREE.Group>(null)
  const oreGroup = useRef<THREE.Group>(null)
  const crystalTip = useRef<THREE.Object3D>(null)
  const swarmMotion = useRef<SwarmMotion>({ pointer: new THREE.Vector2(), active: false, energy: 0, swirl: 0 })
  const repulsion = useMemo<RepulsionUniforms>(() => ({
    uRepelPointer: { value: new THREE.Vector2() },
    uRepelAspect: { value: 1 },
    uRepelStrength: { value: 0 },
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
      <ParticleSwarm motion={swarmMotion} reducedMotion={reducedMotion} />
      <CosmicParticles repulsion={repulsion} />
      <OreCrystal group={oreGroup} crystalTip={crystalTip} reducedMotion={reducedMotion} />
      <NeuralNetwork group={neuralGroup} oreGroup={oreGroup} repulsion={repulsion} reducedMotion={reducedMotion} />
      <CameraDirector reducedMotion={reducedMotion} neuralGroup={neuralGroup} oreGroup={oreGroup} crystalTip={crystalTip} motion={swarmMotion} />
      <OreButtonAnchor oreGroup={oreGroup} buttonAnchor={buttonAnchor} />
      <RenderOnScroll enabled={reducedMotion && documentVisible} />
    </Canvas>
  )
}

function useScrollProgress() {
  useEffect(() => {
    // Chapter three is copied above chapter one and chapter one below chapter three, so the page can jump
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
    history.replaceState(history.state, '', `${location.pathname}${location.search}#signal`)
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
    let remainder = 0
    let frame = 0
    const pause = () => { lastInteraction = performance.now(); remainder = 0 }
    const tick = (now: number) => {
      const dt = lastFrame ? Math.min((now - lastFrame) / 1000, 0.05) : 0
      lastFrame = now
      const focused = document.activeElement instanceof HTMLElement && document.activeElement !== document.body
      if (!document.hidden && !focused && now - lastInteraction > 5000) {
        remainder += dt * 6 // pixels per second, independent of display refresh rate
        const pixels = Math.floor(remainder)
        if (pixels) {
          remainder -= pixels
          window.scrollBy({ top: pixels, behavior: 'instant' })
        }
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

  useEffect(() => () => { void sound.current?.close(); sound.current = null }, [])
  useEffect(() => {
    if (!enabled) return
    const motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)')
    let lastAudioPhase = chapterPhase()
    let lastCrystalZoom = -Infinity
    const update = () => {
      const phase = chapterPhase()
      sound.current?.update(phase)
      const closeUpReached = (lastAudioPhase < 1.75 && phase >= 1.75 && phase < 2)
        || (lastAudioPhase > 1.82 && phase <= 1.82 && phase > 1)
      if (closeUpReached && !motionPreference.matches && !document.hidden && performance.now() - lastCrystalZoom > 2000) {
        sound.current?.crystalZoom()
        lastCrystalZoom = performance.now()
      }
      const difference = Math.abs(((phase - lastAudioPhase + 4.5) % 3) - 1.5)
      const departure = signalDeparture(phase)
      const presence = THREE.MathUtils.smoothstep(departure, 0.12, 0.42) * (1 - THREE.MathUtils.smoothstep(departure, 0.8, 0.98))
      sound.current?.glyphZoom(motionPreference.matches || document.hidden ? 0 : presence * Math.min(1, difference * 90))
      lastAudioPhase = phase
    }
    const music = window.setInterval(() => sound.current?.note(chapterPhase()), 1700)
    const ambience = window.setInterval(update, 250)
    const crystal = () => sound.current?.cue('crystal')
    let lastPointer: { x: number; y: number; time: number } | null = null
    let lastNetworkMotion = 0
    const networkMove = (event: PointerEvent) => {
      if (event.pointerType === 'touch' || motionPreference.matches || document.hidden) return
      const now = performance.now()
      const phase = chapterPhase()
      if (lastPointer && phase >= 0.75 && phase <= 1.45) {
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
      if (lastNetworkMotion && (performance.now() - lastNetworkMotion > 220 || phase < 0.75 || phase > 1.45 || motionPreference.matches)) stopNetwork()
    }, 100)
    const pointerLeave = (event: PointerEvent) => { if (!event.relatedTarget) stopNetwork() }
    const thresholds = [0.55, 1.52, 2.55]
    const armed = thresholds.map(() => true)
    let previousPhase = rawChapterPhase()
    let lastTransition = 0
    const transition = () => {
      const phase = rawChapterPhase()
      let delta = phase - previousPhase
      // The loop seam goes from 3 back to 0, not across the whole timeline.
      if (delta > 1.5) delta -= 3
      if (delta < -1.5) delta += 3
      const next = previousPhase + delta
      thresholds.forEach((threshold, index) => {
        const distance = Math.abs(phase - threshold)
        if (Math.min(distance, 3 - distance) > 0.12) armed[index] = true
        const crossed = [-3, 0, 3].some((offset) => {
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
      if (document.hidden) { stopNetwork(); void current.suspend() }
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
    window.addEventListener('pointermove', networkMove, { passive: true })
    window.addEventListener('pointerout', pointerLeave)
    window.addEventListener('blur', stopNetwork)
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
      window.removeEventListener('pointermove', networkMove)
      window.removeEventListener('pointerout', pointerLeave)
      window.removeEventListener('blur', stopNetwork)
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
    <button type="button" className="sound-toggle" aria-pressed={enabled} aria-label={enabled ? 'Turn sound off' : 'Turn sound on'} disabled={starting} onClick={() => void toggle()}>
      <span className="sound-indicator" aria-hidden="true" /> Sound {enabled ? 'on' : 'off'}
    </button>
    {error && <span className="sound-error" role="status">Sound unavailable</span>}
  </div>
}

export function Experience() {
  useScrollProgress()
  const { reducedMotion, documentVisible } = useRenderPreferences()
  useIdleJourney(reducedMotion)
  const buttonAnchor = useRef<HTMLSpanElement>(null)
  return (
    <main>
      <div className="webgl-shell" aria-hidden="true"><CanvasBoundary><SignalCanvas reducedMotion={reducedMotion} documentVisible={documentVisible} buttonAnchor={buttonAnchor} /></CanvasBoundary></div>
      <header className="chrome">
        <a className="brand" href="#signal" aria-label="Claude Expert home">claude<span>.expert</span></a>
        <div className="chrome-controls">
          <nav aria-label="Chapters">
            <a className="is-active" href="#signal">Signal</a>
            <a href="#mind">Mind</a>
            <a href="#potential">Potential</a>
          </nav>
          <SoundToggle />
        </div>
      </header>

      <PotentialChapter id="lead" hidden />
      <SignalChapter id="signal" />

      <section id="mind" className="chapter mind" aria-label="Chapter two: Mind">
        <p>Mind</p>
        <div><RainHeadline lines={['When applied', 'it becomes Value']} /><span className="mind-caption">Connecting the right dots</span></div>
      </section>
      <PotentialChapter id="potential" buttonAnchor={buttonAnchor} />
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

// Chapter one, rendered twice: once at the top and once after chapter three as the seam for the infinite loop.
function SignalChapter({ id, hidden = false }: { id: string; hidden?: boolean }) {
  return (
      <section id={id} className="chapter signal" aria-hidden={hidden || undefined}>
        <div className="chapter-index">Signal</div>
        <div className="hero-copy">
          <RainHeadline hero lines={['Knowledge', 'is abundant.']} />
          <p className="deck">Every breakthrough starts as a small, living pattern inside the noise.</p>
        </div>
        <div className="scroll-prompt">Scroll to decode</div>
      </section>
  )
}

// Chapter three, rendered twice: once in place and once above chapter one as the seam for scrolling upward.
function PotentialChapter({ id, hidden = false, buttonAnchor }: { id: string; hidden?: boolean; buttonAnchor?: RefObject<HTMLSpanElement | null> }) {
  const [titleRevealed, setTitleRevealed] = useState(false)
  const revealTitle = useMemo(() => () => setTitleRevealed(true), [])
  return (
      <section id={id} className="chapter potential" aria-label={hidden ? undefined : 'Chapter three: Potential'} aria-hidden={hidden || undefined} inert={hidden || undefined}>
        <p>Potential</p>
        <div className="potential-copy"><RainHeadline lines={['Learn how to', 'build this', 'in 5 days']} onReveal={revealTitle} /><span ref={buttonAnchor} className="cta-anchor"><a className={`cta ${titleRevealed ? 'cta-arriving' : 'cta-waiting'}`} href="https://claude-expert.pages.dev/"><span className="cta-sweep" aria-hidden="true" /><span className="cta-glyphs" aria-hidden="true">ᚫ ⊹ ᛟ ⌁</span><span className="cta-label">become claude.expert</span><span className="cta-arrow" aria-hidden="true">↗︎</span></a></span></div>
      </section>
  )
}
