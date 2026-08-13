/**
 * THE scattering law — the only copy. Exponential air (physics.airExtinction:
 * sigma, scale height, per-wavelength weights all derived from chemistry),
 * Beer–Lambert extinction, and single in-scatter of sunlight with slant-path
 * attenuation toward the sun. Every shader that meets the air — terrain,
 * water, and the sky shell — compiles this same chunk and marches the same
 * integral along its own view rays. The camera is just wherever it is:
 * from orbit these numbers read as the blue limb and hazy distance; from
 * the ground the identical numbers read as a bright sky, red sunsets and a
 * dark star-lit night. Nothing is imposed per viewpoint.
 */
export const AIR_UNIFORMS_GLSL = /* glsl */ `
uniform vec3 uAirW;      // per-wavelength scattering weights, mean 1
uniform float uAirSigma; // surface extinction per planet radius of path; 0 = airless
uniform float uAirH;     // density scale height, planet radii
uniform float uSunLum;   // display luminance of raw sunlight (universe constant)
uniform vec3 uAirNight;  // starlight/airglow floor: night air is never a void
uniform float uAirCurv;  // Chapman curvature 2H/R of the REAL planet (physics.airExtinction)
uniform vec3 uAirAlb;    // single-scattering albedo: what survives one bounce (chemistry absorbers)
uniform float uAeroTau;  // aerosol CLOUD DECK: vertical optical column (0 = clear skies)
uniform vec3 uAeroW;     // aerosol per-wavelength weights, mean 1 (Mie-flat chemistry tint)
uniform float uTorch;    // headlamp brightness (engine eases it in when daylight dies)
uniform vec3 uTorchDir;  // headlamp axis, body-local
`;

export const AIR_SCATTER_GLSL = /* glsl */ `
// The cloud deck's altitude profile: condensates condense at their
// condensation altitude, not at the ground, so the aerosol column rides a
// Gaussian shell centered ~3 scale heights up (width 1.2H). Above it:
// space sees an opaque ball. Below it: CLEAR air under a glowing ceiling —
// Venus is soup at 55 km and a hazy desert at the floor. deckAbove is the
// fraction of the column above radius r (logistic ≈ Gaussian CDF), for
// sunlight and diffusion columns; deckRho is the local density whose
// integral over r is exactly uAeroTau.
float deckRho(float r) {
  float z = (r - 1.0 - 3.0 * uAirH) / (1.2 * uAirH);
  return exp(-0.5 * z * z) / (3.0 * uAirH);
}
float deckAbove(float r) {
  float z = (r - 1.0 - 3.0 * uAirH) / (1.2 * uAirH);
  return 1.0 / (1.0 + exp(1.7 * z));
}
// The torch beam made visible by the air itself: every parcel inside the
// cone scatters lamp light back toward the eye, so sigma alone decides
// how obvious the beam is AND how far it carries — the integrand
// sig * e^(-2*sig*d) concentrates a fixed light budget ever closer to the
// lamp as the air thickens. Clean air shows almost no beam (just the pool
// where the light lands), fog shows a bright short cone, and a vacuum
// shows nothing at all. Same march, same deck, same weights as sunlight:
// the beam is not drawn, it is scattered.
vec3 torchGlow(vec3 a, vec3 b) {
  if (uTorch <= 0.0) return vec3(0.0);
  float len = distance(a, b);
  vec3 vd = (b - a) / max(len, 1e-6);
  float cone = smoothstep(0.78, 0.965, dot(vd, uTorchDir));
  if (cone <= 0.0) return vec3(0.0);
  float L = min(len, 0.25);
  float seg = L / 6.0;
  vec3 tau2 = vec3(0.0);
  vec3 glow = vec3(0.0);
  for (int i = 0; i < 6; i++) {
    float d = (float(i) + 0.5) * seg;
    vec3 sp = a + vd * d;
    float r = max(length(sp), 1.0);
    float rho = exp(-(r - 1.0) / uAirH);
    vec3 sig = uAirSigma * uAirW * rho + uAeroTau * uAeroW * deckRho(r);
    float fall = 1.0 / (1.0 + 300.0 * d * d);
    // Out-and-back extinction to the midpoint of this parcel.
    glow += sig * fall * exp(-2.0 * tau2 - sig * seg) * seg;
    tau2 += sig * seg;
  }
  return uTorch * vec3(1.0, 0.96, 0.88) * (0.5 * cone) * glow;
}
// March the view path a→b (body-local frame, planet radius 1) and return
// the light the air scatters toward the camera; per-channel optical depth
// of the path lands in tau. At each sample, the sun's own light arrives
// attenuated by its slant path through the air (density * scale height /
// cos zenith): grazing sunlight loses its blue and the terminator fades
// out — sunset colors and twilight are consequences, not styling. Air the
// sun cannot reach still scatters the starlight/airglow floor, so night
// horizons fade into a faint glow instead of a black void.
vec3 airScatter(vec3 a, vec3 b, vec3 lightDir, out vec3 tau) {
  vec3 sig = uAirSigma * uAirW;
  // Clip the vacuum out of the march: slide the start of the path forward
  // to where the ray first meets appreciable air (~7 scale heights — that
  // also covers the cloud deck, whose Gaussian dies by 3H + 3 widths), so
  // all 12 samples land IN the atmosphere however far away the camera is.
  float top = 1.0 + 7.0 * uAirH;
  float len = distance(a, b);
  if (len > 1e-6) {
    vec3 d = (b - a) / len;
    float bb = dot(a, d);
    float disc = bb * bb - (dot(a, a) - top * top);
    if (disc > 0.0) {
      float tIn = clamp(-bb - sqrt(disc), 0.0, len);
      a += d * tIn;
      len -= tIn;
    }
  }
  float seg = len / 12.0;
  tau = vec3(0.0);
  vec3 insc = vec3(0.0);
  vec3 amb = vec3(0.0);
  // Screen-space phase dither: hides the concentric quantization bands a
  // fixed 12-step march would print around the sun (interleaved gradient
  // noise — structureless per pixel, no moiré on smooth spheres).
  float j = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))) - 0.5;
  for (int i = 0; i < 12; i++) {
    vec3 sp = mix(a, b, (float(i) + 0.5 + j) / 12.0);
    float r = max(length(sp), 1.0);
    float rho = exp(-(r - 1.0) / uAirH);
    vec3 dtau = (sig * rho + uAeroTau * uAeroW * deckRho(r)) * seg;
    // Emission point: the photons a segment sends to the camera scatter
    // where the segment's own optical depth is still ~1 — its ENTRY side
    // when it is thick, its middle when it is thin. Sampling sunlight at
    // the midpoint of an opaque segment reads sun-starved deep air and
    // paints a false dark trench between a thick world's ground and its
    // limb glow; the entry-biased point sees the bright, lit air that
    // actually feeds the camera. Thin segments keep the midpoint exactly.
    float dtm = max(dtau.r, max(dtau.g, dtau.b));
    vec3 se = mix(a, b, (float(i) + j + min(0.5, 1.0 / max(dtm, 2.0))) / 12.0);
    float rs = max(length(se), 1.0);
    float rhos = exp(-(rs - 1.0) / uAirH);
    float mu = dot(se, lightDir) / rs;
    // Chapman slant column for the sunlight reaching this sample: the
    // flat-atmosphere 1/cos(zenith) diverges at the terminator and wrongly
    // blacks out limb-grazing air, but a tangent sunbeam really crosses a
    // FINITE column, Ch(0) = sqrt(pi*R/2H) vertical columns. uAirCurv is
    // the REAL planet's 2H/(pi*R) from the barometric law (the drawn
    // shell is display-stretched): each world's temperature, air
    // chemistry, gravity and radius decide how red its sunsets burn.
    // A sun below the sample's horizontal (mu < 0) dives to a tangent
    // point and climbs back out — twice the tangent column at its lowest,
    // denser point, minus the ascent. That doubly-grazed light is the
    // deepest red the world ever makes.
    float C = inversesqrt(mu * mu + uAirCurv / rs);
    float slantF = mu >= 0.0
      ? C
      : 2.0 * exp(min(0.5 * rs * mu * mu / uAirH, 20.0)) * inversesqrt(uAirCurv / rs) - C;
    // Vertical column overhead, per channel: exponential gas plus whatever
    // fraction of the cloud deck still hangs above this sample. Under the
    // deck the aerosol term is the FULL deck (a ceiling the sun must
    // pierce); above it, nothing — the same numbers that make the opaque
    // ball from orbit make the clear-but-gloomy floor from the ground.
    vec3 colUp = sig * (rhos * uAirH) + uAeroTau * uAeroW * deckAbove(rs);
    // Night falls when the planet itself shadows the sample, not at some
    // fixed sun angle: high air keeps catching sunlight after ground
    // sunset, so twilight glows overhead — and limb air glows from orbit.
    float hor = -sqrt(max(1.0 - 1.0 / (rs * rs), 0.0));
    float lit = smoothstep(hor - 0.03, hor + 0.06, mu);
    vec3 Tsun = exp(-min(colUp * slantF, vec3(40.0))) * lit;
    // Multiple scattering: photons the single-bounce ledger writes off are
    // not destroyed — scattering only redirects them, and deep columns
    // random-walk light downward. Diffusion theory transmits ~1/(1+3t/4)
    // through optical depth t where the direct beam dies as e^-t, so each
    // parcel also glows with that diffuse floor (vertical column overhead,
    // scaled by the sun's incidence on it). Thin skies barely notice;
    // a hothouse ground trades pitch black for shadowless amber gloom
    // that brightens into daylight as you climb out of the murk.
    vec3 Tdif = max(vec3(0.0), 1.0 / (1.0 + 0.75 * colUp) - exp(-colUp)) * (lit * max(mu, 0.0));
    // Absorbers rule the random walk: a diffusing photon's path is ~tau
    // times longer than a straight one, so even weak chemistry absorption
    // (sulfur photochemistry on hot CO2 decks, tholins in organic haze)
    // compounds — diffusion similarity says the walk survives as
    // e^(-tau*sqrt(3(1-albedo))). Pure scattering (albedo 1) stays grey;
    // absorbers turn deep gloom amber to red because blue dies first.
    Tdif *= exp(-colUp * sqrt(3.0 * max(vec3(0.0), 1.0 - uAirAlb)));
    // Exact segment integral for a constant source: e^-tau * (1 - e^-dtau).
    // The midpoint rule e^-(tau+dtau/2)*dtau it replaces is fine for thin
    // segments but collapses to zero when one step is optically thick —
    // hothouse air would swallow its own glow.
    vec3 w = exp(-tau) * (1.0 - exp(-dtau));
    insc += (Tsun + Tdif) * w;
    // The starlight floor belongs to shadowed air only: next to any
    // sunlight it is nothing, and adding it to daylight would wash the
    // sky grey. Night and twilight air keep their faint glow.
    amb += (1.0 - lit) * w;
    tau += dtau;
  }
  return uSunLum * insc + uAirNight * amb;
}
`;
