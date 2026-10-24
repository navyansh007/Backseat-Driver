import * as THREE from 'three/webgpu';
import { Fn, mix, output, rangeFogFactor, sRGBTransferOETF, toneMapping, toneMappingExposure, vec3, vec4 } from 'three/tsl';
import type { Node, NodeBuilder } from 'three/webgpu';

const TONE_MAPPING = THREE.ACESFilmicToneMapping;

/**
 * Make WebGPURenderer produce the same image the WebGL renderer did.
 *
 * WebGL tone-maps and sRGB-encodes inside every material's shader, mixes fog in after that
 * (in display space), and blends transparent surfaces in display space. WebGPURenderer
 * instead draws into an HDR buffer and tone-maps the whole frame at the end, which changes
 * how smoke, fire, sparks and fog look. Here the renderer's own output stage is switched off
 * (so it also draws straight to the canvas with MSAA) and each material applies the WebGL
 * steps itself, in the same order.
 *
 * Custom shader materials (particles, smoke, skids, fireballs) output raw values, as their
 * WebGL ShaderMaterial versions did, so they skip all of this.
 */
export function useWebGLOutput(renderer: THREE.WebGPURenderer, scene: THREE.Scene, fog: THREE.Fog) {
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;

  const display = (rgb: Node<'vec3'>, builder: NodeBuilder) => {
    const toneMapped = builder.material.toneMapped ? toneMapping(TONE_MAPPING, toneMappingExposure, rgb) : rgb;
    return sRGBTransferOETF(toneMapped) as Node<'vec3'>;
  };
  // render targets (environment map, shadows) stay linear and untouched, as in WebGL
  const toScreen = (builder: NodeBuilder) => builder.renderer.getRenderTarget() === null;

  // WebGL uploads the fog colour in the output colour space and mixes it after encoding
  const c = fog.color.getRGB(new THREE.Color(), THREE.SRGBColorSpace);
  const fogColor = vec3(c.r, c.g, c.b);
  scene.fogNode = Fn((builder: NodeBuilder) => {
    if (!toScreen(builder)) return output;
    return vec4(mix(display(output.rgb, builder), fogColor, rangeFogFactor(fog.near, fog.far)), output.a);
  })();

  (renderer.contextNode.value as { getOutput?: (node: Node<'vec4'>, builder: NodeBuilder) => Node }).getOutput = (node, builder) => {
    if (!toScreen(builder)) return node;
    const fogged = (builder.material as THREE.Material & { fog?: boolean }).fog && (builder as NodeBuilder & { fogNode?: Node | null }).fogNode;
    if (fogged) return node; // the fog node already encoded it
    return vec4(display(node.rgb, builder), node.a);
  };
}
