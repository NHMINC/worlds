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
import { SHAPE_GLSL } from '../world/skyShape';
import type { DustVolume } from '../world/dustVolume';
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

/** Bake a number into GLSL as a float literal (GLSL ES has no int→float). */
const glslFloat = (x: number): string => (Number.isInteger(x) ? `${x}.0` : `${x}`);

/**
 * Dust is not drawn; it is subtraction. The bake stores the raw
 * midplane clump photograph (`ismAt.photo`) in a 3D volume; the
 * march carves it live (floor + hardness). One law for stars and
 * the far photograph: Beer–Lambert skin plus a PER-CLOUD opacity
 * sum — each cloud's crest density sets how dark it is, and
 * overlapping clouds add (extinctMarch). Empty space stays clear.
 * uExtinctK is the one opacity grade — clear at 0, full at
 * K_FULL. `steps` is baked per shader.
 */
const extinctGlsl = (steps: number) => /* glsl */ `
  uniform float uExtinctK;
  uniform float uExtinctMax;
  uniform float uExtinctCut;
  uniform float uExtinctHard;
  uniform float uExtinctAbyss;
  uniform float uDustDebug;
  uniform vec3 uDustRgb;
  uniform sampler3D uDustVol;
  uniform vec3 uDustOrigin;
  uniform vec3 uDustInvSize;
  // Raw photograph field (the bake stores ismAt.photo uncarved).
  float extinctRhoRaw(vec3 p) {
    vec3 uv = (p - uDustOrigin) * uDustInvSize;
    if (uv.x < 0.0 || uv.y < 0.0 || uv.z < 0.0 ||
        uv.x > 1.0 || uv.y > 1.0 || uv.z > 1.0) return 0.0;
    // WebGL2 / GLSL3: Three rewrites texture2D → texture, not texture3D.
    // texture3D fails to compile and the whole harvest Points program dies.
    // Linear 3D tap. Isolated voxels used to read as diamonds
    // (the tent kernel); the bake splats a Gaussian so the
    // isosurface follows the sheet, not the lattice.
    return texture(uDustVol, uv).r;
  }
  // The cloud carve: floor + hardness (the old bake-time dense
  // cut and streak) applied per tap, so both are live knobs.
  float extinctRho(vec3 p) {
    float t = max(extinctRhoRaw(p) - uExtinctCut, 0.0);
    return pow(t, max(uExtinctHard, 0.15));
  }
  // Opacity grade: skin and cloud opacity all scale with uExtinctK.
  // K_FULL is the gain at which an abyss-density cloud reaches
  // the full column cap; below it everything fades toward clear.
  float extinctGrade() {
    return min(uExtinctK * ${glslFloat(1 / UNIVERSE.GALAXY_EXTINCT_K_FULL)}, 1.0);
  }
  // One march, two answers: x = the carved Beer–Lambert skin
  // integral, y = the CLOUD COLUMN in units of EXTINCT_COL.
  // Opacity is a saturating function of local density (a ramp
  // from the fade floor to uExtinctAbyss) INTEGRATED along the
  // path — a column, not a crest. A cloud at abyss density goes
  // lightless in EXTINCT_COL kpc (~one typical diameter); a
  // wisp of the same density costs its thinness; overlapping
  // clouds add; a long in-plane column saturates at the cap.
  // The old per-segment crest rule charged a whole face-on slab
  // crossing as one near-abyss cloud (the max over the crossing)
  // — ~3 magnitudes darker than a real disc.
  vec2 extinctMarch(vec3 from, vec3 dir, float t0, float dCat) {
    float dt = dCat / ${glslFloat(steps)};
    float h = max(dt, 0.04) * 0.33;
    float lo = max(uExtinctCut, 1e-3);
    float v0 = lo * 0.55;
    float abyss = max(uExtinctAbyss, v0 * 2.0);
    float skin = 0.0;
    float col = 0.0;
    for (int i = 0; i < ${steps}; i++) {
      vec3 p = from + dir * (t0 + (float(i) + 0.5) * dt);
      // Three in-step taps AVERAGE into the column — they sample
      // the interval; a max would inflate a thin sheet back into
      // a wall. The carved skin keeps the max so the reddened rim
      // cannot slip between taps. RAMP is the density contrast:
      // opacity is savagely nonlinear in density (a core is
      // 10–100 mag where the body is a fraction of one), so a
      // typical body prices near a magnitude and cores go black.
      float r1 = extinctRhoRaw(p - dir * h);
      float r2 = extinctRhoRaw(p);
      float r3 = extinctRhoRaw(p + dir * h);
      col += (pow(smoothstep(v0, abyss, r1), ${glslFloat(UNIVERSE.GALAXY_EXTINCT_RAMP)})
        + pow(smoothstep(v0, abyss, r2), ${glslFloat(UNIVERSE.GALAXY_EXTINCT_RAMP)})
        + pow(smoothstep(v0, abyss, r3), ${glslFloat(UNIVERSE.GALAXY_EXTINCT_RAMP)})) * (dt / 3.0);
      float raw = max(r2, max(r1, r3));
      skin += pow(max(raw - uExtinctCut, 0.0), max(uExtinctHard, 0.15));
    }
    return vec2(skin, col * ${glslFloat(1 / UNIVERSE.GALAXY_EXTINCT_COL)});
  }
  // Total optical depth of a camera→star column: honest carved
  // skin plus the cloud column, capped. A thin cloud dims a
  // star; only a dense column (one abyss cloud, or a stack) is
  // lightless.
  float extinctTau(vec3 from, vec3 to) {
    float dCat = length(to - from);
    vec3 dir = (to - from) / max(dCat, 1e-4);
    vec2 m = extinctMarch(from, dir, 0.0, dCat);
    float depth = min(m.x * uExtinctK * dCat * ${glslFloat(1 / steps)}, uExtinctMax);
    depth += uExtinctMax * extinctGrade() * m.y;
    return min(depth, uExtinctMax);
  }
  vec3 extinctT(vec3 from, vec3 to) {
    return exp(-extinctTau(from, to) * uDustRgb);
  }
  vec2 extinctSpan(vec3 from, vec3 dir) {
    vec3 d = dir;
    if (abs(d.x) < 1e-8) d.x = 1e-8;
    if (abs(d.y) < 1e-8) d.y = 1e-8;
    if (abs(d.z) < 1e-8) d.z = 1e-8;
    vec3 b0 = uDustOrigin;
    vec3 b1 = uDustOrigin + 1.0 / max(uDustInvSize, vec3(1e-6));
    vec3 tA = (b0 - from) / d;
    vec3 tB = (b1 - from) / d;
    vec3 tmin = min(tA, tB);
    vec3 tmax = max(tA, tB);
    float enter = max(max(tmin.x, tmin.y), tmin.z);
    float leave = min(min(tmax.x, tmax.y), tmax.z);
    if (leave < 0.0 || enter > leave) return vec2(1.0, -1.0);
    return vec2(enter, leave);
  }
  // The far photograph: the same march, the same cloud column.
  // Honest Beer–Lambert through the toy-thin sheet is glass
  // face-on (T ≈ 0.96 through a ribbon body — the sheet is
  // ~0.15 kpc), so transmission alone can never silhouette the
  // clouds; the saturating column is the decreed extra depth.
  // An eye embedded in a cloud looks out through the rest of
  // it — a wisp is a reddened haze, an abyss is night. The fade
  // band rides the RAW field below the carve floor, so rims
  // fade, and everything reddens through the same Beer–Lambert
  // curve. Harvest stars keep their honest camera→star column
  // (extinctT) — from inside the fog you still see what is
  // close.
  vec3 extinctLook(vec3 from, vec3 dir) {
    vec2 span = extinctSpan(from, dir);
    if (span.x > span.y) return vec3(1.0);
    float t0 = max(span.x, 0.0);
    float dCat = span.y - t0;
    if (dCat < 1e-4) return vec3(1.0);
    vec2 m = extinctMarch(from, dir, t0, dCat);
    float depth = min(m.x * uExtinctK * dCat * ${glslFloat(1 / steps)}, uExtinctMax);
    depth += uExtinctMax * extinctGrade() * m.y;
    return exp(-min(depth, uExtinctMax) * uDustRgb);
  }
`;

/** Look test: `?dust=green` / `?fog=green` (or the live knob)
 *  paints a shaded lime skin on the ISM-field ribbons
 *  on the sky — not the catalog pins. */
function dustDebugOn(): boolean {
  if (typeof location === 'undefined') return false;
  return /[?&](?:dust|fog|fox)=green/.test(location.search);
}

const SILHOUETTE_VERT = /* glsl */ `
  ${extinctGlsl(UNIVERSE.GALAXY_EXTINCT_STEPS)}
  attribute vec3 aColor;
  attribute float aVis;
  attribute float aLum;
  attribute float aKind;
  attribute float aSize;
  attribute float aSeed;
  uniform float uPass;
  uniform vec3 uCenter;
  uniform float uScale;
  uniform float uPixel;
  uniform float uPxPerRad;
  uniform float uRegionR;
  uniform float uNebulaPx;
  uniform float uFluxEps;
  uniform float uLRef;
  uniform float uPsfCore;
  uniform float uPsfTail;
  uniform float uPsfA;
  uniform float uPsfB;
  uniform float uPsfThresh;
  uniform float uShineLGain;
  uniform float uSkyDim;
  uniform float uShineLP;
  uniform float uShineDistRef;
  uniform float uShineDistP;
  uniform float uPinCanvas;
  uniform vec3 uWhiteRef;
  uniform float uDensGain;
  uniform float uHueFloor;
  uniform float uCatalogFrozen;
  attribute vec3 aExt;
  varying vec3 vColor;
  varying float vVis;
  varying float vKind;
  varying float vSeed;
  varying vec3 vCenterView;
  varying float vRadiusView;
  varying vec3 vCenterCat;
  varying float vPx;
  varying float vStamp;

  void main() {
    vColor = aColor;
    vKind = aKind;
    vSeed = aSeed;
    vCenterView = vec3(0.0);
    vRadiusView = 0.0;
    vCenterCat = vec3(0.0);
    vPx = 0.0;
    vStamp = 0.0;
    // Cull wrong-kind sprites for the pass here — a fragment discard
    // still rasterizes the whole quad, tripling core overdraw. Dust
    // is not harvested (kind > 3.5 never passes either gate).
    // No membership ball: the harvest is the whole sky.
    if ((uPass < 0.5 && aKind > 0.5) ||
        (uPass > 0.5 && (aKind < 0.5 || aKind > 3.5))) {
      vVis = 0.0;
      gl_PointSize = 0.0;
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }
    vec3 view = (position - uCenter) * uScale;
    vec4 mv = modelViewMatrix * vec4(view, 1.0);
    if (aKind > 0.5) {
      // Same angular law as the local layer: radiusKpc / distance,
      // with a pixel floor so far sources stay findable. No pop at
      // the bubble boundary.
      float d = max(length(mv.xyz), 0.001);
      float ang = max(aSize, 0.005) * uScale / d;
      float floorPx = uNebulaPx * uPixel;
      gl_PointSize = clamp(2.0 * ang * uPxPerRad, floorPx, 512.0);
      vVis = aVis * uSkyDim;
      vCenterView = mv.xyz;
      vRadiusView = max(aSize, 0.005) * uScale;
      vCenterCat = position;
      vPx = gl_PointSize;
    } else {
      // Point + eye PSF. Sprite size is room for visible wings,
      // not a disc radius. Colour is Teff, pushed off grey.
      float d = max(length(mv.xyz), 0.001);
      float L = max(aLum, 1e-4);
      float distF = pow(uShineDistRef / max(d, 0.4), uShineDistP);
      float shine = uShineLGain * pow(L / max(uLRef, 1.0), uShineLP) * distF;
      // AMBASSADOR GLOW: aVis carries the local star density —
      // each row wears the integrated light of its ~thousands of
      // unsampled neighbours. Dense-core ambassadors run the
      // overexposure law into white-gold: the Hubble bulge from
      // the density field, not a painted core.
      shine *= 1.0 + uDensGain * clamp(aVis, 0.0, 1.0);
      // Survey light: 1 in open catalog space, ARRIVE_SKY_GAIN
      // at the host. The photosphere is a second pass and
      // never sees this.
      shine *= uSkyDim;
      float num = uPsfTail * shine / max(uPsfThresh, 1e-5) - uPsfA;
      float rCss = sqrt(max(0.0, num / max(uPsfB, 1e-5)));
      float css = max(1.0, 1.0 + 2.0 * rCss);
      float wingPx = css * uPixel;
      // Floor pin: soft device-pixel Gaussian. A thin plus still
      // blinked — GL_POINTS hops the covered set by 1px. Wings
      // that already need more room keep the CSS PSF.
      if (wingPx <= uPinCanvas) {
        gl_PointSize = uPinCanvas;
        vStamp = 1.0;
      } else {
        gl_PointSize = max(uPixel, wingPx);
      }
      // Natural colouring with honest colour management: the
      // blackbody law (teffToRgb) yields DISPLAY (sRGB) colour,
      // so decode to linear here — all light math (intensity,
      // extinction, the hue ceiling) runs in linear light — and
      // the fragment encodes back to sRGB. uWhiteRef is the
      // photograph's WHITE BALANCE: the linear colour of the
      // reference blackbody that reads as white — one divide,
      // the camera law, no per-class edits.
      vec3 lin = pow(max(aColor, 0.0), vec3(2.2)) / max(uWhiteRef, vec3(1e-3));
      float maxc = max(lin.r, max(lin.g, lin.b));
      vColor = lin / max(maxc, 1e-3);
      // AMBASSADOR COLOUR FLOOR: integrated old-population light
      // blends to gold, never a lone dwarf's brown. Warm rows
      // floor green/blue at yellow-gold (linear 0.70 / 0.27 ≈
      // display 0.85 / 0.55); 0 restores individual colours.
      if (vColor.r >= vColor.b) {
        vColor.g = max(vColor.g, 0.70 * uHueFloor);
        vColor.b = max(vColor.b, 0.27 * uHueFloor);
      }
      vVis = shine;
      vPx = gl_PointSize;
    }
    // Extinction: march the column from the bubble to this row.
    // Frozen SOI: the column is latched on aExt (same law, once).
    vec3 ext = uCatalogFrozen > 0.5 ? aExt : extinctT(uCenter, position);
    float extLum = dot(ext, vec3(0.2126, 0.7152, 0.0722));
    vVis *= extLum;
    vColor *= ext / max(extLum, 1e-3);
    gl_Position = projectionMatrix * mv;
  }
`;

const STAR_FRAG = /* glsl */ `
  ${SHAPE_GLSL}
  // 0 = photosphere stars, 1 = emission nebulae (screen blend).
  // Dust has no pass: it is sightline extinction in the vertex stage.
  uniform float uPass;
  uniform float uNebGain;
  uniform float uScale;
  uniform float uPixel;
  uniform mat3 uCamRotInv;
  uniform float uDustSteps;
  uniform float uDustMinPx;
  uniform float uDustFreq;
  uniform float uPsfCore;
  uniform float uPsfTail;
  uniform float uPsfA;
  uniform float uPsfB;
  uniform float uPinCore;
  varying vec3 vColor;
  varying float vVis;
  varying float vKind;
  varying float vSeed;
  varying vec3 vCenterView;
  varying float vRadiusView;
  varying vec3 vCenterCat;
  varying float vPx;
  varying float vStamp;
  void main() {
    if (uPass < 0.5 && vKind > 0.5) discard;
    if (uPass > 0.5 && (vKind < 0.5 || vKind > 3.5)) discard;
    vec2 p = gl_PointCoord * 2.0 - 1.0;
    if (vKind < 0.5) {
      // Same device-pixel Gaussian as harvestPinWeight. A 1px hop
      // only exchanges faint halo — not a disc, not a plus.
      // Hue is a channel RATIO: painting past the channel ceiling
      // clips R, G, B alike and the colour dies — that is what
      // whitened every hot star. Cap the painted value where the
      // strongest channel saturates, so a bright star grows a
      // saturated colour plateau instead of a white dot; the
      // luminosity the plateau cannot show already lives in the
      // Lorentzian wings (the coloured glow).
      float hueCeil = 1.0 / max(max(vColor.r, max(vColor.g, vColor.b)), 1e-3);
      if (vStamp > 0.5) {
        vec2 d = (gl_PointCoord - 0.5) * vPx;
        float w = exp(-dot(d, d) * uPinCore);
        float I = min(max(vVis, 0.0) * w, hueCeil);
        // Low floor: the faint end fades out, it does not pop.
        if (I < 0.003) discard;
        // Encode linear light back to sRGB. Gamma is monotone,
        // so MAX compositing picks the same winner.
        gl_FragColor = vec4(pow(clamp(vColor * I, 0.0, 1.0), vec3(1.0 / 2.2)), 1.0);
        return;
      }
      float edge = length(p);
      if (edge > 1.0) discard;
      float I = max(vVis, 0.0);
      // PSF lives in CSS pixels, not sprite UVs. Stretching a
      // gaussian to fill the quad was the white-disc photograph.
      float rCss = (edge * vPx * 0.5) / max(uPixel, 1.0);
      // DOT + HALO, never a disc. The dot is a fixed sub-pixel
      // Gaussian — a star is unresolved at any brightness; the
      // halo is the Lorentzian and magnitude grows its REACH.
      float coreT = exp(-rCss * rCss * uPsfCore);
      float tailT = uPsfTail / (uPsfA + uPsfB * rCss * rCss);
      float window = 1.0 - edge * edge;
      window *= window;
      // OVEREXPOSURE: hue survives up to the channel ceiling;
      // light past it whitens the pixel, the way a saturated
      // photocell blends white. A glowing gold star reads
      // white-gold core, gold shoulder, gold halo; a dim orange
      // dwarf never crosses the ceiling and stays orange. The
      // soft knee keeps a brightness gradient everywhere.
      float w = I * (0.95 * coreT + tailT);
      float base = hueCeil * (1.0 - exp(-w / hueCeil));
      float whiten = 1.0 - exp(-max(w - hueCeil, 0.0) * 0.5);
      vec3 c = base * mix(vColor, vec3(1.0), whiten) * window;
      if (max(c.r, max(c.g, c.b)) < 0.003) discard;
      // Encode linear light back to sRGB (monotone — MAX-safe).
      gl_FragColor = vec4(pow(clamp(c, 0.0, 1.0), vec3(1.0 / 2.2)), 1.0);
      return;
    }
    // Emission nebulae: self-luminous shells. Brightness is emission
    // measure — rho² integrated along the ray — normalized to surface
    // brightness so rings and filaments come from geometry.
    if (vPx < uDustMinPx * uPixel) {
      float mask = smoothstep(1.0, 0.5, length(p));
      // Same photograph knob as the marched path — unresolved
      // shells used to ignore it and stack the midplane to white.
      float a = vVis * uNebGain * 0.12 * mask;
      if (a < 0.01) discard;
      gl_FragColor = vec4(vColor * a, 1.0);
      return;
    }
    vec3 fragView = vCenterView + vec3(p.x, -p.y, 0.0) * vRadiusView;
    vec3 rd = normalize(fragView);
    float b = dot(rd, vCenterView);
    float cc = dot(vCenterView, vCenterView) - vRadiusView * vRadiusView;
    float h = b * b - cc;
    if (h <= 0.0) discard;
    h = sqrt(h);
    float t0 = max(b - h, 0.001);
    float t1 = b + h;
    if (t1 <= t0) discard;
    float radiusCat = vRadiusView / uScale;
    float steps = clamp(floor(vPx / 24.0) + 2.0, 2.0, uDustSteps);
    float em = 0.0;
    vec3 meanRel = vec3(0.0);
    float wSum = 0.0;
    for (int i = 0; i < 16; i++) {
      if (float(i) >= steps - 0.5) break;
      float t = mix(t0, t1, (float(i) + 0.5) / steps);
      vec3 relCat = (uCamRotInv * (rd * t - vCenterView)) / uScale;
      float rho = nebRho(vKind, vCenterCat + relCat, relCat, radiusCat, vVis, uDustFreq, vSeed);
      float w = rho * rho;
      em += w;
      meanRel += relCat * w;
      wSum += w;
    }
    float segCat = (t1 - t0) / uScale;
    em *= uNebGain * vVis * segCat / (steps * max(radiusCat, 1e-4));
    if (em < 0.012 || wSum < 1e-5) discard;
    // The palette is a line spectrum, placed by IONIZATION
    // STRATIFICATION: excitation is highest near the hot source and
    // in young (hard-spectrum) events, falling outward — [O III]
    // teal cores, H-alpha pink bodies, [S II] deep-red cool edges.
    // One nebula wears the whole mix; age slides the balance.
    vec3 mrel = meanRel / wSum;
    float rMean = length(mrel) / max(radiusCat, 1e-4);
    float hard = clamp(vVis, 0.0, 1.0);
    float e = hard * (1.6 - 1.1 * rMean);
    if (vKind > 2.5) {
      // Shock strands: neighbouring filaments ride different shock
      // speeds — the Veil's interleaved red and teal lacework. The
      // lace survives ageing; the overall balance still reddens.
      e += 0.12 + 0.6 * nebField(vCenterCat + mrel * 2.6 + 91.0, uDustFreq * 1.6);
    }
    vec3 lineSII = vec3(0.9, 0.18, 0.12);
    vec3 lineHa = vec3(1.0, 0.4, 0.36);
    vec3 lineOIII = vec3(0.3, 0.95, 0.8);
    vec3 line = mix(lineSII, lineHa, smoothstep(0.1, 0.5, e));
    line = mix(line, lineOIII, smoothstep(0.55, 0.95, e));
    // Chemistry keeps a voice: the host tint leans the line blend.
    vec3 col = mix(line, vColor, 0.25);
    float glow = em / (1.0 + em);
    gl_FragColor = vec4(col * glow, 1.0);
  }
`;

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
      name === 'uWarpCross'
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
