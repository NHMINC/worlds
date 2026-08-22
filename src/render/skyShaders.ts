/**
 * The survey sky's GLSL: the shared extinction march (dust is
 * sightline subtraction, never drawn), the harvest star vertex
 * law (PSF pins + ambassador glow + white balance), and the one
 * fragment both passes compile (MAX-composited stars, screen
 * nebulae). Strings only — the materials live in skySurvey.ts.
 */
import { UNIVERSE } from '../world/physics';
import { SHAPE_GLSL } from '../world/skyShape';

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
export const extinctGlsl = (steps: number) => /* glsl */ `
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

export const SILHOUETTE_VERT = /* glsl */ `
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

export const STAR_FRAG = /* glsl */ `
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

