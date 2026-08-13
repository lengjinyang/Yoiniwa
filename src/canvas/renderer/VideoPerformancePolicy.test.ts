import { describe, expect, it } from 'vitest';
import type { ImageItem } from '../../types';
import { videoBadgeWorldSize } from './VideoRenderer';
import {
  chooseVideoFrameUploads, normalizeVideoFps, oldestPlaybackIntent, resolvedVideoDuration, shouldResizeVideoFrame,
  videoCloserScrubFrame, videoFramePhaseUploadable, videoFrameScrubState, videoFrameSize, videoFrameTime,
  videoFrameUploadDue, videoLiveScrubQueue, videoResponsiveSeekReady, videoScrubFrameAtDelta,
  VIDEO_SCRUB_PIXELS_PER_FRAME, VIDEO_SCRUB_PIXELS_PER_FRAME_MAX, VIDEO_SCRUB_PIXELS_PER_FRAME_MIN,
  clampVideoScrubPixelsPerFrame, videoScrubPixelsPerFrame, videoScrubSeekTarget, videoScrubStrideForVelocity,
  videoScrubTargets,
  videoSeekAlreadyAtTime, videoShouldCancelLiveDecode, videoVisibilityAction,
} from './VideoPerformancePolicy';

const item = {
  width: 1920, height: 1080, naturalWidth: 3840, naturalHeight: 2160,
} as ImageItem;

describe('VideoPerformancePolicy', () => {
  it('selects oversampled screen-sized even frame surfaces capped by source and GPU', () => {
    expect(videoFrameSize(item, { x: 0, y: 0, scale: 0.25 }, 1).edge).toBe(1024);
    const large = videoFrameSize(item, { x: 0, y: 0, scale: 4 }, 2, 4096);
    expect(large.edge).toBe(3840);
    expect(large.width).toBe(3840);
    expect(large.height % 2).toBe(0);
    const stretched = videoFrameSize(
      { ...item, width: 800, height: 800 } as ImageItem,
      { x: 0, y: 0, scale: 1 },
      1,
    );
    expect(stretched.height).toBeGreaterThanOrEqual(1000);
  });

  it('freezes video surfaces while the camera is moving, then resizes after it settles', () => {
    expect(shouldResizeVideoFrame(undefined, 1024, true)).toBe(true);
    expect(shouldResizeVideoFrame(512, 1024, true)).toBe(false);
    expect(shouldResizeVideoFrame(1024, 512, true)).toBe(false);
    expect(shouldResizeVideoFrame(1024, 1024, false)).toBe(false);
    expect(shouldResizeVideoFrame(512, 1024, false)).toBe(true);
    expect(shouldResizeVideoFrame(1024, 512, false)).toBe(true);
  });

  it('keeps the selected video smooth and tolerates 30fps timing jitter for background videos', () => {
    expect(videoFrameUploadDue(16.7, 10, 1)).toBe(true);
    expect(videoFrameUploadDue(26.7, 10, 2)).toBe(false);
    expect(videoFrameUploadDue(42.2, 10, 2)).toBe(true);
    expect(videoFrameUploadDue(26.7, 10, 2, true)).toBe(true);
  });

  it('maps the scrubber to exact integer frames', () => {
    const state = videoFrameScrubState(1.5, 2, 60);
    expect(state).toEqual({ fps: 60, frameCount: 120, maxFrame: 119, currentFrame: 90 });
    expect(videoFrameTime(91, 2, 60)).toBeCloseTo(91.5 / 60);
    expect(videoFrameTime(999, 2, 60)).toBeCloseTo(119.5 / 60);
    expect(normalizeVideoFps(60.0000001)).toBe(60);
    expect(normalizeVideoFps(59.94)).toBe(59.94);
  });

  it('maps horizontal jog movement to clamped frame steps', () => {
    expect(videoScrubFrameAtDelta(20, 16, 100)).toBe(20);
    expect(videoScrubFrameAtDelta(20, -32, 100)).toBe(19);
    expect(videoScrubFrameAtDelta(0, -120, 100)).toBe(0);
    expect(videoScrubFrameAtDelta(99, 120, 100)).toBe(100);
    expect(videoScrubFrameAtDelta(20, 1, 100)).toBe(20);
    expect(videoScrubFrameAtDelta(20, 32, 100, 16)).toBe(22);
    expect(videoScrubFrameAtDelta(0, 240, 999, 0.24)).toBe(999);
  });

  it('ignores unloaded 0-duration media and keeps a fixed pixels-per-frame jog', () => {
    expect(resolvedVideoDuration(12.5, 0)).toBe(12.5);
    expect(resolvedVideoDuration(undefined, Number.NaN, 8)).toBe(8);
    expect(resolvedVideoDuration(undefined, 0)).toBe(0);
    expect(videoScrubPixelsPerFrame(480, 30)).toBe(VIDEO_SCRUB_PIXELS_PER_FRAME);
    expect(videoScrubPixelsPerFrame(480, 480)).toBe(VIDEO_SCRUB_PIXELS_PER_FRAME);
    expect(clampVideoScrubPixelsPerFrame(12)).toBe(VIDEO_SCRUB_PIXELS_PER_FRAME_MIN);
    expect(clampVideoScrubPixelsPerFrame(8)).toBe(VIDEO_SCRUB_PIXELS_PER_FRAME_MIN);
    expect(clampVideoScrubPixelsPerFrame(96)).toBe(VIDEO_SCRUB_PIXELS_PER_FRAME_MAX);
    expect(clampVideoScrubPixelsPerFrame('nope')).toBe(VIDEO_SCRUB_PIXELS_PER_FRAME);
  });

  it('uses velocity tiers and preserves every frame only at precision speed', () => {
    expect([0.1, 0.5, 1.2, 2.2].map(videoScrubStrideForVelocity)).toEqual([1, 2, 4, 8]);
    expect(videoScrubTargets(4, 8, 1)).toEqual([5, 6, 7, 8]);
    expect(videoScrubTargets(8, 4, 1)).toEqual([7, 6, 5, 4]);
    expect(videoScrubTargets(4, 20, 4)).toEqual([20]);
    expect(videoScrubTargets(4, 18, 4)).toEqual([16]);
    expect(videoScrubTargets(4, 6, 4)).toEqual([]);
    expect(videoLiveScrubQueue([{ frameIndex: 4, sequential: true }], 8, true))
      .toEqual([{ frameIndex: 4, sequential: true }, { frameIndex: 8, sequential: true }]);
    expect(videoLiveScrubQueue([{ frameIndex: 4, sequential: false }, { frameIndex: 9, sequential: false }], 20, false))
      .toEqual([{ frameIndex: 20, sequential: false }]);
    expect(videoCloserScrubFrame(12, 4, 20)).toBe(true);
    expect(videoCloserScrubFrame(50, 20, 20)).toBe(false);
    expect(videoShouldCancelLiveDecode(10, 11)).toBe(false);
    expect(videoShouldCancelLiveDecode(10, 12)).toBe(false);
    expect(videoShouldCancelLiveDecode(10, 13)).toBe(true);
    expect(videoShouldCancelLiveDecode(undefined, 40)).toBe(false);
  });

  it('uploads decoded seek frames while paused', () => {
    expect(videoFramePhaseUploadable('playing')).toBe(true);
    expect(videoFramePhaseUploadable('paused')).toBe(true);
    expect(videoFramePhaseUploadable('suspended')).toBe(false);
  });

  it('waits for the decoded scrub frame before chasing the latest target', () => {
    expect(videoScrubSeekTarget(true, 1.25)).toBeUndefined();
    expect(videoScrubSeekTarget(false, 1.25)).toBe(1.25);
    expect(videoScrubSeekTarget(false, 2.5)).toBe(2.5);
    expect(videoResponsiveSeekReady(true, 12)).toBe(false);
    expect(videoResponsiveSeekReady(false, undefined)).toBe(false);
    expect(videoResponsiveSeekReady(false, 12)).toBe(true);
    expect(videoSeekAlreadyAtTime(1.001, 1, 30)).toBe(true);
    expect(videoSeekAlreadyAtTime(1.2, 1, 30)).toBe(false);
  });

  it('prioritizes the selected frame and respects the byte budget', () => {
    const result = chooseVideoFrameUploads([
      { id: 'old', bytes: 8, selected: false, sequence: 1 },
      { id: 'selected', bytes: 8, selected: true, sequence: 3 },
      { id: 'new', bytes: 8, selected: false, sequence: 2 },
    ], 16);
    expect(result.selected).toEqual(['selected', 'old']);
    expect(result.used).toBe(16);
  });

  it('round-robins non-selected uploads across successive frames', () => {
    const candidates = [
      { id: 'a', bytes: 16, selected: false, sequence: 1 },
      { id: 'b', bytes: 16, selected: false, sequence: 2 },
      { id: 'c', bytes: 16, selected: false, sequence: 3 },
    ];
    const first = chooseVideoFrameUploads(candidates, 16);
    const second = chooseVideoFrameUploads(candidates, 16, first.nextRoundRobinAfterId);
    const third = chooseVideoFrameUploads(candidates, 16, second.nextRoundRobinAfterId);
    expect(first.selected).toEqual(['a']);
    expect(second.selected).toEqual(['b']);
    expect(third.selected).toEqual(['c']);
  });

  it('evicts the oldest playback intent when the fifth video starts', () => {
    expect(oldestPlaybackIntent([
      { id: 'second', intentOrder: 2 }, { id: 'first', intentOrder: 1 }, { id: 'third', intentOrder: 3 },
    ])?.id).toBe('first');
  });

  it('suspends outside prefetch and resumes only after becoming visible', () => {
    expect(videoVisibilityAction(true, 'playing', false, false)).toBe('suspend');
    expect(videoVisibilityAction(true, 'playing', true, false)).toBe('none');
    expect(videoVisibilityAction(true, 'suspended', false, true)).toBe('none');
    expect(videoVisibilityAction(true, 'suspended', true, true)).toBe('resume');
  });
});

describe('videoBadgeWorldSize', () => {
  it('keeps a readable screen size when the canvas is zoomed out', () => {
    const size = videoBadgeWorldSize({ width: 1920, height: 1080 }, 0.1);
    expect(size.height).toBeCloseTo(180);
  });

  it('does not overflow a tiny video', () => {
    const size = videoBadgeWorldSize({ width: 20, height: 12 }, 0.1);
    expect(size.height).toBeLessThanOrEqual(12 * 0.9);
  });
});
