export interface RuntimeFlags {
  stressTest: boolean;
  performanceBenchmark: boolean;
  projectZoomBenchmark: boolean;
  devSmokeTest: boolean;
  realImageTest: boolean;
  forceThumbnailFailure: boolean;
  smokeTest: boolean;
  cleanTestSession: boolean;
  manualInputRecording: boolean;
  legacyRenderer: boolean;
}

export function parseRuntimeFlags(env: NodeJS.ProcessEnv, argv: readonly string[]): RuntimeFlags {
  const stressTest = env.REFCANVAS_STRESS_TEST === '1';
  const performanceBenchmark = env.REFCANVAS_PERF_BENCH === '1';
  const projectZoomBenchmark = Boolean(env.REFCANVAS_PROJECT_BENCH_PATH);
  const devSmokeTest = env.REFCANVAS_DEV_SMOKE === '1';
  const realImageTest = env.REFCANVAS_REAL_IMAGE_TEST === '1';
  const forceThumbnailFailure = realImageTest && env.REFCANVAS_FORCE_THUMBNAIL_FAILURE === '1';
  const smokeTest = projectZoomBenchmark || performanceBenchmark || stressTest || realImageTest || devSmokeTest
    || argv.includes('--smoke-test') || env.REFCANVAS_SMOKE_TEST === '1';
  return {
    stressTest, performanceBenchmark, projectZoomBenchmark, devSmokeTest, realImageTest,
    forceThumbnailFailure, smokeTest,
    cleanTestSession: smokeTest || env.REFCANVAS_CLEAN_TEST_SESSION === '1',
    manualInputRecording: env.REFCANVAS_MANUAL_INPUT_RECORD === '1',
    legacyRenderer: env.REFCANVAS_LEGACY_RENDERER === '1',
  };
}
