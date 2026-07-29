import { describe, expect, it } from 'vitest';
import { readPerformanceMetrics } from './performanceMetrics';

describe('performance metrics', () => {
  it('reads backend-independent canvas diagnostics', () => {
    const attributes: Record<string, string> = {
      'data-rendered-images': '48',
      'data-total-images': '2000',
      'data-konva-layers': '6',
      'data-render-backend': 'konva',
    };
    const host = { getAttribute: (name: string) => attributes[name] ?? null } as unknown as Element;
    expect(readPerformanceMetrics(host)).toEqual({ renderedImages: 48, totalImages: 2000, konvaLayers: 6, backend: 'konva' });
  });

  it('reads GPU frame and quality diagnostics when present', () => {
    const attributes: Record<string, string> = {
      'data-rendered-images': '2000', 'data-total-images': '2000', 'data-konva-layers': '6',
      'data-render-backend': 'webgl2', 'data-draw-calls': '37', 'data-frame-p95-ms': '8.4',
      'data-lod-coverage': '1.52', 'data-interaction-uploads': '0',
    };
    const host = { getAttribute: (name: string) => attributes[name] ?? null } as unknown as Element;
    expect(readPerformanceMetrics(host)).toMatchObject({
      backend: 'webgl2', drawCalls: 37, frameP95Ms: 8.4, lodCoverage: 1.52, interactionUploads: 0,
    });
  });
});
