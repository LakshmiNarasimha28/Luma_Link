import type { PixelBuffer } from './types.js';

/**
 * Synthetic image-channel degradation suite for controlled Reed-Solomon ECC experiments.
 *
 * NOTE: These utilities perform SYNTHETIC numerical simulations for unit testing and
 * theoretical boundary evaluation. They do NOT represent real-world camera optics,
 * dynamic exposure, motion blur, or ambient lighting conditions.
 */

/**
 * Creates an isolated clone of a PixelBuffer.
 */
export function clonePixelBuffer(pb: PixelBuffer): PixelBuffer {
  const clonedData = new Uint8ClampedArray(pb.data.length);
  clonedData.set(pb.data);
  return {
    width: pb.width,
    height: pb.height,
    data: clonedData,
  };
}

/**
 * Simple deterministic pseudo-random generator for reproducible synthetic corruption.
 */
function lcgRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * Applies synthetic salt-and-pepper noise to a pixel buffer.
 *
 * @param pb Input pixel buffer
 * @param noiseFraction Fraction of pixels to corrupt (0.0 to 1.0)
 * @param seed Random seed
 */
export function applySaltAndPepperNoise(
  pb: PixelBuffer,
  noiseFraction: number,
  seed: number = 42,
): PixelBuffer {
  const out = clonePixelBuffer(pb);
  const totalPixels = pb.width * pb.height;
  const rand = lcgRandom(seed);

  for (let i = 0; i < totalPixels; i++) {
    if (rand() < noiseFraction) {
      const val = rand() < 0.5 ? 0 : 255;
      const offset = i * 4;
      out.data[offset] = val;
      out.data[offset + 1] = val;
      out.data[offset + 2] = val;
    }
  }

  return out;
}

/**
 * Applies synthetic random pixel corruption (channel inversion).
 */
export function applyPixelCorruption(
  pb: PixelBuffer,
  corruptionRate: number,
  seed: number = 101,
): PixelBuffer {
  const out = clonePixelBuffer(pb);
  const totalPixels = pb.width * pb.height;
  const rand = lcgRandom(seed);

  for (let i = 0; i < totalPixels; i++) {
    if (rand() < corruptionRate) {
      const offset = i * 4;
      out.data[offset] = 255 - out.data[offset]!;
      out.data[offset + 1] = 255 - out.data[offset + 1]!;
      out.data[offset + 2] = 255 - out.data[offset + 2]!;
    }
  }

  return out;
}

/**
 * Simulates partial optical obstruction (e.g. finger, glare, or physical damage)
 * by overwriting a rectangular region with a solid color.
 *
 * @param xFrac Normalized X offset (0.0 to 1.0)
 * @param yFrac Normalized Y offset (0.0 to 1.0)
 * @param wFrac Normalized width (0.0 to 1.0)
 * @param hFrac Normalized height (0.0 to 1.0)
 */
export function applyPartialObstruction(
  pb: PixelBuffer,
  xFrac: number,
  yFrac: number,
  wFrac: number,
  hFrac: number,
  color: [number, number, number, number] = [0, 0, 0, 255],
): PixelBuffer {
  const out = clonePixelBuffer(pb);
  const startX = Math.floor(xFrac * pb.width);
  const startY = Math.floor(yFrac * pb.height);
  const endX = Math.min(pb.width, startX + Math.floor(wFrac * pb.width));
  const endY = Math.min(pb.height, startY + Math.floor(hFrac * pb.height));

  for (let y = startY; y < endY; y++) {
    for (let x = startX; x < endX; x++) {
      const offset = (y * pb.width + x) * 4;
      out.data[offset] = color[0];
      out.data[offset + 1] = color[1];
      out.data[offset + 2] = color[2];
      out.data[offset + 3] = color[3];
    }
  }

  return out;
}

/**
 * Applies synthetic box blur simulating lens out-of-focus or motion blur.
 */
export function applyBoxBlur(pb: PixelBuffer, radius: number): PixelBuffer {
  if (radius <= 0) return clonePixelBuffer(pb);
  const out = clonePixelBuffer(pb);
  const width = pb.width;
  const height = pb.height;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let rSum = 0;
      let gSum = 0;
      let bSum = 0;
      let count = 0;

      for (let dy = -radius; dy <= radius; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -radius; dx <= radius; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const off = (ny * width + nx) * 4;
          rSum += pb.data[off]!;
          gSum += pb.data[off + 1]!;
          bSum += pb.data[off + 2]!;
          count++;
        }
      }

      const outOff = (y * width + x) * 4;
      out.data[outOff] = Math.round(rSum / count);
      out.data[outOff + 1] = Math.round(gSum / count);
      out.data[outOff + 2] = Math.round(bSum / count);
      out.data[outOff + 3] = 255;
    }
  }

  return out;
}

/**
 * Simulates low sensor resolution or camera distance by downsampling and upsampling back.
 */
export function applyDownscaleUpscale(pb: PixelBuffer, downscaleFactor: number): PixelBuffer {
  if (downscaleFactor <= 1) return clonePixelBuffer(pb);
  const out = clonePixelBuffer(pb);
  const factor = Math.floor(downscaleFactor);

  for (let y = 0; y < pb.height; y += factor) {
    for (let x = 0; x < pb.width; x += factor) {
      const srcOffset = (y * pb.width + x) * 4;
      const r = pb.data[srcOffset]!;
      const g = pb.data[srcOffset + 1]!;
      const b = pb.data[srcOffset + 2]!;

      for (let dy = 0; dy < factor && y + dy < pb.height; dy++) {
        for (let dx = 0; dx < factor && x + dx < pb.width; dx++) {
          const dstOffset = ((y + dy) * pb.width + (x + dx)) * 4;
          out.data[dstOffset] = r;
          out.data[dstOffset + 1] = g;
          out.data[dstOffset + 2] = b;
          out.data[dstOffset + 3] = 255;
        }
      }
    }
  }

  return out;
}
