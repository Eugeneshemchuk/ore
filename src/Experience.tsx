import { Canvas, useFrame, useLoader, useThree } from '@react-three/fiber'
import { useMemo, useRef, useState, useEffect } from 'react'
import * as THREE from 'three'

const GLYPH_COUNT = 1180

const vertexShader = /* glsl */ `
  uniform float uTime;
  uniform float uProgress;
  uniform vec2 uPointer;
  attribute float aSeed;
  attribute float aSize;
  varying float vSignal;
  void main() {
    vec3 p = position;
    float wave = sin(p.y * 1.9 + uTime * 0.55 + aSeed * 10.0);
    p.x += wave * 0.12;
    p.z += sin(p.x * 2.4 + uTime * 0.3) * 0.06;
    vec2 delta = p.xy - uPointer * vec2(5.2, 3.2);
    float influence = smoothstep(2.2, 0.0, length(delta));
    p.xy += normalize(delta + 0.001) * influence * 0.22;
    vSignal = smoothstep(0.78, 0.98, fract(aSeed * 19.13 + uTime * 0.025 + p.y * 0.075));
    vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
    gl_PointSize = aSize * (62.0 / -mvPosition.z);
    gl_Position = projectionMatrix * mvPosition;
  }
`

const fragmentShader = /* glsl */ `
  uniform float uTime;
  varying float vSignal;
  void main() {
    vec2 uv = gl_PointCoord - 0.5;
    float edge = 1.0 - smoothstep(0.34, 0.5, max(abs(uv.x), abs(uv.y)));
    float notch = step(0.18, abs(uv.x)) * step(0.18, abs(uv.y));
    float glyph = edge * (1.0 - notch * 0.55);
    vec3 mineral = vec3(0.80, 0.86, 0.88);
    vec3 ember = vec3(0.94, 0.31, 0.17);
    vec3 color = mix(mineral, ember, vSignal);
    gl_FragColor = vec4(color, glyph * mix(0.24, 0.95, vSignal));
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

function GlyphField({ progress }: { progress: number }) {
  const material = useRef<THREE.ShaderMaterial>(null)
  const pointer = useRef(new THREE.Vector2(20, 20))
  const { viewport, pointer: cursor } = useThree()

  const geometry = useMemo(() => {
    const positions = new Float32Array(GLYPH_COUNT * 3)
    const seeds = new Float32Array(GLYPH_COUNT)
    const sizes = new Float32Array(GLYPH_COUNT)
    for (let i = 0; i < GLYPH_COUNT; i += 1) {
      const i3 = i * 3
      positions[i3] = (Math.random() - 0.5) * 13
      positions[i3 + 1] = (Math.random() - 0.5) * 8
      positions[i3 + 2] = (Math.random() - 0.5) * 4 - 1.6
      seeds[i] = Math.random()
      sizes[i] = 0.48 + Math.random() * 0.8
    }
    const result = new THREE.BufferGeometry()
    result.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    result.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1))
    result.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1))
    return result
  }, [])

  useFrame(({ clock }) => {
    if (!material.current) return
    const pageProgress = window.scrollY / Math.max(1, document.documentElement.scrollHeight - window.innerHeight)
    pointer.current.lerp(new THREE.Vector2(cursor.x, cursor.y), 0.06)
    material.current.uniforms.uTime.value = clock.getElapsedTime()
    material.current.uniforms.uProgress.value = pageProgress
    material.current.opacity = 1 - THREE.MathUtils.smoothstep(pageProgress, 0.08, 0.45)
    material.current.uniforms.uPointer.value.set(
      pointer.current.x * viewport.width * 0.5,
      pointer.current.y * viewport.height * 0.5,
    )
  })

  return (
    <points geometry={geometry} frustumCulled={false}>
      <shaderMaterial
        ref={material}
        transparent
        depthWrite={false}
        blending={THREE.AdditiveBlending}
        uniforms={{
          uTime: { value: 0 },
          uProgress: { value: 0 },
          uPointer: { value: new THREE.Vector2(20, 20) },
        }}
        vertexShader={vertexShader}
        fragmentShader={fragmentShader}
      />
    </points>
  )
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
    const pageProgress = window.scrollY / Math.max(1, document.documentElement.scrollHeight - window.innerHeight)
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
    const p = window.scrollY / Math.max(1, document.documentElement.scrollHeight - window.innerHeight)
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
    const p = window.scrollY / Math.max(1, document.documentElement.scrollHeight - window.innerHeight)
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

function OreReference() {
  const material = useRef<THREE.MeshBasicMaterial>(null)
  const { size } = useThree()
  const texture = useLoader(THREE.TextureLoader, '/images/silvery-crystals-volcanic-ore.png')
  texture.colorSpace = THREE.SRGBColorSpace
  useFrame(() => {
    const p = window.scrollY / Math.max(1, document.documentElement.scrollHeight - window.innerHeight)
    if (material.current) material.current.opacity = THREE.MathUtils.smoothstep(p, 0.69, 0.84)
  })
  return <mesh position={[size.width < 720 ? 1.05 : 2.55, -0.08, -0.35]} rotation={[0, -0.16, 0]}>
    <planeGeometry args={[size.width < 720 ? 3.9 : 5.15, size.width < 720 ? 3.9 : 5.15]} />
    <meshBasicMaterial ref={material} map={texture} transparent opacity={0} toneMapped={false} />
  </mesh>
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
    const pageProgress = window.scrollY / Math.max(1, document.documentElement.scrollHeight - window.innerHeight)
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
      <GlyphField progress={progress} />
      <CosmicParticles />
      <NeuralNetwork progress={progress} />
      <OreReference />
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
    const update = () => {
      const max = document.documentElement.scrollHeight - window.innerHeight
      target = max > 0 ? window.scrollY / max : 0
    }
    const tick = () => {
      current += (target - current) * 0.075
      setProgress(current)
      frame = requestAnimationFrame(tick)
    }
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
  const [sound, setSound] = useState(false)

  return (
    <main>
      <div className="webgl-shell" aria-hidden="true"><SignalCanvas progress={progress} paused={reducedMotion || !documentVisible} /></div>
      <header className="chrome">
        <a className="brand" href="#signal" aria-label="Claude Expert home">claude<span>.expert</span></a>
        <nav aria-label="Chapters">
          <a className="is-active" href="#signal">01 Signal</a>
          <a href="#mind">02 Mind</a>
          <a href="#potential">03 Potential</a>
        </nav>
        <button type="button" className="sound" onClick={() => setSound(!sound)} aria-pressed={sound}>
          {sound ? 'Sound on' : 'Sound off'}
        </button>
      </header>

      <section id="signal" className="chapter signal">
        <div className="chapter-index">01 / 03 — SIGNAL</div>
        <div className="hero-copy">
          <p className="eyebrow">Claude Expert presents</p>
          <h1>Knowledge<br /><em>begins</em> as signal.</h1>
          <p className="deck">Every breakthrough starts as a small, living pattern inside the noise.</p>
        </div>
        <aside className="alien-card" aria-label="Synthetic signal trace">
          <span>ORIGIN / 0001</span>
          <div className="glyph-sequence" aria-hidden="true">
            <i>ᚫ</i><i>ϟ</i><i>⊹</i><i>ᛟ</i><i>⌁</i>
            <i>⋔</i><i>ᚢ</i><i>Ϟ</i><i>⊙</i><i>ᚨ</i>
            <i>⌇</i><i>⟐</i><i>ᛉ</i><i>ϟ</i><i>∴</i>
          </div>
          <small>DECODE IN PROGRESS</small>
        </aside>
        <div className="scroll-prompt"><span></span> Scroll to decode</div>
      </section>

      <section id="mind" className="chapter mind" aria-label="Chapter two: Mind">
        <p>02 / 03 — MIND</p>
        <div><h2>Signals connect.<br /><em>Intelligence</em> awakens.</h2><span className="mind-caption">360 nodes / live pathway field</span></div>
      </section>
      <section id="potential" className="chapter potential" aria-label="Chapter three: Potential">
        <p>03 / 03 — POTENTIAL</p>
        <div className="potential-copy"><h2>Knowledge,<br /><em>crystallised.</em></h2><p className="ore-note">A rare material. A limitless becoming.</p><a className="cta" href="https://claude-expert.pages.dev/">Learn how to do this <span>↗</span></a></div>
      </section>
    </main>
  )
}
