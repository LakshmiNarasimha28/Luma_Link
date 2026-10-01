import QRCode from 'qrcode';
import jsQR from 'jsqr';
import type {
  VisualCodec,
  VisualCodecType,
  EccLevel,
  VisualCodecOptions,
  VisualFrame,
  BitMatrix,
  PixelBuffer,
} from './types.js';
import { VisualCapacityError, VisualDecodeError } from './types.js';

// Resolve CJS / ESM module interoperability for qrcode and jsQR
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const qrcodeLib: any = (QRCode as any).default ?? QRCode;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const jsQrLib: any = (jsQR as any).default ?? jsQR;

/**
 * ISO/IEC 18004 8-bit Byte Mode capacity table for QR Versions 1 to 40.
 * Index corresponds directly to Version (1..40). Index 0 is unused.
 */
export const QR_BYTE_CAPACITIES: Record<EccLevel, readonly number[]> = {
  L: [
    0, 17, 32, 53, 78, 106, 134, 154, 192, 230, 271, 321, 367, 425, 458, 520, 586, 644, 718, 792,
    858, 929, 1003, 1091, 1171, 1273, 1367, 1465, 1528, 1628, 1732, 1840, 1952, 2068, 2188, 2303,
    2431, 2563, 2699, 2809, 2953,
  ],
  M: [
    0, 14, 26, 42, 62, 84, 106, 122, 152, 180, 213, 251, 287, 331, 362, 412, 450, 504, 560, 624,
    666, 711, 779, 857, 911, 997, 1059, 1125, 1190, 1264, 1370, 1452, 1538, 1628, 1722, 1809, 1911,
    1989, 2099, 2213, 2331,
  ],
  Q: [
    0, 11, 20, 32, 46, 60, 74, 86, 108, 130, 151, 177, 203, 241, 258, 292, 322, 364, 394, 442, 482,
    509, 544, 599, 661, 701, 742, 793, 842, 898, 958, 1016, 1076, 1140, 1200, 1269, 1329, 1399,
    1465, 1528, 1663,
  ],
  H: [
    0, 7, 14, 24, 34, 44, 58, 64, 84, 98, 119, 137, 155, 177, 194, 216, 240, 280, 308, 324, 370,
    390, 420, 463, 498, 533, 563, 627, 669, 714, 735, 797, 852, 876, 923, 986, 1024, 1054, 1096,
    1142, 1273,
  ],
};

export class SimpleBitMatrix implements BitMatrix {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;

  constructor(width: number, height: number, data?: Uint8Array) {
    this.width = width;
    this.height = height;
    this.data = data ?? new Uint8Array(width * height);
  }

  get(x: number, y: number): boolean {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) {
      return false;
    }
    return this.data[y * this.width + x] === 1;
  }

  set(x: number, y: number, value: boolean): void {
    if (x >= 0 && x < this.width && y >= 0 && y < this.height) {
      this.data[y * this.width + x] = value ? 1 : 0;
    }
  }
}

/**
 * Renders a BitMatrix into a standard RGBA PixelBuffer with quiet zone and scaling.
 */
export function renderMatrixToRgba(
  matrix: BitMatrix,
  scale: number = 4,
  quietZone: number = 4,
): PixelBuffer {
  const pixelWidth = (matrix.width + quietZone * 2) * scale;
  const pixelHeight = (matrix.height + quietZone * 2) * scale;
  const rgba = new Uint8ClampedArray(pixelWidth * pixelHeight * 4);

  // Background: clean white (255, 255, 255, 255)
  rgba.fill(255);

  for (let y = 0; y < matrix.height; y++) {
    for (let x = 0; x < matrix.width; x++) {
      if (matrix.get(x, y)) {
        // Dark module: solid black (0, 0, 0, 255)
        for (let sy = 0; sy < scale; sy++) {
          for (let sx = 0; sx < scale; sx++) {
            const px = (quietZone + x) * scale + sx;
            const py = (quietZone + y) * scale + sy;
            const offset = (py * pixelWidth + px) * 4;
            rgba[offset] = 0;
            rgba[offset + 1] = 0;
            rgba[offset + 2] = 0;
            rgba[offset + 3] = 255;
          }
        }
      }
    }
  }

  return {
    width: pixelWidth,
    height: pixelHeight,
    data: rgba,
  };
}

/**
 * Baseline QR Visual Codec implementing LumaLink VisualCodec interface.
 * Encodes binary payloads into QR frames and decodes QR image frames back to raw bytes.
 */
export class QrVisualCodec implements VisualCodec {
  readonly codecType: VisualCodecType = 'qr';

  /**
   * Returns maximum byte capacity for the given version and ECC level.
   */
  getCapacity(version: number, eccLevel: EccLevel = 'M'): number {
    if (version < 1 || version > 40) {
      return 0;
    }
    const table = QR_BYTE_CAPACITIES[eccLevel];
    return table[version] ?? 0;
  }

  /**
   * Encodes a raw binary payload into a VisualFrame using ISO/IEC 18004 8-bit byte mode.
   * No Base64, hex, or JSON encoding is performed; binary is preserved directly.
   */
  encode(payload: Uint8Array, options?: VisualCodecOptions): VisualFrame {
    const eccLevel: EccLevel = options?.eccLevel ?? 'M';
    const scale = options?.scale ?? 4;
    const quietZone = options?.quietZone ?? 4;

    const maxAllowableVersion = options?.maxVersion ?? 40;
    const maxCapacity = this.getCapacity(maxAllowableVersion, eccLevel);

    if (payload.length > maxCapacity) {
      throw new VisualCapacityError(
        payload.length,
        maxCapacity,
        `Payload size (${payload.length}B) exceeds maximum capacity for QR version ${maxAllowableVersion} ECC ${eccLevel} (${maxCapacity}B)`,
      );
    }

    if (options?.version) {
      const versionCapacity = this.getCapacity(options.version, eccLevel);
      if (payload.length > versionCapacity) {
        throw new VisualCapacityError(
          payload.length,
          versionCapacity,
          `Payload size (${payload.length}B) exceeds capacity for forced QR version ${options.version} ECC ${eccLevel} (${versionCapacity}B)`,
        );
      }
    }

    try {
      // Encode as raw byte mode segment
      const qrData = qrcodeLib.create([{ data: payload, mode: 'byte' }], {
        errorCorrectionLevel: eccLevel,
        version: options?.version,
      });

      const moduleSize = qrData.modules.size;
      const rawModules = qrData.modules.data; // Uint8Array of moduleSize * moduleSize

      const matrixData = new Uint8Array(moduleSize * moduleSize);
      for (let i = 0; i < matrixData.length; i++) {
        matrixData[i] = rawModules[i] === 1 ? 1 : 0;
      }
      const matrix = new SimpleBitMatrix(moduleSize, moduleSize, matrixData);

      const pixelBuffer = renderMatrixToRgba(matrix, scale, quietZone);

      return {
        codecType: 'qr',
        matrix,
        pixelBuffer,
        metadata: {
          version: qrData.version,
          eccLevel,
          payloadBytes: payload.length,
          moduleDimensions: { width: moduleSize, height: moduleSize },
          pixelDimensions: { width: pixelBuffer.width, height: pixelBuffer.height },
          timestamp: Date.now(),
        },
      };
    } catch (err) {
      if (err instanceof VisualCapacityError) {
        throw err;
      }
      throw new VisualCapacityError(
        payload.length,
        maxCapacity,
        `QR generation failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Decodes a VisualFrame or raw PixelBuffer back into raw binary bytes.
   */
  decode(frameOrPixels: VisualFrame | PixelBuffer): Uint8Array {
    const pixelBuffer = 'pixelBuffer' in frameOrPixels ? frameOrPixels.pixelBuffer : frameOrPixels;

    const clamped =
      pixelBuffer.data instanceof Uint8ClampedArray
        ? pixelBuffer.data
        : new Uint8ClampedArray(
            pixelBuffer.data.buffer,
            pixelBuffer.data.byteOffset,
            pixelBuffer.data.byteLength,
          );

    const result = jsQrLib(clamped, pixelBuffer.width, pixelBuffer.height, {
      inversionAttempts: 'dontInvert',
    });

    if (!result || !result.binaryData) {
      throw new VisualDecodeError(
        'QR decoding failed: visual symbol not detected or corruption exceeded error-correction capacity',
      );
    }

    return new Uint8Array(result.binaryData);
  }
}
