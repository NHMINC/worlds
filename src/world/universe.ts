/**
 * The constants of the universe — every named knob in one
 * visible place, under the charter.
 *
 * THE CHARTER: we set parameters and laws; we never hand-roll outcomes.
 * When a world looks wrong, fix the law, not the world. Spatial scale is
 * real (R☉, AU, km). Time is 1:1 with the wall; a live observer rate is
 * time-lapse on the same closed form, not a hidden gearbox. Hex coarseness
 * is the remaining toy. Every named constant lives in the UNIVERSE block
 * below — never as per-case fudges scattered through the code.
 *
 * Archetypes are OUTPUTS, never inputs: there is no world-type switch here.
 * Iceballs, hothouses, methane worlds, airless rocks and living paradises
 * are attractor regions of one causal chain:
 *
 *   star metallicity → disk chemistry at the orbit (condensation sequence)
 *   → one elemental inventory per body → bulk density → gravity
 *   → Jeans escape (which gases the world can hold) → surface pressure
 *   → greenhouse → surface temperature → hydrosphere phase (water/methane)
 *   → solutes, palette, life.
 *
 * Simplifications decreed by the god-engineers (documented, not hidden):
 * every body has a metallic core with a spin-aligned magnetic dipole (a
 * compass works everywhere and points to spin-north); orbits are stable by
 * fiat; interiors, plate tectonics and weather are out of scope.
 */

// ------------------------------------------------------------------ constants

/** All named constants of the universe, in one visible place. */
export const UNIVERSE = {
  /** SI / km conversions. One metric; catalog stays kpc on the GPU. */
  PC_M: 3.085677581e16,
  AU_M: 1.495978707e11,
  AU_KM: 1.495978707e8,
  RSUN_M: 6.957e8,
  RSUN_KM: 6.957e5,
  REARTH_M: 6.371e6,
  REARTH_KM: 6371,
  /** 1 kpc in km. Equal to PC_M metres: 1000 pc × m/pc ÷ 1000 m/km. */
  KPC_KM: 3.085677581e16,

  /** Earth mean density (kg/m³) — moon/planet Kepler mass. */
  RHO_EARTH: 5514,
  G_SI: 6.6743e-11,
  GM_SUN: 1.3271244e20,
  SEC_DAY: 86400,
  SEC_YEAR: 365.25 * 86400,

  /** Gravity law: g = G_TOY · density(rel Earth) · radius(rel Earth). Earth is 1 g. */
  G_TOY: 1,
  /** Reference radius of a size-100 rocky world (km). radiusRel = R / R_HOME. */
  R_HOME: 6371,

  /** Stellar flux: T_eq = T_HAB · L^0.25 · sqrt(A_HAB / a). a in AU. */
  T_HAB: 278,
  A_HAB: 1,

  /**
   * 1 R☉ in the local mesh unit (km). Stefan–Boltzmann Teff uses
   * R / STAR_R_GL. The catalog already stores R in solar units.
   */
  get STAR_R_GL(): number {
    return this.RSUN_KM;
  },
  STAR_TEFF_SUN: 5772,

  /**
   * Photosphere display luminance (the disk before the eye's knee).
   * A real photosphere is ~10⁹× the sky; an LDR screen cannot span
   * that. This is the furnace exposure: the face is bright, the
   * centre clips toward white-hot, the limb keeps Teff. Full
   * Eddington at μ = 0 is welding glass — we keep the shape
   * (centre brighter than limb) on a high floor (STAR_DISK_FLOOR).
   * Universe-level, never per-star.
   */
  STAR_DISK_LUM: 3.8,
  /**
   * Display limb floor (0–1). Physical Eddington on a G star
   * falls to ~0.4 — that is the welding-glass disk. The eye
   * saturates; the floor stays high so the whole body blazes
   * and only the rim keeps colour.
   */
  STAR_DISK_FLOOR: 0.78,

  /**
   * Granulation contrast on the photosphere (peak, at a fully
   * convective envelope). Real granules are a few percent;
   * more than this reads as a marble planet, not a skin.
   */
  STAR_GRAN: 0.12,

  /**
   * Chromosphere: the limb continued. CHROMA multiplies the
   * DISPLAY edge (floor × face, not welding-glass μ = 0) and
   * the shine is exp + Lorentzian, 1 at the limb. A peak above
   * that edge is a hoop. CHROMA_H is the decay length in R.
   */
  STAR_CHROMA: 1.0,
  STAR_CHROMA_H: 0.14,

  /**
   * Unresolved-disk bloom — the eye's PSF on a star that has
   * not yet become a surface. Angular half-width at A_HAB for
   * L=1 (radians); GAIN is the core. Weight is e^(−θ / THETA)
   * so a small disk in the sky still blazes and a parked sun
   * (θ ~ 0.25) does not grow a second white circle. CAP is
   * the max width past the limb while still unresolved.
   */
  STAR_GLARE_ANG: 0.12,
  STAR_GLARE_GAIN: 2.4,
  STAR_GLARE_CAP: 0.18,
  STAR_GLARE_THETA: 0.055,

  /**
   * K-corona + wind: Thomson column of photosphere light. CORONA is
   * the r⁻⁶ limb (Baumbach); WIND is the r⁻² Parker outflow that
   * carries streamers into the system. Both scatter the star's own
   * colour — a blue star does not grow an orange halo. Dim: this
   * is haze past the skin, not a filled disc.
   */
  STAR_CORONA: 0.35,
  STAR_WIND: 0.38,
  /**
   * How far the DRAWN limb-haze reaches (photosphere radii).
   * Must stay far inside STAR_CORONA_R (the hard wall). Tight:
   * 1.6 R plus a Parker fill was a second, blue, circle.
   */
  STAR_CORONA_DRAW: 1.48,
  /**
   * Corona / wind shell outer radius, in photosphere radii —
   * drawn by star.ts and treated as the star's VIEW SKIN: a
   * star is a furnace, so films and parks stay outside the
   * fire, not 10,000 km over the photosphere like a world.
   */
  STAR_CORONA_R: 4,
  /**
   * Compact-remnant film floor (solar radii). A pulsar or black
   * hole is tens of km — a film scaled to that puts wall, graze
   * and park within a fraction of one float64 ULP of a catalog
   * coordinate at 8 kpc (~55 km), so the ordering law becomes
   * unevaluable noise and orbit entry never latches. Every star
   * film (ride, fences, free-fly park) floors the radius here:
   * ~14,000 km keeps the whole stack hundreds of ULPs wide.
   */
  STAR_FILM_R_MIN: 0.02,
  /**
   * Sub-threshold star highlight (star.ts marker): the ring's
   * angular radius on screen (rad). It appears when the surface
   * subtends less than HALF this — so it can never overlap a
   * readable disk, and it hands off to the disk on approach. A
   * neutron star at its film park (thousands of true radii out)
   * keeps the ring; the class label hangs off it.
   */
  STAR_MARK_ANG: 0.022,

  /**
   * Flare visibility. Activity (starActivity) decides whether the
   * dynamo fires; this gain is how hard a reconnection reads on an
   * LDR screen. Prominences are the same events seen on the limb.
   */
  STAR_FLARE: 1.2,

  /**
   * Display knee for body irradiance. Raw 1/r² at the inner edge is
   * ~8× habitable; the scene is exposed for A_HAB and brighter flux
   * compresses through this so Mercury-path worlds wash toward white
   * instead of clipping a hole.
   */
  STAR_IRR_KNEE: 0.28,

  /**
   * Eye adaptation on the dim side (display exponent below flux 1).
   * The law stays inverse-square; the EYE is logarithmic — an outer
   * world still fades with distance, but the way a dusk fades to a
   * watcher, not the way a photometer reads it. Without this, a far
   * day side drops below its own moonlit night tint.
   */
  STAR_IRR_ADAPT: 0.55,

  /** Accretion disk temperature: T_disk = DISK_C · L^0.25 · a^-DISK_P (K), a in AU.
   *  DISK_C = T_HAB and DISK_P = 1/2 puts the water frost near 2.7 AU for L=1. */
  DISK_C: 278,
  DISK_P: 0.5,

  /** Condensation temperatures (K), toy-compressed. */
  FROST_H2O: 170,
  FROST_NH3: 115,
  FROST_CO2: 90,
  FROST_CH4: 70,

  /**
   * Jeans escape: a gas of molecular weight mu is retained when
   * mu ≥ ESCAPE_K · T_eq / (g · radiusRel) — escape velocity physics:
   * small hot worlds can't hold light gases.
   */
  ESCAPE_K: 0.0113,

  /**
   * Stellar wind stripping: an atmosphere survives long-term only when the
   * escape parameter g·radiusRel beats WIND_K · (T_eq/300)² — hot little
   * worlds near the star are sandblasted bare (the Mercury path).
   */
  WIND_K: 0.35,

  /** Devolatilization: rock that condensed hot lost its C and N; retention
   * ramps in as the disk cools below DEVOL_T over DEVOL_SPAN kelvin. */
  DEVOL_T: 420,
  DEVOL_SPAN: 160,

  /** Surface pressure: P(atm) = PRESSURE_K · retained gas mass fraction · g. */
  PRESSURE_K: 75,

  /**
   * Runaway greenhouse: warm worlds with a real CO2 atmosphere lose their
   * water to photodissociation and bake their carbon out (the Venus path).
   */
  RUNAWAY_T: 305,
  RUNAWAY_MIN_P: 0.1,
  RUNAWAY_MULT: 40,

  /** Greenhouse lift: T_surf = T_eq · (1 + GH_K · P_gh^GH_P). */
  GH_K: 0.185,
  GH_P: 0.31,

  /** Liquid phase windows (K). Methane's is toy-widened: the bottle is small. */
  WATER_WIN: [258, 395] as const,
  METHANE_WIN: [78, 135] as const,
  /** Ice persistence ceilings (K): below these, CO2 and N2 sit on the
   * surface as unmoving frozen sheets (they skip the liquid phase at low
   * pressure — dry ice sublimes, it never pools). */
  CO2_ICE_T: 150,
  N2_ICE_T: 70,
  /** Minimum pressure to keep a liquid surface from sublimating away. */
  LIQUID_MIN_P: 0.06,
  /** Above this surface temperature the water inventory is lost to space. */
  BOIL_OFF_T: 420,

  /**
   * The "interesting universe" bias, a decreed delivery rule: comets stock
   * the temperate band with extra water (peak mass fraction added at the
   * habitable temperature). 0.12 at the peak is the onion's designed
   * shoreline (sea01 ≈ 0.5, waterline 13.4) — timid stock left living
   * worlds on the dry shelf and looked like a different planet.
   */
  HAB_WATER: 0.12,

  /** Life odds where liquid water, warmth and pressure align. */
  LIFE_ODDS: 0.8,
  LIFE_T: [250, 335] as const,
  LIFE_P: [0.25, 5] as const,

  /** Tidal locking: planets inside LOCK_A · sqrt(L) are locked; a band
   * outside that is a seeded coin flip (torque falls off as 1/a^6, so the
   * transition is narrow). */
  LOCK_A: 0.51,
  LOCK_COIN: 1.35,

  /** Dial mapping: temp01 = (T_surf − T_COLD) / (T_HOT − T_COLD). */
  T_COLD: 213,
  T_HOT: 371,

  /** Surface temperature field spans (dial units): time-averaged insolation
   * gives spinners a latitude gradient and star-locked worlds a substellar
   * ("eyeball") gradient. One law, spin state as input. */
  TEMP_SPAN_SPIN: 0.35,
  TEMP_SPAN_LOCKED: 0.55,

  /**
   * Seasons: the local temperature adds a seasonal anomaly
   * SEASON_GAIN · sin(latitude) · sin(sun declination). The declination in
   * the body frame is read straight off the live sun direction, so seasons
   * scale with axial tilt and vanish for untilted or locked worlds — snow
   * lines breathe and sea ice migrates with no special case. (No thermal
   * lag: this toy climate responds instantly.)
   */
  SEASON_GAIN: 1.2,

  /** Atmospheres thicker than this hide the surface under a haze deck. */
  HAZE_P: 6,

  /**
   * Aerial perspective: air is densest at the ground and thins as
   * exp(-h/H), H = kT/(mg). Vacuum has no scatterers — the glow dies
   * with the exponential, so the limb is a halo that hugs the sphere,
   * not a bloom that lights space. AIR_H is the reference world's
   * scale height (1 g, 288 K, mu 29 air) as a fraction of its radius:
   * toy-compressed so a holdable globe has room for a limb (~24×
   * real H/R). The GLOW is not that whole shell: ISS photographs are
   * a thin blue line, then black, because a sideways look through
   * the exponential only lights the dense well (see AIR_LINE).
   * AIR_SIGMA is the reference surface extinction per radius of path
   * (Beer–Lambert). Sized with AIR_H so an Earthlike column reaches
   * grazing optical depth ~2 at the horizon — the regime where red
   * starts outliving blue (sunsets) — while the vertical column
   * stays clear enough to see space at night.
   */
  AIR_H: 0.032,
  AIR_SIGMA: 3.45,
  /**
   * Limb LINE: in-scatter that reads as the planetary halo lives in the
   * well-mixed lower column (most of the mass, a couple of scale heights).
   * AIR_LINE is the density — fraction of surface — at which that glow
   * has fallen to half. Above it, 1 atm air is transparent and you see
   * space through the upper layers; the halo is a bright tangent line,
   * not a filled shell out to 7H. Extinction still uses the full
   * exponential, so a thick world can still hide stars. Aerosol decks
   * keep their own weight (a deck is opaque wherever it sits).
   */
  AIR_LINE: 0.22,

  /**
   * Display luminance of unscattered sunlight relative to a unit diffuse
   * surface. The sun is far brighter than anything it lights; this one
   * number is what makes in-scattered air READ as a bright sky against
   * terrain, from orbit or from the ground. Universe-level, never per-world.
   */
  SUN_LUM: 2,

  /**
   * H/R of home-world air: the barometric scale height kT/(mg) of N2/O2
   * at 288 K under 1 g (8.4 km) over the real planet radius (6371 km).
   * Physical anchor for the sunbeam slant law — every world rescales it
   * by its own T, molecular weight, gravity and radius.
   */
  AIR_HR_HOME: 8.4 / 6371,

  /**
   * Starlight-and-airglow floor (display radiance, cool blue): air that
   * sunlight cannot reach still scatters SOMETHING — the same fiction that
   * moonlights the night ground. Without it, grazing night paths extinguish
   * the world into a void and horizons read as black bands.
   */
  NIGHT_AIR: [0.075, 0.1, 0.16] as [number, number, number],

  /**
   * Precipitation cycle: snow is fallen weather, not paint. It needs a
   * volatile reservoir to evaporate from AND an atmosphere thick enough to
   * lift, carry and drop it — the cycle ramps to full strength at this
   * pressure (atm). Mars teaches the lesson: cold peaks, near-vacuum, no
   * snow caps.
   */
  SNOW_CYCLE_P: 0.2,

  /**
   * Type-II migration: odds that a giant, still embedded in a gassy disk,
   * surrenders angular momentum and spirals inward. The spiral sweeps the
   * corridor it crosses — architectures stop being Sol clones (hot
   * Jupiters, warm giants, orphaned outer zones).
   */
  MIGRATE_P: 0.24,

  /**
   * Outgassing: volatiles reach a surface only where radiogenic heat still
   * drives geology, and that heat budget scales with size. The ramp (in
   * radiusRel) splits the moons — Titan-size keeps a working atmosphere,
   * Callisto-size stays sealed, Luna-size is bare — and thins the smallest
   * planets (the Mars lesson: small worlds cool off and fall quiet).
   */
  OUTGAS_R: [0.42, 0.7] as const,

  /** Moon tide → sea-state gain: scales Σ ρ·(R/a)³ onto the 0..1 dial. */
  TIDE_K: 1200,

  /** The waves' volume knob: one gain over every sea's foam and ripple
   * amplitude, from baby laps in ponds to ocean surf. Cosmetic constant of
   * this universe — energy stays physical, presentation scales. */
  WAVE_GAIN: 1.35,

  /**
   * Cox–Munk mean-square facet slope of a liquid sea. Energy 0 (airless
   * mirror, no wind) sits at CALM — a tight sunglint coin. Energy 1 (full
   * wind + tide) sits at WIND — a wide glitter path. ANISO is across-path
   * / along-path: required slope grows slower in the sun–camera plane, so
   * Earth-from-orbit sunglint is a streak, not a disc. Physical, not a
   * paint. GLINT_GAIN scales the NDF so the specular core is sun-white;
   * the path's falloff is the NDF itself (do not lift the tails).
   */
  WAVE_SLOPE_CALM: 0.003,
  WAVE_SLOPE_WIND: 0.034,
  WAVE_SLOPE_ANISO: 0.22,
  GLINT_GAIN: 3.2,

  /** Observer rate: wall seconds → system seconds. Default 1 is a real
   * day and a real year. Raise it to time-lapse the same closed form
   * (pose, season, night, waves). */
  TIME_SCALE: 1,

  /**
   * Wave / foam / render-tide sit on that same celestial t. CLOCK is
   * the sea's cycle rate (Hz at tempo=1) — the old surf 10 × 0.055 —
   * so TIME_SCALE=1 keeps the beach period and a lapse speeds the sea
   * with the sky. waveClock returns a 0..1 phase (float64); shaders
   * walk a closed orbit of radius WALK in noise space so the hash
   * never sees Unix-scale t (that was the orbit shimmer). Tide is
   * sin(tSys · TIDE) in JS — not a wrapped shader tick.
   */
  WAVE_CLOCK: 0.55,
  WAVE_WALK: 2,
  WAVE_TIDE: 0.12,

  /**
   * Course lock. The reticle plate only names an object inside
   * AIM_RANGE_KPC (a neighbourhood, not the far disk). A star
   * has to fly through the pip to lock; once named it holds
   * until the look leaves. A tap does not set course — Set
   * course / the chart is autopilot: heading hold at
   * ARRIVE_HOLD (1/s) and warp-ahead.
   * A look drag aborts both. The sphere of influence is a fixed 0.01 ly
   * (ARRIVE_RANGE_LY), not the object's radius — park distance
   * is the size law. That sphere is sticky: warp is ARRIVE_WARP
   * (1/1000) of GALAXY_WARP while you are inside it — a speed
   * limit on every move (warp, roll, zoom), not a teleport —
   * and another star or world can be
   * named while you are still inside.
   * The photosphere replaces the pin when the
   * sphere is entered — the harvest pin cannot draw the approach
   * (a point, then float32 hops). From ARRIVE_BRAKE_LY (50 ly)
   * in, speed is half of GALAXY_WARP, held until a frame would
   * reach the fence, then half again — longest time at each
   * gear, fastest arrival at the SOI without skipping it. The
   * floor is the sphere speed limit.
   * Astern keeps the sphere limit only — no 50 ly brake, no
   * landing on a shell; outside the fence is full warp. Survey
   * gain is surveyGain(d): 1 outside the sphere, ARRIVE_SKY_GAIN
   * at the centre, linear in distance — a place law, not a
   * lock, gear, or fly-around. Camera, ship, planet, pin: same
   * sample. The 50 ly gears stay at full survey light. Warp
   * latches Stop when the disk covers ARRIVE_FILL of the
   * shorter field (min of vertical and horizontal FOV —
   * portrait uses the width). The host furnace is not dimmed. Worlds
   * of that host draw in the same AU-scale pass. It does
   * not open the old system viewer.
   * A world inside that bubble has its own fence
   * (WORLD_RANGE_AU) — a place, not the radius.
   * Same family: heading hold, then a calculated ramp
   * into the slot (`WORLD_SLOT_K` from the insert window
   * and capture rate) so the fence cannot be skipped,
   * Stop when that world's disk covers ARRIVE_FILL.
   * Look drag releases the heading, not the world.
   * Another world or another star can be named
   * without leaving the host — SOI is a place.
   * Survey gain stays the
   * host-sphere law. The ball stays a ball.
   */
  AIM_RANGE_KPC: 1,
  ARRIVE_HOLD: 3,
  /**
   * Flight control limits (shipControls.ts) — the autopilot's
   * hands obey these; guidance plans arcs it can actually fly.
   * TURN/ROLL are rad/s (the old per-frame clamp allowed ~33
   * rad/s — the end-over-end tumble). ACCEL is a 1/s spin-up
   * rate, scale-free from crawl to warp; cuts bind instantly.
   */
  SHIP_TURN_RATE: 0.9,
  SHIP_ROLL_RATE: 0.8,
  /**
   * Capture latch attitude gate (rad): the ride only latches
   * once the nose AND the roll have settled onto the parked
   * side-on look — the latch bolts the ride pose, and latching
   * on position alone snapped whatever roll was still easing
   * (a sudden tilt on orbit entry).
   */
  ORBIT_LATCH_ANG: 0.02,
  SHIP_ACCEL: 2.5,
  /**
   * Feasible-arc margin (navigator): commanded speed is capped
   * at this fraction of SHIP_TURN_RATE × the local arc radius —
   * never fly faster than the nose can turn the arc, or the
   * ship circles its target instead of arriving.
   */
  NAV_ARC_MARGIN: 0.6,
  /**
   * Lock-on capture into a named ring: position and heading
   * ease onto the ring at this rate (1/s). Sized WITH the
   * flight limits so the slide and the roll finish together —
   * at 1.4 the position landed in under a second and then sat
   * waiting for the bank (a rushed slide, then a pause). The
   * glide is the point: take more time, arrive settled.
   */
  ORBIT_CAPTURE: 0.6,
  /**
   * Terminal touch rate (1/s): the speed floor at the slot is
   * this × the park radius, so the last park radius takes
   * ~1/this seconds. The old floor was ARRIVE_K (1.2/s): the
   * final approach crossed in 0.8 s — a lunge, not a glide.
   */
  ORBIT_GLIDE_K: 0.25,
  /**
   * Lock-on insertion window in ring radii. The fly-to is a
   * TANGENT of the park sphere from the first frame — the nose
   * is already prograde at contact. This window only eases the
   * side-on bank / limb yaw. (The old law slid the aim from the
   * near face to a 90° lead; that slam drove the ship into the
   * body.)
   */
  ORBIT_INSERT: 6,
  /**
   * Arrival is a graze of the park sphere, not a dive at the
   * near face. Impact parameter must reach this fraction of
   * the park radius or we keep flying the tangent.
   */
  ORBIT_ARRIVE_GRAZE: 0.9,
  /**
   * Arrival band over the park radius. A tangent trajectory
   * converges on the sphere without crossing it, so a hairline
   * "at the shell" test never fires and the ship circles the
   * park forever. Once inside park × (1 + this) with a grazing
   * heading, cruise hands the last stretch to capture — the
   * slide onto the ring is capture's job, done at ORBIT_CAPTURE.
   */
  ORBIT_ARRIVE_BAND: 0.15,
  ARRIVE_WARP: 0.001,
  /**
   * Close-crawl beat (fence / this). Leave-orbit escape
   * floors √2 ω r by the same number × the place fence —
   * SI unbound speed is invisible in catalog kpc at
   * TIME_SCALE 1; this is the visible "safely sped up."
   * Cap is ARRIVE_WARP × GALAXY_WARP so the SOI is not
   * a one-frame skip.
   */
  ARRIVE_K: 1.2,
  ARRIVE_FILL: 0.22,
  ARRIVE_RANGE_LY: 0.01,
  /** The 0.01 ly fence in catalog units. 1 kpc = 3261.56 ly. */
  get ARRIVE_RANGE_KPC(): number {
    return this.ARRIVE_RANGE_LY / 3261.56;
  },
  /**
   * Where the approach brake begins. Ahead only. Full
   * GALAXY_WARP outside; inside this radius, half warp for
   * as long as a frame will not hit the fence, then half
   * again, down to the sphere limit. Astern ignores this.
   */
  ARRIVE_BRAKE_LY: 50,
  get ARRIVE_BRAKE_KPC(): number {
    return this.ARRIVE_BRAKE_LY / 3261.56;
  },
  /**
   * Galaxy light inside a sphere of influence. The harvest /
   * nebula / cosmic photograph is enhanced so you can fly the
   * disk; that fill would make night impossible. surveyGain(d)
   * is the law: 1 at ARRIVE_RANGE, this floor at the centre,
   * linear in catalog distance. Lock, helm gear, and look-
   * around do not enter. Every occupant samples the same
   * number (camera, later a planet or ship). The 50 ly brake
   * does not dim. The floor is a dark-sky Earth night, a
   * little clearer — the band is readable, not a flood. The
   * host furnace is real starlight and is not multiplied.
   * The catalog freezes on entry: same pins, latched viewpoint,
   * each row's dust column baked once. Not a raster sky.
   */
  ARRIVE_SKY_GAIN: 0.08,
  /**
   * World fence inside the host sphere. A place, not the
   * body's radius — park is the size law (ARRIVE_FILL).
   * 0.02 AU is a few million km: the ball is already a
   * disk, and the close-crawl still has room to stop.
   */
  WORLD_RANGE_AU: 0.02,
  get WORLD_RANGE_KPC(): number {
    return (this.WORLD_RANGE_AU * this.AU_KM) / this.KPC_KM;
  },
  /**
   * World-course speed. One curve, no guessed AU step.
   * Remain is distance to the slot (named ring, else the
   * fill park). Far out, k is ARRIVE_K — the close-crawl
   * already used on the star. Through the insert window
   * (ORBIT_INSERT ring radii) k eases to
   * ORBIT_CAPTURE / ORBIT_INSERT, so the last stretch
   * lasts the capture, not a snap. The touch floor is
   * ORBIT_GLIDE_K × park. Blend is remain / (remain +
   * window): at one window out, k is halfway; at ten
   * windows, it is almost ARRIVE_K. Astern ignores the
   * slot and keeps the close-crawl.
   */
  get WORLD_SLOT_K(): number {
    return this.ORBIT_CAPTURE / this.ORBIT_INSERT;
  },
  /**
   * Transfer route. Space is empty; bodies are balls. A held
   * course never flies into one: if the sightline crosses
   * another body's (or the photosphere's) graze sphere — this
   * many radii, or the absolute clear shell
   * (`WORLD_ORBIT_CLEAR_KM`), whichever is larger — take the
   * shorter of the two tangents. Inside a graze, climb out
   * first. Re-derived every frame from Kepler positions.
   */
  ROUTE_GRAZE: 3,
  /**
   * Absolute clearance above any surface (km). Named orbits,
   * the near-shell fence, and the transfer graze never put the
   * eye closer than this — small moons used to park at a
   * fraction of a body radius and read as "inside" the ball.
   */
  WORLD_ORBIT_CLEAR_KM: 10_000,
  /**
   * Drone camera. Pinch / wheel thrusts along the look at a
   * fraction of the subject distance (`SOI_ZOOM`). The ship
   * helm does not zoom — that was a fake slide. Roll is a
   * hold or a key (`SOI_TWIST` rad/s) in flight (A/D, ←/→,
   * or a still hold on the left/right of the screen). Right
   * / clockwise is negative twist. On a ridden ring the helm
   * look is locked (`SOI_TRACK_*` is the named-park cage, not
   * a zoom range). The drone is anti-gravity: zoom thrusts
   * along the look, drag steers. Soft floor is the ball
   * itself (`R × 1.002`) so it can enter air and fly between
   * moons. Target is drone-only — a latched lock. Launch and
   * return are INSTANT camera cuts (translation is kinematic;
   * no momentum to animate): launch appears at the hover film
   * (`HOVER_FILL`) on the ship's radial, locked on the body
   * the ship is orbiting; return switches straight back to the
   * ship camera, which never moved. Tap Target off to free
   * fly; tap on to lock the body in the pip. The lock does
   * not hop.
   */
  SOI_ZOOM: 0.55,
  /** Hold / key roll rate (rad/s). 1 ≈ 57°/s. */
  SOI_TWIST: 1,
  SOI_TRACK_MIN: 0.12,
  SOI_TRACK_MAX: 8,
  /**
   * Ride film (equatorial / ecliptic — one law, every body).
   * SIDE-ON: prograde, yawed toward the body so the near limb
   * sits this fraction across the HORIZONTAL field (½ = the
   * vertical centre line: the body confined to the left half),
   * rolled so the ring plane is level. Distance is the corner
   * curve of occupancy (`ORBIT_LIMB_CORNER` inset on CAM_FOV ×
   * CAM_ASPECT) — same picture on a moon and a giant. Insertion
   * eases from full-ahead to this yaw. The helm does not zoom
   * or free-look on the ring.
   */
  ORBIT_LIMB_FILL: 0.5,
  /** Inset on the lower corners (1 = exact corners). */
  ORBIT_LIMB_CORNER: 0.92,
  /**
   * Where a body's air ENDS, in scale heights — the top of the
   * drawn sky shell AND the body's occupancy radius share this
   * one number: a body's size is surface + atmosphere.
   * (The skin once added 2.2·scaleH in the wrong UNITS — radii
   * read as km — so the air added nothing and rides parked
   * inside the shell.)
   */
  AIR_SHELL_H: 7,
  /**
   * Vacuum clearance on that occupancy. The limb film parks
   * outside this so the camera sits in vacuum, not on the
   * sky-shell mesh — AT the air top is still in the volume
   * (BackSide shell, ray starts at the camera). Same 5 % the
   * star film uses over the corona.
   */
  ORBIT_SKIN_CLEAR: 1.05,
  /**
   * The drone's launch film: the FULL disk in frame with edge
   * padding — its diameter covers this fraction of the SHORTER
   * live field, so portrait pads the sides and landscape pads
   * top / bottom. (Hover rides are retired; the drone is the
   * close look.)
   */
  HOVER_FILL: 0.72,
  /** Vertical field of the explorer camera (degrees). */
  CAM_FOV: 50,
  /**
   * Film aspect the orbit law is cut for. A live window can
   * differ; the limb stays close.
   */
  CAM_ASPECT: 16 / 9,
  /**
   * Host-pass orbit rings. The old system viewer used ~0.1 on a
   * black void; that is glass on the dimmed harvest. These are
   * wayfinding, not emission — readable ellipses against the
   * photograph. Moons a step quieter.
   */
  HOST_ORBIT: 0.7,
  HOST_ORBIT_MOON: 0.42,
  /**
   * Harvest pins are absolute kpc in float32. Around the solar
   * circle the ULP is ~200 AU; inside this distance the pin hops
   * and the furnace must already be the star.
   */
  ARRIVE_PIN_KPC: 1e-5,
  STAR_REVEAL_PX: 3,

  /**
   * The shared galaxy. One seed, one SBbc (grand-design barred spiral).
   * Everyone who plays the canonical game is in this galaxy. A different
   * seed through the same laws is a private universe; cosmic-engineer
   * knobs later are other values in this block, not another generator.
   */
  CANONICAL_SEED: 'helix',

  /** Age of the galaxy (Gyr). Stars older than this were not born here. */
  GALAXY_AGE_GYR: 13.0,

  /**
   * Milky Way mass model (lengths in kpc). The density field is how
   * many stars a region is owed. Thin/thick discs, a long bar, a boxy
   * bulge and an X/peanut (Ciambur+2017), a broken exponential disc
   * (Lian+2024), a faint halo. Arms are a midplane overdensity only.
   *
   * Rd, zd: Bland-Hawthorn & Gerhard 2016. Bar ~4.2 kpc, peanut
   * R=1.67 z=0.65. Four-arm stellar contrast is mild; gas carries
   * the rest (GAS_ARM_A). The thin sheet is not a brick: it flares
   * outside FLARE_R, the outer midplane warps, and corrugation
   * wrinkles the plane. Stars draw sech² heights on that sheet
   * (spheroid scale inside the box/peanut) so edge-on is a rounded
   * bulge plus a disk, not a clipped lattice slab. The core holds
   * the MW bulge/bar share of the mass model; the harvest is still
   * the luminous thin-disk clock, with that bump, not a brighter line.
   */
  GALAXY_RD: 2.6,
  GALAXY_R_MAX: 16,
  GALAXY_ZD: 0.3,
  GALAXY_Z_THICK: 0.9,
  /** Flare onset (kpc). zd(R) = ZD · (1 + K · max(0, R − FLARE_R)^P). */
  GALAXY_FLARE_R: 6,
  GALAXY_FLARE_K: 0.16,
  GALAXY_FLARE_P: 1.2,
  /** Outer-disk warp onset (kpc) and amplitude at R_MAX (kpc). */
  GALAXY_WARP_R: 8.5,
  GALAXY_WARP_Z: 0.7,
  GALAXY_WARP_PHI: 0.4,
  /** Midplane corrugation amplitude (kpc). Several Fourier modes. */
  GALAXY_CORRUGATE: 0.22,
  /** How tightly stellar birth follows that midplane. 1 is glued
   *  (the S-slab); 0 is a flat sheet. Occupancy / SFR / H II still
   *  sit on the full wrinkle. The dust photograph uses DUST_MID
   *  (0 = geometric midplane — edge-on averages to a slit).
   *  0.4 leaves a hint of the MW warp in the stars. */
  GALAXY_STAR_MID: 0.4,
  GALAXY_RD_THICK: 3.0,
  GALAXY_RD_INNER: 8.0,
  GALAXY_R_BREAK: 7.5,
  GALAXY_R_BREAK_W: 1.1,
  GALAXY_THIN_AMP: 1.15,
  GALAXY_BAR_A: 4.2,
  GALAXY_BAR_B: 0.85,
  GALAXY_BAR_C: 0.28,
  GALAXY_BAR_AMP: 2.4,
  GALAXY_BOX_A: 1.15,
  GALAXY_BOX_B: 0.72,
  GALAXY_BOX_C: 0.48,
  GALAXY_BOX_AMP: 5.5,
  GALAXY_PEANUT_R: 1.67,
  GALAXY_PEANUT_Z: 0.65,
  GALAXY_PEANUT_AMP: 3.8,
  GALAXY_NUC_RD: 0.22,
  GALAXY_NUC_ZD: 0.07,
  GALAXY_NUC_AMP: 2.2,
  GALAXY_ARM_M: 4,
  GALAXY_PITCH: (13 * Math.PI) / 180,
  GALAXY_ARM_A: 0.2,
  GALAXY_ARM_M2: 2,
  GALAXY_PITCH2: (18 * Math.PI) / 180,
  GALAXY_ARM_A2: 0.1,
  GALAXY_HALO_A: 8,
  GALAXY_HALO_AMP: 0.004,

  /**
   * Rotation. The halo makes the curve flat: v(R) ≈ V_ROT, so
   * Ω(R) = V_ROT / R falls outward while the two-armed density wave
   * turns rigidly at OMEGA_P. We render in the wave's corotating
   * frame — the arms stand still and the stars stream through them
   * at Ω(R) − Ω_p: prograde inside corotation (R < V_ROT / OMEGA_P
   * ≈ 8.4 kpc, just outside the solar circle, as decreed), retrograde
   * beyond it. Units are toy: kpc and radians per second of wall
   * clock, compressed so an orbit is minutes, not 200 Myr.
   */
  GALAXY_V_ROT: 0.021,
  GALAXY_OMEGA_P: 0.0025,

  /**
   * The interstellar medium is supersonically turbulent, so its
   * density is log-normal: ρ = ρ̄ · exp(σ·s) with s a zero-mean,
   * spatially INTERPOLATED noise field (coherent complexes spanning
   * ~1/TURB_FREQ kpc — many catalog cells, never a per-cell coin).
   * TURB_SIGMA is that σ (clumping strength); TURB_FREQ is cycles
   * per kpc of the largest eddies. TURB_SHEAR stretches those
   * eddies along the spiral phase (galactic rotation) so natal
   * clouds are filaments. The gas disk is flatter than the stars
   * (RD_GAS × stellar Rd), with a bar-swept inner hole. Occupancy,
   * SFR, and H II drink that field (occCeil). The optical bake is
   * a separate photograph: same hole and decline, but a geometric
   * midplane sheet (DUST_MID, ZD_DUST) of domain-warped fractal
   * fluff (DUST_FREQ / DUST_SWIRL / DUST_DETAIL / DUST_SIGMA) —
   * a turbulent ocean, angles everywhere, no bank and no snake,
   * and NO arm preference (grains are event debris scattered
   * through the disc, not a tracer of the pattern). Dust reddens:
   * extinction per unit optical depth is DUST_RGB (R, G, B) — a
   * mild Cardelli-ish R_V≈3.1 curve (A_R : A_V : A_B). Blue still
   * dies first, but a long edge-on column goes dark, not rust.
   */
  GALAXY_TURB_SIGMA: 1.35,
  GALAXY_TURB_FREQ: 0.85,
  /** Along-arm / across-arm eddy aspect. 1 = round blobs. */
  GALAXY_TURB_SHEAR: 4.2,
  GALAXY_RD_GAS: 1.6,
  /** Molecular sheet: thinner than the stars, stronger arm contrast. */
  GALAXY_ZD_GAS: 0.12,
  GALAXY_GAS_ARM_A: 0.7,
  /**
   * Dust photograph (ismAt.photo). Occupancy keeps ZD_GAS / GAS_ARM
   * / TURB_* on the warped sheet so star ids and ages do not move.
   * DUST_MID = 0 pins the optical sheet to z = 0 — edge-on still
   * averages to a slit. The texture is domain-warped fBm: a slow
   * swirl field (DUST_SWIRL, kpc of warp) bends the clump noise
   * so eddies curl at every angle — no picked directions, no
   * lattice axis. DUST_FREQ is cycles/kpc of the largest clumps;
   * DUST_DETAIL is octave persistence (how much fine wisp rides
   * the big fluff). No arm term: clump positions are the
   * turbulence alone. Star ids do not move.
   */
  GALAXY_DUST_MID: 0,
  GALAXY_ZD_DUST: 0.1,
  /**
   * Disk grip: how tightly the photograph hugs the midplane.
   * 1 pins the classic thin slit (scale height = ZD_DUST) and
   * flattens the eddies (clouds wider than tall). Loosen it and
   * the effective scale height opens as ZD_DUST / grip while the
   * turbulence goes isotropic and the vertical swirl wakes up —
   * the same warped fBm is then free to carve longer ribbons
   * that climb out of the disc instead of lying down in it.
   * One knob: envelope, noise flattening, and vertical warp
   * all read it. Photograph only — star ids do not move.
   */
  GALAXY_DUST_GRIP: 0.75,
  /**
   * Corrugation: how far a cloud's centre wanders off the slice,
   * in rms units of the effective scale height (ZD / grip). A
   * seeded 2D field a few clouds wide lifts and sinks the sheet's
   * local centre, so each cloud carries its own altitude — clouds
   * ride supernova bubbles and spiral shocks off the plane. 0
   * pins every centre to one plane and flying through the disc
   * meets a coherent layer boundary (an inverse oreo), which no
   * turbulent ISM has.
   */
  GALAXY_DUST_JITTER: 1,
  /** Size law only (cycles/kpc of the largest clumps). 4.2 puts
   *  the dominant ribbons near ~240 pc — the scale of the biggest
   *  real molecular complexes (Orion, W51), and still ~2.5 bake
   *  voxels so the lattice stays hidden. Number is DUST_COVER. */
  GALAXY_DUST_FREQ: 4.2,
  /** Number law: lifts (>1) or sinks (<1) the whole turbulence
   *  distribution with the summits pinned at 1 — more or fewer
   *  crests clear the cloud floor, while clump size (FREQ) and
   *  the darkness of the densest clouds (crest height vs
   *  EXTINCT_ABYSS) stay put. 1 is identity. */
  GALAXY_DUST_COVER: 1,
  GALAXY_DUST_SWIRL: 0.85,
  GALAXY_DUST_DETAIL: 0.55,
  GALAXY_DUST_SIGMA: 1.7,
  /**
   * Optical dust shares the bar-swept cavity (HOLE / HOLE_P) with
   * the occupancy sheet. No catalog walk of dead slots.
   */
  GALAXY_DUST_HOLE: 2.4,
  GALAXY_DUST_HOLE_P: 2,
  GALAXY_SFR_GAIN: 18,
  GALAXY_CLOUD_HII: 0.1,
  GALAXY_DUST_RGB: [0.75, 1.0, 1.32] as [number, number, number],

  /** Solar circle (kpc) — home-star search and the thin-disk yardstick. */
  R_SUN: 8.2,

  /**
   * Implicit catalog: a star is (cell, slot), never a stored row.
   * Occupancy is density × volume × GALAXY_N_K — that product *is* the
   * population, not a sample of it. objectAt is O(1) at 10⁹ ids the
   * same as at ten. We never enumerate the galaxy; the explorer asks
   * objectsNear for the volume it occupies. GALAXY_POPULATION is the
   * design headcount (∫ density dV × N_K). The grid is fine enough
   * that the densest cell stays under MAX_SLOT. Halo cells stay
   * sparse; arms fill up.
   */
  GALAXY_NR: 288,
  GALAXY_NTH: 576,
  GALAXY_NZ: 18,
  GALAXY_MAX_SLOT: 8192,
  GALAXY_N_K: 12_600_000,
  GALAXY_POPULATION: 1_000_000_000,

  /**
   * The explorer sky is the harvest (SILHOUETTE_*): one
   * magnitude-limited survey — every living star above the
   * luminosity floor, and nothing else.
   * Dust is extinction. “Here” is a focus in front of the camera.
   * GALAXY_REGION_* is the future neighbourhood law, not the
   * explorer. Face-on / Edge-on slide the viewpoint far enough
   * that the disk fits the screen. View is 1:1 catalog kpc.
   */
  GALAXY_SECTORS: 120,
  GALAXY_SECTOR_RINGS: 40,
  GALAXY_SECTOR_STARS: 2500,
  /** Future faint-survey neighbourhood (kpc). Not the explorer sky. */
  GALAXY_REGION_R: 0.02,
  /**
   * Latched warp. Diameter (2 × R_MAX) in CROSS_S seconds — rim
   * to opposite rim in about a minute. Rate is catalog kpc / s;
   * on is this cruise, off is stop. A/D and ←/→ roll
   * (`SOI_TWIST` rad/s); they do not slide.
   */
  GALAXY_WARP_CROSS_S: 69,
  get GALAXY_WARP(): number {
    return (2 * this.GALAXY_R_MAX) / this.GALAXY_WARP_CROSS_S;
  },
  /**
   * Galactocentric radius where latched warp lets go (kpc).
   * Four disk radii — past Face-on / Edge-on, still inside the
   * halo. Quiet: no toast. Inward warp still runs so you can
   * fall home. Roll is unchanged.
   */
  get GALAXY_WARP_LIM(): number {
    return this.GALAXY_R_MAX * 4;
  },
  /** Within this of the tap, every occupied slot is drawn. */
  GALAXY_REGION_FULL_R: 0.12,
  /** Distance over which the IMF cut ramps to U_FAR. */
  GALAXY_REGION_U_RAMP: 0.15,
  /** Far cells: keep only this upper quantile of the IMF. */
  GALAXY_REGION_U_FAR: 0.9985,
  /**
   * Distant harvest (region dive). The flyable ball does
   * not change. Outside it, the rest of the disk is one law:
   * a UNIFORM SAMPLE of the whole population. One row per
   * (GALAXY_POPULATION / GALAXY_SAMPLE_N) occupied slots,
   * systematic over the IMF-stratified slot index with a
   * hashed per-cell offset — so the harvest mirrors the true
   * proportions: mostly M dwarfs, sun-like in their share,
   * giants where mass is old, remnants, and the rare living
   * O/B. No brightness floor (a magnitude-limited survey was
   * 97% B stars — brightness and temperature are one axis on
   * the main sequence, so the sky was monochrome). Nebulae
   * are their own catalog (NEBULA_M + SILHOUETTE_NEB_GAIN),
   * rebaked like dust, not reminted with the stars. Dust is
   * not a harvest row. The fog is the dense tail of the
   * molecular sheet. Same catalog frame.
   * Distant discs are toy angular
   * sizes.
   * Emission nebulae are self-luminous raymarched shells on
   * the host — brightness is emission measure (rho² along the ray),
   * so rings and filament crossings are geometry. Colour is a LINE
   * SPECTRUM placed by ionization stratification: [O III] teal near
   * the hot source and in young hard-spectrum events, H-alpha pink
   * through the body, [S II] deep red at cool edges; SNR strands
   * interleave red and teal (shock-speed lacework). One nebula wears
   * the whole mix; age slides the balance and host chemistry leans
   * the blend. The event law (emissionLook) expands and fades them:
   * PN grows over PN_GYR, SNR Sedov-ish (t^0.4) to SNR_R_MAX, H II
   * is Strömgren-ish (HII_R_K · L^⅓); NEB_EMISSION is the
   * photograph stretch. They screen-blend (they glow, they do not
   * add to a white bar).
   * DUST EMITS NOTHING — it filters. The fog is the dense tail
   * of ismAt.photo (hole × decline × small midplane
   * clumps). Many overlapping clouds, tight to z = 0 — edge-on
   * they average to a thin slit, not one meandering snake.
   * Every cloud carries its own opacity (crest density vs
   * EXTINCT_ABYSS): most are translucent haze, a rare dense
   * crest is lightless, and overlaps add. The thin rim reddens
   * what shines through. Baked once and marched from the
   * bubble centre (EXTINCT_STEPS taps). Transmittance is
   * Beer–Lambert: exp(−τ · DUST_RGB). Harvest does not mint
   * dust rows.
   * Envelope size is ANGULAR in both layers — radiusKpc / distance —
   * with NEBULA_PX as the pixel floor so far shells stay findable;
   * shells under DUST_MINPX skip the march (a disc).
   * Stars are a soft device-pixel Gaussian of photosphere
   * colour (so a 1-pixel hop only moves the faint halo) — a
   * point of light, no disc, no bloom sprite. Intensity is L^P · (D/d)^q
   * then I/(1+I) so hue survives. Optical approximations,
   * like AIR_LINE. Not pickable.
   */
  /** Harvest sample size. STRATIFIED: the IMF is cut into mass
   *  strata (the spectral classes) and each stratum gets an equal
   *  share of this budget, sampled by its own deterministic
   *  stride over the IMF-ordered slots — collectors as
   *  arithmetic, no rejection. A truly uniform draw was ~85% M/L
   *  dwarfs (a dim red smudge). Within a stratum the sample stays
   *  uniform across cells, so regions keep their character: O/B
   *  in the arms, giants pooled in the old core. Massive strata
   *  are largely remnants at galactic ages — that is the clock,
   *  not a bug. Count is the law's outcome (± the strides). */
  GALAXY_SAMPLE_N: 250_000,
  /** Nebula catalog: IMF floor (M☉) for the PN / SNR walk.
   *  H II (m ≥ 8 in a cloud) is always walked. 3.89 matches the
   *  survey mass floor, so the first look is the shells that
   *  used to ride the star harvest. Lower includes more leftover
   *  PNe; this catalog rebakes without reminting stars. */
  GALAXY_NEBULA_M: 3.89,
  /** Nebula catalog: emissionLook surface-brightness gain. Young
   *  events blaze (~1); faded shells ghost (~0.1). H II always kept.
   *  Three median halvings from 0.65: the top eighth — showpieces.
   *  Rebake the nebula catalog; do not remint stars. */
  GALAXY_SILHOUETTE_NEB_GAIN: 0.932,
  /** Fewer, fuller: exposure boost on backdrop shell emission. The
   *  count knobs above thin the census; this shows what survives. */
  SILHOUETTE_NEB_BOOST: 1.6,
  /** March multiplier on the baked field — how hard dust filters
   *  starlight. This is the photograph gain, not a thicker sheet.
   *  The one true opacity slider: the skin and the per-cloud
   *  opacity sum both grade with it, clear at 0 and fully dark
   *  at EXTINCT_K_FULL. */
  GALAXY_EXTINCT_K: 6,
  /** The K at which an abyss-density cloud reaches the full
   *  column cap (EXTINCT_MAX). Below it the whole dust effect
   *  grades linearly toward clear. A law, baked into the
   *  shader — not a live knob. */
  GALAXY_EXTINCT_K_FULL: 6,
  /** Clump floor: `ismAt.photo` below this is not a cloud. The
   *  bake stores the raw photograph; this carves it in the march
   *  (the old bake-time dense cut, now a live knob). Most of the
   *  disk is below this — the photograph is many small midplane
   *  clumps, not a carpet. Also anchors the per-cloud fade: a
   *  cloud's opacity ramps from raw 0.55× this floor up to
   *  EXTINCT_ABYSS (extinctMarch). */
  GALAXY_EXTINCT_CUT: 0.08,
  /** Power on the excess above the floor (the old bake-time
   *  streak, now live). Higher hardens cores and thins the
   *  edges — opaque without spreading. */
  GALAXY_EXTINCT_HARD: 0.85,
  /** Cloud opacity ramp top: the raw density at which dust counts
   *  as abyss-grade. Opacity is a COLUMN — a saturating ramp of
   *  local density (fade floor → this) integrated along the path
   *  in units of EXTINCT_COL — so the log-normal field prices a
   *  typical cloud near A_V ≈ 0.5–1 mag (translucent, reddened),
   *  makes true abysses the rare dense tail, and lets overlaps
   *  stack toward black. Stars and the cosmic background obey
   *  the same column. 0.65 is the owner's calibration: single
   *  clouds stay hazy veils (midplane crests top out ~0.67);
   *  darkness is earned by stacked columns. */
  GALAXY_EXTINCT_ABYSS: 0.65,
  /** The column that saturates: this many kpc of abyss-grade dust
   *  reaches the full cap (lightless). ~One typical cloud diameter
   *  (1/DUST_FREQ), so a dense cloud blacks out in one crossing, a
   *  face-on disc crossing costs about a magnitude (the real MW
   *  face-on number), and a long in-plane column hits the cap. A
   *  law, baked into the shader — not a live knob. */
  GALAXY_EXTINCT_COL: 0.2,
  /** Density contrast of the opacity ramp (power on the floor →
   *  abyss smoothstep). Real cloud opacity is savagely nonlinear
   *  in density — a GMC core is 10–100 mag where the diffuse body
   *  is a fraction of one. 3 prices a typical cloud body near
   *  A ≈ 1 mag while abyss-grade cores stay lightless; 1 was a
   *  linear ramp that charged every body like a core. A law,
   *  baked into the shader — not a live knob. */
  GALAXY_EXTINCT_RAMP: 3,
  /** Look test. 0 = dust is extinction. 1 paints the volume lime. */
  GALAXY_DUST_DEBUG: 0,
  /** Column cap. High enough that a dense clump (or a stack along
   *  the plane) can extinguish; not a “keep the core glorious” floor. */
  GALAXY_EXTINCT_MAX: 8,
  /** Sightline march taps (vertex-shader cost, once per row). */
  GALAXY_EXTINCT_STEPS: 64,
  /** Density volume for the ISM fog (xz × y). Catalog kpc.
   *  Resolves the ~1 kpc turbulent complexes, not 0.09 kpc cirrus.
   *  Each crest is a small Gaussian splat (anti-aliasing only)
   *  so the lattice does not print as diamonds. */
  GALAXY_DUST_VOL_N: 320,
  GALAXY_DUST_VOL_NY: 96,
  /** Local-layer taps: the in-bubble column is at most REGION_R
   *  (~0.02 kpc vs ~30 for the backdrop), so 3 taps sample it more
   *  densely than the backdrop's 12 — same law, cheaper march. */
  GALAXY_EXTINCT_STEPS_LOCAL: 3,
  SILHOUETTE_NEBULA_PX: 4,
  /** Emission-nebula glow gain (photograph stretch, not new energy).
   *  Shells screen-blend: dest + src·(1-dest). They glow and
   *  saturate; they do not add to a white bar. This is one cloud. */
  NEB_EMISSION: 0.7,
  /** Full-grown planetary-nebula shell radius (kpc, toy). */
  PN_R_MAX: 0.08,
  /** Full-grown supernova-remnant shell radius (kpc, toy). */
  SNR_R_MAX: 0.15,
  /** Strömgren scale: H II radius = HII_R_K · L^(1/3), clamped. */
  HII_R_K: 0.004,
  /** Census envelope (kpc) — HUD / occupancy only, not the fog. */
  GALAXY_DUST_R_MAX: 0.16,
  /** Census wisp (kpc). The fog is the ISM field, not this radius. */
  GALAXY_DUST_R_MIN: 0.025,
  /** Leftover sphere-peak knobs. Unused: the field is the fog. */
  GALAXY_DUST_RHO0: 0.45,
  GALAXY_DUST_RHO1: 2.0,
  /** Raymarch steps through a nebula shell (perf knob; 1 = cheap slice). */
  DUST_MARCH_STEPS: 10,
  /** Nebula sprites smaller than this (CSS px) skip the march. */
  DUST_MINPX: 12,
  /** Sub-grid ISM turbulence frequency (cycles / kpc) — the nebula
   *  march's filament scale. */
  DUST_FREQ: 11,
  /** Ice mantles condense when the temperature proxy falls below this. */

  /**
   * Kroupa IMF (number, not mass), amplitudes matched at the breaks:
   * ξ ∝ M^α on [IMF_BD, IMF_MIN] (brown dwarfs), [IMF_MIN, IMF_BRK],
   * then [IMF_BRK, IMF_MAX]. Remnant thresholds in Msun: below WD a dead
   * star is a white dwarf; below NS a neutron star; else a black hole.
   */
  IMF_BD: 0.01,
  IMF_MIN: 0.08,
  IMF_BRK: 0.5,
  IMF_MAX: 120,
  IMF_A0: -0.3,
  IMF_A1: -1.3,
  IMF_A2: -2.3,
  REMNANT_WD: 8,
  REMNANT_NS: 25,

  /**
   * Short phases, toy-stretched so they are findable. Real PN/SNR last
   * 10^4 yr; here they last these Gyr so a traveler can discover them.
   * The law is still “time since death,” not a painted nebula type.
   */
  HII_GYR: 0.012,
  PN_GYR: 0.04,
  SNR_GYR: 0.06,
  PULSAR_GYR: 0.12,
  WR_TAIL: 0.12,

  /**
   * Cosmic background — the decreed fake. We cannot mint the
   * observable universe in a browser. This is a distant shell
   * around the catalog: a black void (vacuum emits nothing), a
   * photograph of distant galaxies (inclined disks — hash size,
   * orientation, Hubble axis, crispness; each with its own
   * shine), and a photograph of
   * distant star-like pins (a dim field plus a rare bright tail).
   * Address i is hash(seed, i) on the sphere — same bottle, same sky.
   * A draw-range prefix must still cover 4π (a Fibonacci spiral
   * of the max budget is a polar cap). Not pickable. Dust
   * filters the sightline; the void is vacuum.
   */
  /** Decreed sky distance (kpc). The GPU draws the sky on the far plane; this is the law, not a mesh. */
  COSMIC_R: 8000,
  /** Photograph gain on the smudge set. Each smudge also has its own shine. */
  COSMIC_GAIN: 1,
  /** Set-wide angular scale. Each galaxy already has its own size. */
  COSMIC_SIZE: 0.36,
  /** Power on the large-scale web. Higher → emptier voids, tighter piles. */
  COSMIC_CLUSTER: 1.85,
  /** How many smudges are drawn (0–MAX). The GPU holds the full budget. */
  COSMIC_SMUDGE_N: 400,
  COSMIC_SMUDGE_N_MAX: 1000,
  /** Photograph gain on the background-star set. Each pin also has its own shine. */
  COSMIC_STAR_GAIN: 0.18,
  /** How many background pins are drawn (0–MAX). The GPU holds the full budget. */
  COSMIC_STAR_N: 10000,
  COSMIC_STAR_N_MAX: 100000,
};

