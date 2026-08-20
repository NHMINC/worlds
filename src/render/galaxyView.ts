/**
 * The galaxy explorer is three catalogs plus the decreed
 * cosmic shell: the star harvest, nebulae, dust-as-extinction,
 * and a
 * distant void of inclined galaxies and star-like pins. The camera sits at the
 * viewpoint centre (1:1 catalog kpc). “Here” is a focus highlight
 * parked in front of the camera; other samples can mark points
 * of interest. The faint 95% is a later survey. Warp is a latched
 * cruise; Face-on / Edge-on slide far enough that the disk fits;
 * Home parks on the loaded star; Back restores the previous pose.
 */
import * as THREE from 'three';
import { UNIVERSE } from '../world/physics';
import { galToCart, homeStar, objectAt, type GalaxyObject } from '../world/galaxy';
import {
  aimLocks,
  harvestGlowPx,
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
  glowRadiusKpc,
} from './galaxyStar';
import { classifyStar } from '../world/stellar';
import { systemAt, starSpecFromState } from '../world/systemgen';
import {
  silhouetteCloud,
  nebulaCloud,
  harvestDustVolume,
  regionName,
  sketchMatches,
  BIT_REMNANT,
  type StarCloud,
} from '../world/sectors';
import { SHAPE_GLSL } from '../world/skyShape';
import type { DustVolume } from '../world/dustVolume';
import { PerfMeter } from './perfHud';
import { makeStar, type StarView } from './star';
import { prepareUniverse } from '../world/universePrep';
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

/** Park “here” this far ahead of the camera (catalog kpc). */
const FOCUS_PARK = 0.35;
const ZOOM_WHEEL_SENS = 0.0008;
const ZOOM_PINCH_POW = 0.7;
/** Tap vs a look: pick if the captured pointer never really moved. */
const TAP_SLOP = 22;

export type GalaxyMode = 'region';
export type GalaxyFilter = 'all' | 'hot' | 'sunlike' | 'cool' | 'remnant' | 'nebula' | 'halo' | 'arm';
export type GalaxyPreset = 'face' | 'edge' | 'home' | 'back';

/** Catalog kpc per kilometre — host meshes live in km under this scale. */
const KM_TO_KPC = 1 / UNIVERSE.KPC_KM;

interface BubblePose {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
}

export function matchesFilter(o: GalaxyObject, f: GalaxyFilter): boolean {
  const st = o.star;
  if (f === 'all') return true;
  if (f === 'hot') return st.mk === 'O' || st.mk === 'B' || st.mk === 'A' || st.phase === 'wolf_rayet';
  if (f === 'sunlike') {
    return (st.mk === 'F' || st.mk === 'G' || st.mk === 'K') && (st.lumClass === 'V' || st.lumClass === 'VI');
  }
  if (f === 'cool') return st.mk === 'M' || st.mk === 'L' || st.mk === 'T' || st.phase === 'brown_dwarf';
  if (f === 'remnant') {
    return st.phase === 'white_dwarf' || st.phase === 'neutron_star' || st.phase === 'pulsar' || st.phase === 'black_hole';
  }
  if (f === 'nebula') return st.nebula !== 'none';
  if (f === 'halo') return o.pop === 'halo';
  return o.inArm;
}


/** Disk diameter with slack — Face-on sits several R_MAX out. */
function regionCamFar(): number {
  return Math.max(UNIVERSE.GALAXY_R_MAX * 8, UNIVERSE.GALAXY_WARP_LIM * 1.5);
}

/**
 * Half-angle (rad) that should hold the disk radius. Edge-on is a
 * horizontal needle — use the width. Face-on is a circle — use the
 * shorter axis so it fits.
 */
export function overviewHalfAngle(fovDeg: number, aspect: number, kind: 'face' | 'edge'): number {
  const vHalf = ((fovDeg * Math.PI) / 180) * 0.5;
  const hHalf = Math.atan(Math.tan(vHalf) * Math.max(1e-4, aspect));
  return kind === 'edge' ? hHalf : Math.min(vHalf, hHalf);
}

/** Sit this far (kpc) so radius `r` fills `fill` of that half-angle. */
export function overviewDistanceKpc(r: number, halfAngle: number, fill = 0.92): number {
  return r / Math.max(1e-4, Math.tan(Math.max(1e-4, halfAngle) * fill));
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
    vec3 ext = extinctT(uCenter, position);
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

export interface GalaxyFocus {
  id: number;
  name: string;
  cls: string;
  phase: string;
  planets: number;
  moons: number;
  life: boolean;
  dark: boolean;
  /** Stage-local pixels. */
  x: number;
  y: number;
  dist: number;
}

export interface GalaxyFrame {
  mode: GalaxyMode;
  theta: number;
  phi: number;
  radius: number;
  pickable: boolean;
  /** Loaded region stars. */
  resolved: number;
  /** Local catalog stars close enough to lock the reticle — no cap. */
  grown: number;
  /** Region label, e.g. "8.2 kpc · 57°". */
  sector: string | null;
  /** GPU rows shown (star harvest + nebula catalog). */
  population: number;
  /** Most-centred star in the sight, when close enough. */
  focus: GalaxyFocus | null;
  /** Held Set-course star (plate stays on it). */
  course: GalaxyFocus | null;
  /** True while warp is latched on (Stop). */
  warp: boolean;
  /** True when the helm is set astern (warp runs opposite the nose). */
  astern: boolean;
  /** Luminous-tail backdrop points currently on the GPU (0 if not minted). */
  backdrop: number;
}

export interface RegionSelection {
  name: string;
  population: number;
  x: number;
  y: number;
  z: number;
}

interface Callbacks {
  onSelect: (obj: GalaxyObject | null) => void;
  onFrame?: (f: GalaxyFrame) => void;
}

export class GalaxyView {
  /** Stars loaded for the open region (empty on the map). */
  objects: GalaxyObject[] = [];
  readonly home: GalaxyObject | null;
  lastEnterMs = 0;
  private seed: string;

  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private canvas: HTMLCanvasElement;
  private callbacks: Callbacks;
  private disposed = false;
  private raf = 0;
  private active = true;

  private mode: GalaxyMode = 'region';
  private regionLabel: string | null = null;
  private sectorPop = 0;
  private overview = false;
  private backPose: BubblePose | null = null;
  private lastSightAt = 0;
  private focusObj: GalaxyObject | null = null;
  private focusHud: GalaxyFocus | null = null;
  private grownCount = 0;
  private briefMemo = new Map<number, { name: string; planets: number; moons: number; life: boolean }>();

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
  /** Star harvest positions (the vertex shader subtracts uCenter). */
  private cloud: StarCloud | null = null;
  /** Nebula catalog — own mesh, rebakes without reminting stars. */
  private nebulae: StarCloud | null = null;

  private camRot3 = new THREE.Matrix3();

  private pickRing: THREE.Mesh;
  private hereRing: THREE.Mesh;
  private hereObj: GalaxyObject | null = null;
  private visitedIds: number[] = [];

  private raycaster = new THREE.Raycaster();
  private ndc = new THREE.Vector2();

  private theta = 0.25;
  private phi = 0.16;
  private tgtTheta = 0.25;
  private tgtPhi = 0.16;

  /** Camera stays at the origin; the bubble centre moves. */
  private arcPos = new THREE.Vector3();
  private arcYaw = 0;
  private arcPitch = -0.6;
  /** Magnification-sphere centre in catalog cartesian (kpc). */
  private arcCenter = new THREE.Vector3();
  /** Last centre we minted / advanced to. */
  private mintAt = new THREE.Vector3();
  private arcFwd = new THREE.Vector3();
  private arcRight = new THREE.Vector3();
  private arcUp = new THREE.Vector3();
  private arcLook = new THREE.Vector3();
  private readonly worldUp = new THREE.Vector3(0, 1, 0);
  private keys = new Set<string>();
  private panBtn = 0;

  private dragging = false;
  /** True once this captured pointer actually moved — a look, not a click. */
  private looking = false;
  private lastX = 0;
  private lastY = 0;
  private moved = 0;
  private pointers = new Map<number, { x: number; y: number }>();
  private pinch0 = 0;
  private thrustOn = false;
  /** Helm gear: false = ahead (along the nose), true = astern. */
  private astern = false;
  private thrustSpeed = 0;
  private idle = 0;
  private lastT = performance.now();
  private lastDt = 1 / 60;
  private viewW = 0;
  private viewH = 0;

  private filter: GalaxyFilter = 'all';
  private selected: GalaxyObject | null = null;
  /**
   * Set course = a heading hold: keep the nose on this star while
   * flying. A look drag releases it (the pilot has the stick); a
   * teleport (enterRegion) releases it. Warp parks at ARRIVE_FILL.
   */
  private courseObj: GalaxyObject | null = null;
  private courseHud: GalaxyFocus | null = null;
  /**
   * Close-approach subject. Latched when the course, reticle, or
   * selected star comes inside ARRIVE_RANGE_LY; released when the
   * camera leaves that bubble. Latching, not re-testing the reticle,
   * because a full-screen star cannot stay on a 0.028 rad crosshair.
   */
  private hostObj: GalaxyObject | null = null;
  private hostStar: StarView | null = null;
  private hostStarId = -1;
  /**
   * The close star draws in its own depth pass over the live galaxy
   * — same camera pose, AU-scale near/far — so the sky never bakes,
   * blanks, or switches environment. One universe, two depth windows.
   */
  private readonly hostScene = new THREE.Scene();
  /** Local km frame at the locked host, scaled into catalog kpc. */
  private hostRoot: THREE.Group | null = null;
  /** Galaxy fill on objects in the bubble — ARRIVE_SKY_GAIN, not a flood. */
  private hostFill: THREE.AmbientLight | null = null;
  private hostOuterAu = 1;
  private readonly epochUnix = Date.now() / 1000 - performance.now() / 1000;

  constructor(
    canvas: HTMLCanvasElement,
    seed: string,
    callbacks: Callbacks,
    hereStarId: number | null = null,
  ) {
    this.canvas = canvas;
    this.callbacks = callbacks;
    this.seed = seed;
    this.home = homeStar(seed);

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    // Full device resolution (same cap as the engine). The old 1.5
    // cap made the browser bilinear-upscale every frame on a 2×
    // display — a blur that ate ~a third of each star dot's peak
    // brightness: a residual filter nobody decreed.
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.perf = new PerfMeter(this.renderer.getContext());
    // The void is black by decree — vacuum emits nothing.
    this.renderer.setClearColor(new THREE.Color(0, 0, 0), 1);
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.001, regionCamFar());

    this.pickRing = this.makeRing(0xf4e4c1, 0.18);
    this.hereRing = this.makeRing(0x7ec8e3, 0.22);
    this.scene.add(this.pickRing);
    this.scene.add(this.hereRing);

    canvas.style.touchAction = 'none';
    canvas.addEventListener('pointerdown', this.onDown, { passive: false });
    canvas.addEventListener('pointermove', this.onMove);
    canvas.addEventListener('pointerup', this.onUp);
    canvas.addEventListener('pointercancel', this.onUp);
    canvas.addEventListener('lostpointercapture', this.onLostCapture);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    this.attachSilhouette();

    this.setHere(hereStarId);
    this.openAtHere();
    if (!this.raf) this.raf = requestAnimationFrame(this.frame);
  }

  // ------------------------------------------------------------- markers

  private makeRing(color: number, inner: number): THREE.Mesh {
    const g = new THREE.RingGeometry(inner, inner * 1.55, 48);
    const m = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.85,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(g, m);
    mesh.rotation.x = Math.PI / 2;
    mesh.visible = false;
    return mesh;
  }

  /** Loaded system, if it is a catalog row. */
  here(): GalaxyObject | null {
    return this.hereObj;
  }

  setHere(id: number | null): void {
    this.hereObj = id != null ? objectAt(this.seed, id) : null;
    this.placeHighlights();
    this.wake();
  }

  setVisited(ids: number[]): void {
    this.visitedIds = ids;
  }

  // ------------------------------------------------------------- region mode

  /** Catalog cartesian → camera frame (origin at the bubble centre). */
  private toView(x: number, y: number, z: number): { x: number; y: number; z: number } {
    if (this.mode !== 'region') return { x, y, z };
    return {
      x: x - this.arcCenter.x,
      y: y - this.arcCenter.y,
      z: z - this.arcCenter.z,
    };
  }

  private viewCart(obj: GalaxyObject): { x: number; y: number; z: number } {
    const c = galToCart(obj.pos);
    return this.toView(c.x, c.y, c.z);
  }

  /**
   * Park the viewpoint at a catalog point. The sky is the once-per-
   * load harvest — we do not remint a neighbourhood. `select` is
   * pinned when the dive is a star.
   */
  enterRegion(x: number, y: number, z: number, select: GalaxyObject | null = null): void {
    this.mode = 'region';
    this.arcCenter.set(x, y, z);
    this.mintAt.set(x, y, z);
    this.bindSky();
    this.regionLabel = regionName(x, y, z);
    this.objects = [];
    this.resetThrust();
    this.courseObj = null;
    this.courseHud = null;

    this.arcPos.set(0, 0, 0);
    const glen = Math.hypot(x, z);
    const ox = glen > 1e-4 ? x / glen : 1;
    const oz = glen > 1e-4 ? z / glen : 0;
    this.aimAt(ox, 0, oz);
    this.idle = 0;
    this.camera.near = 0.001;
    this.camera.far = regionCamFar();
    this.camera.updateProjectionMatrix();
    this.select(select);
    this.applyCam();
    this.updateSight(true);
  }

  private shownCount(): number {
    return (this.cloud?.n ?? 0) + (this.nebulae?.n ?? 0);
  }

  /** Attach stars / nebulae / dust if those caches are warm. */
  private bindSky(): void {
    const stars = silhouetteCloud(this.seed);
    const neb = nebulaCloud(this.seed);
    if (stars) {
      this.cloud = stars;
      if (!this.silPts) this.buildSilhouetteStars();
      else this.pushMagUniforms();
    }
    if (neb) {
      this.nebulae = neb;
      if (!this.silEmisPts) this.buildNebulae();
      else this.pushMagUniforms();
    }
    this.sectorPop = this.shownCount();
    this.lastEnterMs = Math.max(this.cloud?.ms ?? 0, this.nebulae?.ms ?? 0, this.lastEnterMs);
    if (!this.cosmicPts) this.buildCosmic();
    else this.pushMagUniforms();
  }

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

  private disposeSilhouette(): void {
    this.disposeStars();
    this.disposeNebulae();
    this.silDustTex?.dispose();
    this.silDustTex = null;
  }

  private disposeArcStars(): void {
    this.disposeSilhouette();
  }

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
      uPixel: { value: this.renderer.getPixelRatio() },
      uPxPerRad: { value: this.pxPerRad() },
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

  private buildSilhouetteStars(): void {
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
    geo.setDrawRange(0, cloud.n);
    const mat = this.makeCloudMaterial(SILHOUETTE_VERT, this.silUniforms(), 0);
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    pts.renderOrder = -2;
    this.scene.add(pts);
    this.silPts = pts;
    this.silGeo = geo;
    this.silMat = mat;
    this.pushMagUniforms();
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
    geo.setDrawRange(0, cloud.n);
    const emisMat = this.makeCloudMaterial(SILHOUETTE_VERT, this.silUniforms(), 1);
    const emisPts = new THREE.Points(geo, emisMat);
    emisPts.frustumCulled = false;
    emisPts.renderOrder = -1;
    this.scene.add(emisPts);
    this.silEmisPts = emisPts;
    this.silEmisGeo = geo;
    this.silEmisMat = emisMat;
    this.pushMagUniforms();
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
    this.pushMagUniforms();
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
        uPxPerRad: { value: this.pxPerRad() },
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

  /** Live cosmic-engineer write. One uniform, next frame. */
  setLiveUniform(name: string, value: number): void {
    this.wake();
    // Approach laws live in UNIVERSE and are read each frame.
    if (
      name === 'uTimeLapse' ||
      name === 'uArriveRange' ||
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

  /** After a star remint — drop the star mesh only. Nebulae and fog stay. */
  replaceSky(): void {
    this.wake();
    this.disposeStars();
    const cloud = silhouetteCloud(this.seed);
    this.cloud = cloud;
    this.sectorPop = this.shownCount();
    this.lastEnterMs = cloud?.ms ?? this.lastEnterMs;
    this.buildSilhouetteStars();
    this.applyStarVis();
    if (this.mode === 'region') this.updateSight(true);
  }

  /** After a nebula rebake — drop the nebula mesh only. Stars and fog stay. */
  replaceNebulae(): void {
    this.wake();
    this.disposeNebulae();
    const neb = nebulaCloud(this.seed);
    this.nebulae = neb;
    this.sectorPop = this.shownCount();
    this.lastEnterMs = neb?.ms ?? this.lastEnterMs;
    this.buildNebulae();
    this.applyNebVis();
    if (this.mode === 'region') this.updateSight(true);
  }

  /** The dust volume the materials currently point at. The frame
   *  loop compares it with the cache — the initial boot bake used
   *  to notify nobody, so materials built before it (the cosmic
   *  quad and sprites) kept a dead 1×1 placeholder volume forever
   *  and the background sailed through every cloud. */
  private dustWired: DustVolume | null = null;
  private perf!: PerfMeter;

  /** Swap the 3D texture on the existing sky — after any bake:
   *  the initial boot mint, a cache load, or a knob rebake. */
  replaceDust(): void {
    this.wake();
    this.silDustTex?.dispose();
    this.silDustTex = null;
    const tex = this.ensureDustTexture();
    const vol = harvestDustVolume(this.seed);
    this.dustWired = vol;
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

  /**
   * Survey gain. Distance, not a clock: 1 at the ARRIVE_RANGE_LY
   * fence (and outside), ARRIVE_SKY_GAIN at the fill park, linear
   * in between. Leaving the sphere is full survey light again.
   * The furnace is a second pass and is not dimmed.
   */
  private skyDim(): number {
    const host = this.hostObj;
    if (!host) return 1;
    const R = UNIVERSE.ARRIVE_RANGE_KPC;
    if (R <= 0) return 1;
    const g = UNIVERSE.ARRIVE_SKY_GAIN;
    const park = this.parkKpc(host);
    const span = R - park;
    if (span <= 1e-12) return g;
    const t = Math.max(0, Math.min(1, (R - this.arriveDist(host)) / span));
    return 1 + (g - 1) * t;
  }

  /** Catalog positions stay on the GPU; only the bubble centre moves. */
  private pushMagUniforms(): void {
    const cx = this.arcCenter.x;
    const cy = this.arcCenter.y;
    const cz = this.arcCenter.z;
    const dim = this.skyDim();
    for (const mat of this.cloudMats()) {
      if (mat.uniforms.uCenter) mat.uniforms.uCenter.value.set(cx, cy, cz);
      if (mat.uniforms.uScale) mat.uniforms.uScale.value = 1;
      if (mat.uniforms.uSkyDim) mat.uniforms.uSkyDim.value = dim;
    }
    if (this.hostFill) this.hostFill.intensity = dim;
  }


  // --------------------------------------------------------------- state

  setFilter(f: GalaxyFilter): void {
    this.wake();
    this.filter = f;
    this.applyStarVis();
    this.applyNebVis();
    if (this.mode === 'region') this.updateSight(true);
  }

  dismiss(): void {
    this.select(null);
  }

  /**
   * Set course: hold the heading on a star. The nose eases onto the
   * target at ARRIVE_HOLD and stays there while flying. A look drag
   * hands the stick back — it does not remove the close star.
   * Warp parks when the disk fills the view.
   */
  setCourse(obj: GalaxyObject): void {
    if (this.mode !== 'region') return;
    // Inside a host sphere you cannot pick a different target —
    // leave the host sphere first.
    if (this.hostObj && this.hostObj.id !== obj.id) return;
    this.courseObj = obj;
    const brief = this.briefFor(obj);
    const st = obj.star;
    this.courseHud = {
      id: obj.id,
      name: brief.name,
      cls: classifyStar(st),
      phase: st.phase.replace(/_/g, ' '),
      planets: brief.planets,
      moons: brief.moons,
      life: brief.life,
      dark: st.phase.includes('dwarf') || st.luminosity < 0.05,
      x: 0.5,
      y: 0.5,
      dist: this.arriveDist(obj),
    };
    this.select(null);
    this.wake();
  }

  private clearCourse(): void {
    this.courseObj = null;
    this.courseHud = null;
  }

  /** Ease the nose onto the course star and keep it there. */
  private holdCourse(dt: number): void {
    const c = this.courseObj;
    if (!c || this.mode !== 'region' || this.looking) return;
    const p = galToCart(c.pos);
    const dx = p.x - this.arcCenter.x;
    const dy = p.y - this.arcCenter.y;
    const dz = p.z - this.arcCenter.z;
    const d = Math.hypot(dx, dy, dz);
    if (d < 1e-15) return;
    if (this.courseHud) this.courseHud.dist = d;
    const tgtYaw = Math.atan2(dx, dz);
    const tgtPitch = THREE.MathUtils.clamp(
      Math.asin(THREE.MathUtils.clamp(dy / d, -1, 1)),
      -1.45,
      1.45,
    );
    let dYaw = tgtYaw - this.arcYaw;
    dYaw = Math.atan2(Math.sin(dYaw), Math.cos(dYaw));
    const dPitch = tgtPitch - this.arcPitch;
    if (Math.abs(dYaw) + Math.abs(dPitch) < 1e-7) return;
    const k = 1 - Math.exp(-UNIVERSE.ARRIVE_HOLD * dt);
    this.arcYaw += dYaw * k;
    this.arcPitch += dPitch * k;
    this.applyCam();
    this.wake();
  }

  canPick(): boolean {
    return this.mode === 'region';
  }

  currentMode(): GalaxyMode {
    return this.mode;
  }

  currentRegion(): RegionSelection | null {
    if (!this.regionLabel) return null;
    return {
      name: this.regionLabel,
      population: this.sectorPop,
      x: this.arcCenter.x,
      y: this.arcCenter.y,
      z: this.arcCenter.z,
    };
  }

  selectedObject(): GalaxyObject | null {
    return this.selected;
  }

  beaconCount(): number {
    const n = this.shownCount();
    return n > 0 ? n : this.objects.length;
  }

  /** The arc's loaded survey — every row is a tappable catalog id. */
  surveyStars(): GalaxyObject[] {
    return this.objects;
  }

  /** Latest performance summary for the bottom bar. */
  perfSummary(): string {
    return this.perf.summary();
  }

  /** Local catalog stars close enough to lock the reticle. Smoke / HUD. */
  grownStars(): number {
    return this.grownCount;
  }

  /** True when the luminous harvest is on the GPU. */
  cloudFitsRegion(): boolean {
    return Boolean(this.cloud && this.cloud.n > 0 && this.silPts);
  }

  /**
   * Open the region on the loaded star (else home) and park it
   * just ahead of the centre reticle. That pose is the Back bookmark.
   */
  openAtHere(): void {
    const obj = this.hereObj ?? this.home;
    if (!obj) {
      this.goOverview('face');
      return;
    }
    this.focus(obj);
    this.approachNearest();
    this.pinBack();
  }

  setPreset(p: GalaxyPreset): void {
    this.wake();
    if (p === 'home') {
      const obj = this.hereObj ?? this.home;
      if (!obj) return;
      this.focus(obj);
      this.approachNearest();
      this.pinBack();
      return;
    }
    if (p === 'back') {
      this.restoreBack();
      return;
    }
    this.goOverview(p);
  }

  private snapshotPose(): BubblePose {
    return {
      x: this.arcCenter.x,
      y: this.arcCenter.y,
      z: this.arcCenter.z,
      yaw: this.arcYaw,
      pitch: this.arcPitch,
    };
  }

  /** Remember the current pose unless we are already in an overview. */
  private rememberBack(): void {
    if (this.overview) return;
    this.backPose = this.snapshotPose();
  }

  /** Home (and first look) pin Back to this pose. */
  private pinBack(): void {
    this.overview = false;
    this.backPose = this.snapshotPose();
  }

  /**
   * Sit so the disk diameter fills the screen. Edge-on uses the
   * width (a needle); face-on uses the shorter axis (a circle).
   */
  private overviewDistance(kind: 'face' | 'edge'): number {
    return overviewDistanceKpc(
      UNIVERSE.GALAXY_R_MAX,
      overviewHalfAngle(this.camera.fov, this.camera.aspect, kind),
    );
  }

  private goOverview(kind: 'face' | 'edge'): void {
    this.rememberBack();
    this.overview = true;
    const d = this.overviewDistance(kind);
    if (kind === 'face') {
      this.enterRegion(0, d, 0, null);
      this.aimAt(0, -1, 0);
    } else {
      // In the plane. A lift put the camera above the dust sheet,
      // so the lane became a floor and the top stayed puffy.
      this.enterRegion(d, 0, 0, null);
      this.aimAt(-1, 0, 0);
    }
    this.applyCam();
    this.updateSight(true);
  }

  private restoreBack(): void {
    const p = this.backPose;
    if (!p) {
      this.openAtHere();
      return;
    }
    this.overview = false;
    this.enterRegion(p.x, p.y, p.z, null);
    this.arcYaw = p.yaw;
    this.arcPitch = p.pitch;
    this.applyCam();
    this.updateSight(true);
  }

  /** Open the region around a star and select it. */
  focus(obj: GalaxyObject): void {
    this.wake();
    const c = galToCart(obj.pos);
    this.enterRegion(c.x, c.y, c.z, obj);
  }

  /**
   * Slide the bubble so a pinned star sits just ahead of the camera
   * (still at the centre). Smoke / tests.
   */
  approachNearest(): GalaxyObject | null {
    const best = this.selected ?? this.hereObj ?? this.home;
    if (!best) return null;
    if (this.mode !== 'region') this.focus(best);
    const cat = galToCart(best.pos);
    this.orientArc();
    const off = FOCUS_PARK;
    this.arcCenter.set(
      cat.x - this.arcFwd.x * off,
      cat.y - this.arcFwd.y * off,
      cat.z - this.arcFwd.z * off,
    );
    this.mintAt.copy(this.arcCenter);
    this.pushMagUniforms();
    this.placeHighlights();
    const v = this.viewCart(best);
    this.aimAt(v.x, v.y, v.z);
    this.applyCam();
    this.updateSight(true);
    return best;
  }

  focusedObject(): GalaxyObject | null {
    return this.focusObj;
  }

  /** Refresh sight uniforms — smoke / tests. */
  syncArc(): void {
    if (this.mode === 'region') this.updateSight(true);
  }

  /** Harvest glow size (device px). f(L), not 1/d — smoke proves approach does not inflate it. */
  pointApparent(id: number): number {
    const cloud = this.cloud;
    const px = this.renderer.getPixelRatio();
    if (!cloud) return 0;
    for (let i = 0; i < cloud.n; i++) {
      if (cloud.ids[i] === id) return harvestGlowPx(cloud.lum[i], px);
    }
    const o = objectAt(this.seed, id);
    return o ? harvestGlowPx(o.star.luminosity, px) : 0;
  }

  /**
   * An on-screen cloud star — smoke proves the full field is tappable.
   */
  probePointStar(): { id: number; x: number; y: number } | null {
    const cloud = this.cloud;
    if (!cloud) return null;
    const rect = this.canvas.getBoundingClientRect();
    this.camera.updateMatrixWorld();
    const e = this.camera.matrixWorldInverse.elements;
    const p = this.camera.projectionMatrix.elements;
    const step = Math.max(1, Math.floor(cloud.n / 4000));
    const cx = this.arcCenter.x;
    const cy = this.arcCenter.y;
    const cz = this.arcCenter.z;
    const cat = cloud.pos;
    for (let i = 0; i < cloud.n; i += step) {
      if (!sketchMatches(cloud.bits[i], this.filter)) continue;
      const i3 = i * 3;
      const x = cat[i3] - cx;
      const y = cat[i3 + 1] - cy;
      const z = cat[i3 + 2] - cz;
      const mx = e[0] * x + e[4] * y + e[8] * z + e[12];
      const my = e[1] * x + e[5] * y + e[9] * z + e[13];
      const mz = e[2] * x + e[6] * y + e[10] * z + e[14];
      const mw = e[3] * x + e[7] * y + e[11] * z + e[15];
      const cw = p[3] * mx + p[7] * my + p[11] * mz + p[15] * mw;
      if (cw <= 1e-6) continue;
      const nx = (p[0] * mx + p[4] * my + p[8] * mz + p[12] * mw) / cw;
      const ny = (p[1] * mx + p[5] * my + p[9] * mz + p[13] * mw) / cw;
      if (nx * nx + ny * ny > 0.55) continue;
      const sx = rect.left + (nx * 0.5 + 0.5) * rect.width;
      const sy = rect.top + (-ny * 0.5 + 0.5) * rect.height;
      if (sx < 280 || sx > 1000 || sy < 120 || sy > 520) continue;
      return { id: cloud.ids[i], x: sx, y: sy };
    }
    return null;
  }

  /**
   * Rotate the look in place. Smoke uses this to prove free look.
   */
  orbitBy(dTheta: number, dPhi = 0): void {
    if (this.mode === 'region') {
      this.arcYaw += dTheta;
      this.arcPitch = THREE.MathUtils.clamp(this.arcPitch - dPhi, -1.45, 1.45);
      this.applyCam();
      this.idle = 0;
      return;
    }
    this.tgtTheta += dTheta;
    this.tgtPhi = THREE.MathUtils.clamp(this.tgtPhi + dPhi, 0.08, 1.45);
    this.idle = 0;
  }

  /** Slide the bubble along the look. Smoke / WASD. */
  flyAlong(kpc: number): void {
    if (this.mode !== 'region') return;
    this.orientArc();
    this.moveBubble(this.arcFwd.x * kpc, this.arcFwd.y * kpc, this.arcFwd.z * kpc);
    this.applyCam();
  }

  /** Slide the bubble along camera right. */
  flyStrafe(kpc: number): void {
    if (this.mode !== 'region') return;
    this.orientArc();
    this.moveBubble(this.arcRight.x * kpc, this.arcRight.y * kpc, this.arcRight.z * kpc);
    this.applyCam();
  }

  resize(w: number, h: number): void {
    if (w === this.viewW && h === this.viewH) return;
    this.viewW = w;
    this.viewH = h;
    this.wake();
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
  }

  /** Pause the loop while the explorer is hidden so the planet can run. */
  setActive(on: boolean): void {
    if (this.disposed || on === this.active) return;
    this.active = on;
    if (on) {
      this.lastT = performance.now();
      this.wake();
      if (!this.raf) this.raf = requestAnimationFrame(this.frame);
    } else {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
      this.setWarp(false);
    }
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.canvas.removeEventListener('pointerdown', this.onDown);
    this.canvas.removeEventListener('pointermove', this.onMove);
    this.canvas.removeEventListener('pointerup', this.onUp);
    this.canvas.removeEventListener('pointercancel', this.onUp);
    this.canvas.removeEventListener('lostpointercapture', this.onLostCapture);
    this.canvas.removeEventListener('wheel', this.onWheel);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    this.detachHostStar();
    this.disposeArcStars();
    this.disposeCosmic();
    this.pickRing.geometry.dispose();
    (this.pickRing.material as THREE.Material).dispose();
    this.hereRing.geometry.dispose();
    (this.hereRing.material as THREE.Material).dispose();
    this.renderer.dispose();
  }

  private resetThrust(): void {
    this.thrustOn = false;
    this.thrustSpeed = 0;
  }

  private bubbleR(): number {
    return Math.hypot(this.arcCenter.x, this.arcCenter.y, this.arcCenter.z);
  }

  /** Signed look axis for this gear: +1 ahead, −1 astern. */
  private thrustSign(): number {
    return this.astern ? -1 : 1;
  }

  /** Warp may run inside the fence, or past it only while the gear points inward. */
  private warpMayRun(): boolean {
    const r = this.bubbleR();
    const lim = UNIVERSE.GALAXY_WARP_LIM;
    if (r < lim) return true;
    this.orientArc();
    if (r < 1e-6) return true;
    return this.arcFwd.dot(this.arcCenter) * this.thrustSign() < 0;
  }

  /** Latch warp on (fixed cruise) or off (stop). A tap, not a hold. */
  setWarp(on: boolean): void {
    if (this.mode !== 'region') return;
    this.thrustOn = on && this.warpMayRun();
    this.idle = 0;
    if (this.thrustOn) this.wake(2);
  }

  /** Ahead / astern. Only while stopped — a running warp keeps the gear. */
  setGear(astern: boolean): void {
    if (this.mode !== 'region' || this.thrustOn) return;
    if (this.astern === astern) return;
    this.astern = astern;
    this.idle = 0;
    this.wake();
  }

  toggleGear(): void {
    this.setGear(!this.astern);
  }

  warping(): boolean {
    return this.thrustOn;
  }

  private select(obj: GalaxyObject | null): void {
    this.wake();
    this.selected = obj;
    this.placeHighlights();
    this.callbacks.onSelect(obj);
  }

  // ------------------------------------------------------------- camera

  private aimAt(x: number, y: number, z: number): void {
    const dx = x;
    const dy = y;
    const dz = z;
    const len = Math.max(1e-8, Math.hypot(dx, dy, dz));
    this.arcPitch = Math.asin(THREE.MathUtils.clamp(dy / len, -1, 1));
    this.arcYaw = Math.atan2(dx, dz);
  }

  private orientArc(): void {
    const cp = Math.cos(this.arcPitch);
    this.arcFwd.set(cp * Math.sin(this.arcYaw), Math.sin(this.arcPitch), cp * Math.cos(this.arcYaw));
    this.arcRight.crossVectors(this.arcFwd, this.worldUp);
    if (this.arcRight.lengthSq() < 1e-10) this.arcRight.set(1, 0, 0);
    else this.arcRight.normalize();
    this.arcUp.crossVectors(this.arcRight, this.arcFwd).normalize();
  }

  private pxPerRad(): number {
    const h = this.canvas.clientHeight || 800;
    const fov = (this.camera.fov * Math.PI) / 180;
    return (0.5 * h * this.renderer.getPixelRatio()) / Math.tan(fov * 0.5);
  }

  private applyCam(): void {
    this.orientArc();
    this.camera.position.set(0, 0, 0);
    this.camera.up.copy(this.arcUp);
    this.arcLook.copy(this.arcFwd);
    this.camera.lookAt(this.arcLook);
    this.theta = this.arcYaw;
    this.phi = Math.PI / 2 - this.arcPitch;
    // The main pass always keeps the whole galaxy: near follows the
    // subject in (its pin must not clip), far stays the disk. The
    // furnace and worlds draw in a second AU-scale depth pass on top.
    const lock = this.hostObj;
    if (lock) {
      const d = this.arriveDist(lock);
      this.camera.near = Math.min(0.001, Math.max(1e-14, d * 0.04));
      this.camera.far = regionCamFar();
    } else {
      this.camera.near = 0.001;
      this.camera.far = regionCamFar();
    }
    this.camera.updateProjectionMatrix();
    this.pushMagUniforms();
  }

  private arriveDist(obj: GalaxyObject): number {
    const c = galToCart(obj.pos);
    return Math.hypot(
      c.x - this.arcCenter.x,
      c.y - this.arcCenter.y,
      c.z - this.arcCenter.z,
    );
  }

  /**
   * The close star is a place, not a heading. Once we are inside
   * its ARRIVE_RANGE_LY sphere (or it has already become the furnace), keep
   * it until we fly away. Course lock and look-drag only steer;
   * they do not own the object.
   */
  private updateArriveSubject(): void {
    const range = UNIVERSE.ARRIVE_RANGE_KPC;
    if (this.hostObj) {
      if (this.arriveDist(this.hostObj) <= range) return;
      this.hostObj = null;
      return;
    }
    for (const cand of [this.courseObj, this.focusObj, this.selected]) {
      if (cand && this.arriveDist(cand) <= range) {
        this.hostObj = cand;
        return;
      }
    }
  }

  private detachHostStar(): void {
    this.hostObj = null;
    this.detachHost();
  }

  private detachHost(): void {
    this.detachHostFurnace();
    if (this.hostRoot) {
      this.hostScene.remove(this.hostRoot);
      this.hostRoot = null;
    }
    this.hostStarId = -1;
    this.hostFill = null;
    this.hostOuterAu = 1;
  }

  private detachHostFurnace(): void {
    if (!this.hostStar) return;
    this.hostRoot?.remove(this.hostStar.group);
    this.hostStar.dispose();
    this.hostStar = null;
    // The photosphere is gone: the harvest pin is the star again.
    this.applyStarVis();
  }

  private ensureHostRoot(): THREE.Group {
    if (this.hostRoot) return this.hostRoot;
    const root = new THREE.Group();
    root.scale.setScalar(KM_TO_KPC);
    // Same law as the photograph: a small galaxy fill, not a 0.22 flood
    // that would make night impossible once worlds land.
    const fill = new THREE.AmbientLight(0x9aa8c4, UNIVERSE.ARRIVE_SKY_GAIN);
    root.add(fill);
    this.hostFill = fill;
    this.hostScene.add(root);
    this.hostRoot = root;
    return root;
  }

  private hideHarvestId(id: number): void {
    if (!this.starVis || !this.cloud) return;
    const arr = this.starVis.array as Float32Array;
    const { ids, n } = this.cloud;
    const lim = Math.min(n, arr.length);
    for (let i = 0; i < lim; i++) {
      if (ids[i] === id) arr[i] = 0;
    }
    this.starVis.needsUpdate = true;
  }

  private attachHostFurnace(lock: GalaxyObject): void {
    this.detachHostFurnace();
    const spec = starSpecFromState(lock.star, () => 0.5);
    this.hostStar = makeStar(spec);
    this.ensureHostRoot().add(this.hostStar.group);
    this.hostStar.light.intensity = 0;
    this.hostStarId = lock.id;
    // The photosphere replaces the pin — the rest of the sky stays live.
    this.hideHarvestId(lock.id);
  }

  /**
   * Sphere entry: the photosphere replaces the harvest pin the
   * same frame. The pin cannot draw the approach. No systemAt.
   */
  private updateHostArrival(now: number): void {
    this.updateArriveSubject();
    const lock = this.hostObj;
    if (!lock) {
      if (this.hostRoot || this.hostStar) {
        this.detachHost();
        this.applyCam();
      }
      return;
    }
    const cart = galToCart(lock.pos);
    const dx = cart.x - this.arcCenter.x;
    const dy = cart.y - this.arcCenter.y;
    const dz = cart.z - this.arcCenter.z;
    if (this.hostStarId !== lock.id && (this.hostRoot || this.hostStar)) this.detachHost();
    // The sphere is the object of interest: the pin cannot draw
    // the approach (it stays a point, then hops). Swap the frame
    // we enter. Looking around is not leaving.
    if (!this.hostStar) this.attachHostFurnace(lock);

    const root = this.hostRoot;
    if (root) root.position.set(dx, dy, dz);

    const tSys = (this.epochUnix + now / 1000) * UNIVERSE.TIME_SCALE;
    if (root) root.updateMatrixWorld(true);
    if (this.hostStar && root) {
      const camLocal = new THREE.Vector3();
      this.hostStar.group.worldToLocal(camLocal.copy(this.camera.position));
      this.hostStar.update(camLocal, tSys, new THREE.Vector3(1, 1, 1));
    }
    this.applyCam();
    this.wake(2);
  }

  /**
   * Cruise speed. Cap is small and fixed so extra space between
   * stars is felt as more zoom, not a faster ship. Slow further
   * only when a star is already close (examine, don't overshoot).
   */
  private arcPace(): number {
    const cloud = this.cloud;
    let minD = 8;
    if (cloud) {
      const step = Math.max(1, Math.floor(cloud.n / 6000));
      const cx = this.arcCenter.x;
      const cy = this.arcCenter.y;
      const cz = this.arcCenter.z;
      const cat = cloud.pos;
      for (let i = 0; i < cloud.n; i += step) {
        const i3 = i * 3;
        const d = Math.hypot(cat[i3] - cx, cat[i3 + 1] - cy, cat[i3 + 2] - cz);
        if (d > 1e-4 && d < minD) minD = d;
      }
    }
    if (this.selected) {
      const c = this.viewCart(this.selected);
      const d = Math.hypot(c.x, c.y, c.z);
      if (d > 1e-4) minD = Math.min(minD, d);
    }
    return THREE.MathUtils.clamp(0.42 * minD, 0.004, 0.025);
  }

  /**
   * Gestures are catalog kpc. The camera stays at the origin; the
   * viewpoint slides. The GPU holds the harvest — the vertex shader
   * subtracts uCenter. No membership walk.
   */
  /** Speed inside the host sphere: min(ARRIVE_WARP × warp, ARRIVE_K · d). */
  private sphereSpeed(d: number): number {
    return Math.min(
      UNIVERSE.GALAXY_WARP * UNIVERSE.ARRIVE_WARP,
      UNIVERSE.ARRIVE_K * Math.max(d, 1e-16),
    );
  }

  private moveBubble(vx: number, vy: number, vz: number, _force = false): void {
    if (this.mode !== 'region') return;
    if (this.hostObj) {
      const max = this.sphereSpeed(this.arriveDist(this.hostObj)) * Math.max(this.lastDt, 1 / 120);
      const len = Math.hypot(vx, vy, vz);
      if (len > max) {
        const s = max / len;
        vx *= s;
        vy *= s;
        vz *= s;
      }
    }
    this.arcCenter.x += vx;
    this.arcCenter.y += vy;
    this.arcCenter.z += vz;
    this.mintAt.copy(this.arcCenter);
    this.regionLabel = regionName(this.arcCenter.x, this.arcCenter.y, this.arcCenter.z);
    this.pushMagUniforms();
    this.placeHighlights();
  }

  /** Harvest is minted once at app boot; wait for stars + nebulae + dust. */
  private attachSilhouette(): void {
    void prepareUniverse(this.seed).then(() => {
      if (this.disposed) return;
      this.bindSky();
      this.wake();
    });
  }

  /** Here and the current pick sit in camera space as focus rings. */
  private placeHighlights(): void {
    const here = this.hereObj ?? this.home;
    if (here) {
      const c = this.viewCart(here);
      this.hereRing.position.set(c.x, c.y, c.z);
      this.hereRing.visible = true;
    } else {
      this.hereRing.visible = false;
    }
    if (this.selected) {
      const c = this.viewCart(this.selected);
      this.pickRing.position.set(c.x, c.y, c.z);
      this.pickRing.visible = true;
    } else {
      this.pickRing.visible = false;
    }
  }

  /**
   * Pinch / wheel slides the ball along the look (the camera stays
   * at the centre; the bubble moves).
   */
  private zoom(factor: number): void {
    this.idle = 0;
    this.orientArc();
    const dir = factor < 1 ? 1 : -1;
    const step = this.arcPace() * 14 * Math.abs(Math.log(Math.max(1e-3, factor))) * dir;
    this.moveBubble(this.arcFwd.x * step, this.arcFwd.y * step, this.arcFwd.z * step);
    this.applyCam();
  }

  // ------------------------------------------------------------- picking

  /** Client-pixel position of a catalog object, or null if off-screen. */
  projectClient(obj: GalaxyObject): { x: number; y: number } | null {
    const rect = this.canvas.getBoundingClientRect();
    const c = this.viewCart(obj);
    const v = new THREE.Vector3(c.x, c.y, c.z).project(this.camera);
    if (v.z < -1.2 || v.z > 1.2) return null;
    return {
      x: rect.left + (v.x * 0.5 + 0.5) * rect.width,
      y: rect.top + (-v.y * 0.5 + 0.5) * rect.height,
    };
  }

  private setRay(cx: number, cy: number): void {
    const rect = this.canvas.getBoundingClientRect();
    this.ndc.set(
      ((cx - rect.left) / Math.max(1, rect.width)) * 2 - 1,
      -((cy - rect.top) / Math.max(1, rect.height)) * 2 + 1,
    );
    this.camera.updateMatrixWorld();
    this.raycaster.setFromCamera(this.ndc, this.camera);
  }

  private pick(cx: number, cy: number): void {
    this.setRay(cx, cy);
    const picked = this.pickCloud(cx, cy);
    if (!picked) return;
    if (this.hostObj && picked.id !== this.hostObj.id) return;
    this.select(picked);
  }

  /** Here and visited samples — always pickable, even if faint. */
  private pickPoi(cx: number, cy: number): GalaxyObject | null {
    const pois: GalaxyObject[] = [];
    const here = this.hereObj ?? this.home;
    if (here) pois.push(here);
    for (const id of this.visitedIds) {
      if (here && id === here.id) continue;
      const o = objectAt(this.seed, id);
      if (o) pois.push(o);
    }
    let best: GalaxyObject | null = null;
    let bestD = 28;
    for (const o of pois) {
      const p = this.projectClient(o);
      if (!p) continue;
      const d = Math.hypot(p.x - cx, p.y - cy);
      if (d < bestD) {
        bestD = d;
        best = o;
      }
    }
    return best;
  }

  private pickCloud(cx: number, cy: number): GalaxyObject | null {
    const poi = this.pickPoi(cx, cy);
    if (poi) return poi;
    this.camera.updateMatrixWorld();
    const e = this.camera.matrixWorldInverse.elements;
    const p = this.camera.projectionMatrix.elements;
    const rect = this.canvas.getBoundingClientRect();
    const ox = this.arcCenter.x;
    const oy = this.arcCenter.y;
    const oz = this.arcCenter.z;
    const pxPer = this.pxPerRad() / Math.max(1, this.renderer.getPixelRatio());
    let bestId = -1;
    let bestD = Infinity;
    for (const cloud of [this.cloud, this.nebulae]) {
      if (!cloud) continue;
      const cat = cloud.pos;
      const bits = cloud.bits;
      const ids = cloud.ids;
      const lum = cloud.lum;
      for (let i = 0; i < cloud.n; i++) {
        if (!sketchMatches(bits[i], this.filter)) continue;
        const i3 = i * 3;
        const x = cat[i3] - ox;
        const y = cat[i3 + 1] - oy;
        const z = cat[i3 + 2] - oz;
        const mx = e[0] * x + e[4] * y + e[8] * z + e[12];
        const my = e[1] * x + e[5] * y + e[9] * z + e[13];
        const mz = e[2] * x + e[6] * y + e[10] * z + e[14];
        const mw = e[3] * x + e[7] * y + e[11] * z + e[15];
        const cw = p[3] * mx + p[7] * my + p[11] * mz + p[15] * mw;
        if (cw <= 1e-6) continue;
        const nx = (p[0] * mx + p[4] * my + p[8] * mz + p[12] * mw) / cw;
        const ny = (p[1] * mx + p[5] * my + p[9] * mz + p[13] * mw) / cw;
        if (nx < -1.15 || nx > 1.15 || ny < -1.15 || ny > 1.15) continue;
        const sx = rect.left + (nx * 0.5 + 0.5) * rect.width;
        const sy = rect.top + (-ny * 0.5 + 0.5) * rect.height;
        const d = Math.hypot(sx - cx, sy - cy);
        const viewD = Math.max(1e-4, Math.hypot(mx, my, mz));
        const dim = (bits[i] & BIT_REMNANT) !== 0 || lum[i] < 0.05;
        const hitR = Math.max(22, 0.55 * 2 * glowRadiusKpc(lum[i], dim) * pxPer / viewD);
        if (d <= hitR && d < bestD) {
          bestD = d;
          bestId = ids[i];
        }
      }
    }
    if (bestId < 0) return null;
    return objectAt(this.seed, bestId);
  }

  // ------------------------------------------------------------- input

  private onDown = (e: PointerEvent): void => {
    this.wake();
    e.preventDefault();
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      // Capture is how a drag that leaves the canvas stays real input.
    }
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.panBtn = e.button;
    if (this.pointers.size === 1) {
      this.dragging = true;
      this.looking = false;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      this.moved = 0;
      this.idle = 0;
    } else if (this.pointers.size === 2) {
      this.dragging = false;
      this.looking = false;
      const pts = [...this.pointers.values()];
      this.pinch0 = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    }
  };

  private onMove = (e: PointerEvent): void => {
    // Only a pointer we captured on down. Hover and UI clicks never land here.
    if (!this.pointers.has(e.pointerId)) return;
    if ((e.pointerType === 'mouse' || e.pointerType === 'pen') && e.buttons === 0) return;
    this.wake();
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pointers.size === 2) {
      const pts = [...this.pointers.values()];
      const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      if (this.pinch0 > 0) {
        const ratio = d / Math.max(1e-3, this.pinch0);
        this.zoom(Math.pow(1 / Math.max(0.2, ratio), ZOOM_PINCH_POW));
      }
      this.pinch0 = d;
      this.moved += 4;
      this.idle = 0;
      return;
    }
    if (!this.dragging) return;
    // This event's movement (capture keeps it real off-canvas).
    let dx = e.movementX;
    let dy = e.movementY;
    if (dx === 0 && dy === 0) {
      dx = e.clientX - this.lastX;
      dy = e.clientY - this.lastY;
    }
    if (dx === 0 && dy === 0) return;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    this.moved += Math.hypot(dx, dy);
    this.idle = 0;
    const strafe = this.mode === 'region' && (this.panBtn === 1 || this.panBtn === 2 || e.shiftKey);
    if (strafe) {
      this.strafePixels(dx, dy);
      return;
    }
    if (this.mode === 'region') {
      this.looking = true;
      this.clearCourse();
      this.arcYaw -= dx * 0.005;
      this.arcPitch = THREE.MathUtils.clamp(this.arcPitch - dy * 0.005, -1.45, 1.45);
      this.applyCam();
      return;
    }
    this.tgtTheta -= dx * 0.005;
    this.tgtPhi = Math.max(0.08, Math.min(1.52, this.tgtPhi - dy * 0.005));
    this.theta = this.tgtTheta;
    this.phi = this.tgtPhi;
  };

  private strafePixels(dx: number, dy: number): void {
    if (this.mode !== 'region') return;
    this.orientArc();
    const dist = Math.max(0.02, this.arcPace() * 8);
    const worldH = 2 * dist * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) * 0.5);
    const wpp = worldH / Math.max(1, this.canvas.clientHeight);
    this.moveBubble(this.arcRight.x * -dx * wpp + this.arcUp.x * dy * wpp, this.arcRight.y * -dx * wpp + this.arcUp.y * dy * wpp, this.arcRight.z * -dx * wpp + this.arcUp.z * dy * wpp);
    this.applyCam();
  }

  private onUp = (e: PointerEvent): void => {
    if (!this.pointers.has(e.pointerId)) return;
    this.wake();
    const tap = this.dragging && !this.looking && this.moved < TAP_SLOP;
    this.endPointer(e.pointerId);
    if (tap) this.pick(e.clientX, e.clientY);
  };

  private onLostCapture = (e: PointerEvent): void => {
    if (!this.pointers.has(e.pointerId)) return;
    this.endPointer(e.pointerId);
  };

  private endPointer(id: number): void {
    this.pointers.delete(id);
    if (this.pointers.size < 2) this.pinch0 = 0;
    this.dragging = false;
    this.looking = false;
  };

  private onWheel = (e: WheelEvent): void => {
    this.wake();
    e.preventDefault();
    this.zoom(Math.exp(e.deltaY * ZOOM_WHEEL_SENS));
    this.idle = 0;
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (this.mode === 'region' && !e.repeat) {
      if (e.code === 'ArrowUp') {
        e.preventDefault();
        if (!this.thrustOn) this.setGear(false);
        this.setWarp(true);
        return;
      }
      if (e.code === 'ArrowDown') {
        e.preventDefault();
        if (this.thrustOn) this.setWarp(false);
        else {
          this.setGear(true);
          this.setWarp(true);
        }
        return;
      }
      if (e.code === 'KeyW') {
        e.preventDefault();
        this.setWarp(true);
        return;
      }
      if (e.code === 'KeyS') {
        e.preventDefault();
        this.setWarp(false);
        return;
      }
    }
    if (this.isSteerKey(e.code)) {
      this.wake();
      if (this.mode === 'region') e.preventDefault();
      this.keys.add(e.code);
    }
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    if (!this.keys.has(e.code) && !this.isSteerKey(e.code)) return;
    this.keys.delete(e.code);
    this.wake();
  };

  private isSteerKey(code: string): boolean {
    return (
      code === 'KeyA' ||
      code === 'KeyD' ||
      code === 'KeyQ' ||
      code === 'KeyE' ||
      code === 'Space' ||
      code === 'KeyC' ||
      code === 'ArrowLeft' ||
      code === 'ArrowRight'
    );
  }

  private steerHeld(): boolean {
    for (const c of this.keys) if (this.isSteerKey(c)) return true;
    return false;
  }

  /** Catalog distance at which the object's disk covers ARRIVE_FILL of the vertical FOV. */
  private parkKpc(obj: GalaxyObject): number {
    // Remnants are point-sized (pulsar ~1e-5 R☉). Fill-park on that
    // radius is ~1e-15 kpc — closer than holdCourse will aim, so
    // warp never Stops. Floor at a WD photosphere: one law, every
    // compact object still has a reachable park.
    const Rsun = Math.max(0.01, obj.star.radius);
    const R = Rsun * UNIVERSE.RSUN_KM * KM_TO_KPC;
    const fov = (this.camera.fov * Math.PI) / 180;
    const half = 0.5 * UNIVERSE.ARRIVE_FILL * fov;
    return R / Math.max(1e-8, Math.tan(half));
  }

  /**
   * Latched warp: W / Warp is a fixed catalog rate in the current
   * gear; S / Stop is stop. When stopped, ↑ sets ahead and warps,
   * ↓ sets astern and warps. The helm gear flips the sign: astern
   * runs opposite the nose so you can back off a park. Inside a host's
   * ARRIVE_RANGE_LY sphere the rate is ARRIVE_WARP of GALAXY_WARP —
   * a speed limit, sticky until you fly out. If this step would
   * enter the sphere, the limit already applies (or a warp frame
   * skips it). Ahead on a locked course Stops at the fill park —
   * no teleport, no leftover-frame dump. Astern never parks.
   */
  private cruise(dt: number): void {
    if (this.mode !== 'region') {
      this.thrustOn = false;
      this.thrustSpeed = 0;
      return;
    }
    if (this.thrustOn && !this.warpMayRun()) this.thrustOn = false;
    this.orientArc();
    this.updateArriveSubject();
    const sign = this.thrustSign();
    let v = UNIVERSE.GALAXY_WARP;
    const course = this.courseObj;
    const range = UNIVERSE.ARRIVE_RANGE_KPC;
    if (this.hostObj) {
      v = this.sphereSpeed(this.arriveDist(this.hostObj));
    } else if (course) {
      const d = this.arriveDist(course);
      const c = galToCart(course.pos);
      const tCa =
        ((c.x - this.arcCenter.x) * this.arcFwd.x +
          (c.y - this.arcCenter.y) * this.arcFwd.y +
          (c.z - this.arcCenter.z) * this.arcFwd.z) *
        sign;
      if (tCa > 0 && d - UNIVERSE.GALAXY_WARP * dt <= range) v = this.sphereSpeed(d);
    }
    this.thrustSpeed = this.thrustOn ? v : 0;
    if (this.thrustSpeed <= 0) return;
    let step = this.thrustSpeed * dt;
    if (!this.astern && course) {
      const d = this.arriveDist(course);
      const park = this.parkKpc(course);
      if (d <= park) {
        this.setWarp(false);
        return;
      }
      const c = galToCart(course.pos);
      const tCa =
        (c.x - this.arcCenter.x) * this.arcFwd.x +
        (c.y - this.arcCenter.y) * this.arcFwd.y +
        (c.z - this.arcCenter.z) * this.arcFwd.z;
      if (tCa > 0 && step >= d - park) {
        const inv = 1 / d;
        const remain = d - park;
        this.moveBubble(
          (c.x - this.arcCenter.x) * inv * remain,
          (c.y - this.arcCenter.y) * inv * remain,
          (c.z - this.arcCenter.z) * inv * remain,
        );
        this.setWarp(false);
        return;
      }
    }
    this.moveBubble(this.arcFwd.x * sign * step, this.arcFwd.y * sign * step, this.arcFwd.z * sign * step);
  }

  private steerArc(dt: number): void {
    let mx = 0;
    let my = 0;
    let mz = 0;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) mx += 1;
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) mx -= 1;
    if (this.keys.has('KeyE') || this.keys.has('Space')) my += 1;
    if (this.keys.has('KeyQ') || this.keys.has('KeyC')) my -= 1;
    if (mx === 0 && my === 0 && mz === 0) return;
    this.orientArc();
    const boost = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') ? 3 : 1;
    const pace = this.arcPace() * boost;
    this.moveBubble(
      (this.arcRight.x * mx + this.arcUp.x * my + this.arcFwd.x * mz) * pace * dt,
      (this.arcRight.y * mx + this.arcUp.y * my + this.arcFwd.y * mz) * pace * dt,
      (this.arcRight.z * mx + this.arcUp.z * my + this.arcFwd.z * mz) * pace * dt,
    );
    this.idle = 0;
  }

  // --------------------------------------------------------------- sight

  /**
   * Filter the local catalog cloud and lock the centre reticle onto
   * a visitable star. Silhouette backdrop rows are not in this cloud.
   */
  private updateSight(force = false): void {
    if (this.mode !== 'region') return;
    const now = performance.now();
    if (!force && now - this.lastSightAt < 50) return;
    this.lastSightAt = now;
    this.aimReticle();
  }

  /**
   * Centre reticle vs local catalog points. Lock uses the visit body
   * (aimRadiusKpc), not the 1px paint pin — a star that flies through
   * the pip is real and set-course-able even while it is still a point.
   * Dust is an ISM address; the magnitude-limited backdrop is not here.
   */
  private aimReticle(): void {
    if (this.mode !== 'region') {
      this.focusObj = null;
      this.focusHud = null;
      this.grownCount = 0;
      return;
    }
    if (!this.cloud && !this.nebulae) {
      this.focusObj = null;
      this.focusHud = null;
      this.grownCount = 0;
      return;
    }
    this.orientArc();
    const lx = this.arcFwd.x;
    const ly = this.arcFwd.y;
    const lz = this.arcFwd.z;
    const cx = 0;
    const cy = 0;
    const cz = 0;
    const cosCone = Math.cos(0.028);
    const ox = this.arcCenter.x;
    const oy = this.arcCenter.y;
    const oz = this.arcCenter.z;
    let grown = 0;
    let bestId = -1;
    let bestOff = 1;
    let bestDist = 0;
    let bestDim = false;
    for (const cloud of [this.cloud, this.nebulae]) {
      if (!cloud) continue;
      const cat = cloud.pos;
      const lum = cloud.lum;
      const bits = cloud.bits;
      const ids = cloud.ids;
      for (let i = 0; i < cloud.n; i++) {
        if (!sketchMatches(bits[i], this.filter)) continue;
        const i3 = i * 3;
        const dx = cat[i3] - ox - cx;
        const dy = cat[i3 + 1] - oy - cy;
        const dz = cat[i3 + 2] - oz - cz;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < 1e-12) continue;
        const dist = Math.sqrt(d2);
        if (dist > UNIVERSE.AIM_RANGE_KPC) continue;
        if (this.hostObj && ids[i] !== this.hostObj.id) continue;
        const dim = (bits[i] & BIT_REMNANT) !== 0 || lum[i] < 0.05;
        if (!aimLocks(lum[i], dist, dim)) continue;
        grown++;
        const inv = 1 / dist;
        const dot = dx * inv * lx + dy * inv * ly + dz * inv * lz;
        if (dot < cosCone) continue;
        const off = 1 - dot;
        if (off < bestOff) {
          bestOff = off;
          bestId = ids[i];
          bestDist = dist;
          bestDim = dim;
        }
      }
    }
    this.grownCount = grown;
    if (bestId < 0) {
      this.focusObj = null;
      this.focusHud = null;
      return;
    }
    if (this.focusObj?.id === bestId && this.focusHud) {
      this.focusHud.dist = bestDist;
      this.focusHud.dark = bestDim;
      return;
    }
    const hit = objectAt(this.seed, bestId);
    if (!hit) {
      this.focusObj = null;
      this.focusHud = null;
      return;
    }
    this.focusObj = hit;
    const brief = this.briefFor(hit);
    const st = hit.star;
    this.focusHud = {
      id: hit.id,
      name: brief.name,
      cls: classifyStar(st),
      phase: st.phase.replace(/_/g, ' '),
      planets: brief.planets,
      moons: brief.moons,
      life: brief.life,
      dark: bestDim,
      x: 0.5,
      y: 0.5,
      dist: bestDist,
    };
  }

  private briefFor(obj: GalaxyObject): { name: string; planets: number; moons: number; life: boolean } {
    const hit = this.briefMemo.get(obj.id);
    if (hit) return hit;
    if (this.briefMemo.size > 48) this.briefMemo.clear();
    try {
      const spec = systemAt(this.seed, obj.id);
      let planets = 0;
      let moons = 0;
      let life = false;
      for (const b of spec.bodies) {
        if (b.parent) moons++;
        else planets++;
        if (b.physics.life) life = true;
      }
      const row = { name: spec.star.name, planets, moons, life };
      this.briefMemo.set(obj.id, row);
      return row;
    } catch {
      const row = { name: classifyStar(obj.star), planets: 0, moons: 0, life: false };
      this.briefMemo.set(obj.id, row);
      return row;
    }
  }

  /** Filter dims non-matching points; every star stays a point. */
  private applyStarVis(): void {
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
  private applyNebVis(): void {
    if (!this.nebVis || !this.nebulae) return;
    const arr = this.nebVis.array as Float32Array;
    const { bits, gain, n } = this.nebulae;
    const lim = Math.min(n, arr.length);
    for (let i = 0; i < lim; i++) {
      arr[i] = sketchMatches(bits[i], this.filter) ? gain[i] : gain[i] * 0.08;
    }
    this.nebVis.needsUpdate = true;
  }

  // --------------------------------------------------------------- frame

  /** Frames left before the loop rests. The galaxy is a static
   *  catalog: at rest nothing changes, so nothing should render —
   *  every star vertex re-marches the dust column each draw
   *  (~37M texture taps a frame), pure heat when the camera is
   *  still. Planets will live inside this scene; it must idle
   *  cold. */
  private restIn = 90;
  private lastPose = { x: NaN, y: 0, z: 0, yaw: 0, pitch: 0 };

  /** Keep the loop rendering for at least n more frames.
   *  Resting stops rAF entirely — wake is the only restart. */
  private wake(n = 45): void {
    this.restIn = Math.max(this.restIn, n);
    if (this.disposed || !this.active || this.raf) return;
    this.lastT = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  private frame = (): void => {
    if (this.disposed || !this.active) {
      this.raf = 0;
      return;
    }
    const f0 = performance.now();
    // Rewire every material whenever the baked volume changes —
    // the one path that covers boot mint, cache hit, and rebuild.
    if (harvestDustVolume(this.seed) !== this.dustWired) {
      this.replaceDust();
      this.wake();
    }
    const now = performance.now();
    const dt = Math.min(0.05, (now - this.lastT) / 1000);
    this.lastT = now;
    this.lastDt = dt;
    this.idle += dt;
    this.holdCourse(dt);
    this.cruise(dt);
    this.steerArc(dt);
    // Motion is the universal wake: input, warp, and settling
    // all end as pose drift. Hover, a parked Home pick, and a
    // spinning focus ring are not motion — those used to keep
    // the catalog remarching forever. Everything else that can
    // change a pixel calls wake() explicitly.
    const p = this.lastPose;
    const moved =
      Math.abs(p.x - this.arcCenter.x) > 1e-9 ||
      Math.abs(p.y - this.arcCenter.y) > 1e-9 ||
      Math.abs(p.z - this.arcCenter.z) > 1e-9 ||
      Math.abs(p.yaw - this.arcYaw) > 1e-9 ||
      Math.abs(p.pitch - this.arcPitch) > 1e-9;
    if (moved || !Number.isFinite(p.x)) {
      p.x = this.arcCenter.x;
      p.y = this.arcCenter.y;
      p.z = this.arcCenter.z;
      p.yaw = this.arcYaw;
      p.pitch = this.arcPitch;
      this.applyCam();
      this.wake(30);
    }
    if (this.thrustOn || this.steerHeld()) this.wake(2);
    if (this.restIn <= 0) {
      this.perf.tick(performance.now() - f0, false);
      this.perf.markRest();
      this.raf = 0;
      return;
    }
    this.restIn--;
    this.updateSight();
    this.aimReticle();

    const t = now * 0.001;
    const px = this.renderer.getPixelRatio();
    const pxPer = this.pxPerRad();
    // View→catalog rotation so the cloud march samples a camera-stable field.
    this.camera.updateMatrixWorld();
    this.camRot3.setFromMatrix4(this.camera.matrixWorld);
    for (const mat of this.cloudMats()) {
      if (mat.uniforms.uPixel) mat.uniforms.uPixel.value = px;
      if (mat.uniforms.uPxPerRad) mat.uniforms.uPxPerRad.value = pxPer;
      if (mat.uniforms.uCamRotInv) {
        (mat.uniforms.uCamRotInv.value as THREE.Matrix3).copy(this.camRot3);
      }
      if (mat.uniforms.uInvProj) {
        (mat.uniforms.uInvProj.value as THREE.Matrix4).copy(this.camera.projectionMatrixInverse);
      }
    }

    const cam = this.camera.position;
    const ringFor = (mesh: THREE.Mesh, lo: number, hi: number, k: number) => {
      const d = cam.distanceTo(mesh.position);
      mesh.scale.setScalar(Math.max(lo, Math.min(hi, d * k)));
    };
    ringFor(this.pickRing, 0.00035, 0.03, 0.045);
    ringFor(this.hereRing, 0.0005, 0.045, 0.06);
    this.pickRing.rotation.z = t * 0.35;
    this.hereRing.rotation.z = t * -0.22;

    this.updateHostArrival(now);
    // Attach can land on this frame — write the survey dim after
    // the host is known so the first in-sphere draw is already dark.
    const dim = this.skyDim();
    for (const mat of this.cloudMats()) {
      if (mat.uniforms.uSkyDim) mat.uniforms.uSkyDim.value = dim;
    }
    if (this.hostFill) this.hostFill.intensity = dim;

    // One scene, one pass, straight to the canvas: the void is
    // black (vacuum emits nothing), self-extincted background
    // sprites add onto it, then the galaxy draws in front. A
    // stacked column saturates to white — film, not a knee.
    this.renderer.setRenderTarget(null);
    this.perf.beginDraw();
    this.renderer.render(this.scene, this.camera);
    if (this.hostRoot && this.hostObj) {
      // Close-approach pass: same camera pose, AU-scale depth window,
      // drawn over the live galaxy. The star is IN the galaxy — the
      // sky never bakes, blanks, or switches environment; the depth
      // buffer is simply re-cleared for the near geometry.
      const d = this.arriveDist(this.hostObj);
      const aKpc = this.hostOuterAu * UNIVERSE.AU_KM * KM_TO_KPC;
      const near0 = this.camera.near;
      const far0 = this.camera.far;
      this.camera.near = Math.max(1e-18, Math.min(d * 0.02, aKpc * 0.01));
      this.camera.far = Math.max(d * 8, aKpc * 40, 1e-8);
      this.camera.updateProjectionMatrix();
      this.renderer.autoClear = false;
      this.renderer.clearDepth();
      this.renderer.render(this.hostScene, this.camera);
      this.renderer.autoClear = true;
      this.camera.near = near0;
      this.camera.far = far0;
      this.camera.updateProjectionMatrix();
    }
    this.perf.endDraw();
    this.perf.tick(performance.now() - f0, true);
    this.callbacks.onFrame?.({
      mode: this.mode,
      theta: this.theta,
      phi: this.phi,
      radius: Math.hypot(this.arcCenter.x, this.arcCenter.z),
      pickable: true,
      resolved: this.shownCount(),
      grown: this.grownCount,
      sector: this.regionLabel,
      population: this.sectorPop,
      focus: this.focusHud,
      course: this.courseHud,
      warp: this.thrustOn,
      astern: this.astern,
      backdrop: this.shownCount(),
    });
    this.raf = requestAnimationFrame(this.frame);
  };
}
