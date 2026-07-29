export interface PerformanceMetrics {
  renderedImages: number;
  totalImages: number;
  konvaLayers: number;
  backend: string;
  drawCalls?: number;
  gpuBytes?: number;
  cpuImageBytes?: number;
  frameP95Ms?: number;
  frameP99Ms?: number;
  lodCoverage?: number;
  interactionUploads?: number;
  longTasks?: number;
}

export function readPerformanceMetrics(host: Element | null): PerformanceMetrics | undefined {
  if (!host) return;
  const renderedImages = Number(host.getAttribute('data-rendered-images'));
  const totalImages = Number(host.getAttribute('data-total-images'));
  const konvaLayers = Number(host.getAttribute('data-konva-layers'));
  if (![renderedImages, totalImages, konvaLayers].every(Number.isFinite)) return;
  const result: PerformanceMetrics = {
    renderedImages,
    totalImages,
    konvaLayers,
    backend: host.getAttribute('data-render-backend') ?? 'unknown',
  };
  const optional: Array<[keyof PerformanceMetrics, string]> = [
    ['drawCalls', 'data-draw-calls'], ['gpuBytes', 'data-gpu-bytes'], ['cpuImageBytes', 'data-cpu-image-bytes'],
    ['frameP95Ms', 'data-frame-p95-ms'], ['frameP99Ms', 'data-frame-p99-ms'], ['lodCoverage', 'data-lod-coverage'],
    ['interactionUploads', 'data-interaction-uploads'], ['longTasks', 'data-long-tasks'],
  ];
  optional.forEach(([key, attribute]) => {
    const raw = host.getAttribute(attribute);
    if (raw === null) return;
    const value = Number(raw);
    if (Number.isFinite(value)) (result as unknown as Record<string, unknown>)[key] = value;
  });
  return result;
}
