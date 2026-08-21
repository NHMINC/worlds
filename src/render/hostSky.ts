/**
 * SOI night sky: a cubemap of the live harvest, sampled on a
 * clip quad. Parallax inside ARRIVE_RANGE is nothing; look
 * still changes which direction you see. Bake at unity gain;
 * surveyGain multiplies at sample time — same place law as
 * the live catalog, so the swap does not pop.
 */
import * as THREE from 'three';

const SKY_VERT = /* glsl */ `
varying vec2 vNdc;
void main() {
  vNdc = position.xy;
  gl_Position = vec4(position.xy, 1.0, 1.0);
}
`;

const SKY_FRAG = /* glsl */ `
uniform samplerCube uSky;
uniform float uSkyDim;
uniform mat3 uCamRot;
uniform mat4 uInvProj;
varying vec2 vNdc;
void main() {
  vec4 v = uInvProj * vec4(vNdc, 1.0, 1.0);
  vec3 dir = normalize(uCamRot * normalize(v.xyz));
  vec3 c = textureCube(uSky, dir).rgb * uSkyDim;
  gl_FragColor = vec4(c, 1.0);
}
`;

export function makeHostSkyMaterial(cube: THREE.CubeTexture): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: SKY_VERT,
    fragmentShader: SKY_FRAG,
    uniforms: {
      uSky: { value: cube },
      uSkyDim: { value: 1 },
      uCamRot: { value: new THREE.Matrix3() },
      uInvProj: { value: new THREE.Matrix4() },
    },
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
}

export function makeHostSkyMesh(mat: THREE.ShaderMaterial): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -20;
  return mesh;
}
