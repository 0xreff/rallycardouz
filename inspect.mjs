import { NodeIO } from '@gltf-transform/core';
import { bounds } from '@gltf-transform/core';

async function run() {
  const io = new NodeIO();
  const doc = await io.read('public/assets/d01c4c8e1685f8a60e41844cdde58a22.glb');
  const root = doc.getRoot();
  const scene = root.getDefaultScene();
  
  // calculate bounds
  // Wait, gltf-transform bounds requires the bounding-box function which might be complex, 
  // Let's just run a node script using THREE.js. Wait, three.js requires DOM for GLTFLoader.
  // We can just rely on the in-game THREE.js Box3 logging by modifying Car.ts to print it.
}
run().catch(console.error);
