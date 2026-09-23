/**
 * Unit tests for cfg_scale range clamping (KUG-1342).
 *
 * The accepted classifier-free guidance band is [1.2, 2.5]; values outside
 * it are clamped into the band client-side (matching the server).
 */

import { describe, it, expect } from 'vitest';
import { clampCfgScale, MIN_CFG_SCALE, MAX_CFG_SCALE } from './utils';

describe('clampCfgScale', () => {
  it('passes undefined through (server default applies)', () => {
    expect(clampCfgScale(undefined)).toBeUndefined();
  });

  it('clamps values below the floor up to 1.2', () => {
    for (const cfg of [0, 1.0, 1.19]) {
      expect(clampCfgScale(cfg)).toBe(MIN_CFG_SCALE);
    }
  });

  it('clamps values above the ceiling down to 2.5', () => {
    for (const cfg of [2.51, 3.0, 5, 10]) {
      expect(clampCfgScale(cfg)).toBe(MAX_CFG_SCALE);
    }
  });
});
