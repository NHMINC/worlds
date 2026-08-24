/**
 * The survey sky: harvest stars, showpiece nebulae, ISM dust
 * extinction, and the decreed cosmic background — every GPU
 * resource of the once-per-load catalog photograph. This module
 * owns the meshes, materials, the 3D dust texture, and the SOI
 * catalog freeze. It does not know about the ship, the course,
 * or the host system: callers push a bubble centre and a survey
 * dim; place laws stay outside.
 *
 * Dust is never drawn — it is sightline extinction (extinctGlsl)
 * folded into every vertex shader that looks through the disk.
 */
import * as THREE from 'three';
import { UNIVERSE } from '../world/physics';
import {
  HARVEST_L_REF,
  HARVEST_PIN_CANVAS,
  HARVEST_PIN_CORE,
  HARVEST_PSF_A,
  HARVEST_PSF_B,
  HARVEST_DENS_GAIN,
  HARVEST_HUE_FLOOR,
  HARVEST_PSF_CORE,
  HARVEST_WHITE_K,
  whiteRefLinear,
  HARVEST_PSF_TAIL,
  HARVEST_PSF_THRESH,
  HARVEST_SHINE_DIST_P,
  HARVEST_SHINE_DIST_REF,
  HARVEST_SHINE_GAIN,
  HARVEST_SHINE_L_P,
  POINT_FLUX_EPS,
} from './galaxyStar';
import {
  silhouetteCloud,
  nebulaCloud,
  harvestDustVolume,
  sketchMatches,
  type GalaxyFilterName,
  type StarCloud,
} from '../world/sectors';
import type { DustVolume } from '../world/dustVolume';
import { extinctGlsl, SILHOUETTE_VERT, STAR_FRAG } from './skyShaders';
import { extinctLook, extinctT } from '../world/extinct';
import {
  COSMIC_STAR_PIN,
  COSMIC_STAR_PIN_CORE,
  dustFilterFrag,
  cosmicSmudgeFrag,
  cosmicSmudgeVert,
  cosmicStarFrag,
  cosmicStarVert,
  cosmicVert,
  mintCosmicSmudges,
  mintCosmicStars,
} from './cosmicBg';

/** Look test: `?dust=green` / `?fog=green` (or the live knob)
 *  paints a shaded lime skin on the ISM-field ribbons
 *  on the sky — not the catalog pins. */
function dustDebugOn(): boolean {
  if (typeof location === 'undefined') return false;
  return /[?&](?:dust|fog|fox)=green/.test(location.search);
}

/**
 * What the sky borrows from the conductor. Place laws (SOI,
 * survey dim) and the camera stay outside; the sky only needs
 * to wake the loop, size its sprites, and know where the
 * frozen viewpoint is.
 */
export interface SkyHooks {
  wake(n?: number): void;
  pxPerRad(): number;
  pixelRatio(): number;
  /** Inside a host sphere — extinct-knob writes rebake the freeze. */
  hostPresent(): boolean;
  /** Bubble centre (catalog kpc) — the freeze latches this. */
  center(): THREE.Vector3;
}

export class SkySurvey {
  /** Star harvest positions (the vertex shader subtracts uCenter). */
  cloud: StarCloud | null = null;
  /** Nebula catalog — own mesh, rebakes without reminting stars. */
  nebulae: StarCloud | null = null;
  /** Sketch filter — dims non-matching rows, never culls. */
  filter: GalaxyFilterName = 'all';

  private starVis: THREE.BufferAttribute | null = null;
  private nebVis: THREE.BufferAttribute | null = null;
  private silPts: THREE.Points | null = null;
  private silGeo: THREE.BufferGeometry | null = null;
  private silMat: THREE.ShaderMaterial | null = null;
  private silEmisPts: THREE.Points | null = null;
  private silEmisGeo: THREE.BufferGeometry | null = null;
  private silEmisMat: THREE.ShaderMaterial | null = null;
  private silDustTex: THREE.Data3DTexture | null = null;
  /** The dust filter quad: multiplies the background (void clear +
   *  pins + smudges — everything beyond the dust box) by one
   *  per-pixel march. Not a skybox; the background is scene
   *  content and this is the one law that filters it. */
  private cosmicPts: THREE.Mesh | null = null;
  private cosmicGeo: THREE.BufferGeometry | null = null;
  private cosmicMat: THREE.ShaderMaterial | null = null;
  private cosmicStarPts: THREE.Points | null = null;
  private cosmicStarGeo: THREE.BufferGeometry | null = null;
  private cosmicStarMat: THREE.ShaderMaterial | null = null;
  private cosmicSmudgePts: THREE.Points | null = null;
  private cosmicSmudgeGeo: THREE.BufferGeometry | null = null;
  private cosmicSmudgeMat: THREE.ShaderMaterial | null = null;
  /**
   * SOI catalog freeze. Latch uCenter on entry, bake each row's
   * dust column onto aExt, then the vertex march sleeps.
   * -1 = thawed. Pins stay pins.
   */
  private catalogFreezeI = -1;
  private catalogFrozen = false;
  private readonly catalogFreezeCenter = new THREE.Vector3();
  /** The dust volume the materials currently point at. The frame
   *  loop compares it with the cache — the initial boot bake used
   *  to notify nobody, so materials built before it (the cosmic
   *  quad and sprites) kept a dead 1×1 placeholder volume forever
   *  and the background sailed through every cloud. */
  private dustWired: DustVolume | null = null;
  private readonly camRot3 = new THREE.Matrix3();
  /** Last pushed centre + survey dim — rebuilds re-push these. */
  private readonly lastCenter = new THREE.Vector3();
  private lastDim = 1;

  private readonly scene: THREE.Scene;
  private readonly seed: string;
  private readonly hooks: SkyHooks;

  constructor(scene: THREE.Scene, seed: string, hooks: SkyHooks) {
    this.scene = scene;
    this.seed = seed;
    this.hooks = hooks;
  }

  shownCount(): number {
    return (this.cloud?.n ?? 0) + (this.nebulae?.n ?? 0);
  }

  /** Newest mint timestamp across the loaded packs. */
  mintedMs(): number {
    return Math.max(this.cloud?.ms ?? 0, this.nebulae?.ms ?? 0);
  }

  /** True when the luminous harvest is on the GPU. */
  ready(): boolean {
    return Boolean(this.cloud && this.cloud.n > 0 && this.silPts);
  }

  /** Attach stars / nebulae / dust if those caches are warm. */
  bind(): void {
    const stars = silhouetteCloud(this.seed);
    const neb = nebulaCloud(this.seed);
    if (stars) {
      this.cloud = stars;
      if (!this.silPts) this.buildStars();
      else this.pushStored();
    }
    if (neb) {
      this.nebulae = neb;
      if (!this.silEmisPts) this.buildNebulae();
      else this.pushStored();
    }
    if (!this.cosmicPts) this.buildCosmic();
    else this.pushStored();
  }

  // ------------------------------------------------------------ teardown

  private disposeStars(): void {
    if (this.silPts) {
      this.scene.remove(this.silPts);
      this.silGeo?.dispose();
      this.silMat?.dispose();
      this.silPts = null;
      this.silGeo = null;
      this.silMat = null;
      this.starVis = null;
    }
  }

  private disposeNebulae(): void {
    if (this.silEmisPts) {
      this.scene.remove(this.silEmisPts);
      this.silEmisGeo?.dispose();
      this.silEmisMat?.dispose();
      this.silEmisPts = null;
      this.silEmisGeo = null;
      this.silEmisMat = null;
      this.nebVis = null;
    }
  }

  private disposeCosmic(): void {
    if (this.cosmicPts) {
      this.scene.remove(this.cosmicPts);
      this.cosmicGeo?.dispose();
      this.cosmicMat?.dispose();
      this.cosmicPts = null;
      this.cosmicGeo = null;
      this.cosmicMat = null;
    }
    if (this.cosmicStarPts) {
      this.scene.remove(this.cosmicStarPts);
      this.cosmicStarGeo?.dispose();
      this.cosmicStarMat?.dispose();
      this.cosmicStarPts = null;
      this.cosmicStarGeo = null;
      this.cosmicStarMat = null;
    }
    if (this.cosmicSmudgePts) {
      this.scene.remove(this.cosmicSmudgePts);
      this.cosmicSmudgeGeo?.dispose();
      this.cosmicSmudgeMat?.dispose();
      this.cosmicSmudgePts = null;
      this.cosmicSmudgeGeo = null;
      this.cosmicSmudgeMat = null;
    }
  }

  dispose(): void {
    this.disposeStars();
    this.disposeNebulae();
    this.disposeCosmic();
    this.silDustTex?.dispose();
    this.silDustTex = null;
  }

  // ------------------------------------------------------------ uniforms

  private shineUniforms(): Record<string, THREE.IUniform> {
    return {
      uLRef: { value: HARVEST_L_REF },
      uWhiteRef: { value: new THREE.Vector3(...whiteRefLinear(HARVEST_WHITE_K)) },
      uDensGain: { value: HARVEST_DENS_GAIN },
      uHueFloor: { value: HARVEST_HUE_FLOOR },
      uPsfCore: { value: HARVEST_PSF_CORE },
      uPsfTail: { value: HARVEST_PSF_TAIL },
      uPsfA: { value: HARVEST_PSF_A },
      uPsfB: { value: HARVEST_PSF_B },
      uPsfThresh: { value: HARVEST_PSF_THRESH },
      uShineLGain: { value: HARVEST_SHINE_GAIN },
      uSkyDim: { value: 1 },
      uShineLP: { value: HARVEST_SHINE_L_P },
      uShineDistRef: { value: HARVEST_SHINE_DIST_REF },
      uShineDistP: { value: HARVEST_SHINE_DIST_P },
      uPinCanvas: { value: HARVEST_PIN_CANVAS },
      uPinCore: { value: HARVEST_PIN_CORE },
      uFluxEps: { value: POINT_FLUX_EPS },
    };
  }

  /** The nebula-march knobs, shared by every material that compiles STAR_FRAG. */
  private dustUniforms(): Record<string, THREE.IUniform> {
    return {
      uCamRotInv: { value: new THREE.Matrix3() },
      uNebGain: { value: UNIVERSE.NEB_EMISSION },
      uDustSteps: { value: UNIVERSE.DUST_MARCH_STEPS },
      uDustMinPx: { value: UNIVERSE.DUST_MINPX },
      uDustFreq: { value: UNIVERSE.DUST_FREQ },
    };
  }

  /** Extinction knobs — the shared dust law (extinctGlsl) in both vertex shaders. */
  private extinctUniforms(): Record<string, THREE.IUniform> {
    const tex = this.ensureDustTexture();
    const vol = harvestDustVolume(this.seed);
    const origin = vol?.origin ?? [-1, -1, -1];
    const size = vol?.size ?? [2, 2, 2];
    return {
      uExtinctK: { value: UNIVERSE.GALAXY_EXTINCT_K },
      uExtinctMax: { value: UNIVERSE.GALAXY_EXTINCT_MAX },
      uExtinctCut: { value: UNIVERSE.GALAXY_EXTINCT_CUT },
      uExtinctHard: { value: UNIVERSE.GALAXY_EXTINCT_HARD },
      uExtinctAbyss: { value: UNIVERSE.GALAXY_EXTINCT_ABYSS },
      uDustDebug: { value: dustDebugOn() ? 1 : UNIVERSE.GALAXY_DUST_DEBUG },
      uDustRgb: { value: new THREE.Vector3(...UNIVERSE.GALAXY_DUST_RGB) },
      uDustVol: { value: tex },
      uDustOrigin: { value: new THREE.Vector3(origin[0], origin[1], origin[2]) },
      uDustInvSize: { value: new THREE.Vector3(1 / size[0], 1 / size[1], 1 / size[2]) },
      uCatalogFrozen: { value: 0 },
    };
  }

  /** Upload the baked ISM fog. Empty 1³ if the harvest is not in yet. */
  private ensureDustTexture(): THREE.Data3DTexture {
    const vol = harvestDustVolume(this.seed);
    if (this.silDustTex) {
      if (vol && this.silDustTex.image.width <= 1 && vol.nx > 1) {
        this.silDustTex.dispose();
        this.silDustTex = null;
      } else {
        return this.silDustTex;
      }
    }
    const tex = vol
      ? new THREE.Data3DTexture(vol.data, vol.nx, vol.ny, vol.nz)
      : new THREE.Data3DTexture(new Float32Array(1), 1, 1, 1);
    tex.format = THREE.RedFormat;
    tex.type = THREE.FloatType;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.wrapR = THREE.ClampToEdgeWrapping;
    tex.unpackAlignment = 1;
    tex.colorSpace = THREE.NoColorSpace;
    tex.needsUpdate = true;
    this.silDustTex = tex;
    return tex;
  }

  /**
   * Two passes per layer, one shared fragment. Stars MAX into the
   * photograph — a pixel is the brightest source covering it,
   * light does not stack. Additive summing was the blue-star
   * killer: the harvest is ~97% blue B stars, but any two
   * overlapping blue halos summed to white per channel, so hue
   * died wherever stars overlapped (almost everywhere). Under
   * MAX, overlap keeps the colour and whiteout is impossible by
   * construction; density reads as coverage, not accumulation.
   * Emission nebulae keep SCREEN so shells glow and saturate.
   * Dust has no pass: both vertex shaders fold extinction in.
   */
  private makeCloudMaterial(
    vertexShader: string,
    uniforms: Record<string, THREE.IUniform>,
    pass: number,
  ): THREE.ShaderMaterial {
    uniforms.uPass = { value: pass };
    const nebula = pass === 1;
    return new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader: STAR_FRAG,
      uniforms,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.CustomBlending,
      blendEquation: nebula ? THREE.AddEquation : THREE.MaxEquation,
      blendSrc: nebula ? THREE.OneMinusDstColorFactor : THREE.OneFactor,
      blendDst: THREE.OneFactor,
      toneMapped: false,
    });
  }

  private silUniforms(): Record<string, THREE.IUniform> {
    return {
      uCenter: { value: new THREE.Vector3() },
      uScale: { value: 1 },
      uPixel: { value: this.hooks.pixelRatio() },
      uPxPerRad: { value: this.hooks.pxPerRad() },
      uRegionR: { value: UNIVERSE.GALAXY_REGION_R },
      uNebulaPx: { value: UNIVERSE.SILHOUETTE_NEBULA_PX },
      ...this.shineUniforms(),
      ...this.dustUniforms(),
      ...this.extinctUniforms(),
      // Fewer, fuller: the backdrop keeps only showpieces, so its
      // shells get more exposure than the local layer would.
      uNebGain: { value: UNIVERSE.NEB_EMISSION * UNIVERSE.SILHOUETTE_NEB_BOOST },
    };
  }

  // ------------------------------------------------------------ builders

  private buildStars(): void {
    const cloud = silhouetteCloud(this.seed);
    if (!cloud || cloud.n <= 0) return;
    this.disposeStars();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(cloud.pos, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(cloud.col, 3));
    const vis = cloud.gain.slice();
    const visAttr = new THREE.BufferAttribute(vis, 1);
    visAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aVis', visAttr);
    this.starVis = visAttr;
    geo.setAttribute('aLum', new THREE.BufferAttribute(cloud.lum, 1));
    geo.setAttribute('aKind', new THREE.BufferAttribute(cloud.kind, 1));
    geo.setAttribute('aSize', new THREE.BufferAttribute(cloud.size, 1));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(cloud.pulse, 1));
    this.bindExtAttr(geo, cloud.n);
    geo.setDrawRange(0, cloud.n);
    const mat = this.makeCloudMaterial(SILHOUETTE_VERT, this.silUniforms(), 0);
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    pts.renderOrder = -2;
    this.scene.add(pts);
    this.silPts = pts;
    this.silGeo = geo;
    this.silMat = mat;
    this.pushStored();
  }

  private buildNebulae(): void {
    const cloud = nebulaCloud(this.seed);
    if (!cloud || cloud.n <= 0) return;
    this.disposeNebulae();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(cloud.pos, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(cloud.col, 3));
    const vis = cloud.gain.slice();
    const visAttr = new THREE.BufferAttribute(vis, 1);
    visAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aVis', visAttr);
    this.nebVis = visAttr;
    geo.setAttribute('aLum', new THREE.BufferAttribute(cloud.lum, 1));
    geo.setAttribute('aKind', new THREE.BufferAttribute(cloud.kind, 1));
    geo.setAttribute('aSize', new THREE.BufferAttribute(cloud.size, 1));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(cloud.pulse, 1));
    this.bindExtAttr(geo, cloud.n);
    geo.setDrawRange(0, cloud.n);
    const emisMat = this.makeCloudMaterial(SILHOUETTE_VERT, this.silUniforms(), 1);
    const emisPts = new THREE.Points(geo, emisMat);
    emisPts.frustumCulled = false;
    emisPts.renderOrder = -1;
    this.scene.add(emisPts);
    this.silEmisPts = emisPts;
    this.silEmisGeo = geo;
    this.silEmisMat = emisMat;
    this.pushStored();
  }

  private cloudMats(): THREE.ShaderMaterial[] {
    const out: THREE.ShaderMaterial[] = [];
    for (const m of [this.silMat, this.silEmisMat, this.cosmicMat, this.cosmicStarMat, this.cosmicSmudgeMat]) {
      if (m) out.push(m);
    }
    return out;
  }

  /** The void is black by decree — vacuum emits nothing, so there
   *  is no background light for a filter to multiply (sprites
   *  extinct themselves). The fullscreen quad survives only as
   *  the lime fog look-test: visible when debug is on, skipped
   *  entirely otherwise (a fullscreen dust march saved per frame). */
  private applyFilterBlend(mat: THREE.ShaderMaterial): void {
    const debug = ((mat.uniforms.uDustDebug?.value as number) ?? 0) >= 0.5;
    mat.blending = THREE.NoBlending;
    if (this.cosmicPts) this.cosmicPts.visible = debug;
  }

  private buildCosmic(): void {
    if (this.cosmicPts) return;
    const geo = new THREE.PlaneGeometry(2, 2);
    const mat = new THREE.ShaderMaterial({
      vertexShader: cosmicVert(),
      fragmentShader: dustFilterFrag(extinctGlsl(UNIVERSE.GALAXY_EXTINCT_STEPS), UNIVERSE.GALAXY_EXTINCT_STEPS),
      uniforms: {
        uCenter: { value: new THREE.Vector3() },
        uCamRotInv: { value: new THREE.Matrix3() },
        uInvProj: { value: new THREE.Matrix4() },
        ...this.extinctUniforms(),
      },
      transparent: true,
      depthWrite: false,
      depthTest: false,
      toneMapped: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    // The look-test paints over the whole sky, after the sprites.
    mesh.renderOrder = -6;
    this.scene.add(mesh);
    this.cosmicPts = mesh;
    this.cosmicGeo = geo;
    this.cosmicMat = mat;
    this.applyFilterBlend(mat);
    this.buildCosmicSmudges();
    this.buildCosmicStars();
    this.pushStored();
  }

  private cosmicCount(kind: 'star' | 'smudge'): number {
    if (kind === 'star') {
      return Math.max(0, Math.min(UNIVERSE.COSMIC_STAR_N_MAX, Math.round(UNIVERSE.COSMIC_STAR_N)));
    }
    return Math.max(0, Math.min(UNIVERSE.COSMIC_SMUDGE_N_MAX, Math.round(UNIVERSE.COSMIC_SMUDGE_N)));
  }

  private buildCosmicSmudges(): void {
    if (this.cosmicSmudgePts) return;
    const cloud = mintCosmicSmudges(this.seed, UNIVERSE.COSMIC_SMUDGE_N_MAX, UNIVERSE.COSMIC_CLUSTER);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(cloud.pos, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(cloud.col, 3));
    geo.setAttribute('aShine', new THREE.BufferAttribute(cloud.shine, 1));
    geo.setAttribute('aSize', new THREE.BufferAttribute(cloud.size, 1));
    geo.setAttribute('aAspect', new THREE.BufferAttribute(cloud.aspect, 1));
    geo.setAttribute('aAngle', new THREE.BufferAttribute(cloud.angle, 1));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(cloud.seed, 1));
    geo.setAttribute('aCrisp', new THREE.BufferAttribute(cloud.crisp, 1));
    geo.setDrawRange(0, this.cosmicCount('smudge'));
    const mat = new THREE.ShaderMaterial({
      vertexShader: cosmicSmudgeVert(),
      fragmentShader: cosmicSmudgeFrag(extinctGlsl(UNIVERSE.GALAXY_EXTINCT_STEPS)),
      uniforms: {
        uCosmicGain: { value: UNIVERSE.COSMIC_GAIN },
        uSkyDim: { value: 1 },
        uCosmicSize: { value: UNIVERSE.COSMIC_SIZE },
        uPxPerRad: { value: this.hooks.pxPerRad() },
        uCenter: { value: new THREE.Vector3() },
        uCamRotInv: { value: new THREE.Matrix3() },
        ...this.extinctUniforms(),
      },
      transparent: true,
      depthWrite: false,
      depthTest: false,
      // Same MAX law as the stars: light does not stack.
      blending: THREE.CustomBlending,
      blendEquation: THREE.MaxEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      toneMapped: false,
    });
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    pts.renderOrder = -7;
    this.scene.add(pts);
    this.cosmicSmudgePts = pts;
    this.cosmicSmudgeGeo = geo;
    this.cosmicSmudgeMat = mat;
  }

  private remintCosmicSmudges(): void {
    if (!this.cosmicSmudgeGeo) {
      this.buildCosmicSmudges();
      return;
    }
    const cloud = mintCosmicSmudges(this.seed, UNIVERSE.COSMIC_SMUDGE_N_MAX, UNIVERSE.COSMIC_CLUSTER);
    const geo = this.cosmicSmudgeGeo;
    geo.setAttribute('position', new THREE.BufferAttribute(cloud.pos, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(cloud.col, 3));
    geo.setAttribute('aShine', new THREE.BufferAttribute(cloud.shine, 1));
    geo.setAttribute('aSize', new THREE.BufferAttribute(cloud.size, 1));
    geo.setAttribute('aAspect', new THREE.BufferAttribute(cloud.aspect, 1));
    geo.setAttribute('aAngle', new THREE.BufferAttribute(cloud.angle, 1));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(cloud.seed, 1));
    geo.setAttribute('aCrisp', new THREE.BufferAttribute(cloud.crisp, 1));
    geo.setDrawRange(0, this.cosmicCount('smudge'));
  }

  private buildCosmicStars(): void {
    if (this.cosmicStarPts) return;
    const cloud = mintCosmicStars(this.seed, UNIVERSE.COSMIC_STAR_N_MAX);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(cloud.pos, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(cloud.col, 3));
    geo.setAttribute('aShine', new THREE.BufferAttribute(cloud.shine, 1));
    this.bindExtAttr(geo, UNIVERSE.COSMIC_STAR_N_MAX);
    geo.setDrawRange(0, this.cosmicCount('star'));
    const mat = new THREE.ShaderMaterial({
      vertexShader: cosmicStarVert(extinctGlsl(UNIVERSE.GALAXY_EXTINCT_STEPS)),
      fragmentShader: cosmicStarFrag(),
      uniforms: {
        uStarGain: { value: UNIVERSE.COSMIC_STAR_GAIN },
        uSkyDim: { value: 1 },
        uPinCanvas: { value: COSMIC_STAR_PIN },
        uPinCore: { value: COSMIC_STAR_PIN_CORE },
        uCenter: { value: new THREE.Vector3() },
        uWhiteRef: { value: new THREE.Vector3(...whiteRefLinear(HARVEST_WHITE_K)) },
        uCatalogFrozen: { value: 0 },
        ...this.extinctUniforms(),
      },
      transparent: true,
      depthWrite: false,
      depthTest: false,
      // Same MAX law as the stars: light does not stack.
      blending: THREE.CustomBlending,
      blendEquation: THREE.MaxEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      toneMapped: false,
    });
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    pts.renderOrder = -8;
    this.scene.add(pts);
    this.cosmicStarPts = pts;
    this.cosmicStarGeo = geo;
    this.cosmicStarMat = mat;
  }

  // -------------------------------------------------------------- knobs

  /** Live cosmic-engineer write. One uniform, next frame. */
  setLiveUniform(name: string, value: number): void {
    this.hooks.wake();
    // Approach laws live in UNIVERSE and are read each frame.
    if (
      name === 'uTimeLapse' ||
      name === 'uArriveRange' ||
      name === 'uArriveBrake' ||
      name === 'uArriveSky' ||
      name === 'uArriveWarp' ||
      name === 'uArriveK' ||
      name === 'uArriveFill' ||
      name === 'uArriveHold' ||
      name === 'uAimRange' ||
      name === 'uWarpCross' ||
      name === 'uStarBloomThr' ||
      name === 'uStarBloomRad' ||
      name === 'uStarBloomGain'
    ) {
      return;
    }
    if (name === 'uWhiteK') {
      const wb = whiteRefLinear(value);
      for (const mat of this.cloudMats()) {
        const u = mat.uniforms.uWhiteRef;
        if (u) (u.value as THREE.Vector3).set(wb[0], wb[1], wb[2]);
      }
      return;
    }
    if (name === 'uStarN') {
      UNIVERSE.COSMIC_STAR_N = value;
      this.cosmicStarGeo?.setDrawRange(0, this.cosmicCount('star'));
      return;
    }
    if (name === 'uSmudgeN') {
      UNIVERSE.COSMIC_SMUDGE_N = value;
      this.cosmicSmudgeGeo?.setDrawRange(0, this.cosmicCount('smudge'));
      return;
    }
    if (name === 'uCosmicCluster') {
      for (const mat of this.cloudMats()) {
        const u = mat.uniforms[name];
        if (u) u.value = value;
      }
      this.remintCosmicSmudges();
      return;
    }
    if (name === 'uDustDebug') {
      value = value >= 0.5 ? 1 : 0;
      const u = this.cosmicMat?.uniforms.uDustDebug;
      if (u) u.value = value;
      if (this.cosmicMat) this.applyFilterBlend(this.cosmicMat);
    }
    for (const mat of this.cloudMats()) {
      const u = mat.uniforms[name];
      if (u) u.value = value;
    }
    if (
      this.hooks.hostPresent() &&
      (name === 'uExtinctK' ||
        name === 'uExtinctCut' ||
        name === 'uExtinctHard' ||
        name === 'uExtinctAbyss' ||
        name === 'uExtinctMax')
    ) {
      this.beginFreeze();
    }
  }

  liveUniform(name: string): number | null {
    if (name === 'uStarN') return this.cosmicCount('star');
    if (name === 'uSmudgeN') return this.cosmicCount('smudge');
    const u =
      this.silMat?.uniforms[name] ??
      this.silEmisMat?.uniforms[name] ??
      this.cosmicMat?.uniforms[name] ??
      this.cosmicStarMat?.uniforms[name] ??
      this.cosmicSmudgeMat?.uniforms[name];
    return typeof u?.value === 'number' ? u.value : null;
  }

  // ------------------------------------------------------------ rebuilds

  /** After a star remint — drop the star mesh only. Nebulae and fog stay. */
  replaceSky(): void {
    this.disposeStars();
    this.cloud = silhouetteCloud(this.seed);
    this.buildStars();
    this.applyStarVis();
  }

  /** After a nebula rebake — drop the nebula mesh only. Stars and fog stay. */
  replaceNebulae(): void {
    this.disposeNebulae();
    this.nebulae = nebulaCloud(this.seed);
    this.buildNebulae();
    this.applyNebVis();
  }

  /** True when the baked dust volume moved under the materials. */
  dustStale(): boolean {
    return harvestDustVolume(this.seed) !== this.dustWired;
  }

  /** Swap the 3D texture on the existing sky — after any bake:
   *  the initial boot mint, a cache load, or a knob rebake. */
  replaceDust(): void {
    this.silDustTex?.dispose();
    this.silDustTex = null;
    const tex = this.ensureDustTexture();
    const vol = harvestDustVolume(this.seed);
    this.dustWired = vol;
    if (this.hooks.hostPresent()) this.beginFreeze();
    const origin = vol?.origin ?? [-1, -1, -1];
    const size = vol?.size ?? [2, 2, 2];
    for (const mat of this.cloudMats()) {
      if (mat.uniforms.uDustVol) mat.uniforms.uDustVol.value = tex;
      if (mat.uniforms.uDustOrigin) {
        (mat.uniforms.uDustOrigin.value as THREE.Vector3).set(origin[0], origin[1], origin[2]);
      }
      if (mat.uniforms.uDustInvSize) {
        (mat.uniforms.uDustInvSize.value as THREE.Vector3).set(1 / size[0], 1 / size[1], 1 / size[2]);
      }
    }
  }

  // ------------------------------------------------------- centre + dim

  /** Catalog positions stay on the GPU; only the bubble centre moves. */
  pushCenter(cx: number, cy: number, cz: number, dim: number): void {
    this.lastCenter.set(cx, cy, cz);
    this.lastDim = dim;
    const frozen = this.catalogFreezeI >= 0 || this.catalogFrozen;
    const ox = frozen ? this.catalogFreezeCenter.x : cx;
    const oy = frozen ? this.catalogFreezeCenter.y : cy;
    const oz = frozen ? this.catalogFreezeCenter.z : cz;
    for (const mat of this.cloudMats()) {
      if (mat.uniforms.uCenter) mat.uniforms.uCenter.value.set(ox, oy, oz);
      if (mat.uniforms.uScale) mat.uniforms.uScale.value = 1;
      if (mat.uniforms.uSkyDim) mat.uniforms.uSkyDim.value = dim;
      if (mat.uniforms.uCatalogFrozen) mat.uniforms.uCatalogFrozen.value = this.catalogFrozen ? 1 : 0;
    }
  }

  /** Re-push the last centre / dim after a rebuild. */
  private pushStored(): void {
    this.pushCenter(this.lastCenter.x, this.lastCenter.y, this.lastCenter.z, this.lastDim);
  }

  /** Survey light this frame — place law computed outside. */
  setDim(dim: number): void {
    this.lastDim = dim;
    for (const mat of this.cloudMats()) {
      if (mat.uniforms.uSkyDim) mat.uniforms.uSkyDim.value = dim;
    }
  }

  /** Per-frame camera-tied uniforms (sprite sizing, march frame). */
  tickCamera(camera: THREE.PerspectiveCamera): void {
    const px = this.hooks.pixelRatio();
    const pxPer = this.hooks.pxPerRad();
    // View→catalog rotation so the cloud march samples a camera-stable field.
    this.camRot3.setFromMatrix4(camera.matrixWorld);
    for (const mat of this.cloudMats()) {
      if (mat.uniforms.uPixel) mat.uniforms.uPixel.value = px;
      if (mat.uniforms.uPxPerRad) mat.uniforms.uPxPerRad.value = pxPer;
      if (mat.uniforms.uCamRotInv) {
        (mat.uniforms.uCamRotInv.value as THREE.Matrix3).copy(this.camRot3);
      }
      if (mat.uniforms.uInvProj) {
        (mat.uniforms.uInvProj.value as THREE.Matrix4).copy(camera.projectionMatrixInverse);
      }
    }
  }

  // ------------------------------------------------------------- filter

  setFilter(f: GalaxyFilterName): void {
    this.filter = f;
    this.applyStarVis();
    this.applyNebVis();
  }

  /** Filter dims non-matching points; every star stays a point. */
  applyStarVis(): void {
    if (!this.starVis || !this.cloud) return;
    const arr = this.starVis.array as Float32Array;
    const { bits, n } = this.cloud;
    const lim = Math.min(n, arr.length);
    for (let i = 0; i < lim; i++) {
      arr[i] = sketchMatches(bits[i], this.filter) ? 1 : 0.08;
    }
    this.starVis.needsUpdate = true;
  }

  /** Filter dims non-matching shells; gain stays the emission measure. */
  applyNebVis(): void {
    if (!this.nebVis || !this.nebulae) return;
    const arr = this.nebVis.array as Float32Array;
    const { bits, gain, n } = this.nebulae;
    const lim = Math.min(n, arr.length);
    for (let i = 0; i < lim; i++) {
      arr[i] = sketchMatches(bits[i], this.filter) ? gain[i] : gain[i] * 0.08;
    }
    this.nebVis.needsUpdate = true;
  }

  /** The photosphere replaces this pin while inside its sphere. */
  hideHarvestId(id: number): void {
    if (!this.starVis || !this.cloud) return;
    const arr = this.starVis.array as Float32Array;
    const { ids, n } = this.cloud;
    const lim = Math.min(n, arr.length);
    for (let i = 0; i < lim; i++) {
      if (ids[i] === id) arr[i] = 0;
    }
    this.starVis.needsUpdate = true;
  }

  // ------------------------------------------------------------- freeze

  private bindExtAttr(geo: THREE.BufferGeometry, n: number): Float32Array {
    const have = geo.getAttribute('aExt');
    if (have) return have.array as Float32Array;
    const ext = new Float32Array(Math.max(1, n) * 3);
    for (let i = 0; i < n; i++) {
      ext[i * 3] = 1;
      ext[i * 3 + 1] = 1;
      ext[i * 3 + 2] = 1;
    }
    const attr = new THREE.BufferAttribute(ext, 3);
    attr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aExt', attr);
    return ext;
  }

  private setCatalogFrozenFlag(on: boolean): void {
    this.catalogFrozen = on;
    for (const mat of this.cloudMats()) {
      if (mat.uniforms.uCatalogFrozen) mat.uniforms.uCatalogFrozen.value = on ? 1 : 0;
    }
  }

  beginFreeze(): void {
    this.catalogFreezeCenter.copy(this.hooks.center());
    this.catalogFrozen = false;
    this.catalogFreezeI = 0;
    if (this.silGeo && this.cloud) this.bindExtAttr(this.silGeo, this.cloud.n);
    if (this.silEmisGeo && this.nebulae) this.bindExtAttr(this.silEmisGeo, this.nebulae.n);
    if (this.cosmicStarGeo) this.bindExtAttr(this.cosmicStarGeo, UNIVERSE.COSMIC_STAR_N_MAX);
    this.setCatalogFrozenFlag(false);
    this.pushStored();
    this.hooks.wake(8);
  }

  thaw(): void {
    this.catalogFrozen = false;
    this.catalogFreezeI = -1;
    this.setCatalogFrozenFlag(false);
  }

  /**
   * Bake each catalog row's dust column from the latched SOI
   * centre. Live march stays on until the attribute is full,
   * then the vertex shader reads aExt.
   */
  tickFreeze(): void {
    if (!this.hooks.hostPresent()) {
      if (this.catalogFreezeI >= 0 || this.catalogFrozen) this.thaw();
      return;
    }
    if (this.catalogFreezeI < 0) this.beginFreeze();
    if (this.catalogFrozen) return;
    const vol = harvestDustVolume(this.seed);
    if (!vol) return;
    const jobs: { pos: Float32Array; ext: THREE.BufferAttribute; n: number; look: boolean }[] = [];
    if (this.silGeo && this.cloud) {
      const ext = this.silGeo.getAttribute('aExt') as THREE.BufferAttribute | undefined;
      const pos = this.silGeo.getAttribute('position') as THREE.BufferAttribute | undefined;
      if (ext && pos) jobs.push({ pos: pos.array as Float32Array, ext, n: this.cloud.n, look: false });
    }
    if (this.silEmisGeo && this.nebulae) {
      const ext = this.silEmisGeo.getAttribute('aExt') as THREE.BufferAttribute | undefined;
      const pos = this.silEmisGeo.getAttribute('position') as THREE.BufferAttribute | undefined;
      if (ext && pos) jobs.push({ pos: pos.array as Float32Array, ext, n: this.nebulae.n, look: false });
    }
    if (this.cosmicStarGeo) {
      const ext = this.cosmicStarGeo.getAttribute('aExt') as THREE.BufferAttribute | undefined;
      const pos = this.cosmicStarGeo.getAttribute('position') as THREE.BufferAttribute | undefined;
      if (ext && pos) {
        jobs.push({ pos: pos.array as Float32Array, ext, n: this.cosmicCount('star'), look: true });
      }
    }
    let total = 0;
    for (const j of jobs) total += j.n;
    if (total <= 0) {
      this.setCatalogFrozenFlag(true);
      return;
    }
    const from: [number, number, number] = [
      this.catalogFreezeCenter.x,
      this.catalogFreezeCenter.y,
      this.catalogFreezeCenter.z,
    ];
    let i = this.catalogFreezeI;
    const deadline = performance.now() + 4;
    while (i < total && performance.now() < deadline) {
      let rest = i;
      let job = jobs[0];
      for (const j of jobs) {
        if (rest < j.n) {
          job = j;
          break;
        }
        rest -= j.n;
      }
      const i3 = rest * 3;
      const px = job.pos[i3];
      const py = job.pos[i3 + 1];
      const pz = job.pos[i3 + 2];
      let rgb: [number, number, number];
      if (job.look) {
        const len = Math.hypot(px, py, pz) || 1;
        rgb = extinctLook(vol, from, [px / len, py / len, pz / len]);
      } else {
        rgb = extinctT(vol, from, [px, py, pz]);
      }
      const arr = job.ext.array as Float32Array;
      arr[i3] = rgb[0];
      arr[i3 + 1] = rgb[1];
      arr[i3 + 2] = rgb[2];
      i++;
    }
    let acc = 0;
    for (const j of jobs) {
      if (this.catalogFreezeI < acc + j.n && i > acc) j.ext.needsUpdate = true;
      acc += j.n;
    }
    this.catalogFreezeI = i;
    if (i >= total) this.setCatalogFrozenFlag(true);
    this.hooks.wake(2);
  }
}
