import GUI from 'lil-gui';

/** lil-gui panel bound directly to config. Any change calls onChange(). */
export function createDebugGui(config, presets, { onChange, onQuality }) {
  const gui = new GUI({ title: 'Desert mood' });
  gui.add(config, 'quality', Object.keys(presets)).onChange(onQuality);
  gui.add(config, 'exposure', 0.2, 3, 0.01);

  const sun = gui.addFolder('Sun');
  sun.add(config.sun, 'elevation', 1, 60, 0.1);
  sun.add(config.sun, 'azimuth', 0, 360, 0.5);
  sun.add(config.sun, 'intensity', 0, 10, 0.05);
  sun.addColor(config.sun, 'color');
  sun.add(config.sun, 'discSize', 0.2, 5, 0.05);
  sun.add(config.sun, 'discIntensity', 1, 150, 1);

  const sky = gui.addFolder('Sky').close();
  sky.addColor(config.sky, 'zenith');
  sky.add(config.sky, 'horizonBlend', 0.05, 1, 0.01);
  sky.add(config.sky, 'curve', 0.2, 3, 0.01);
  sky.add(config.sky, 'glow', 0, 2, 0.01);
  sky.add(config.sky, 'mieG', 0, 0.95, 0.01);
  sky.add(config.sky, 'coreGlow', 0, 10, 0.1);

  const fog = gui.addFolder('Fog / haze');
  fog.addColor(config.fog, 'color');
  fog.addColor(config.fog, 'sunColor');
  fog.add(config.fog, 'density', 0, 0.003, 0.00001);
  fog.add(config.fog, 'heightFalloff', 0, 0.1, 0.001);
  fog.add(config.fog, 'baseHeight', -50, 50, 0.5);
  fog.add(config.fog, 'sunPower', 1, 32, 0.1);
  fog.add(config.fog, 'sunStrength', 0, 1.5, 0.01);
  fog.add(config.haze, 'opacity', 0, 0.6, 0.01).name('sheet opacity');
  fog.add(config.haze, 'height', 2, 60, 0.5).name('sheet height');
  fog.add(config.haze, 'speed', 0, 4, 0.05).name('sheet drift');

  const pal = gui.addFolder('Palette').close();
  for (const k of Object.keys(config.palette)) pal.addColor(config.palette, k);
  pal.addColor(config.hemi, 'sky').name('hemi sky');
  pal.addColor(config.hemi, 'ground').name('hemi ground');
  pal.add(config.hemi, 'intensity', 0, 3, 0.01).name('hemi intensity');

  const sand = gui.addFolder('Sand').close();
  sand.add(config.sand, 'rippleScale', 0.2, 4, 0.01);
  sand.add(config.sand, 'rippleStrength', 0, 2, 0.01);
  sand.add(config.sand, 'rippleStretch', 1, 10, 0.1);
  sand.add(config.sand, 'rippleFadeDistance', 40, 600, 1);
  sand.add(config.sand, 'sparkle', 0, 3, 0.01);
  sand.add(config.sand, 'rim', 0, 3, 0.01);
  sand.add(config.sand, 'variation', 0, 0.5, 0.01);
  sand.add(config.wind, 'direction', 0, 360, 1).name('wind direction');
  sand.add(config.wind, 'speed', 0, 12, 0.1).name('wind speed');

  const rocks = gui.addFolder('Rocks').close();
  rocks.add(config.rocks, 'strataScale', 0.01, 0.5, 0.001);
  rocks.add(config.rocks, 'strataContrast', 0, 2, 0.01);
  rocks.add(config.rocks, 'streaks', 0, 1, 0.01);
  rocks.add(config.rocks, 'rim', 0, 3, 0.01);

  const dust = gui.addFolder('Dust').close();
  dust.add(config.dust, 'amount', 0, 3, 0.01);
  dust.add(config.dust, 'size', 0.2, 4, 0.01);
  dust.add(config.dust, 'growth', 0, 12, 0.1);
  dust.add(config.dust, 'lifetime', 0.2, 3, 0.01);
  dust.add(config.dust, 'opacity', 0, 1, 0.01);
  dust.add(config.dust, 'backlight', 0, 4, 0.01);
  dust.add(config.dust, 'backPower', 1, 16, 0.1);

  const cam = gui.addFolder('Camera').close();
  cam.add(config.camera, 'fov', 40, 90, 0.5);
  cam.add(config.camera, 'fovKick', 0, 25, 0.1);
  cam.add(config.camera, 'distance', 3, 20, 0.1);
  cam.add(config.camera, 'height', 0.5, 8, 0.05);
  cam.add(config.camera, 'lookAhead', 0, 20, 0.1);
  cam.add(config.camera, 'lookHeight', 0, 4, 0.05);
  cam.add(config.camera, 'followDamping', 0.5, 20, 0.1);
  cam.add(config.camera, 'lookDamping', 0.5, 20, 0.1);
  cam.add(config.camera, 'shake', 0, 3, 0.01);
  cam.add(config.camera, 'bob', 0, 3, 0.01);

  const post = gui.addFolder('Post').close();
  post.add(config.post, 'bloomStrength', 0, 3, 0.01);
  post.add(config.post, 'bloomRadius', 0, 1, 0.01);
  post.add(config.post, 'bloomThreshold', 0, 5, 0.01);
  post.add(config.post, 'vignette', 0, 1, 0.01);
  post.addColor(config.post, 'vignetteTint');
  post.add(config.post, 'grain', 0, 0.2, 0.001);
  post.add(config.post, 'chromatic', 0, 0.02, 0.0001);
  post.add(config.post, 'saturation', 0, 2, 0.01);
  post.add(config.post, 'contrast', 0.5, 1.5, 0.01);
  post.add(config.post, 'warmth', -1, 1, 0.01);
  post.add(config.post, 'shimmer', 0, 0.01, 0.0001);
  post.add(config.post, 'shimmerWidth', 0.005, 0.3, 0.001);
  for (const key of ['lift', 'gamma', 'gain']) {
    const f = post.addFolder(key).close();
    const [min, max] = key === 'lift' ? [-0.2, 0.2] : [0.5, 1.5];
    for (const ch of ['r', 'g', 'b']) f.add(config.post[key], ch, min, max, 0.001);
  }

  const veh = gui.addFolder('Vehicle').close();
  veh.add(config.vehicle, 'autoDrive');
  veh.add(config.vehicle, 'maxSpeed', 5, 60, 0.5);
  veh.add(config.vehicle, 'accel', 1, 30, 0.1);
  veh.add(config.vehicle, 'turnRate', 0.3, 4, 0.01);
  veh.addColor(config.vehicle, 'headlightColor');
  veh.add(config.vehicle, 'headlightIntensity', 0, 30, 0.1);
  veh.add(config.vehicle, 'spotIntensity', 0, 200, 1);

  const label = 'Copy config to clipboard';
  const fallback = (text) => {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  };
  const actions = {
    copy() {
      const text = `export const config = ${JSON.stringify(config, null, 2)};\n`;
      const done = () => { btn.name('Copied!'); setTimeout(() => btn.name(label), 1200); };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, () => { fallback(text); done(); });
      } else {
        fallback(text);
        done();
      }
    },
  };
  const btn = gui.add(actions, 'copy').name(label);

  gui.onChange(onChange);
  return gui;
}
