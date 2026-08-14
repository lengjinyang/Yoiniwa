import { describe, expect, it } from 'vitest';
import type { ImageItem } from '../../types';
import { videoBadgeWorldSize } from './VideoRenderer';
import {
  chooseVideoFrameUploads, normalizeVideoFps, oldestPlaybackIntent, resolvedVideoDuration, shouldResizeVideoFrame,
  videoFramePhaseUploadable, videoFrameState, videoFrameSize, videoFrameTime,
  videoFrameUploadDue, videoHasDecodedFrame, videoPresentedFrameIsNew,
  videoShouldBindPosterFallback, videoShouldShowPoster, videoVisibilityAction,
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

  it('does not upload the same decoded presentation twice', () => {
    expect(videoPresentedFrameIsNew(1, -1)).toBe(true);
    expect(videoPresentedFrameIsNew(1, 1)).toBe(false);
    expect(videoPresentedFrameIsNew(1 + 1e-7, 1)).toBe(false);
    expect(videoPresentedFrameIsNew(1.04, 1)).toBe(true);
  });

  it('maps playback time to integer frames', () => {
    const state = videoFrameState(1.5, 2, 60);
    expect(state).toEqual({ fps: 60, frameCount: 120, maxFrame: 119, currentFrame: 90 });
    expect(videoFrameTime(91, 2, 60)).toBeCloseTo(91.5 / 60);
    expect(videoFrameTime(999, 2, 60)).toBeCloseTo(119.5 / 60);
    expect(normalizeVideoFps(60.0000001)).toBe(60);
    expect(normalizeVideoFps(59.94)).toBe(59.94);
  });

  it('ignores unloaded media duration', () => {
    expect(resolvedVideoDuration(12.5, 0)).toBe(12.5);
    expect(resolvedVideoDuration(undefined, Number.NaN, 8)).toBe(8);
    expect(resolvedVideoDuration(undefined, 0)).toBe(0);
  });

  it('uploads decoded seek frames while paused or first-loading', () => {
    expect(videoFramePhaseUploadable('playing')).toBe(true);
    expect(videoFramePhaseUploadable('paused')).toBe(true);
    expect(videoFramePhaseUploadable('loading')).toBe(true);
    expect(videoFramePhaseUploadable('suspended')).toBe(false);
    expect(videoHasDecodedFrame(1920, 1080, 1)).toBe(false);
    expect(videoHasDecodedFrame(1920, 1080, 2)).toBe(true);
    expect(videoHasDecodedFrame(0, 0, 4)).toBe(false);
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

  it('does not fall back to the first-frame poster while a paused frame is on screen', () => {
    expect(videoShouldBindPosterFallback(true, false, 12)).toBe(false);
    expect(videoShouldBindPosterFallback(false, true, 12)).toBe(false);
    expect(videoShouldBindPosterFallback(false, false, 12)).toBe(false);
    expect(videoShouldBindPosterFallback(false, false, 0)).toBe(true);
    expect(videoShouldShowPoster('paused', false, 0)).toBe(true);
    expect(videoShouldShowPoster('playing', false, 0)).toBe(false);
    expect(videoShouldShowPoster('paused', true, 0)).toBe(false);
    expect(videoShouldShowPoster('paused', false, 12)).toBe(false);
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
