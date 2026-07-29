import { describe, expect, it } from 'vitest';
import { parseRuntimeFlags } from './runtime-flags.js';

describe('runtime flags', () => {
  it('keeps normal mode free of test renderer flags', () => {
    expect(parseRuntimeFlags({}, ['electron'])).toMatchObject({ smokeTest: false, cleanTestSession: false });
  });

  it('treats project benchmark as an isolated smoke session', () => {
    expect(parseRuntimeFlags({ REFCANVAS_PROJECT_BENCH_PATH: 'board.refcanvas' }, ['electron']))
      .toMatchObject({ projectZoomBenchmark: true, smokeTest: true, cleanTestSession: true });
  });

  it('only forces thumbnail failure for the real image test', () => {
    expect(parseRuntimeFlags({ REFCANVAS_FORCE_THUMBNAIL_FAILURE: '1' }, [])).toMatchObject({ forceThumbnailFailure: false });
    expect(parseRuntimeFlags({ REFCANVAS_REAL_IMAGE_TEST: '1', REFCANVAS_FORCE_THUMBNAIL_FAILURE: '1' }, []))
      .toMatchObject({ forceThumbnailFailure: true });
  });
});
