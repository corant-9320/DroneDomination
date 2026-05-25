import { describe, it, expect, vi, beforeEach } from 'vitest';
import { segmentAngle, drawUnitIcon } from '../unitIcons.js';
import * as unitRenderer from '../unitRenderer.js';

// Mock getUnitSprite to return a null sprite (placeholder path) so tests don't depend on document/Three.js
vi.mock('../unitRenderer.js', () => ({
  getUnitSprite: vi.fn(() => null),
}));

/**
 * Minimal mock of UnitData matching the shape imported from worldData.
 */
function makeUnit(overrides: Partial<{
  id: string;
  label: string;
  ownerId: string;
  tileIndex: number;
  segment: number;
  attributes: Record<string, number>;
  currentHealth: number;
}> = {}) {
  return {
    id: overrides.id ?? 'unit_0',
    label: overrides.label ?? 'Test',
    ownerId: overrides.ownerId ?? 'city_0',
    tileIndex: overrides.tileIndex ?? 0,
    segment: overrides.segment ?? 0,
    attributes: overrides.attributes ?? { maxHealth: 3, wheeledMovement: 2 },
    currentHealth: overrides.currentHealth ?? 3,
  } as any;
}

/**
 * Creates a mock CanvasRenderingContext2D with all drawing methods stubbed.
 */
function createMockCtx(): CanvasRenderingContext2D {
  const ctx: Record<string, any> = {};
  const methods = [
    'save', 'restore', 'translate', 'rotate',
    'fillRect', 'strokeRect', 'beginPath', 'moveTo', 'lineTo',
    'arc', 'fill', 'stroke', 'fillText', 'closePath',
    'clearRect', 'clip', 'setTransform', 'resetTransform',
  ];
  for (const m of methods) {
    ctx[m] = vi.fn();
  }
  ctx.fillStyle = '';
  ctx.strokeStyle = '';
  ctx.lineWidth = 0;
  ctx.lineCap = '';
  ctx.font = '';
  ctx.textAlign = '';
  ctx.textBaseline = '';
  return ctx as unknown as CanvasRenderingContext2D;
}

describe('unitIcons', () => {
  describe('segmentAngle', () => {
    it('returns -π/2 for segment 0 (pointing up)', () => {
      const angle = segmentAngle(0);
      expect(angle).toBeCloseTo(-Math.PI / 2, 10);
    });

    it('returns -π/2 + π/3 for segment 1 (60° clockwise from up)', () => {
      const angle = segmentAngle(1);
      expect(angle).toBeCloseTo(-Math.PI / 2 + Math.PI / 3, 10);
    });

    it('returns -π/2 + 2π/3 for segment 2', () => {
      const angle = segmentAngle(2);
      expect(angle).toBeCloseTo(-Math.PI / 2 + (2 * Math.PI) / 3, 10);
    });

    it('returns π/2 for segment 3 (pointing down)', () => {
      const angle = segmentAngle(3);
      expect(angle).toBeCloseTo(Math.PI / 2, 10);
    });

    it('returns -π/2 + 4π/3 for segment 4', () => {
      const angle = segmentAngle(4);
      expect(angle).toBeCloseTo(-Math.PI / 2 + (4 * Math.PI) / 3, 10);
    });

    it('returns -π/2 + 5π/3 for segment 5', () => {
      const angle = segmentAngle(5);
      expect(angle).toBeCloseTo(-Math.PI / 2 + (5 * Math.PI) / 3, 10);
    });

    it('produces angles evenly spaced by π/3', () => {
      for (let s = 0; s < 5; s++) {
        const diff = segmentAngle(s + 1) - segmentAngle(s);
        expect(diff).toBeCloseTo(Math.PI / 3, 10);
      }
    });

    it('covers full circle from segment 0 to segment 5', () => {
      const totalSpan = segmentAngle(5) - segmentAngle(0);
      expect(totalSpan).toBeCloseTo((5 * Math.PI) / 3, 10);
    });
  });

  describe('drawUnitIcon', () => {
    let ctx: CanvasRenderingContext2D;

    beforeEach(() => {
      ctx = createMockCtx();
    });

    it('does not throw for a basic wheeled unit', () => {
      const unit = makeUnit({
        attributes: { maxHealth: 3, wheeledMovement: 2, rangeAttack: 1 },
        currentHealth: 3,
      });
      expect(() => drawUnitIcon(ctx, unit, 100, 100, 10, '#ff0000')).not.toThrow();
    });

    it('does not throw for a legged unit with splash attack', () => {
      const unit = makeUnit({
        attributes: { maxHealth: 2, limbMovement: 3, splashAttack: 2 },
        currentHealth: 2,
      });
      expect(() => drawUnitIcon(ctx, unit, 50, 50, 8, '#00ff00')).not.toThrow();
    });

    it('does not throw for a flight unit with all attributes', () => {
      const unit = makeUnit({
        attributes: {
          maxHealth: 5,
          armour: 3,
          defence: 2,
          flightMovement: 4,
          rangeAttack: 3,
          splashAttack: 1,
          repair: 2,
        },
        currentHealth: 4,
      });
      expect(() => drawUnitIcon(ctx, unit, 200, 200, 12, '#0000ff')).not.toThrow();
    });

    it('does not throw with empty attributes object', () => {
      const unit = makeUnit({ attributes: {}, currentHealth: 1 });
      expect(() => drawUnitIcon(ctx, unit, 0, 0, 5, '#fff')).not.toThrow();
    });

    it('calls save and restore on the context', () => {
      const unit = makeUnit();
      drawUnitIcon(ctx, unit, 100, 100, 10, '#f00');
      expect(ctx.save).toHaveBeenCalled();
      expect(ctx.restore).toHaveBeenCalled();
    });

    it('translates to the specified screen position', () => {
      const unit = makeUnit();
      drawUnitIcon(ctx, unit, 42, 73, 10, '#f00');
      expect(ctx.translate).toHaveBeenCalledWith(42, 73);
    });

    it('does not rotate when facingAngle override is provided', () => {
      const unit = makeUnit({ segment: 0 });
      const customAngle = Math.PI / 4;
      drawUnitIcon(ctx, unit, 0, 0, 10, '#f00', customAngle);
      expect(ctx.rotate).not.toHaveBeenCalled();
    });

    it('handles unit with zero currentHealth gracefully', () => {
      const unit = makeUnit({
        attributes: { maxHealth: 3, wheeledMovement: 1 },
        currentHealth: 0,
      });
      expect(() => drawUnitIcon(ctx, unit, 10, 10, 10, '#f00')).not.toThrow();
    });

    it('handles very large size values without throwing', () => {
      const unit = makeUnit();
      expect(() => drawUnitIcon(ctx, unit, 0, 0, 1000, '#f00')).not.toThrow();
    });

    it('handles size of 0 without throwing', () => {
      const unit = makeUnit();
      expect(() => drawUnitIcon(ctx, unit, 0, 0, 0, '#f00')).not.toThrow();
    });

    it('draws a placeholder circle when sprite is not cached', () => {
      const unit = makeUnit();
      drawUnitIcon(ctx, unit, 0, 0, 10, '#f00');
      expect(ctx.arc).toHaveBeenCalledWith(0, 0, expect.any(Number), 0, Math.PI * 2);
    });
  });
});
