import { mulberry32, xmur3 } from './rng';

/**
 * The physics engine of the bottle universe.
 *
 * THE CHARTER: this universe runs entirely on physics, with deliberate tweaks
 * to mass, distance and time so it fits in a bottle. We set parameters and
 * laws; we never hand-roll outcomes. When a world looks wrong, fix the law,
 * not the world. Every toy-scaling constant lives in the UNIVERSE block
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

/** All toy scalings of the bottle universe, in one visible place. */
export const UNIVERSE = {
  /** Gravity law: g = G_TOY · density(rel Earth) · radius(rel home world). */
  G_TOY: 1.35,
  /** Reference GL radius of a size-100 rocky world (radiusRel = 1). */
  R_HOME: 4.48,

  /** Stellar flux: T_eq = T_HAB · L^0.25 · sqrt(A_HAB / a). */
  T_HAB: 278,
  A_HAB: 90,

  /**
   * Render stretch of interplanetary space. Chemistry and T_eq read the
   * compact `a`; the camera flies in a · SPACE_SCALE so worlds are
   * destinations. Inverse-square at a BODY uses physics `a` (the same
   * number T_eq already drank). Inverse-square at the EYE — glare,
   * photosphere wash — uses the stretched distance, referenced to
   * A_HAB · SPACE_SCALE (the bottle's 1 AU on screen).
   */
  SPACE_SCALE: 10,

  /**
   * Bottle radius of 1 Rsun. Stefan–Boltzmann Teff uses R / STAR_R_GL.
   * The generator's G dwarf sits near 20; remnants floor above this.
   */
  STAR_R_GL: 20,
  STAR_TEFF_SUN: 5772,

  /**
   * Photosphere display luminance (the disk before the eye's knee).
   * A real photosphere is ~10⁹× the sky; an LDR screen cannot span
   * that, so this one number is the exposure that makes the core
   * clip to white and the limb keep colour. Universe-level, never
   * per-star — Teff only tints, it does not dim the furnace.
   */
  STAR_DISK_LUM: 3.8,

  /**
   * Eye/optics glare: ONE radially uniform falloff around the disk.
   * Angular half-width at A_HAB·SPACE_SCALE for L=1 (radians); scales
   * as sqrt(flux) so a close approach widens the wash and the outer
   * system keeps a bright point. GLARE_GAIN is the core brightness.
   * The sun should only dominate the frame when you are looking at
   * it up close — not filter the whole system view.
   */
  STAR_GLARE_ANG: 0.12,
  STAR_GLARE_GAIN: 3.4,

  /**
   * K-corona + wind: Thomson column of photosphere light. CORONA is
   * the r⁻⁶ limb (Baumbach); WIND is the r⁻² Parker outflow that
   * carries streamers into the system. Both scatter the star's own
   * colour — a blue star does not grow an orange halo.
   */
  STAR_CORONA: 0.95,
  STAR_WIND: 0.72,

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

  /** Accretion disk temperature: T_disk = DISK_C · L^0.25 · a^-DISK_P (K). */
  DISK_C: 2670,
  DISK_P: 0.55,

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
   * habitable temperature).
   */
  HAB_WATER: 0.05,

  /** Life odds where liquid water, warmth and pressure align. */
  LIFE_ODDS: 0.8,
  LIFE_T: [250, 335] as const,
  LIFE_P: [0.25, 5] as const,

  /** Tidal locking: planets inside LOCK_A · sqrt(L) are locked; a band
   * outside that is a seeded coin flip (torque falls off as 1/a^6, so the
   * transition is narrow). */
  LOCK_A: 46,
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

  /** The universe's gearbox: wall seconds → system seconds. Everything
   * celestial (orbits, spin, days, seasons) turns this much slower than
   * the wall clock, so a dawn is something you can watch. Applied where
   * wall time becomes system time; wave/foam animation keeps its own
   * cosmetic clock. */
  TIME_SCALE: 1 / 3,

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
  GALAXY_DUST_GRIP: 0.67,
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
   * on is this cruise, off is stop. WASD stays the slow
   * look-around pace (arcPace).
   */
  GALAXY_WARP_CROSS_S: 69,
  get GALAXY_WARP(): number {
    return (2 * this.GALAXY_R_MAX) / this.GALAXY_WARP_CROSS_S;
  },
  /**
   * Galactocentric radius where latched warp lets go (kpc).
   * Four disk radii — past Face-on / Edge-on, still inside the
   * halo. Quiet: no toast. Inward warp still runs so you can
   * fall home. WASD is unchanged.
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
   * a magnitude-limited survey — living stars above SILHOUETTE_L
   * (late-B and hotter, WR; SILHOUETTE_M is the IMF slot
   * gate that keeps the hot walk cheap) plus the old-clock
   * giant branch (SILHOUETTE_GIANT_M … M, keep GIANT_L). Those
   * K giants are the Hubble bump: they concentrate where the
   * mass is old (bulge / bar / thick / inner thin), not a
   * painted core. The count is an outcome of those floors,
   * not a cap. Nebulae
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
  GALAXY_SILHOUETTE_M: 3.89,
  /** Backdrop stars: present-day L / L☉. Brightness is this continuous
   *  luminosity, not a magnitude bin. 162 L☉ is the MS light of the
   *  3.89 M☉ late-B floor (L ≈ 1.4 M^3.5) — the depth at which the
   *  survey holds ~10⁵ stars. SILHOUETTE_M is the IMF walk/keep
   *  cut; SILHOUETTE_L is the luminosity keep. Both change the
   *  census. Count is the floors' outcome, not a cap. Stars are
   *  the cheap citizens (a small Gaussian, vertex-only cost); the
   *  count knob that matters for the GPU is envelopes, not this. */
  GALAXY_SILHOUETTE_L: 162,
  /**
   * Old-clock giant branch. The hot survey never walks this IMF
   * (M ≲ 1.3 dies as a remnant before the bulge is old). The
   * harvester adds a second slice: slots in [GIANT_M, SILHOUETTE_M)
   * that are on the giant/subgiant clock, kept at GIANT_L
   * (low-mass RGB is ~16–56 L☉ — they fail the 162 L☉ hot floor).
   * Colour is Teff. The hot tail itself is a thin-disk walk —
   * bulge / bar / halo age floors sit above those lifetimes, so
   * those cells are not re-read. Rebuild the harvest; star ids
   * do not move.
   */
  GALAXY_SILHOUETTE_GIANT_M: 0.94,
  GALAXY_SILHOUETTE_GIANT_L: 18,
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
   *  makes true abysses the rare dense tail (~top 5%, midplane
   *  p95 ≈ 0.25), and lets overlaps stack toward black. Stars and
   *  the cosmic background obey the same column. */
  GALAXY_EXTINCT_ABYSS: 0.25,
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
   * Short phases, toy-stretched so they are findable in the bottle the
   * way TIME_SCALE stretches a dawn. Real PN/SNR last 10^4 yr; here they
   * last these Gyr so a traveler can discover them. The law is still
   * “time since death,” not a painted nebula type.
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

// ------------------------------------------------------------------ types

export const ELEMENTS = [
  'H', 'He', 'C', 'N', 'O', 'Na', 'Mg', 'Si', 'S', 'Cl', 'K', 'Ca', 'Ti', 'Fe', 'Ni', 'U',
] as const;
export type Element = (typeof ELEMENTS)[number];
/** Mass fractions over ELEMENTS, summing to ~1. */
export type Composition = Record<Element, number>;

export type Gas = 'H2' | 'He' | 'N2' | 'O2' | 'CO2' | 'CH4' | 'H2O' | 'NH3';
const GAS_MU: Record<Gas, number> = {
  H2: 2, He: 4, H2O: 18, CH4: 16, NH3: 17, N2: 28, O2: 32, CO2: 44,
};

export type RGB = [number, number, number];

export interface AtmosphereSpec {
  /** Surface pressure, atm. < 0.01 reads as airless. */
  pressure: number;
  /** Mole-ish mix of retained gases, normalized. */
  mix: Partial<Record<Gas, number>>;
}

/** The volatiles that can fill basins, as liquid or unmoving ice. */
export type Volatile = 'water' | 'methane' | 'co2' | 'nitrogen';

export interface HydrosphereSpec {
  /** What fills the basins — 'none' leaves bare rock hollows. */
  substance: Volatile | 'none';
  /**
   * Phase at MEAN surface conditions: the rock is static, the volatile is
   * the weather. The local temperature field still freezes or melts it
   * regionally in the shaders (polar caps, nightside ice, summer melt).
   */
  state: 'liquid' | 'ice' | 'none';
  /** Sea colors for the liquid phase (the liquid + its solutes). */
  surf: RGB;
  deep: RGB;
  /** Frozen-sheet color: substance chemistry + irradiation + crust dust. */
  ice: RGB;
  /** 0 murky .. 1 glassy: scales translucency. */
  clarity: number;
  /** Shoreline surf/foam strength (methane is glassy and quiet). */
  foam: number;
}

export interface BodyPhysics {
  kind: 'rocky' | 'gas';
  /** Radius relative to the home world (R_HOME GL units). */
  radiusRel: number;
  /** Bulk density relative to Earth. */
  densityRel: number;
  /** Surface gravity in g. Derived, never set. */
  gravity: number;
  /** System metallicity (rel solar) — inherited from the star. */
  metallicity: number;
  /** Equilibrium and greenhouse-adjusted surface temperature (K). */
  TeqK: number;
  TsurfK: number;
  atmosphere: AtmosphereSpec;
  hydrosphere: HydrosphereSpec;
  /** Bulk elemental inventory (mass fractions). */
  inventory: Composition;
  /** Solid-surface partition of the inventory (what mining finds). */
  crust: Composition;
  /** Habitability emerged and life took hold (O2 signature, organics). */
  life: boolean;
  /**
   * 0..1 snow/frost deposition capacity — open-liquid reservoir ×
   * precipitation cycle. 0 on airless, bone-dry AND freeze-locked worlds
   * (a sealed frozen reservoir cannot evaporate, so nothing falls on the
   * peaks); liquid methane worlds deposit methane frost from their own
   * seas. WHERE it settles is the temperature field's business; whether it
   * CAN settle at all is decided here.
   */
  snow: number;
  /**
   * Temperature dial for the snow-line law, measured relative to the
   * WORKING volatile's freeze point (unclamped). For water it equals
   * temp01; for methane seas it re-centers so frost caps peaks of a world
   * whose lowlands are comfortably liquid. One law, freeze point as input.
   */
  snowTemp01: number;
  /** Terrain dial mappings, derived from the physics. */
  temp01: number;
  sea01: number;
}

// ------------------------------------------------------------------ helpers

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

export function zeroComposition(): Composition {
  const c = {} as Composition;
  for (const e of ELEMENTS) c[e] = 0;
  return c;
}

function addMix(into: Composition, parts: Partial<Composition>, weight: number): void {
  for (const [e, f] of Object.entries(parts) as Array<[Element, number]>) {
    into[e] += f * weight;
  }
}

function normalize(c: Composition): Composition {
  let sum = 0;
  for (const e of ELEMENTS) sum += c[e];
  if (sum <= 0) return c;
  for (const e of ELEMENTS) c[e] /= sum;
  return c;
}

/** Metal phase (the core-formers; also seeds surface veins). */
const METAL: Partial<Composition> = { Fe: 0.9, Ni: 0.09, U: 0.01 };
/** Silicate rock phase (refractories only; volatiles ride separately). */
const ROCK: Partial<Composition> = {
  O: 0.442, Si: 0.243, Mg: 0.145, Ca: 0.062, S: 0.047, Na: 0.029,
  K: 0.014, Ti: 0.009, Cl: 0.005,
};
/** Volatiles bound in rock — burned off where the disk condensed hot. */
const ROCK_VOLATILES: Partial<Composition> = { C: 0.026, N: 0.008 };
/** Ice phases (condensation products). */
const ICE_H2O: Partial<Composition> = { H: 0.112, O: 0.888 };
const ICE_CO2: Partial<Composition> = { C: 0.273, O: 0.727 };
const ICE_CH4: Partial<Composition> = { C: 0.749, H: 0.251 };
const ICE_NH3: Partial<Composition> = { N: 0.823, H: 0.177 };
/** Gas giant bulk. */
const GAS_BULK: Partial<Composition> = { H: 0.735, He: 0.24, C: 0.01, N: 0.008, O: 0.007 };

/** Disk temperature at orbit a for stellar luminosity L. */
export function diskTempAt(a: number, L: number): number {
  return UNIVERSE.DISK_C * Math.pow(L, 0.25) * Math.pow(a, -UNIVERSE.DISK_P);
}

/** Equilibrium temperature at orbit a for stellar luminosity L. */
export function equilibriumTemp(a: number, L: number): number {
  return UNIVERSE.T_HAB * Math.pow(L, 0.25) * Math.sqrt(UNIVERSE.A_HAB / a);
}

/** Smooth 0..1 "has condensed" ramp as the disk cools below a frost temp. */
function frosted(diskT: number, frostT: number): number {
  return clamp01((frostT - diskT) / (frostT * 0.35));
}

// ------------------------------------------------------------------ inventory

/**
 * Elemental inventory of a solid body from the condensation sequence at its
 * feeding zone: refractories everywhere, ices beyond their frost lines,
 * comet-delivered water in the temperate band (the decreed bias).
 */
function solidInventory(
  rng: () => number,
  diskT: number,
  Teq: number,
  Z: number,
  co: number,
): { inv: Composition; iceFrac: number; waterMass: number } {
  const inv = zeroComposition();

  // Metal fraction scales with metallicity; rock is the remainder of the
  // refractory budget.
  const metal = 0.22 * Math.pow(Z, 0.7) * (0.85 + rng() * 0.3);

  // Ices claim a growing share of the solid mass as the disk cools.
  const fW = frosted(diskT, UNIVERSE.FROST_H2O);
  const fN = frosted(diskT, UNIVERSE.FROST_NH3);
  const fC2 = frosted(diskT, UNIVERSE.FROST_CO2);
  const fC1 = frosted(diskT, UNIVERSE.FROST_CH4);
  // The disk's C/O ratio partitions the volatile budget: in a carbon-rich
  // nebula the oxygen is locked up in CO gas, so water ice starves while
  // carbon ices and carbides feast (solar co = 1 is exact identity).
  const oxyFree = clamp01(1.55 - 0.55 * co);
  let iceW = 0.42 * fW * (0.7 + rng() * 0.6) * oxyFree;
  const iceN = 0.05 * fN * (0.6 + rng() * 0.8);
  const iceC2 = 0.08 * fC2 * (0.6 + rng() * 0.8) * co;
  const iceC1 = 0.07 * fC1 * (0.6 + rng() * 0.8) * co;

  // Comet delivery into the temperate band: water where it matters most
  // (comets are children of the same disk, so they starve with it).
  const habBump = Math.exp(-Math.pow((Teq - 285) / 45, 2));
  iceW += UNIVERSE.HAB_WATER * habBump * (0.6 + rng() * 0.8) * oxyFree;

  // Past co = 1 the condensation sequence flips: carbides and graphite
  // condense as refractories — dark carbon crusts instead of silicates.
  const graphiteJitter = rng(); // drawn unconditionally: stream discipline
  const graphite = 0.55 * Math.max(0, co - 1) * (0.7 + graphiteJitter * 0.6);

  const iceTotal = iceW + iceN + iceC2 + iceC1;
  const rock = Math.max(0.05, 1 - metal - iceTotal) * (1 - clamp01(graphite));

  addMix(inv, METAL, metal);
  addMix(inv, ROCK, rock);
  addMix(inv, { C: 1 }, (metal + rock + iceTotal) * clamp01(graphite));
  // Devolatilization law: rock keeps its bound C and N only where the disk
  // condensed cool — the innermost worlds are volatile-starved.
  const devol = clamp01((UNIVERSE.DEVOL_T - diskT) / UNIVERSE.DEVOL_SPAN);
  addMix(inv, ROCK_VOLATILES, rock * devol * Math.min(1.5, co));
  addMix(inv, ICE_H2O, iceW);
  addMix(inv, ICE_NH3, iceN);
  addMix(inv, ICE_CO2, iceC2);
  addMix(inv, ICE_CH4, iceC1);
  normalize(inv);

  const total = metal + rock + iceTotal;
  return { inv, iceFrac: iceTotal / total, waterMass: iceW / total };
}

/** Bulk density (rel Earth) from the phase mix. */
function bulkDensity(metalFrac: number, iceFrac: number): number {
  const rockFrac = Math.max(0, 1 - metalFrac - iceFrac);
  return (metalFrac * 7.9 + rockFrac * 3.95 + iceFrac * 1.2) / 5.51;
}

// ------------------------------------------------------------------ rocky body

export interface RockyInputs {
  seed: string;
  /** Orbit of the planet (moons: the parent's orbit — same feeding zone). */
  a: number;
  /** GL radius of the body. */
  radiusGL: number;
  /** Stellar luminosity (rel sun) and metallicity (rel solar). */
  L: number;
  Z: number;
  /** Keeps a face to the STAR (systemgen's torque law decides). The snow
   * law needs it: the warmest point of the temperature field is the
   * substellar point on a locked world, the equator on a spinner. */
  lockedToStar?: boolean;
  /** Disk C/O ratio relative to solar (the star deals it; default 1). */
  CO?: number;
  /** Terraforming: player-dialed surface temperature on the T_COLD..T_HOT
   * dial scale, UNCLAMPED (below 0 = deep cryo, above 1 = past boil-off).
   * Overrides Tsurf and re-runs every downstream law — hydrosphere phase,
   * snow cycle, life, classification. Boil-off history is judged at the
   * natural temperature (cooling a Venus stays dry). */
  tempOverride01?: number;
}

export function rockyPhysics(inp: RockyInputs): BodyPhysics {
  const rng = mulberry32(xmur3(`${inp.seed}:phys`)());
  const diskT = diskTempAt(inp.a, inp.L);
  const Teq = equilibriumTemp(inp.a, inp.L);

  // --- inventory & gravity: chemistry first, gravity derived ---
  const { inv, iceFrac, waterMass } = solidInventory(rng, diskT, Teq, inp.Z, inp.CO ?? 1);
  const metalFrac = inv.Fe + inv.Ni + inv.U;
  const densityRel = bulkDensity(metalFrac, iceFrac);
  const radiusRel = inp.radiusGL / UNIVERSE.R_HOME;
  const gravity = UNIVERSE.G_TOY * densityRel * radiusRel;

  // --- atmosphere: what the disk delivered, filtered by Jeans escape ---
  // Outgassing law: buried volatiles reach the surface only where the body
  // is big enough for radiogenic heat to keep geology alive. Planets always
  // qualify; moons split into Titans (air) and sealed ice balls (bare).
  const [og0, og1] = UNIVERSE.OUTGAS_R;
  const outgas = clamp01((radiusRel - og0) / (og1 - og0));
  // Available gas sources (mass fractions of the body).
  const cold = clamp01((UNIVERSE.FROST_H2O - Teq) / 60);
  const avail: Partial<Record<Gas, number>> = {
    N2: inv.N * 0.85 * outgas,
    CO2: inv.C * (0.35 + 0.45 * clamp01((Teq - 220) / 120)) * outgas,
    CH4: inv.C * 0.45 * cold * outgas,
    H2O: waterMass * 0.02 * outgas,
  };

  // Escape: mu_min falls out of escape-velocity physics, and the stellar
  // wind sandblasts hot little worlds bare regardless of molecular weight.
  const gR = gravity * radiusRel;
  const muMin = (UNIVERSE.ESCAPE_K * Teq) / Math.max(1e-4, gR);
  const windNeed = UNIVERSE.WIND_K * Math.pow(Teq / 300, 2);
  const windKeep = clamp01((gR / windNeed - 0.8) / 0.4);
  const retained: Partial<Record<Gas, number>> = {};
  let gasMass = 0;
  for (const [g, m] of Object.entries(avail) as Array<[Gas, number]>) {
    const keep = clamp01((GAS_MU[g] / muMin - 1.0) / 0.5) * windKeep;
    if (m * keep > 1e-6) {
      retained[g] = m * keep;
      gasMass += m * keep;
    }
  }

  let pressure = UNIVERSE.PRESSURE_K * gasMass * gravity;

  // Runaway greenhouse (the Venus path): warm enough to lose water, with a
  // real CO2 atmosphere, the carbonate sink fails and the full carbon
  // budget bakes out as CO2.
  const runaway =
    Teq > UNIVERSE.RUNAWAY_T && (retained.CO2 ?? 0) > 1e-5 && pressure > UNIVERSE.RUNAWAY_MIN_P;
  if (runaway) pressure *= UNIVERSE.RUNAWAY_MULT * (0.7 + rng() * 0.6);

  // Greenhouse lift from the greenhouse-active partial pressures.
  const mixSum = Object.values(retained).reduce((x, y) => x + y, 0) || 1;
  const pCO2 = (pressure * (retained.CO2 ?? 0)) / mixSum;
  const pCH4 = (pressure * (retained.CH4 ?? 0)) / mixSum;
  const pH2O = (pressure * (retained.H2O ?? 0)) / mixSum;
  const pGH = pCO2 + 12 * pCH4 + 5 * pH2O;
  let Tsurf = Teq * (1 + (pGH > 0 ? UNIVERSE.GH_K * Math.pow(pGH, UNIVERSE.GH_P) : 0));

  // --- hydrosphere: phase windows decide what can pool in the basins.
  // Where water is frozen rock-hard but methane sits in its liquid window,
  // the seas are methane over water-ice bedrock — Titan emerges. ---
  // Boil-off is HISTORY, judged at the natural temperature before any
  // terraforming: water lost to space never comes back by cooling a Venus.
  const boiledOff = Tsurf > UNIVERSE.BOIL_OFF_T || runaway;

  // The terraform dial is a lawful input, not a paint bucket: it overrides
  // the surface temperature, and every downstream law re-runs — seas freeze
  // or melt, the snow cycle seals or opens, life appears or dies, and the
  // classification follows. Same pipeline, one changed quantity. The dial
  // is deliberately UNCLAMPED: values below 0 and above 1 reach past the
  // display range into deep-cryo (nitrogen sheets) and past boil-off (dead
  // scorched basins) — the visuals saturate, the chemistry keeps going.
  if (inp.tempOverride01 !== undefined) {
    Tsurf = Math.max(
      3,
      UNIVERSE.T_COLD + inp.tempOverride01 * (UNIVERSE.T_HOT - UNIVERSE.T_COLD),
    );
  }
  const hasWater = waterMass > 0.015 && !boiledOff;
  const waterLiquid =
    hasWater &&
    Tsurf > UNIVERSE.WATER_WIN[0] &&
    Tsurf < UNIVERSE.WATER_WIN[1] &&
    pressure > UNIVERSE.LIQUID_MIN_P;
  const methaneLiquid =
    inv.C > 0.02 &&
    cold > 0.4 &&
    Tsurf > UNIVERSE.METHANE_WIN[0] &&
    Tsurf < UNIVERSE.METHANE_WIN[1] &&
    pressure > UNIVERSE.LIQUID_MIN_P;

  let substance: HydrosphereSpec['substance'] = 'none';
  let state: HydrosphereSpec['state'] = 'none';
  if (waterLiquid) {
    substance = 'water';
    state = 'liquid';
  } else if (methaneLiquid) {
    substance = 'methane';
    state = 'liquid';
  } else {
    // Nothing pools as liquid: basins fill with an unmoving frozen sheet.
    // Which ice? The MOST VOLATILE species that has frozen — it condensed
    // last, so it blankets the earlier, harder ices (Pluto wears nitrogen
    // ice over its water-ice bedrock, never the other way round; deeply
    // frozen water ice is effectively rock).
    const iceCandidates: Array<[Volatile, number, number]> = [
      ['nitrogen', UNIVERSE.N2_ICE_T, inv.N * 0.9],
      ['methane', UNIVERSE.METHANE_WIN[0], inv.C * 0.45 * cold],
      ['co2', UNIVERSE.CO2_ICE_T, inv.C * 0.5],
      ['water', UNIVERSE.WATER_WIN[0], hasWater ? waterMass : 0],
    ];
    for (const [name, freezeT, mass] of iceCandidates) {
      if (Tsurf < freezeT && mass > 0.012) {
        substance = name;
        state = 'ice';
        break;
      }
    }
  }

  // --- life: a physical condition, then a (biased) seeded roll. The roll
  // is drawn UNCONDITIONALLY so the rng stream never depends on a branch:
  // re-running the pipeline with a temperature override must reproduce
  // every other seeded quantity exactly. ---
  const habitable =
    substance === 'water' &&
    state === 'liquid' &&
    Tsurf > UNIVERSE.LIFE_T[0] &&
    Tsurf < UNIVERSE.LIFE_T[1] &&
    pressure > UNIVERSE.LIFE_P[0] &&
    pressure < UNIVERSE.LIFE_P[1];
  const lifeRoll = rng();
  const life = habitable && lifeRoll < UNIVERSE.LIFE_ODDS;

  // Life leaves its signature: O2, and a whisper of biogenic methane.
  if (life) {
    const o2 = gasMass * 0.26;
    retained.O2 = o2;
    retained.CH4 = (retained.CH4 ?? 0) + gasMass * 0.01;
    gasMass += o2;
    pressure = UNIVERSE.PRESSURE_K * gasMass * gravity;
  }

  // Normalize the mix for display/scattering.
  const mix: Partial<Record<Gas, number>> = {};
  const total = Object.values(retained).reduce((x, y) => x + y, 0);
  if (total > 0) {
    for (const [g, m] of Object.entries(retained) as Array<[Gas, number]>) {
      mix[g] = m / total;
    }
  }

  // --- dials: terrain reads temperature and sea level from the physics.
  // Frozen sheets fill the basins just like their liquid would — the same
  // inventory, unmoving. ---
  const temp01 = clamp01((Tsurf - UNIVERSE.T_COLD) / (UNIVERSE.T_HOT - UNIVERSE.T_COLD));
  const drySeaJitter = rng(); // drawn unconditionally: branch-independent stream
  let sea01: number;
  if (substance === 'water') {
    sea01 =
      state === 'liquid'
        ? clamp(0.3 + 1.6 * waterMass, 0.3, 0.62)
        : clamp(0.28 + 1.4 * waterMass, 0.28, 0.58);
  } else if (substance === 'methane') sea01 = clamp(0.24 + 3 * inv.C, 0.24, 0.5);
  else if (substance === 'co2') sea01 = clamp(0.2 + 2.2 * inv.C, 0.2, 0.45);
  else if (substance === 'nitrogen') sea01 = clamp(0.18 + 9 * inv.N, 0.18, 0.4);
  else sea01 = 0.02 + drySeaJitter * 0.08;

  // Snow/freeze dial measured from the working volatile's freeze point.
  // With the water window this is algebraically identical to temp01
  // (unclamped). The sea-ice law in the shaders anchors to the same dial.
  const FREEZE_REF: Record<Volatile, number> = {
    water: UNIVERSE.WATER_WIN[0],
    methane: UNIVERSE.METHANE_WIN[0],
    co2: UNIVERSE.CO2_ICE_T,
    nitrogen: UNIVERSE.N2_ICE_T,
  };
  const freezeRef = substance === 'none' ? UNIVERSE.WATER_WIN[0] : FREEZE_REF[substance];
  const snowTemp01 =
    (Tsurf - freezeRef + (UNIVERSE.WATER_WIN[0] - UNIVERSE.T_COLD)) /
    (UNIVERSE.T_HOT - UNIVERSE.T_COLD);

  // --- cryosphere: snow only falls where something can evaporate and an
  // atmosphere can carry it back up a mountainside. Evaporation needs OPEN
  // LIQUID, and "open" is a question for the temperature FIELD, not the
  // mean: a world whose mean sits below freezing can still melt a broad
  // equatorial band (Snowball Earth kept an open ring and kept snowing),
  // so we test the WARMEST point of the same insolation law the shaders
  // render — equator for spinners, substellar point for locked worlds.
  // Only when even that point stays frozen is the reservoir truly sealed:
  // vapor pressure collapses, precipitation stops, and old summit snow is
  // wind-scoured into the lowland cold traps (the Dry Valleys / Mars
  // lesson). Any exposed sea saturates the reservoir — evaporation reads
  // the open surface, not the total volatile budget — so capacity is the
  // melt fraction times the cycle strength (zero below the airless
  // threshold). ---
  const cycle = clamp01((pressure - 0.02) / (UNIVERSE.SNOW_CYCLE_P - 0.02));
  const span = inp.lockedToStar ? UNIVERSE.TEMP_SPAN_LOCKED : UNIVERSE.TEMP_SPAN_SPIN;
  const insolMax = inp.lockedToStar ? 1.0 : (1 - 0.785) * 1.6; // toygen.insolationAt peaks
  const freeze01 =
    (UNIVERSE.WATER_WIN[0] - UNIVERSE.T_COLD) / (UNIVERSE.T_HOT - UNIVERSE.T_COLD);
  const warmest01 = snowTemp01 + span * insolMax;
  // The ramp is steep on purpose: it exists only for continuity right at
  // the isotherm crossing. A few kelvin of melt already exposes a working
  // sea, and any working sea saturates the reservoir.
  const openLiquid =
    state === 'liquid'
      ? 1
      : state === 'ice' && pressure > UNIVERSE.LIQUID_MIN_P
        ? clamp01((warmest01 - freeze01) / 0.02)
        : 0;
  const snow = openLiquid * cycle;

  // --- crust: the solid partition (inventory minus air and sea) ---
  const crust = { ...inv };
  crust.N = Math.max(0, crust.N - (retained.N2 ?? 0) * 0.9);
  if (substance === 'water') {
    crust.H = Math.max(0, crust.H - waterMass * 0.09);
    crust.O = Math.max(0, crust.O - waterMass * 0.78);
  }
  if (life) crust.C += 0.012; // organics settle into the topsoil
  normalize(crust);

  return {
    kind: 'rocky',
    radiusRel,
    densityRel,
    gravity,
    metallicity: inp.Z,
    TeqK: Teq,
    TsurfK: Tsurf,
    atmosphere: { pressure, mix },
    hydrosphere: hydrosphereColors(substance, state, crust, Teq, temp01, life),
    inventory: inv,
    crust,
    life,
    snow,
    snowTemp01,
    temp01,
    sea01,
  };
}

// ------------------------------------------------------------------ gas giant

export interface GasInputs {
  seed: string;
  a: number;
  radiusGL: number;
  L: number;
  Z: number;
  /** Disk C/O ratio relative to solar (default 1). */
  CO?: number;
}

export function gasPhysics(inp: GasInputs): BodyPhysics {
  const rng = mulberry32(xmur3(`${inp.seed}:phys`)());
  const diskT = diskTempAt(inp.a, inp.L);
  const Teq = equilibriumTemp(inp.a, inp.L);

  const inv = zeroComposition();
  addMix(inv, GAS_BULK, 1);
  // Trace chemistry by disk temperature: ammonia clouds in the warmer gas
  // region, methane blues far out — the same condensation law as the rocks.
  // A carbon-rich disk deepens the methane hand.
  const traceCH4 =
    0.012 * frosted(diskT, UNIVERSE.FROST_CH4 * 1.8) * (0.7 + rng() * 0.6) * (inp.CO ?? 1);
  const traceNH3 = 0.01 * frosted(diskT, UNIVERSE.FROST_NH3 * 1.4) * (0.7 + rng() * 0.6);
  addMix(inv, ICE_CH4, traceCH4);
  addMix(inv, ICE_NH3, traceNH3);
  normalize(inv);

  const radiusRel = inp.radiusGL / UNIVERSE.R_HOME;
  const densityRel = 0.24 + 0.1 * rng();
  const gravity = UNIVERSE.G_TOY * densityRel * radiusRel;

  const mix: Partial<Record<Gas, number>> = {
    H2: 0.86,
    He: 0.12,
    CH4: traceCH4 * 1.3,
    NH3: traceNH3 * 1.2,
  };

  return {
    kind: 'gas',
    radiusRel,
    densityRel,
    gravity,
    metallicity: inp.Z,
    TeqK: Teq,
    TsurfK: Teq,
    atmosphere: { pressure: 1000, mix },
    hydrosphere: {
      substance: 'none',
      state: 'none',
      surf: [0, 0, 0],
      deep: [0, 0, 0],
      ice: [0, 0, 0],
      clarity: 0,
      foam: 0,
    },
    inventory: inv,
    crust: zeroComposition(),
    life: false,
    snow: 0,
    snowTemp01: clamp01((Teq - UNIVERSE.T_COLD) / (UNIVERSE.T_HOT - UNIVERSE.T_COLD)),
    temp01: clamp01((Teq - UNIVERSE.T_COLD) / (UNIVERSE.T_HOT - UNIVERSE.T_COLD)),
    sea01: 0,
  };
}

// ------------------------------------------------------------------ colors from chemistry

function mixRGB(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/**
 * Frozen-sheet color from real ice optics, then aged by chemistry:
 * - water ice absorbs red -> thick sheets read blue-white (glacier blue);
 * - CO2 ice (dry ice) is brilliant scattering white (Mars's seasonal caps);
 * - fresh CH4 ice is pale cream, but radiation cooks exposed CH4/N2 ice
 *   into tholins — the pink-brown blush of Pluto and Makemake. More carbon
 *   and more stellar UV, redder the sheet;
 * - N2 ice is milky cream (Sputnik Planitia's glaciers);
 * - and crust dust stains every sheet toward the local rock.
 */
function iceColorFor(substance: Volatile, crust: Composition, Teq: number): RGB {
  let c: RGB =
    substance === 'water'
      ? [0.78, 0.87, 0.96]
      : substance === 'co2'
        ? [0.96, 0.97, 0.99]
        : substance === 'methane'
          ? [0.9, 0.86, 0.74]
          : [0.93, 0.92, 0.87];
  if (substance === 'methane' || substance === 'nitrogen') {
    const dose = clamp01(crust.C * 9) * (0.35 + 0.65 * clamp01(Teq / 90));
    c = mixRGB(c, [0.71, 0.49, 0.4], 0.6 * dose);
  }
  const dust = clamp01((crust.Fe - 0.08) / 0.3);
  return mixRGB(c, [0.6, 0.5, 0.44], 0.3 * dust);
}

/** Sea color, clarity, surf and ice tint from the substance + its solutes. */
function hydrosphereColors(
  substance: HydrosphereSpec['substance'],
  state: HydrosphereSpec['state'],
  crust: Composition,
  Teq: number,
  temp01: number,
  life: boolean,
): HydrosphereSpec {
  const ice = substance === 'none' ? ([0.88, 0.92, 0.97] as RGB) : iceColorFor(substance, crust, Teq);
  if (substance === 'methane') {
    // Liquid methane: dark amber, glassy, almost still.
    return {
      substance,
      state,
      surf: [0.55, 0.4, 0.18],
      deep: [0.16, 0.1, 0.04],
      ice,
      clarity: 0.9,
      foam: 0.25,
    };
  }
  if (substance === 'co2' || substance === 'nitrogen') {
    // Cryogenic sheets: any pressurized partial melt reads as pale glassy
    // slush (colorless liquids over bright ice), never tropical water.
    return {
      substance,
      state,
      surf: [0.78, 0.84, 0.88],
      deep: [0.45, 0.54, 0.62],
      ice,
      clarity: 0.85,
      foam: 0,
    };
  }
  if (substance === 'none') {
    // Bare hollows: liquid colors are the water defaults (they only show
    // if a player floods the world by hand).
    return {
      substance,
      state,
      surf: [0.32, 0.86, 0.83],
      deep: [0.12, 0.5, 0.72],
      ice,
      clarity: 0.7,
      foam: 1,
    };
  }
  // Water: start from the home palette, then let chemistry tint it.
  let surf: RGB = [0.32, 0.86, 0.83]; // #52dcd4
  let deep: RGB = [0.12, 0.5, 0.72]; // #1e7fb8
  // Iron-stained seas shift teal-green.
  const fe = clamp01((crust.Fe - 0.1) / 0.2);
  surf = mixRGB(surf, [0.35, 0.78, 0.55], fe * 0.55);
  deep = mixRGB(deep, [0.1, 0.45, 0.4], fe * 0.55);
  // Life richens the blue-green.
  if (life) {
    surf = mixRGB(surf, [0.28, 0.88, 0.76], 0.4);
    deep = mixRGB(deep, [0.1, 0.5, 0.78], 0.4);
  }
  // Cold seas run steel-blue.
  const chill = clamp01((0.35 - temp01) / 0.35);
  surf = mixRGB(surf, [0.55, 0.72, 0.82], chill * 0.5);
  deep = mixRGB(deep, [0.2, 0.36, 0.55], chill * 0.5);
  // Salts cloud the water a touch.
  const salt = clamp01((crust.Na + crust.Cl) / 0.04);
  const clarity = 0.85 - 0.3 * salt;
  return { substance, state, surf, deep, ice, clarity, foam: 1 };
}

/** Rayleigh-ish rim tint from the gas mix: what this sky scatters. */
export function rayleighTint(atmo: AtmosphereSpec): RGB {
  const GAS_TINT: Record<Gas, RGB> = {
    N2: [0.5, 0.72, 1.0],
    O2: [0.52, 0.76, 1.0],
    CO2: [0.78, 0.82, 0.88],
    CH4: [1.0, 0.62, 0.32],
    H2O: [0.75, 0.85, 0.95],
    NH3: [0.9, 0.82, 0.66],
    H2: [0.8, 0.78, 0.95],
    He: [0.85, 0.85, 0.95],
  };
  let out: RGB = [0, 0, 0];
  let sum = 0;
  for (const [g, f] of Object.entries(atmo.mix) as Array<[Gas, number]>) {
    // Haze-formers (CH4, NH3) punch above their molar weight in color.
    const w = f * (g === 'CH4' || g === 'NH3' ? 6 : 1);
    out = [out[0] + GAS_TINT[g][0] * w, out[1] + GAS_TINT[g][1] * w, out[2] + GAS_TINT[g][2] * w];
    sum += w;
  }
  if (sum <= 0) return [0.56, 0.76, 0.94];
  return [out[0] / sum, out[1] / sum, out[2] / sum];
}

/** hsl → rgb in [0,1]. */
function hsl(h: number, s: number, l: number): RGB {
  const f = (n: number) => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)];
}

/**
 * Disk color of a gas giant from its mix and irradiation — one number,
 * no weather. NH3 condensates read warm tan (Jupiter/Saturn), CH4
 * absorbs red so the ball goes cool blue (Uranus/Neptune), mixed traces
 * mute toward grey, and a migrated hot giant darkens as the condensates
 * boil off. Bands, storms and differential rotation are a later weather
 * law; until then the giant is a smooth chemistry-tinted atmosphere.
 */
export function gasColor(p: BodyPhysics): RGB {
  const ch4 = p.atmosphere.mix.CH4 ?? 0;
  const nh3 = p.atmosphere.mix.NH3 ?? 0;
  const total = ch4 + nh3;
  const t = total > 1e-5 ? ch4 / total : 0;
  const blend = t * t * (3 - 2 * t);
  let hue = total > 1e-5 ? (0.09 - 0.51 * blend + 1) % 1 : 0.15;
  const midMute = 1 - 0.62 * (4 * blend * (1 - blend));
  let sat = (0.26 + 0.3 * clamp01(total / 0.02)) * midMute;
  const hot = clamp01((p.TeqK - 320) / 420);
  hue = (hue - 0.47 * hot + 1) % 1;
  sat = sat * (1 - 0.3 * hot) + 0.1 * hot;
  const light = 0.66 * (1 - 0.42 * hot);
  return hsl(hue, sat, light);
}

/**
 * The gas shroud of a rocky world: color from chemistry, opacity from
 * optical depth — column density times photochemical smog (CH4/NH3 build
 * organic haze far more efficiently than clear gases). NO patterns: clouds
 * and weather are a later law. Continuous by design: an Earth-thin sky is
 * invisible, Titan wears a translucent orange veil, a hothouse is a wall.
 * Returns null when the air is too thin to see at all.
 */
export function hazeSpec(p: BodyPhysics): { color: RGB; opacity: number } | null {
  if (p.kind !== 'rocky') return null;
  const organics = (p.atmosphere.mix.CH4 ?? 0) + (p.atmosphere.mix.NH3 ?? 0);
  const tau = (p.atmosphere.pressure / UNIVERSE.HAZE_P) * (1 + 5 * organics);
  const opacity = clamp01(1 - Math.exp(-(tau - 0.45) * 1.6));
  if (opacity < 0.12) return null;
  const tint = rayleighTint(p.atmosphere);
  // Hot CO2 decks bleach toward cream (sulfuric cloud tops); cold organic
  // haze keeps its color.
  const hot = clamp01((p.TsurfK - 380) / 250);
  const color = mixRGB(
    [tint[0] * 0.85 + 0.15, tint[1] * 0.85 + 0.15, tint[2] * 0.85 + 0.15],
    [0.93, 0.88, 0.72],
    hot,
  );
  return { color, opacity };
}

/**
 * Aerial perspective — the atmosphere is dense near the surface and thin
 * at altitude, so light from distant things is absorbed and scattered
 * along the way (Beer–Lambert through an exponential profile). Scale
 * height falls out of kT/(mg): hot thin-gas skies sit tall, cold heavy
 * ones hug the ground. Extinction strength follows column density (P/g)
 * with the same photochemical-smog multiplier the haze deck uses — an
 * Earth-thin sky softens the far horizon, a Titan veil shortens it, a
 * hothouse is a wall, an airless rock shows razor-sharp forever. Returns
 * null when the air is too thin to matter. sigma is per planet radius of
 * path at the surface; scaleH is in planet radii.
 *
 * curve is the Chapman curvature parameter 2H/R of the REAL planet, from
 * the barometric law H = kT/(mg) over the true radius. It sets how long a
 * horizon sunbeam's air column is (~1/sqrt(curve) vertical columns), i.e.
 * how hard sunsets redden: cold, heavy, high-gravity air hugs its world
 * and burns deep red; hot light low-g air is puffy and barely tints. The
 * drawn shell (scaleH) is toy-compressed so the halo reads on a
 * holdable globe, but it still dies with the exponential — vacuum
 * has nothing to scatter — while the sunlight filter uses the real
 * slenderness.
 */
export function airExtinction(p: BodyPhysics): {
  sigma: number;
  scaleH: number;
  curve: number;
  tint: RGB;
  weights: RGB;
  albedo: RGB;
  /** Aerosol deck: vertical optical column and its Mie-flat weights. */
  aeroTau: number;
  aeroW: RGB;
} | null {
  if (p.kind !== 'rocky') return null;
  const P = p.atmosphere.pressure;
  if (P < 0.01) return null;
  let mu = 0;
  let fsum = 0;
  for (const [g, f] of Object.entries(p.atmosphere.mix) as Array<[Gas, number]>) {
    mu += GAS_MU[g] * f;
    fsum += f;
  }
  mu = fsum > 0 ? mu / fsum : 29;
  const grav = Math.max(0.05, p.gravity);
  const scaleH = (UNIVERSE.AIR_H * (p.TsurfK / 288) * (29 / mu)) / grav;
  // True slenderness H/R = kT/(mgR): Earth air anchors the constant at
  // 8.4 km / 6371 km, and the same barometric ratios that stretch scaleH
  // rescale it per world. The 2/pi makes the grazing limit the exact
  // Chapman function, Ch(0) = sqrt(pi*R/2H) — a horizon sunbeam on the
  // home world crosses ~35 vertical columns. Nothing here is a dial.
  const hTrue =
    (UNIVERSE.AIR_HR_HOME * (p.TsurfK / 288) * (29 / mu)) / grav / Math.max(0.2, p.radiusRel);
  const curve = Math.min(1, Math.max(3e-5, (2 * hTrue) / Math.PI));
  const organics = (p.atmosphere.mix.CH4 ?? 0) + (p.atmosphere.mix.NH3 ?? 0);
  // GAS: Rayleigh scattering off the molecules themselves, exponential
  // with altitude.
  const sigma = UNIVERSE.AIR_SIGMA * (P / grav);
  // AEROSOLS: condensate clouds and photochemical smog — sulfuric decks
  // over hot CO2, tholin haze in organic air. This optical depth used to
  // be painted on as an opaque "haze deck" mesh with its own shading; now
  // it feeds the scattering integral, so cloud opacity, the limb, the sky
  // and the ground gloom are one law. Crucially the aerosols are NOT
  // well-mixed with the gas: condensates condense at their condensation
  // altitude, so the deck rides a Gaussian shell aloft (see scattering.ts)
  // and the air beneath it is clear — Venus is soup at 55 km and a hazy
  // desert at the floor. Same pressure/organics threshold as ever (Earth
  // earns none), and hazeSpec's opacity is exactly 1 - exp(-aeroTau): the
  // roster descriptor and the renderer agree.
  const aeroTau = Math.max(0, (P / UNIVERSE.HAZE_P) * (1 + 5 * organics) - 0.45) * 1.6;
  if (sigma + aeroTau / (3 * scaleH) < 0.05) return null;
  // Same hot-bleach law as the haze deck, so sky and fade agree.
  const hot = clamp01((p.TsurfK - 380) / 250);
  const tint = mixRGB(rayleighTint(p.atmosphere), [0.93, 0.88, 0.72], hot);
  // Per-wavelength scattering weights (mean 1). Gas: the tint is what the
  // gas scatters, contrast-stretched toward the Rayleigh 1/λ⁴ ratio the
  // display tints compress (exponent 2.5 lands N2/O2 air near the real
  // ~5:1 blue:red). Aerosol droplets are Mie scatterers — wavelength-flat
  // — so the deck keeps the chemistry color at full pallor: smog whitens
  // a sky clean gas would blue, and mutes sunsets toward Titan grey.
  const wr = Math.pow(Math.max(0.02, tint[0]), 2.5);
  const wg = Math.pow(Math.max(0.02, tint[1]), 2.5);
  const wb = Math.pow(Math.max(0.02, tint[2]), 2.5);
  const wm = (wr + wg + wb) / 3;
  const weights: RGB = [wr / wm, wg / wm, wb / wm];
  const am = Math.max(0.02, (tint[0] + tint[1] + tint[2]) / 3);
  const aeroW: RGB = [tint[0] / am, tint[1] / am, tint[2] / am];
  // Single-scattering albedo: the fraction of light that survives one
  // bounce, per channel. Clean N2/O2 air only scatters (albedo 1), but the
  // same chemistry that drives the hot-bleach law breeds blue-eating
  // absorbers — sulfur photochemistry over hot CO2 decks, tholin smog in
  // organic hazes. Per bounce the loss is tiny; the diffusion walk through
  // a thick column multiplies it into Venus amber and Titan orange.
  const soot = clamp01(0.6 * hot + 3 * organics);
  const albedo: RGB = [1 - 0.008 * soot, 1 - 0.03 * soot, 1 - 0.08 * soot];
  return { sigma, scaleH, curve, tint, weights, albedo, aeroTau, aeroW };
}

// ------------------------------------------------------------------ sea state

export interface SeaState {
  /** 0..1 swell energy: wind (pressure proxy) plus oscillating tide. */
  energy: number;
  /** Wave-clock rate, ~sqrt(g): low-g moons swell slow, heavy worlds chop. */
  tempo: number;
  /** 0..1 moon-tide strength (drives the waterline breathing). */
  tide: number;
}

/**
 * Oscillating tidal forcing on a body from its moons: Σ ρ·(R/a)³, scaled
 * onto a 0..1 dial. Only a body that SPINS relative to the perturber feels
 * a moving tide — a tidally locked body carries a static bulge, which
 * raises no waves. The caller passes only the moons that apply.
 */
export function tidalForcing(
  moons: Array<{ densityRel: number; radiusGL: number; orbitGL: number }>,
): number {
  let f = 0;
  for (const m of moons) {
    const r = m.radiusGL / Math.max(1e-3, m.orbitGL);
    f += m.densityRel * r * r * r;
  }
  return clamp01(f * UNIVERSE.TIDE_K);
}

/**
 * What stirs a sea, until weather is a real law: wind needs an atmosphere
 * (pressure is the proxy — airless worlds keep MIRROR-still seas), moons
 * add tidal slosh, and gravity sets the tempo of every wave. Weather will
 * later multiply and direct the same energy number.
 */
export function seaState(p: BodyPhysics, tide = 0): SeaState {
  const wind = clamp01((p.atmosphere.pressure - 0.02) / 0.4);
  return {
    energy: clamp01(0.9 * wind + 0.45 * tide),
    tempo: Math.sqrt(Math.min(3, Math.max(0.05, p.gravity))),
    tide,
  };
}

/**
 * Cox–Munk mean-square slope of a liquid sea from sea-state energy.
 * Along-path is the sun–camera plane; across-path is tighter (ANISO).
 * The water shader compiles the same numbers — this copy is for tests
 * and anyone reasoning about the law without opening GLSL.
 */
/**
 * Inverse-square irradiance at orbital radius `a` (physics GL, not the
 * display stretch). L=1 at A_HAB is 1 — the exposure the shaders are
 * graded for. Closer worlds bake; the outer system fades. Always the
 * compact `a` chemistry already drank, never a · SPACE_SCALE.
 */
export function starIrradiance(L: number, a: number): number {
  const r = Math.max(a, 1);
  return Math.max(0, L) * (UNIVERSE.A_HAB * UNIVERSE.A_HAB) / (r * r);
}

/**
 * LDR response to stellar irradiance. Exposed for A_HAB (irr = 1).
 * The law is still inverse-square; the screen and the eye are the
 * limits: bright flux compresses through the knee, dim flux through
 * the adaptation exponent. Monotonic — farther is always dimmer.
 */
export function starIrradianceDisplay(irr: number): number {
  const x = Math.max(0, irr);
  if (x <= 1) return Math.pow(x, UNIVERSE.STAR_IRR_ADAPT);
  return 1 + (x - 1) / (1 + UNIVERSE.STAR_IRR_KNEE * (x - 1));
}

/**
 * Photosphere Teff from Stefan–Boltzmann. T / Tsun = (L / R_rel²)^0.25
 * with R_rel = radiusGL / STAR_R_GL. The same closed form stellar.ts
 * uses on catalog stars; the bottle's G dwarf (L=1, R=STAR_R_GL) is
 * 5772 K by construction.
 */
export function starTeff(L: number, radiusGL: number): number {
  const R = Math.max(0.04, radiusGL / UNIVERSE.STAR_R_GL);
  return UNIVERSE.STAR_TEFF_SUN * Math.pow(Math.max(L, 1e-8) / (R * R), 0.25);
}

/**
 * Magnetic activity (0..1). Convective envelopes (Teff ≲ 6500 K) run
 * a dynamo; activity rises as the convection zone deepens (cooler)
 * and as luminosity feeds the field. Radiative envelopes are quiet
 * on the flare axis — their energy leaves as a line-driven wind
 * instead (starWind).
 */
export function starActivity(teff: number, L: number): number {
  const conv = clamp01((6500 - teff) / 2500);
  const mDwarf = clamp01((4000 - teff) / 1600);
  // The dynamo is a convection-zone fraction, not a wattage. An M dwarf
  // is MORE active because the envelope is deep; L only weakly feeds
  // the field so a luminous G star does not out-flare a red dwarf.
  const dynamo = 0.08 + 0.62 * conv + 0.48 * mDwarf;
  const feed = 0.85 + 0.15 * clamp01(Math.sqrt(Math.min(Math.max(L, 0), 4)));
  return clamp01(dynamo * feed);
}

/**
 * Visible wind column (relative). Hot stars: line-driven Ṁ ~ L.
 * Cool stars: Alfvén/Parker wind, weaker but still there. Thomson
 * measure scales as Ṁ / v_w and v_w ~ sqrt(T), so hotter outflows
 * are thinner for the same Ṁ — the two terms keep both ends of
 * the MK sequence readable.
 */
export function starWind(L: number, teff: number): number {
  const hot = clamp01((teff - 7500) / 15000);
  const cool = clamp01((6000 - teff) / 3000);
  const raw = (0.22 + 1.35 * hot + 0.48 * cool) * Math.sqrt(Math.max(L, 0.02));
  // O-star Ṁ is huge; the screen is the limit. Dimmer than 1 is
  // untouched so a K dwarf's breeze still reads.
  if (raw <= 1) return raw;
  return 1 + (raw - 1) / (1 + 0.2 * (raw - 1));
}

/**
 * Eye-frame flux for glare. `d` is the RENDER distance to the star
 * (camera in the SPACE_SCALE stretch). Referenced to A_HAB · SPACE_SCALE
 * so a habitable-zone look at L=1 is flux 1 — the same exposure the
 * body law uses, seen from the cockpit instead of the orbit.
 */
export function starEyeFlux(L: number, d: number): number {
  const dRef = UNIVERSE.A_HAB * UNIVERSE.SPACE_SCALE;
  const r = Math.max(d, 1);
  return Math.max(0, L) * (dRef * dRef) / (r * r);
}

export function waveSlope(energy: number): { along: number; across: number } {
  const along =
    UNIVERSE.WAVE_SLOPE_CALM +
    (UNIVERSE.WAVE_SLOPE_WIND - UNIVERSE.WAVE_SLOPE_CALM) * clamp01(energy);
  return { along, across: along * UNIVERSE.WAVE_SLOPE_ANISO };
}

// ------------------------------------------------------------------ classification

/**
 * NAMES what emerged — description, never prescription. Used by the roster,
 * the inspector and the test suite; generation never reads it.
 */
export function classify(p: BodyPhysics, lockedToStar: boolean): string {
  if (p.kind === 'gas') {
    // Migration delivers giants to the inner system: irradiation grades them.
    if (p.TeqK > 460) return 'scorched giant';
    if (p.TeqK > 290) return 'warm giant';
    return 'gas giant';
  }
  if (p.life) return 'living world';
  if (p.atmosphere.pressure > 8 && p.TsurfK > 430) return 'hothouse';
  const h = p.hydrosphere;
  if (h.substance === 'methane' && h.state === 'liquid') return 'methane world';
  if (lockedToStar && h.substance === 'water') return 'eyeball world';
  if (h.state === 'ice') {
    if (h.substance === 'water') return 'iceball';
    if (h.substance === 'co2') return 'dry-ice world';
    if (h.substance === 'nitrogen') return 'nitrogen iceball';
    return 'frozen methane world';
  }
  // Carbide-and-graphite crusts (carbon-rich disks) trump the water labels.
  if (p.crust.C > 0.15) return 'carbon world';
  if (p.atmosphere.pressure < 0.02) return lockedToStar ? 'scorched rock' : 'airless rock';
  if (p.sea01 < 0.16) return 'desert world';
  if (h.substance === 'water' && h.state === 'liquid' && p.sea01 > 0.55) return 'ocean world';
  return 'temperate world';
}

/** Short physics summary line for rosters and the inspector. */
export function describeBody(p: BodyPhysics): string {
  if (p.kind === 'gas') return `${p.gravity.toFixed(1)}g · H/He`;
  const g = `${p.gravity.toFixed(2)}g`;
  const pr =
    p.atmosphere.pressure < 0.02
      ? 'no atm'
      : `${p.atmosphere.pressure < 10 ? p.atmosphere.pressure.toFixed(1) : Math.round(p.atmosphere.pressure)} atm`;
  const t = `${Math.round(p.TsurfK - 273)}°C`;
  return `${g} · ${pr} · ${t}`;
}

/** Dominant gases as a short readable string, e.g. "N2 77% · O2 21%". */
export function describeAtmosphere(a: AtmosphereSpec): string {
  if (a.pressure < 0.02) return 'none';
  const parts = (Object.entries(a.mix) as Array<[Gas, number]>)
    .sort((x, y) => y[1] - x[1])
    .slice(0, 3)
    .filter(([, f]) => f > 0.01)
    .map(([g, f]) => `${g} ${Math.round(f * 100)}%`);
  return parts.join(' · ') || 'trace';
}
