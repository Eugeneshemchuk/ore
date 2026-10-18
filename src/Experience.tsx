import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { useMemo, useRef, useState, useEffect } from 'react'
import * as THREE from 'three'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'

// Alien runes plus half-width katakana (mirrored at draw time, as in the film) for the digital rain atlas.
const RUNES = [...'ᚫϟ⊹ᛟ⌁⋔ᚢϞ⊙ᚨ⌇⟐ᛉ∴']
const KATAKANA = [...'ﾊﾐﾋｰｳｼﾅﾓﾆｻﾜﾂｵﾘｱﾎﾃﾏｹﾒｴｶｷﾑﾕﾗｾﾈｽﾀﾇﾍ']
const ATLAS_COLUMNS = 8
const RAIN_CELL_PX = window.innerWidth < 720 ? 15 : 19

// Scene progress 0..1 across the three chapters, rewinding to 0 while the looped copy of chapter one scrolls in.
// The page repeats every loop period, so positions in the lead-in copy of chapter three map onto the real one.
function loopProgress() {
  const start = document.getElementById('signal')?.offsetTop ?? 0
  const end = (document.getElementById('potential')?.offsetTop ?? 0) - start
  const period = Math.max(1, (document.getElementById('loop')?.offsetTop ?? 0) - start)
  const y = (((window.scrollY - start) % period) + period) % period
  if (y <= end) return y / Math.max(1, end)
  return 1 - Math.min(1, (y - end) / Math.max(1, period - end))
}

const rainVertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
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
  uniform vec2 uPointer;
  varying vec2 vUv;

  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

  // Returns distance (in rows) behind the drop's head, or -1 when this cell is outside the drop.
  float drop(float column, float row, float salt) {
    float speed = 7.0 + hash(vec2(column, salt)) * 13.0;
    float trail = 8.0 + hash(vec2(column, salt + 7.0)) * 22.0;
    float period = uCells.y + trail + hash(vec2(column, salt + 3.0)) * uCells.y;
    float head = floor(mod(uTime * speed + hash(vec2(column, salt + 1.0)) * period, period));
    float behind = head - row;
    return behind >= 0.0 && behind < trail ? behind / trail : -1.0;
  }

  void main() {
    vec2 grid = vUv * uCells;
    vec2 cell = floor(grid);
    vec2 local = fract(grid);
    float row = uCells.y - 1.0 - cell.y;

    float a = drop(cell.x, row, 0.0);
    float b = drop(cell.x, row, 41.0);
    float t = a < 0.0 ? b : (b < 0.0 ? a : min(a, b));

    float near = smoothstep(0.22, 0.0, length((vUv - uPointer) * vec2(uCells.x / uCells.y, 1.0)));
    if (t < 0.0 && near < 0.01) discard;

    // Symbols mutate, faster near the head of a drop.
    float rate = mix(9.0, 1.2, clamp(t, 0.0, 1.0)) * (0.4 + hash(cell));
    float glyph = floor(hash(cell + floor(uTime * rate) * 0.137) * uGlyphCount);
    vec2 atlasCell = vec2(mod(glyph, uAtlasGrid.x), floor(glyph / uAtlasGrid.x));
    vec2 atlasUv = (atlasCell + vec2(local.x, 1.0 - local.y)) / uAtlasGrid;
    vec2 gradient = vUv * uCells / uAtlasGrid;
    float ink = textureGrad(uAtlas, vec2(atlasUv.x, 1.0 - atlasUv.y), dFdx(gradient), dFdy(gradient)).a;

    float leader = t >= 0.0 ? step(t, 0.02) : 0.0;
    float tail = t >= 0.0 ? pow(1.0 - t, 1.6) : 0.0;
    vec3 green = vec3(0.12, 1.0, 0.42);
    vec3 color = green * tail * 0.85 + vec3(0.78, 1.0, 0.86) * leader * 1.4 + green * near * 0.35;
    float glow = exp(-dot(local - 0.5, local - 0.5) * 9.0) * leader * 0.18;
    // Thin the rain behind the headline so the copy stays legible.
    vec2 screen = (vUv - 0.5) * 1.2 + 0.5;
    float copy = smoothstep(0.62, 0.42, screen.x) * smoothstep(0.22, 0.38, screen.y) * smoothstep(0.78, 0.62, screen.y);
    gl_FragColor = vec4(color * ink + green * glow, 1.0) * uOpacity * (1.0 - copy * 0.6);
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

function DigitalRain() {
  const material = useRef<THREE.ShaderMaterial>(null)
  const pointer = useRef(new THREE.Vector2(9, 9))
  const { camera, size, pointer: cursor, viewport } = useThree()
  const atlas = useMemo(glyphAtlas, [])
  const depth = -1.5
  // Oversize the plane so the camera's drift never reveals an edge.
  const { width, height } = viewport.getCurrentViewport(camera, new THREE.Vector3(0, 0, depth))
  const plane = { width: width * 1.2, height: height * 1.2 }
  const columns = Math.round((size.width * 1.2) / RAIN_CELL_PX)
  const cells = new THREE.Vector2(columns, Math.round(columns * (plane.height / plane.width) / 1.3))
  const uniforms = useMemo(() => ({
    uAtlas: { value: atlas.texture },
    uAtlasGrid: { value: atlas.grid },
    uGlyphCount: { value: atlas.count },
    uCells: { value: new THREE.Vector2() },
    uTime: { value: 0 },
    uOpacity: { value: 1 },
    uPointer: { value: new THREE.Vector2(9, 9) },
  }), [atlas])
  useEffect(() => () => atlas.texture.dispose(), [atlas])

  useFrame(({ clock }) => {
    if (!material.current) return
    const visible = 1 - THREE.MathUtils.smoothstep(loopProgress(), 0.08, 0.45)
    pointer.current.lerp(new THREE.Vector2(cursor.x / 2.4 + 0.5, cursor.y / 2.4 + 0.5), 0.08)
    // The material holds its own copy of the uniforms, so write through it rather than the memoized object.
    const live = material.current.uniforms
    live.uTime.value = clock.getElapsedTime()
    live.uOpacity.value = visible * 0.82
    live.uCells.value.copy(cells)
    live.uPointer.value.copy(pointer.current)
    material.current.visible = visible > 0.001
  })

  return <mesh position={[0, 0, depth]} renderOrder={-1} frustumCulled={false}>
    <planeGeometry args={[plane.width, plane.height]} />
    <shaderMaterial ref={material} transparent depthWrite={false} blending={THREE.AdditiveBlending} uniforms={uniforms} vertexShader={rainVertexShader} fragmentShader={rainFragmentShader} />
  </mesh>
}

function NeuralNetwork({ progress }: { progress: number }) {
  const group = useRef<THREE.Group>(null)
  const nodeMaterial = useRef<THREE.PointsMaterial>(null)
  const lineMaterial = useRef<THREE.LineBasicMaterial>(null)
  const { nodes, links } = useMemo(() => {
    const positions: THREE.Vector3[] = []
    const seed = (index: number) => {
      const angle = index * 2.3999632297
      const radius = Math.sqrt(index / 146) * 2.8
      return new THREE.Vector3(
        Math.cos(angle) * radius + (Math.random() - 0.5) * 0.35,
        Math.sin(angle * 1.63) * radius * 0.58,
        (Math.random() - 0.5) * 2.5,
      )
    }
    for (let i = 0; i < 360; i += 1) positions.push(seed(i))
    const linkData: number[] = []
    positions.forEach((from, i) => {
      const candidates = positions
        .map((to, j) => ({ j, d: from.distanceToSquared(to) }))
        .filter(({ j, d }) => j > i && d < 1.75)
        .sort((a, b) => a.d - b.d)
        .slice(0, 3)
      candidates.forEach(({ j }) => linkData.push(from.x, from.y, from.z, positions[j].x, positions[j].y, positions[j].z))
    })
    const nodeGeometry = new THREE.BufferGeometry().setFromPoints(positions)
    const linkGeometry = new THREE.BufferGeometry()
    linkGeometry.setAttribute('position', new THREE.Float32BufferAttribute(linkData, 3))
    return { nodes: nodeGeometry, links: linkGeometry }
  }, [])

  useFrame(({ clock }) => {
    const pageProgress = loopProgress()
    const visible = THREE.MathUtils.smoothstep(pageProgress, 0.23, 0.38) * (1 - THREE.MathUtils.smoothstep(pageProgress, 0.69, 0.84))
    if (group.current) {
      group.current.rotation.y = clock.getElapsedTime() * 0.06
      group.current.rotation.x = Math.sin(clock.getElapsedTime() * 0.11) * 0.12
      group.current.scale.setScalar(0.8 + visible * 0.3)
    }
    if (nodeMaterial.current) {
      nodeMaterial.current.opacity = visible
      nodeMaterial.current.size = 0.065 + Math.sin(clock.getElapsedTime() * 2.1) * 0.01
    }
    if (lineMaterial.current) lineMaterial.current.opacity = visible * 0.55
  })

  return <group ref={group} position={[1.55, -0.1, -0.55]}>
    <lineSegments geometry={links}>
      <lineBasicMaterial ref={lineMaterial} color="#d9e3e5" transparent opacity={0} depthWrite={false} />
    </lineSegments>
    <points geometry={nodes}>
      <pointsMaterial ref={nodeMaterial} color="#f06e4e" transparent opacity={0} size={0.065} sizeAttenuation depthWrite={false} blending={THREE.AdditiveBlending} />
    </points>
  </group>
}

function CosmicParticles() {
  const field = useRef<THREE.Points>(null)
  const material = useRef<THREE.PointsMaterial>(null)
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
  useFrame(({ clock }) => {
    const p = loopProgress()
    if (field.current) {
      field.current.rotation.y = clock.getElapsedTime() * 0.012
      field.current.rotation.z = Math.sin(clock.getElapsedTime() * 0.07) * 0.03
    }
    if (material.current) material.current.opacity = 0.14 + THREE.MathUtils.smoothstep(p, 0.52, 0.88) * 0.42
  })
  return <points ref={field} geometry={geometry}>
    <pointsMaterial ref={material} color="#d7e2e2" size={0.024} sizeAttenuation transparent opacity={0.14} depthWrite={false} />
  </points>
}

function CameraDirector() {
  const { camera, pointer } = useThree()
  const currentLook = useRef(new THREE.Vector3())
  const targetPosition = useRef(new THREE.Vector3())
  const targetLook = useRef(new THREE.Vector3())
  useFrame(({ clock }) => {
    const p = loopProgress()
    const transitionOne = THREE.MathUtils.smoothstep(p, 0.22, 0.46)
    const transitionTwo = THREE.MathUtils.smoothstep(p, 0.57, 0.82)
    targetPosition.current.set(0, 0, 6.3).lerp(new THREE.Vector3(1.1, 0.08, 4.15), transitionOne).lerp(new THREE.Vector3(-0.42, 0.08, 5.7), transitionTwo)
    targetPosition.current.x += pointer.x * 0.22
    targetPosition.current.y += pointer.y * 0.14
    targetPosition.current.z += Math.sin(clock.getElapsedTime() * 0.45) * 0.13
    targetLook.current.set(0, 0, 0).lerp(new THREE.Vector3(2.05, 0, -0.65), transitionOne).lerp(new THREE.Vector3(1.45, 0, 0), transitionTwo)
    camera.position.lerp(targetPosition.current, 0.035)
    currentLook.current.lerp(targetLook.current, 0.035)
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
  // Smoky quartz: near-transparent glass at the root darkening to dense brown-grey at the tip (RGBA vertex colours).
  const pos = geometry.attributes.position
  const colors = new Float32Array(pos.count * 4)
  const clear = new THREE.Color('#e4e8ea')
  const smoke = new THREE.Color('#3a2c22')
  const c = new THREE.Color()
  for (let i = 0; i < pos.count; i += 1) {
    const t = THREE.MathUtils.smoothstep(pos.getY(i), -height / 2, height / 2)
    c.lerpColors(clear, smoke, t)
    colors.set([c.r, c.g, c.b, THREE.MathUtils.lerp(0.12, 0.88, t)], i * 4)
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 4))
  return geometry
}

// Ryugu-style spinning top: a double cone with a sharp equatorial ridge, rounded poles, light lumps and a few craters.
const CRATERS = [new THREE.Vector3(0.7, 0.2, 0.68), new THREE.Vector3(-0.5, -0.45, 0.72), new THREE.Vector3(-0.8, 0.3, -0.5), new THREE.Vector3(0.2, -0.5, -0.8)].map((v) => v.normalize())
function rockRadius(d: THREE.Vector3) {
  const equator = 1.32
  const pole = 1.12
  const lat = Math.sqrt(1 - d.y * d.y)
  const cone = 1 / (Math.abs(d.y) / pole + lat / equator)
  let r = THREE.MathUtils.lerp(cone, 1.2, 0.18) * (1 + Math.sin(d.x * 4.1 + 1.3) * Math.sin(d.z * 3.7) * 0.04 + Math.sin(d.y * 13.0 + d.z * 11.0) * 0.015)
  CRATERS.forEach((c, i) => { r -= Math.max(0, d.dot(c) - (i === 0 ? 0.9 : 0.95)) * 2.2 })
  return r
}

function OreCrystal() {
  const outer = useRef<THREE.Group>(null)
  const group = useRef<THREE.Group>(null)
  const materials = useRef<THREE.Material[]>([])
  const hover = useRef(0)
  const hit = useRef(false)
  const mouse = useRef(new THREE.Vector2(9, 9))
  // Drag-to-rotate: accumulated user spin plus a velocity that decays for a little inertia after release.
  const drag = useRef({ active: false, x: 0, y: 0 })
  const spin = useRef(new THREE.Vector2())
  const spinVelocity = useRef(new THREE.Vector2())
  const raycaster = useMemo(() => new THREE.Raycaster(), [])
  const { size, gl } = useThree()
  const mobile = size.width < 720
  const envMap = useMemo(() => {
    const pmrem = new THREE.PMREMGenerator(gl)
    const texture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
    pmrem.dispose()
    return texture
  }, [gl])
  const scene = useMemo(() => {
    const rock = new THREE.IcosahedronGeometry(1, 5)
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
        position: dir.clone().multiplyScalar(rockRadius(dir) * 0.9 + height * 0.36),
        quaternion: new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir),
        tint: new THREE.Color().setHSL(0.07 + (i % 3) * 0.015, 0.12, 0.9 - (i % 4) * 0.05),
      }
    })
    const rubble = Array.from({ length: 7 }, (_, i) => ({
      position: new THREE.Vector3(Math.cos(i * 0.9) * (1.9 + (i % 3) * 0.25), Math.sin(i * 1.9) * 0.9, Math.sin(i * 0.9) * 1.6),
      scale: 0.07 + (i % 3) * 0.05,
    }))
    const grid = new THREE.WireframeGeometry(new THREE.SphereGeometry(1.5, 18, 12))
    // Ryugu is strewn with boulders, with one oversized block near the south pole.
    const boulders = Array.from({ length: 36 }, (_, i) => {
      const y = i === 0 ? -0.96 : 1 - (i / 35) * 2
      const dir = new THREE.Vector3(Math.cos(i * 2.39996) * Math.sqrt(1 - y * y), y, Math.sin(i * 2.39996) * Math.sqrt(1 - y * y)).normalize()
      const scale = i === 0 ? 0.24 : 0.035 + ((i * 5) % 7) * 0.012
      return { position: dir.clone().multiplyScalar(rockRadius(dir) + scale * 0.3), scale, rotation: [i, i * 1.3, i * 0.7] as [number, number, number] }
    })
    return { rock, crystals, rubble, boulders, grid }
  }, [])
  const gridMaterial = useMemo(() => new THREE.LineBasicMaterial({ color: '#b9d6df', transparent: true, opacity: 0, depthWrite: false }), [])

  useEffect(() => {
    // The canvas ignores pointer events (content sits above it), so track the cursor and drags on the window.
    const move = (e: PointerEvent) => {
      mouse.current.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1)
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
      if (!hit.current) return
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
    // Hold the page still while a touch drag is rotating the asteroid.
    const touchMove = (e: TouchEvent) => { if (drag.current.active) e.preventDefault() }
    window.addEventListener('pointermove', move, { passive: true })
    window.addEventListener('pointerdown', down)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    window.addEventListener('touchmove', touchMove, { passive: false })
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerdown', down)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      window.removeEventListener('touchmove', touchMove)
      document.body.style.cursor = ''
      envMap.dispose()
      scene.rock.dispose()
      scene.grid.dispose()
      scene.crystals.forEach((c) => c.geometry.dispose())
      gridMaterial.dispose()
    }
  }, [envMap, scene, gridMaterial])

  useFrame(({ clock, camera }) => {
    const p = loopProgress()
    const visible = THREE.MathUtils.smoothstep(p, 0.69, 0.84)
    const t = clock.getElapsedTime()
    if (group.current && outer.current) {
      if (!drag.current.active) {
        spin.current.add(spinVelocity.current)
        spinVelocity.current.multiplyScalar(0.94)
      }
      spin.current.x = THREE.MathUtils.clamp(spin.current.x, -1.2, 1.2)
      group.current.rotation.y = t * 0.12 + p * Math.PI * 1.5 + spin.current.y
      group.current.rotation.x = 0.12 + Math.sin(t * 0.3) * 0.06 + (p - 0.8) * 0.4 + spin.current.x
      outer.current.position.y = -0.38 + Math.sin(t * 0.6) * 0.08 + (0.8 - p) * 0.9
      outer.current.scale.setScalar((mobile ? 0.744 : 1.14) * (0.7 + visible * 0.3))
      raycaster.setFromCamera(mouse.current, camera)
      const wasHit = hit.current
      hit.current = visible > 0.5 && raycaster.intersectObject(group.current, true).length > 0
      if (hit.current !== wasHit && !drag.current.active) document.body.style.cursor = hit.current ? 'grab' : ''
      hover.current = THREE.MathUtils.lerp(hover.current, hit.current || drag.current.active ? 1 : 0, 0.08)
    }
    materials.current.forEach((material) => {
      material.opacity = visible
      material.visible = visible > 0.001
    })
    gridMaterial.opacity = hover.current * visible * 0.22
  })

  const keep = (material: THREE.Material | null) => { if (material && !materials.current.includes(material)) materials.current.push(material) }
  return <group ref={outer} position={[mobile ? 1.25 : 2.75, -0.38, -0.35]}>
    <group ref={group}>
      <mesh geometry={scene.rock}>
        <meshStandardMaterial ref={keep} color="#2e3133" envMap={envMap} envMapIntensity={0.35} roughness={0.92} metalness={0.25} flatShading transparent opacity={0} />
      </mesh>
      {scene.crystals.map((c, index) => <mesh key={index} geometry={c.geometry} position={c.position} quaternion={c.quaternion}>
        <meshPhysicalMaterial ref={keep} color={c.tint} vertexColors envMap={envMap} envMapIntensity={1.6} metalness={0.05} roughness={0.08} ior={1.54} specularIntensity={1} clearcoat={1} clearcoatRoughness={0.04} iridescence={0.25} iridescenceIOR={1.4} iridescenceThicknessRange={[180, 620]} flatShading side={THREE.DoubleSide} depthWrite={false} transparent opacity={0} />
      </mesh>)}
      {scene.boulders.map((b, index) => <mesh key={`b${index}`} position={b.position} scale={b.scale} rotation={b.rotation}>
        <dodecahedronGeometry args={[1, 0]} />
        <meshStandardMaterial ref={keep} color="#34383a" roughness={0.95} metalness={0.2} flatShading transparent opacity={0} />
      </mesh>)}
      {scene.rubble.map((r, index) => <mesh key={index} position={r.position} scale={r.scale} rotation={[index, index * 2, 0]}>
        <dodecahedronGeometry args={[1, 0]} />
        <meshStandardMaterial ref={keep} color="#4a4f52" roughness={0.9} metalness={0.3} flatShading transparent opacity={0} />
      </mesh>)}
      <lineSegments geometry={scene.grid} material={gridMaterial} raycast={() => null} />
    </group>
    <pointLight position={[1.4, 2.4, 2.2]} intensity={7} color="#eef4ff" distance={7} />
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

function SignalCanvas({ progress, paused }: { progress: number; paused: boolean }) {
  return (
    <Canvas
      dpr={[1, window.innerWidth < 720 ? 1.5 : 2]}
      frameloop={paused ? 'never' : 'always'}
      camera={{ position: [0, 0, 6.3], fov: 44 }}
      gl={{ antialias: false, powerPreference: 'high-performance', toneMapping: THREE.ACESFilmicToneMapping }}
      fallback={<div className="canvas-fallback">Knowledge begins as signal.</div>}
    >
      <color attach="background" args={['#070809']} />
      <fog attach="fog" args={['#070809', 3.5, 12]} />
      <ambientLight intensity={0.25} color="#b7c5ca" />
      <pointLight position={[3, 2, 4]} intensity={14} color="#f06e4e" distance={10} />
      <pointLight position={[-4, -2, 2]} intensity={8} color="#b9d6df" distance={10} />
      <DigitalRain />
      <CosmicParticles />
      <NeuralNetwork progress={progress} />
      <OreCrystal />
      <CameraDirector />
    </Canvas>
  )
}

function useScrollProgress() {
  const [progress, setProgress] = useState(0)
  useEffect(() => {
    let target = 0
    let current = 0
    let frame = 0
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
      target = loopProgress()
    }
    const tick = () => {
      current += (target - current) * 0.075
      setProgress(current)
      frame = requestAnimationFrame(tick)
    }
    if ('scrollRestoration' in history) history.scrollRestoration = 'manual'
    if (!location.hash) window.scrollTo({ top: seams().start, behavior: 'instant' })
    update()
    window.addEventListener('scroll', update, { passive: true })
    window.addEventListener('resize', update)
    frame = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
    }
  }, [])
  return progress
}

function useRenderPreferences() {
  const [reducedMotion, setReducedMotion] = useState(false)
  const [documentVisible, setDocumentVisible] = useState(true)
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

export function Experience() {
  const progress = useScrollProgress()
  const { reducedMotion, documentVisible } = useRenderPreferences()
  return (
    <main>
      <div className="webgl-shell" aria-hidden="true"><SignalCanvas progress={progress} paused={reducedMotion || !documentVisible} /></div>
      <header className="chrome">
        <a className="brand" href="#signal" aria-label="Claude Expert home">claude<span>.expert</span></a>
        <nav aria-label="Chapters">
          <a className="is-active" href="#signal">Signal</a>
          <a href="#mind">Mind</a>
          <a href="#potential">Potential</a>
        </nav>
      </header>

      <PotentialChapter id="lead" hidden />
      <SignalChapter id="signal" />

      <section id="mind" className="chapter mind" aria-label="Chapter two: Mind">
        <p>Mind</p>
        <div><h2>Applied knowledge<br />is <em>Value.</em></h2><span className="mind-caption">360 nodes / live pathway field</span></div>
      </section>
      <PotentialChapter id="potential" />
      <SignalChapter id="loop" hidden />
    </main>
  )
}

// Chapter one, rendered twice: once at the top and once after chapter three as the seam for the infinite loop.
function SignalChapter({ id, hidden = false }: { id: string; hidden?: boolean }) {
  return (
      <section id={id} className="chapter signal" aria-hidden={hidden || undefined}>
        <div className="chapter-index">Signal</div>
        <div className="hero-copy">
          <h1>Knowledge<br />is <em>abundant.</em></h1>
          <p className="deck">Every breakthrough starts as a small, living pattern inside the noise.</p>
        </div>
        <div className="scroll-prompt">Scroll to decode</div>
      </section>
  )
}

// Chapter three, rendered twice: once in place and once above chapter one as the seam for scrolling upward.
function PotentialChapter({ id, hidden = false }: { id: string; hidden?: boolean }) {
  return (
      <section id={id} className="chapter potential" aria-label={hidden ? undefined : 'Chapter three: Potential'} aria-hidden={hidden || undefined} inert={hidden || undefined}>
        <p>Potential</p>
        <div className="potential-copy"><h2>Learn how to<br /><em>create value</em></h2><p className="ore-note">A rare material. A limitless becoming.</p><a className="cta" href="https://claude-expert.pages.dev/">Learn how to do this <span>↗</span></a></div>
      </section>
  )
}
