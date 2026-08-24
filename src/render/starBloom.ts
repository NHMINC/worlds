/**
 * Screen-space HDR bloom on the HOST STAR only.
 *
 * The photosphere is a furnace: fragment values sit above 1.
 * Drawn straight to the canvas they clip. This is the eye:
 * render the star into a half-float target, extract the
 * bright pixels, blur them, and add the smear back. Planets
 * are a depth fence — they occlude the furnace — never an
 * extract source. The harvest photograph is never bloomed.
 *
 * Knobs live in UNIVERSE (`STAR_BLOOM_*`) and are read
 * every frame.
 */
import * as THREE from 'three';
import { UNIVERSE } from '../world/physics';

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const EXTRACT_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tSrc;
uniform float uThr;
varying vec2 vUv;

void main() {
  vec3 c = texture2D(tSrc, vUv).rgb;
  float br = max(c.r, max(c.g, c.b));
  float knee = 0.28;
  float soft = clamp(br - uThr + knee, 0.0, 2.0 * knee);
  soft = (soft * soft) / (4.0 * knee + 1e-4);
  float t = max(br - uThr, soft) / max(br, 1e-4);
  gl_FragColor = vec4(c * t, 1.0);
}
`;

const BLUR_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tSrc;
uniform vec2 uTexel;
uniform vec2 uDir;
uniform float uRad;
varying vec2 vUv;

void main() {
  vec2 step = uDir * uTexel * uRad;
  vec3 c = texture2D(tSrc, vUv).rgb * 0.227027;
  c += texture2D(tSrc, vUv + step).rgb * 0.1945946;
  c += texture2D(tSrc, vUv - step).rgb * 0.1945946;
  c += texture2D(tSrc, vUv + step * 2.0).rgb * 0.1216216;
  c += texture2D(tSrc, vUv - step * 2.0).rgb * 0.1216216;
  c += texture2D(tSrc, vUv + step * 3.0).rgb * 0.054054;
  c += texture2D(tSrc, vUv - step * 3.0).rgb * 0.054054;
  c += texture2D(tSrc, vUv + step * 4.0).rgb * 0.016216;
  c += texture2D(tSrc, vUv - step * 4.0).rgb * 0.016216;
  gl_FragColor = vec4(c, 1.0);
}
`;

const ADD_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tBloom;
uniform float uGain;
varying vec2 vUv;

void main() {
  vec3 bloom = texture2D(tBloom, vUv).rgb * uGain;
  if (dot(bloom, vec3(0.299, 0.587, 0.114)) < 1e-4) discard;
  gl_FragColor = vec4(bloom, 1.0);
}
`;

function makeColorRT(
  w: number,
  h: number,
  depth: boolean,
): THREE.WebGLRenderTarget {
  const opts: THREE.RenderTargetOptions = {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: depth,
    stencilBuffer: false,
    colorSpace: THREE.LinearSRGBColorSpace,
  };
  if (depth) {
    const dt = new THREE.DepthTexture(w, h);
    dt.format = THREE.DepthFormat;
    dt.type = THREE.UnsignedIntType;
    dt.minFilter = THREE.NearestFilter;
    dt.magFilter = THREE.NearestFilter;
    opts.depthTexture = dt;
  }
  return new THREE.WebGLRenderTarget(w, h, opts);
}

function makeMat(frag: string, uniforms: THREE.ShaderMaterial['uniforms']): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: frag,
    uniforms,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
}

function hideSiblings(keep: THREE.Object3D): THREE.Object3D[] {
  const parent = keep.parent;
  if (!parent) return [];
  const hidden: THREE.Object3D[] = [];
  for (const child of parent.children) {
    if (child !== keep && child.visible) {
      child.visible = false;
      hidden.push(child);
    }
  }
  return hidden;
}

export class StarBloom {
  private w = 1;
  private h = 1;
  private hdr: THREE.WebGLRenderTarget;
  private bloomA: THREE.WebGLRenderTarget;
  private bloomB: THREE.WebGLRenderTarget;
  private extractMat: THREE.ShaderMaterial;
  private blurMat: THREE.ShaderMaterial;
  private addMat: THREE.ShaderMaterial;
  private quad: THREE.Mesh;
  private blit = new THREE.Scene();
  private blitCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly clearCol = new THREE.Color(0, 0, 0);

  constructor() {
    this.hdr = makeColorRT(1, 1, true);
    this.bloomA = makeColorRT(1, 1, false);
    this.bloomB = makeColorRT(1, 1, false);
    this.extractMat = makeMat(EXTRACT_FRAG, {
      tSrc: { value: this.hdr.texture },
      uThr: { value: UNIVERSE.STAR_BLOOM_THR },
    });
    this.blurMat = makeMat(BLUR_FRAG, {
      tSrc: { value: this.bloomA.texture },
      uTexel: { value: new THREE.Vector2(1, 1) },
      uDir: { value: new THREE.Vector2(1, 0) },
      uRad: { value: UNIVERSE.STAR_BLOOM_RAD },
    });
    this.addMat = makeMat(ADD_FRAG, {
      tBloom: { value: this.bloomA.texture },
      uGain: { value: UNIVERSE.STAR_BLOOM_GAIN },
    });
    this.addMat.blending = THREE.AdditiveBlending;
    this.addMat.transparent = true;
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.extractMat);
    this.quad.frustumCulled = false;
    this.blit.add(this.quad);
  }

  setSize(w: number, h: number): void {
    const bw = Math.max(1, w | 0);
    const bh = Math.max(1, h | 0);
    if (bw === this.w && bh === this.h) return;
    this.w = bw;
    this.h = bh;
    this.hdr.setSize(bw, bh);
    const hw = Math.max(1, bw >> 1);
    const hh = Math.max(1, bh >> 1);
    this.bloomA.setSize(hw, hh);
    this.bloomB.setSize(hw, hh);
  }

  /**
   * Locale is already on the canvas. Draw the star into HDR
   * (planets write depth only), bloom that, add the smear.
   */
  draw(
    renderer: THREE.WebGLRenderer,
    locale: THREE.Scene,
    star: THREE.Object3D,
    marker: THREE.Object3D,
    camera: THREE.Camera,
  ): void {
    const prev = renderer.getRenderTarget();
    const prevAuto = renderer.autoClear;
    const prevAlpha = renderer.getClearAlpha();
    renderer.getClearColor(this.clearCol);
    this.syncKnobs();

    const starWas = star.visible;
    const markWas = marker.visible;
    marker.visible = false;

    renderer.setClearColor(0x000000, 0);
    renderer.setRenderTarget(this.hdr);
    renderer.autoClear = true;
    renderer.clear(true, true, false);

    star.visible = false;
    renderer.autoClear = false;
    this.depthOnly(renderer, locale, camera);

    star.visible = true;
    const hidden = hideSiblings(star);
    renderer.render(locale, camera);
    for (const o of hidden) o.visible = true;

    star.visible = starWas;
    marker.visible = markWas;

    this.blitTo(renderer, this.extractMat, this.bloomA);

    const texel = this.blurMat.uniforms.uTexel.value as THREE.Vector2;
    texel.set(1 / Math.max(1, this.bloomA.width), 1 / Math.max(1, this.bloomA.height));
    const dir = this.blurMat.uniforms.uDir.value as THREE.Vector2;
    const rad0 = UNIVERSE.STAR_BLOOM_RAD;
    this.blurMat.uniforms.uRad.value = rad0;
    dir.set(1, 0);
    this.blurMat.uniforms.tSrc.value = this.bloomA.texture;
    this.blitTo(renderer, this.blurMat, this.bloomB);
    dir.set(0, 1);
    this.blurMat.uniforms.tSrc.value = this.bloomB.texture;
    this.blitTo(renderer, this.blurMat, this.bloomA);
    this.blurMat.uniforms.uRad.value = rad0 * 1.7;
    dir.set(1, 0);
    this.blurMat.uniforms.tSrc.value = this.bloomA.texture;
    this.blitTo(renderer, this.blurMat, this.bloomB);
    dir.set(0, 1);
    this.blurMat.uniforms.tSrc.value = this.bloomB.texture;
    this.blitTo(renderer, this.blurMat, this.bloomA);

    renderer.setRenderTarget(null);
    renderer.autoClear = false;
    renderer.setClearColor(this.clearCol, prevAlpha);
    this.quad.material = this.addMat;
    renderer.render(this.blit, this.blitCam);

    renderer.autoClear = prevAuto;
    renderer.setRenderTarget(prev);
  }

  dispose(): void {
    this.hdr.dispose();
    this.hdr.depthTexture?.dispose();
    this.bloomA.dispose();
    this.bloomB.dispose();
    this.extractMat.dispose();
    this.blurMat.dispose();
    this.addMat.dispose();
    this.quad.geometry.dispose();
  }

  private depthOnly(
    renderer: THREE.WebGLRenderer,
    locale: THREE.Scene,
    camera: THREE.Camera,
  ): void {
    const color = renderer.state.buffers.color;
    color.setMask(false);
    color.setLocked(true);
    renderer.render(locale, camera);
    color.setLocked(false);
    color.setMask(true);
  }

  private blitTo(
    renderer: THREE.WebGLRenderer,
    mat: THREE.ShaderMaterial,
    dest: THREE.WebGLRenderTarget,
  ): void {
    this.quad.material = mat;
    renderer.setRenderTarget(dest);
    renderer.clear(true, false, false);
    renderer.render(this.blit, this.blitCam);
  }

  private syncKnobs(): void {
    this.extractMat.uniforms.uThr.value = UNIVERSE.STAR_BLOOM_THR;
    this.blurMat.uniforms.uRad.value = UNIVERSE.STAR_BLOOM_RAD;
    this.addMat.uniforms.uGain.value = UNIVERSE.STAR_BLOOM_GAIN;
  }
}
