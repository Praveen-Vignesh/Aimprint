// Target detection by reading pixels off the rendered frame — deliberately
// NO access to Three.js scene state, no hook in src/. The bot "sees" only what
// a screen-capture sees, which keeps the shipped app untouched (the removed
// ?bot= Bot Mode is exactly what this avoids) and is robust to refactors of
// main.js internals.
//
// TARGET_COLOR is 0xff5555 (src/constants.js) against a ~0x1a1a1a background,
// so a simple red-dominant threshold isolates it. We centroid the matching
// pixels and return the offset from frame centre (the fixed crosshair).

import { PNG } from 'pngjs';

// Red-dominant test tuned for 0xff5555 vs the dark scene. Generous enough to
// catch the lit sphere's shaded edges, tight enough to ignore the grey walls.
function isTargetPixel(r, g, b) {
  return r > 150 && g < 120 && b < 120 && r - g > 60 && r - b > 60;
}

// pngBuffer: a PNG screenshot of the canvas. Returns null when no target is
// visible (between a hit and the next spawn, or a missed detection), else
// { dx, dy, radiusPx, coverage } where dx/dy are pixel offsets from centre
// (right/down positive) and radiusPx is a rough target radius from its extent.
export function findTarget(pngBuffer) {
  const png = PNG.sync.read(pngBuffer);
  const { width, height, data } = png;

  let sumX = 0;
  let sumY = 0;
  let count = 0;
  let minX = width;
  let maxX = 0;
  let minY = height;
  let maxY = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (isTargetPixel(data[i], data[i + 1], data[i + 2])) {
        sumX += x;
        sumY += y;
        count++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  // Too few matching pixels is noise, not a target.
  if (count < 12) return null;

  const cx = sumX / count;
  const cy = sumY / count;
  const radiusPx = Math.max(maxX - minX, maxY - minY) / 2;
  return {
    dx: cx - width / 2,
    dy: cy - height / 2,
    radiusPx,
    coverage: count
  };
}
