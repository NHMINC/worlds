/**
 * Hubble glow: the unresolved mass as surface brightness.
 * Face-on, ~10⁹ stars are this integral — not a pin list and not
 * a painted spiral. Density is densityParts without stellar arms
 * (Stellata's lesson: extra spatial frequency aliases). Colour is
 * a luminosity-weighted population mix: old bulge/bar/thick → K,
 * young thin → late-B. Dust extincts the march the way it extincts
 * stars. A faint ionized sheet (mean molecular field × gas arms)
 * is a second term, same pass, own gain. The integral sits in
 * front of the far photograph: coverage is 1 − exp(−L), so the
 * night and the pins do not sparkle through the disk. Additive
 * glow cannot cover; this one can.
 */
import { UNIVERSE } from '../world/physics';
import { teffToRgb } from '../world/stellar';

const glslFloat = (x: number): string => (Number.isInteger(x) ? `${x}.0` : `${x}`);

/** Saturation push so a 1 kpc integral still reads as K-gold / B-blue. */
function satPush(rgb: [number, number, number], sat: number): [number, number, number] {
  const lum = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  const ch = (c: number) => Math.min(1, Math.max(0, lum + sat * (c - lum)));
  return [ch(rgb[0]), ch(rgb[1]), ch(rgb[2])];
}

/** Old-pop light: a K4 giant (the Hubble bump). */
export function glowOldRgb(): [number, number, number] {
  return satPush(teffToRgb(4050), 1.85);
}

/** Young thin-disk light: a late-B (the hot harvest's unresolved cousins). */
export function glowYoungRgb(): [number, number, number] {
  return satPush(teffToRgb(14_000), 1.55);
}

/** Ionized sheet: Hα body with a little [O III]. Same lines as nebulae. */
export function glowSfrRgb(): [number, number, number] {
  const ha: [number, number, number] = [1, 0.4, 0.36];
  const o3: [number, number, number] = [0.3, 0.95, 0.8];
  return [ha[0] * 0.72 + o3[0] * 0.28, ha[1] * 0.72 + o3[1] * 0.28, ha[2] * 0.72 + o3[2] * 0.28];
}

/** Same clip-quad as the cosmic void — triangles never cross the camera. */
export function glowVert(): string {
  return /* glsl */ `
  varying vec2 vNdc;
  void main() {
    vNdc = position.xy;
    gl_Position = vec4(position.xy, 1.0, 1.0);
  }
`;
}

/**
 * Analytic mass-model march. `steps` is compiled (GLSL ES 1.0 has
 * no uniform loop bound). Live knobs scale the photograph, not the
 * field. Arms stay off the stellar integral; gas arms ride the SFR term.
 */
export function glowFrag(extinctChunk: string, steps: number): string {
  const U = UNIVERSE;
  const n = glslFloat(steps);
  const Rmax = U.GALAXY_R_MAX * 1.18;
  const zHalf = Math.max(U.GALAXY_Z_THICK * 3.6, 2.8);
  const cot = 1 / Math.max(0.05, Math.tan(U.GALAXY_PITCH));
  return /* glsl */ `
  ${extinctChunk}
  varying vec2 vNdc;
  uniform vec3 uCenter;
  uniform mat3 uCamRotInv;
  uniform mat4 uInvProj;
  uniform float uGlowGain;
  uniform float uGlowOld;
  uniform float uGlowYoung;
  uniform float uGlowSfr;
  uniform float uGlowCore;
  uniform float uGlowCut;
  uniform float uGlowSelf;
  uniform float uGlowDust;
  uniform vec3 uGlowOldRgb;
  uniform vec3 uGlowYoungRgb;
  uniform vec3 uGlowSfrRgb;

  float glowSech2(float x) {
    float e = exp(clamp(x, -12.0, 12.0));
    float s = 2.0 / (e + 1.0 / e);
    return s * s;
  }

  float glowDiskSigma(float R) {
    float blend = 1.0 / (1.0 + exp((R - ${glslFloat(U.GALAXY_R_BREAK)}) / ${glslFloat(U.GALAXY_R_BREAK_W)}));
    return blend * exp(-R / ${glslFloat(U.GALAXY_RD_INNER)}) + (1.0 - blend) * exp(-R / ${glslFloat(U.GALAXY_RD)});
  }

  // Catalog frame: x = R cos θ, y = height, z = R sin θ.
  void glowParts(vec3 p, out float oldL, out float coreL, out float youngL, out float sfrL) {
    float R = length(p.xz);
    float z = p.y;
    float x = p.x;
    float y = p.z;
    float thin = ${glslFloat(U.GALAXY_THIN_AMP)} * glowDiskSigma(R) * glowSech2(z / ${glslFloat(U.GALAXY_ZD)});
    float thick = 0.13 * exp(-R / ${glslFloat(U.GALAXY_RD_THICK)}) * glowSech2(z / ${glslFloat(U.GALAXY_Z_THICK)});
    float rb2 =
      (x * x) / ${glslFloat(U.GALAXY_BAR_A * U.GALAXY_BAR_A)} +
      (y * y) / ${glslFloat(U.GALAXY_BAR_B * U.GALAXY_BAR_B)} +
      (z * z) / ${glslFloat(U.GALAXY_BAR_C * U.GALAXY_BAR_C)};
    float bar = rb2 < 1.0 ? ${glslFloat(U.GALAXY_BAR_AMP)} * pow(1.0 - rb2, 1.6) : 0.0;
    float box = ${glslFloat(U.GALAXY_BOX_AMP)} * exp(-0.5 * (
      (x * x) / ${glslFloat(U.GALAXY_BOX_A * U.GALAXY_BOX_A)} +
      (y * y) / ${glslFloat(U.GALAXY_BOX_B * U.GALAXY_BOX_B)} +
      (z * z) / ${glslFloat(U.GALAXY_BOX_C * U.GALAXY_BOX_C)}));
    float k = ${glslFloat(U.GALAXY_PEANUT_Z / U.GALAXY_PEANUT_R)};
    float xa = min(abs(x), 2.2);
    float ridge = exp(-0.5 * ((x * x) / 2.1025 + (y * y) / 0.1764));
    float peanut = ${glslFloat(U.GALAXY_PEANUT_AMP)} * ridge * (
      exp(-0.5 * pow((z - k * xa) / 0.2, 2.0)) +
      exp(-0.5 * pow((z + k * xa) / 0.2, 2.0)));
    float nuc = ${glslFloat(U.GALAXY_NUC_AMP)} * exp(-R / ${glslFloat(U.GALAXY_NUC_RD)}) * glowSech2(z / ${glslFloat(U.GALAXY_NUC_ZD)});
    float r = length(p);
    float halo = ${glslFloat(U.GALAXY_HALO_AMP)} / pow(1.0 + r / ${glslFloat(U.GALAXY_HALO_A)}, 3.5);
    // Spheroid (core) vs thick/halo stay separate so the Hubble bump
    // can lift without lighting the halo fog.
    oldL = max(0.0, thick + halo);
    coreL = max(0.0, box + peanut + nuc + bar);
    youngL = max(0.0, thin);
    float holeR = ${glslFloat(U.GALAXY_DUST_HOLE)};
    float holeP = ${glslFloat(U.GALAXY_DUST_HOLE_P)};
    float hole = holeR <= 1e-4 ? 1.0 : 1.0 - exp(-pow(R / holeR, holeP));
    float theta = atan(p.z, p.x);
    float phase = ${glslFloat(U.GALAXY_ARM_M)} * theta
      - ${glslFloat(U.GALAXY_ARM_M * cot)} * log(max(R, 0.15) / ${glslFloat(U.GALAXY_RD)});
    float gas = hole
      * exp(-R / ${glslFloat(U.GALAXY_RD * U.GALAXY_RD_GAS)})
      * glowSech2(z / ${glslFloat(U.GALAXY_ZD_GAS)})
      * (1.0 + ${glslFloat(U.GALAXY_GAS_ARM_A)} * cos(phase));
    sfrL = max(0.0, gas);
  }

  // Finite disk: cylinder in xz × height slab. Camera may sit inside.
  vec2 glowSpan(vec3 ro, vec3 rd) {
    float R2 = ${glslFloat(Rmax * Rmax)};
    float a = rd.x * rd.x + rd.z * rd.z;
    float tC0 = 0.0;
    float tC1 = 80.0;
    if (a > 1e-8) {
      float b = 2.0 * (ro.x * rd.x + ro.z * rd.z);
      float c = ro.x * ro.x + ro.z * ro.z - R2;
      float h = b * b - 4.0 * a * c;
      if (h < 0.0 && c > 0.0) return vec2(1.0, -1.0);
      if (h >= 0.0) {
        float s = sqrt(max(h, 0.0));
        tC0 = (-b - s) / (2.0 * a);
        tC1 = (-b + s) / (2.0 * a);
      }
    } else if (ro.x * ro.x + ro.z * ro.z > R2) {
      return vec2(1.0, -1.0);
    }
    float zH = ${glslFloat(zHalf)};
    float tY0;
    float tY1;
    if (abs(rd.y) < 1e-8) {
      if (abs(ro.y) > zH) return vec2(1.0, -1.0);
      tY0 = tC0;
      tY1 = tC1;
    } else {
      float ya = (-zH - ro.y) / rd.y;
      float yb = (zH - ro.y) / rd.y;
      tY0 = min(ya, yb);
      tY1 = max(ya, yb);
    }
    float t0 = max(max(tC0, tY0), 0.0);
    float t1 = min(tC1, tY1);
    return vec2(t0, t1);
  }

  void main() {
    if (uGlowGain < 1e-4) discard;
    vec4 view = uInvProj * vec4(vNdc, 1.0, 1.0);
    vec3 camDir = normalize(view.xyz / max(abs(view.w), 1e-6));
    vec3 dir = normalize(uCamRotInv * camDir);
    vec2 span = glowSpan(uCenter, dir);
    if (span.x > span.y) discard;
    float t0 = span.x;
    float t1 = span.y;
    float dCat = t1 - t0;
    if (dCat < 1e-4) discard;
    float dt = dCat / ${n};
    float kdt = uExtinctK * dt;
    float wall = uExtinctWall;
    float coreFill = uExtinctMax / max(kdt, 1e-4);
    vec3 T = vec3(1.0);
    vec3 em = vec3(0.0);
    for (int i = 0; i < ${steps}; i++) {
      vec3 p = uCenter + dir * (t0 + (float(i) + 0.5) * dt);
      float oldL;
      float coreL;
      float youngL;
      float sfrL;
      glowParts(p, oldL, coreL, youngL, sfrL);
      float cut = uGlowCut;
      float coreW = max(0.0, coreL - cut) * uGlowCore;
      float oldW = max(0.0, oldL - cut) * uGlowOld;
      float youngW = max(0.0, youngL - cut) * uGlowYoung;
      float sfrW = max(0.0, sfrL - cut * 0.35) * uGlowSfr;
      vec3 src = uGlowOldRgb * (oldW + coreW) + uGlowYoungRgb * youngW + uGlowSfrRgb * sfrW;
      float self = (oldW + coreW + youngW + sfrW) * uGlowSelf;
      T *= exp(-vec3(self * dt));
      float r = extinctRhoPeak(p, dir, dt);
      float dust = r;
      if (wall > 1e-4) {
        float core = smoothstep(wall * 0.62, wall, r);
        dust = mix(r, max(r, coreFill), core);
        if (r >= wall * 0.62) T = vec3(0.0);
      }
      T *= exp(-dust * kdt * uDustRgb * uGlowDust);
      em += src * T * dt;
    }
    vec3 c = em * uGlowGain;
    float L = max(dot(c, vec3(0.2126, 0.7152, 0.0722)), 0.0);
    if (L < 0.004) discard;
    // Unresolved disk is in front of the decreed night. Additive
    // dest+src left the pins sparkling through every inter-clump
    // gap; coverage is the same integral as the light.
    float cover = 1.0 - exp(-L * 8.0);
    gl_FragColor = vec4(c, cover);
  }
`;
}
