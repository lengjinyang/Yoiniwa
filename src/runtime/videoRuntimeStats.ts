export interface VideoRuntimeStats {
  playbackIntents: number;
  activeDecoders: number;
  suspendedVideos: number;
  posterTextures: number;
  frameUploads: number;
  frameUploadBytes: number;
  droppedFrames: number;
  uploadFps: number;
  droppedFps: number;
}
