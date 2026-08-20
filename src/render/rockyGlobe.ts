/**
 * One rocky globe for the host pass. Same terrace, air, and water
 * as the isolated viewer — no second planet. Built on a world
 * course / latch; siblings stay balls. No landing tools, no
 * reflection RTs, no torch.
 */
import * as THREE from 'three';
import { frequencyForSize, getGrid, type GeoGrid } from '../world/geodesic';
import { basinFetch, generateLevels, MAX_LEVEL, waterLevelFor } from '../world/toygen';
import { paletteFor } from '../world/toyPalette';
import {
  UNIVERSE,
  airExtinction,
  seaState,
  starIrradiance,
  starIrradianceDisplay,
  tidalForcing,
  waveClock,
} from '../world/physics';
import { effectivePhysics, lockedToStar, type BodySpec, type SystemSpec } from '../world/systemgen';
import { TerraceJob, makeTerrainMaterial, makeWaterMaterial } from './terraceMesh';
import { makeSkyShellMaterials } from './atmosphere';

const TERRACE_ROUNDING = 0.3;
const TIER2_MAX_F = 224;
const BUILD_BUDGET_MS = 6;
const AU_KM = UNIVERSE.AU_KM;

function stepFor(grid: GeoGrid): number {
  return Math.min(grid.cellSpacing() / 5, 0.012);
}

interface GlobeAssets {
  root: THREE.Group;
  geometry: THREE.BufferGeometry;
  terrainMat: THREE.ShaderMaterial;
  waterMat?: THREE.ShaderMaterial;
  water?: THREE.Mesh;
  atmoMat?: THREE.ShaderMaterial;
}

export class RockyGlobe {
  readonly bodyId: string;
  private readonly spec: BodySpec;
  private readonly system: SystemSpec;
  private readonly group: THREE.Group;
  private readonly placeholder: THREE.Object3D | null;
  private readonly tmp = new THREE.Vector3();
  private readonly tmp2 = new THREE.Vector3();
  private readonly tmpQ = new THREE.Quaternion();
  private job: TerraceJob | null;
  private assets: GlobeAssets | null = null;
  private waterLevel = 0;
  private step = 0.01;
  private tideAmp = 0;

  constructor(spec: BodySpec, system: SystemSpec, group: THREE.Group, placeholder: THREE.Object3D | null) {
    this.bodyId = spec.id;
    this.spec = spec;
    this.system = system;
    this.group = group;
    this.placeholder = placeholder;
    const f = frequencyForSize(spec.size);
    const grid = getGrid(f);
    const levels = generateLevels(spec.seed, grid);
    const phys = effectivePhysics(system, spec);
    const sea = spec.seaLevel ?? phys.sea01;
    this.waterLevel = waterLevelFor(sea);
    this.step = stepFor(grid);
    const fetch = basinFetch(grid, levels, this.waterLevel);
    const renderGrid = getGrid(Math.min(TIER2_MAX_F, f * 4));
    this.job = new TerraceJob(
      grid,
      renderGrid,
      levels,
      { waterLevel: this.waterLevel, step: this.step, rounding: TERRACE_ROUNDING },
      fetch,
    );
  }

  get ready(): boolean {
    return this.assets != null;
  }

  /** Spend a slice of the frame. True when the globe is on the group. */
  tick(budgetMs = BUILD_BUDGET_MS): boolean {
    if (this.assets) return true;
    const job = this.job;
    if (!job) return false;
    if (!job.step(budgetMs)) return false;
    this.attach(job.finish(), getGrid(frequencyForSize(this.spec.size)));
    this.job = null;
    return true;
  }

  update(cam: THREE.Camera, tSys: number, L: number, posKm: THREE.Vector3, spinQ: THREE.Quaternion): void {
    const assets = this.assets;
    if (!assets) return;
    const qInv = this.tmpQ.copy(spinQ).conjugate();
    const lightL = this.tmp.copy(posKm).multiplyScalar(-1).normalize().applyQuaternion(qInv);
    const aPhys = Math.max(posKm.length() / AU_KM, 0.02);
    const sunIrr = starIrradianceDisplay(starIrradiance(L, aPhys));
    const sunLum = UNIVERSE.SUN_LUM * sunIrr;
    const shaderT = waveClock(tSys);
    const camL = this.group.worldToLocal(this.tmp2.copy(cam.position));
    const tideLv =
      this.tideAmp > 0
        ? this.tideAmp * Math.sin(tSys * UNIVERSE.WAVE_TIDE + this.spec.orbitPhase)
        : 0;
    const apply = (mat: THREE.ShaderMaterial): void => {
      (mat.uniforms.uLightDir.value as THREE.Vector3).copy(lightL);
      if (mat.uniforms.uSunIrr) mat.uniforms.uSunIrr.value = sunIrr;
      if (mat.uniforms.uSunLum) mat.uniforms.uSunLum.value = sunLum;
      if (mat.uniforms.uTime) mat.uniforms.uTime.value = shaderT;
      (mat.uniforms.uCamPos.value as THREE.Vector3).copy(camL);
    };
    apply(assets.terrainMat);
    if (this.tideAmp > 0) {
      assets.terrainMat.uniforms.uWaterLevel.value = this.waterLevel + tideLv;
      assets.water?.scale.setScalar(1 + tideLv * this.step);
    }
    if (assets.waterMat) apply(assets.waterMat);
    if (assets.atmoMat) apply(assets.atmoMat);
  }

  dispose(): void {
    const assets = this.assets;
    if (assets) {
      this.group.remove(assets.root);
      assets.geometry.dispose();
      assets.terrainMat.dispose();
      assets.waterMat?.dispose();
      assets.atmoMat?.dispose();
      for (const child of assets.root.children) {
        if (child instanceof THREE.Mesh && child.geometry !== assets.geometry) {
          child.geometry.dispose();
        }
      }
      this.assets = null;
    }
    this.job = null;
    if (this.placeholder) this.placeholder.visible = true;
  }

  private attach(geometry: THREE.BufferGeometry, grid: GeoGrid): void {
    const spec = this.spec;
    const phys = effectivePhysics(this.system, spec);
    const locked = lockedToStar(spec);
    const tempSpan = locked ? UNIVERSE.TEMP_SPAN_LOCKED : UNIVERSE.TEMP_SPAN_SPIN;
    const temp = spec.temp ?? phys.temp01;
    const snowShift = phys.snowTemp01 - phys.temp01;
    const hydroState = phys.hydrosphere.state;
    const showWater = hydroState !== 'none';
    let tide = 0;
    if (!spec.tidallyLocked) {
      tide = tidalForcing(
        this.system.bodies
          .filter((b) => b.parent === spec.id)
          .map((b) => ({
            densityRel: b.physics.densityRel,
            radiusGL: b.radius,
            orbitGL: b.orbitRadius,
          })),
      );
    }
    const sea = seaState(phys, tide);
    this.tideAmp = showWater && hydroState === 'liquid' ? 0.3 * sea.tide : 0;
    const ext = airExtinction(phys);
    const air = ext
      ? {
          sigma: ext.sigma,
          scaleH: ext.scaleH,
          curve: ext.curve,
          weights: ext.weights,
          albedo: ext.albedo,
          aeroTau: ext.aeroTau,
          aeroW: ext.aeroW,
        }
      : undefined;
    const terrainMat = makeTerrainMaterial({
      gradient: paletteFor(phys, this.waterLevel),
      tempBase: temp,
      tempSpan,
      lockedToStar: locked,
      surfStrength: showWater && hydroState !== 'ice' ? phys.hydrosphere.foam ?? 1 : 0,
      waveEnergy: sea.energy,
      waveTempo: sea.tempo,
      snowAmount: phys.snow ?? 1,
      snowTempBase: temp + snowShift,
      air,
    });
    terrainMat.uniforms.uWaterLevel.value = this.waterLevel;
    terrainMat.uniforms.uWarpFreq.value = 2.2 / grid.cellSpacing();
    const root = new THREE.Group();
    const terrain = new THREE.Mesh(geometry, terrainMat);
    terrain.renderOrder = 0;
    root.add(terrain);

    let waterMat: THREE.ShaderMaterial | undefined;
    let water: THREE.Mesh | undefined;
    if (showWater) {
      waterMat = makeWaterMaterial({
        surf: phys.hydrosphere.surf,
        deep: phys.hydrosphere.deep,
        clarity: phys.hydrosphere.clarity,
        tempBase: temp + snowShift,
        tempSpan,
        lockedToStar: locked,
        iceColor: phys.hydrosphere.ice,
        neverMelts: hydroState === 'ice' && phys.atmosphere.pressure < UNIVERSE.LIQUID_MIN_P,
        waveEnergy: sea.energy,
        waveTempo: sea.tempo,
        air,
      });
      waterMat.uniforms.uWaveFreq.value = 9 / grid.cellSpacing();
      waterMat.uniforms.uFreeboard.value = this.step * 0.55;
      waterMat.uniforms.uMurk.value = (3.5 - 1.3 * (phys.hydrosphere.clarity ?? 0.75)) / this.step;
      waterMat.uniforms.uStep.value = this.step;
      water = new THREE.Mesh(new THREE.SphereGeometry(1, 384, 256), waterMat);
      water.renderOrder = 5;
      root.add(water);
    }

    let atmoMat: THREE.ShaderMaterial | undefined;
    if (air) {
      const peakH = (MAX_LEVEL - this.waterLevel) * this.step;
      const peakR = 1 + peakH;
      const shellR = Math.max(peakR + 0.06, 1 + 7 * air.scaleH);
      const floorR = Math.max(0.05, 1 - this.waterLevel * this.step - 0.005);
      const shell = makeSkyShellMaterials(air, shellR, floorR);
      const shellGeo = new THREE.SphereGeometry(shellR, 64, 40);
      const extMesh = new THREE.Mesh(shellGeo, shell.ext);
      extMesh.renderOrder = 9;
      root.add(extMesh);
      const glow = new THREE.Mesh(shellGeo, shell.glow);
      glow.renderOrder = 10;
      root.add(glow);
      atmoMat = shell.glow;
    }

    this.group.add(root);
    if (this.placeholder) this.placeholder.visible = false;
    this.assets = { root, geometry, terrainMat, waterMat, water, atmoMat };
  }
}
