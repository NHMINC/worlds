import { UNIVERSE } from '../world/physics';

/**
 * THE surf law — the only copy. Terrain (beach terrace + cliffs) and the
 * sea surface compile this same function. Bathymetry is the input: depth
 * in levels, slope in levels-per-column. Everything else is a consequence.
 *
 *   Green's law    H ~ H∞ · (d0 / d)^{1/4}     — waves grow as they shoal
 *   McCowan        break when H / d > γ         — the breaker line
 *   slope          spilling / plunging / surge  — beach vs cliff
 *
 * Outside the breaker: a travelling swell (phase ~ √d + ωt), sparse
 * whitecaps. At the line: a crash. Inside, on a beach: the crashed wave
 * is a foam bore that rides the remaining water to the coast. A cliff
 * reflects and splashes; it does not grow a surf zone.
 *
 * Foam is Mie-white scatter sitting ON the water, applied after the air
 * integral — otherwise the sky paints the surf blue.
 */
export const SURF_LAW_GLSL = /* glsl */ `
const float WAVE_H0 = float(${UNIVERSE.WAVE_H0});
const float WAVE_D0 = float(${UNIVERSE.WAVE_D0});
const float BREAK_GAMMA = float(${UNIVERSE.BREAK_GAMMA});

float surfFoam(
  float depth,
  float ashore,
  float slopeCell,
  float energy,
  float surfGate,
  float att,
  float freq
) {
  float pxl = max(fwidth(depth), 1e-5);
  float beach = 1.0 - smoothstep(0.35, 1.1, slopeCell);
  float wall = smoothstep(1.1, 2.2, slopeCell);
  float cliff = smoothstep(0.4, 1.8, slopeCell);

  float dPos = max(depth, 0.0);
  float H = energy * WAVE_H0 * pow(WAVE_D0 / max(dPos, 0.18), 0.25);
  float steep = H / max(dPos, 0.12);
  float broken = smoothstep(BREAK_GAMMA * 0.45, BREAK_GAMMA * 1.05, steep);
  float onShelf = 1.0 - smoothstep(WAVE_D0 * 0.9, WAVE_D0 * 1.45, dPos);

  float off = vnoise(vPos * freq * 0.35 + vec3(1.7, 8.3, 5.9));
  float drift = 0.5 * vnoise(vPos * freq * 0.18 + vec3(9.1, 4.4, 6.7) + uTime * 0.009);
  float slant = 0.25 * (vnoise(vPos * freq * 0.9 + vec3(2.9, 7.2, 11.4)) - 0.5);
  float omega = uWaveTempo * 0.042;
  float ph = fract(1.4 * sqrt(dPos) + off + slant + drift + uTime * omega);
  // Thin travelling crest (the swell). Wider bore: the crashed body that
  // rides IN — it leads the crest in phase so the white water is the wave,
  // not a hat on blue water.
  float crest = smoothstep(0.62, 0.80, ph) * (1.0 - smoothstep(0.90, 1.0, ph));
  float bore = smoothstep(0.18, 0.48, ph) * (1.0 - smoothstep(0.84, 1.0, ph));
  float phO = fract(1.4 * sqrt(dPos) + 0.37 + 0.7 * off + drift - uTime * omega);
  float crestO = smoothstep(0.66, 0.85, phO) * (1.0 - smoothstep(0.93, 1.0, phO));

  float churn = vnoise(vPos * freq * 5.2 + vec3(uTime * 0.65, -uTime * 0.5, 4.4))
              * vnoise(vPos * freq * 8.1 + vec3(-uTime * 0.45, uTime * 0.6, 9.3));
  float grain = smoothstep(0.24, 0.48, churn);

  // Deep/mid: sparse whitecaps on steep crests that have not yet broken.
  float whitecap = crest * smoothstep(0.20, 0.48, steep) * (1.0 - 0.9 * broken) * 0.28;
  // Spilling beach: the roller is the wave. Residual foam fills the surf
  // zone between pulses (broken water does not instantly go clear).
  float roller = broken * (0.88 * bore + 0.42 * (0.40 + 0.60 * grain));
  // Plunging / bank: the crash stays on the crest; little white water inshore.
  float plunge = broken * crest;
  float reflected = crestO * mix(0.04, 0.42, cliff) * broken;
  float wetSide = step(0.0, depth);
  float seaFoam = wetSide * att * onShelf * (
      whitecap
    + mix(plunge, roller, beach)
    + reflected
  );

  float reachW = mix(0.7, 2.2, beach);
  float reachGate = 1.0 - smoothstep(0.45 * reachW, reachW, ashore / max(slopeCell, 0.22));
  float swashW = min(max(1.2, 6.0 * pxl), 2.0);
  float landSq = mix(1.8, 4.5, cliff);
  float line = 1.0 - smoothstep(0.0, swashW, depth < 0.0 ? -landSq * depth : depth);
  line *= depth < 0.0 ? reachGate : 1.0;

  float runup = (0.15 + 0.65 * beach) * (0.3 + 0.7 * energy)
              * mix(1.5, 0.85, smoothstep(0.4, 1.1, uWaveTempo));
  float phS = fract(off + slant + drift + uTime * omega - 0.88 - 0.4 * ashore / max(runup, 0.05));
  float rush = smoothstep(0.0, 0.16, phS) * (1.0 - smoothstep(0.22, 0.85, phS));
  float wash = beach * rush * exp(-ashore / max(runup, 0.05))
             * (1.0 - smoothstep(0.5, 1.1, ashore)) * reachGate
             * (0.5 + 0.5 * grain);

  float phX = fract(off + slant + drift + uTime * omega - 0.9);
  float burst = smoothstep(0.0, 0.06, phX) * (1.0 - smoothstep(0.1, 0.4, phX));
  float splash = wall * burst * (1.0 - smoothstep(0.0, 0.45, ashore))
               * (0.35 + 0.65 * smoothstep(0.85, 1.0, energy))
               * (0.4 + 0.6 * grain);

  float landFoam = (1.0 - wetSide) * (wash + splash) * att * energy;
  float lap = mix(0.5, vnoise(vPos * freq * 1.6 + vec3(uTime * 0.25, uTime * -0.18, 3.1)), att);
  float foam = line * (0.10 + 0.10 * lap) * (0.15 + 0.85 * energy);
  foam += 0.95 * seaFoam;
  foam += 0.78 * landFoam;
  return clamp(foam * surfGate * uWaveGain, 0.0, 0.96);
}

vec3 surfFoamColor(float day) {
  return vec3(0.97, 1.0, 1.0) * mix(vec3(0.28, 0.34, 0.52), vec3(1.0), day);
}
`;
