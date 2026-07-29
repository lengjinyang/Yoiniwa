import type { ImageRenderBackend, ImageRenderStats, ResolvedImageRenderCommand } from './ImageRenderBackend';
import type { Viewport } from '../types';
import { rendererInfo, rendererWarn } from '../logger';
import { AtlasAllocator, type AtlasAllocation } from './atlasAllocator';
import { GPU_IMAGE_CACHE_DEFAULT_BYTES, GPU_IMAGE_CACHE_HARD_MAX_BYTES } from '../shared/imagePipelineConfig';
import { UploadBudgetQueue } from './uploadBudget';

const MAX_ATLASES = 4;
const INSTANCE_FLOATS = 13;
const GPU_BUDGET_BYTES = Math.min(GPU_IMAGE_CACHE_DEFAULT_BYTES, GPU_IMAGE_CACHE_HARD_MAX_BYTES);

const vertexSource = `#version 300 es
in vec2 a_position;
in vec2 a_texCoord;
in vec2 i_center;
in vec2 i_size;
in float i_rotation;
in vec4 i_uvRect;
in vec2 i_style;
in float i_textureIndex;
in float i_selected;
uniform vec2 u_resolution;
uniform vec3 u_viewport;
uniform mat3 u_gesture;
uniform float u_gestureOpacity;
out vec2 v_texCoord;
out float v_opacity;
out float v_grayscale;
flat out int v_textureIndex;
void main() {
  float c = cos(i_rotation);
  float s = sin(i_rotation);
  vec2 local = a_position * i_size;
  vec2 world = i_center + vec2(local.x * c - local.y * s, local.x * s + local.y * c);
  if (i_selected > 0.5) world = (u_gesture * vec3(world, 1.0)).xy;
  vec2 screen = (world * u_viewport.z + u_viewport.xy);
  vec2 clip = (screen / u_resolution) * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  v_texCoord = mix(i_uvRect.xy, i_uvRect.zw, a_texCoord);
  v_opacity = i_selected > 0.5 && u_gestureOpacity >= 0.0 ? u_gestureOpacity : i_style.x;
  v_grayscale = i_style.y;
  v_textureIndex = int(i_textureIndex + 0.5);
}`;

const fragmentSource = `#version 300 es
precision mediump float;
in vec2 v_texCoord;
in float v_opacity;
in float v_grayscale;
flat in int v_textureIndex;
uniform sampler2D u_texture0;
uniform sampler2D u_texture1;
uniform sampler2D u_texture2;
uniform sampler2D u_texture3;
out vec4 outColor;
void main() {
  vec4 color;
  if (v_textureIndex == 0) color = texture(u_texture0, v_texCoord);
  else if (v_textureIndex == 1) color = texture(u_texture1, v_texCoord);
  else if (v_textureIndex == 2) color = texture(u_texture2, v_texCoord);
  else color = texture(u_texture3, v_texCoord);
  float luminance = dot(color.rgb, vec3(0.2126, 0.7152, 0.0722));
  color.rgb = mix(color.rgb, vec3(luminance), v_grayscale);
  outColor = vec4(color.rgb, color.a * v_opacity);
}`;

interface AtlasPage {
  texture: WebGLTexture;
}

interface TextureEntry {
  key: string;
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  refs: number;
  pinCount: number;
  estimatedBytes: number;
  lastUsed: number;
  allocation: AtlasAllocation;
}

function compile(gl: WebGL2RenderingContext, type: number, source: string) {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('无法创建 WebGL shader');
  gl.shaderSource(shader, source); gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader); gl.deleteShader(shader);
    throw new Error(`WebGL shader 编译失败：${message}`);
  }
  return shader;
}

function createProgram(gl: WebGL2RenderingContext) {
  const program = gl.createProgram();
  if (!program) throw new Error('无法创建 WebGL program');
  const vertex = compile(gl, gl.VERTEX_SHADER, vertexSource);
  const fragment = compile(gl, gl.FRAGMENT_SHADER, fragmentSource);
  gl.attachShader(program, vertex); gl.attachShader(program, fragment); gl.linkProgram(program);
  gl.deleteShader(vertex); gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`WebGL program 链接失败：${gl.getProgramInfoLog(program)}`);
  return program;
}

export class WebGL2ImageRenderer implements ImageRenderBackend {
  readonly kind = 'webgl2' as const;
  private readonly gl: WebGL2RenderingContext;
  private readonly program: WebGLProgram;
  private readonly quadBuffer: WebGLBuffer;
  private readonly instanceBuffer: WebGLBuffer;
  private readonly vertexArray: WebGLVertexArrayObject;
  private readonly resolutionLocation: WebGLUniformLocation;
  private readonly viewportLocation: WebGLUniformLocation;
  private readonly gestureLocation: WebGLUniformLocation;
  private readonly gestureOpacityLocation: WebGLUniformLocation;
  private readonly textureLocations: WebGLUniformLocation[];
  private readonly textures = new Map<string, TextureEntry>();
  private readonly sharedTextures = new Map<string, TextureEntry>();
  private readonly imageKeys = new WeakMap<object, string>();
  private readonly pages: AtlasPage[] = [];
  private readonly allocator: AtlasAllocator;
  private readonly uploadQueue = new UploadBudgetQueue();
  private activeTextureIds = new Set<string>();
  private syncEvictedIds: string[] = [];
  private nextImageKey = 0;
  private pixelRatio = 1;
  private width = 1;
  private height = 1;
  private lost = false;
  private uploadsPaused = false;
  private drawCalls = 0;
  private instances = 0;
  private textureUploads = 0;
  private bindTextureCalls = 0;
  private bufferDataCalls = 0;
  private bufferSubDataCalls = 0;
  private texImage2DCalls = 0;
  private texSubImage2DCalls = 0;
  private textureUploadMs = 0;
  private frameUploadBytes = 0;
  private gestureUniformUpdates = 0;
  private fullInstanceUploads = 0;
  private lastAllocationWarningAt = 0;
  private instanceData = new Float32Array(0);
  private instanceImageIds: string[] = [];
  private selectedImageIds = new Set<string>();
  private gestureMatrix = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  private gestureOpacity = -1;
  private lastViewport?: Viewport;
  private readonly atlasSize: number;
  private readonly contextLostHandler: (event: Event) => void;
  private readonly contextRestoredHandler: () => void;

  constructor(private readonly canvas: HTMLCanvasElement, onContextLost?: () => void, onContextRestored?: () => void) {
    const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: false });
    if (!gl) throw new Error('WebGL2 不可用');
    this.gl = gl;
    this.atlasSize = Math.min(8192, Number(gl.getParameter?.(gl.MAX_TEXTURE_SIZE)) || 4096);
    this.allocator = new AtlasAllocator(this.atlasSize);
    this.program = createProgram(gl);
    const quadBuffer = gl.createBuffer(); const instanceBuffer = gl.createBuffer(); const vertexArray = gl.createVertexArray();
    if (!quadBuffer || !instanceBuffer || !vertexArray) throw new Error('无法创建 WebGL buffer');
    this.quadBuffer = quadBuffer; this.instanceBuffer = instanceBuffer; this.vertexArray = vertexArray;
    this.resolutionLocation = gl.getUniformLocation(this.program, 'u_resolution')!;
    this.viewportLocation = gl.getUniformLocation(this.program, 'u_viewport')!;
    this.gestureLocation = gl.getUniformLocation(this.program, 'u_gesture')!;
    this.gestureOpacityLocation = gl.getUniformLocation(this.program, 'u_gestureOpacity')!;
    this.textureLocations = [0, 1, 2, 3].map((index) => gl.getUniformLocation(this.program, `u_texture${index}`)!);
    if (!this.resolutionLocation || !this.viewportLocation || !this.gestureLocation || !this.gestureOpacityLocation
      || this.textureLocations.some((location) => !location)) throw new Error('无法定位 WebGL shader 参数');

    gl.bindVertexArray(vertexArray);
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -0.5, -0.5, 0, 0, 0.5, -0.5, 1, 0, -0.5, 0.5, 0, 1,
      -0.5, 0.5, 0, 1, 0.5, -0.5, 1, 0, 0.5, 0.5, 1, 1,
    ]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(this.program, 'a_position');
    const texCoord = gl.getAttribLocation(this.program, 'a_texCoord');
    gl.enableVertexAttribArray(position); gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(texCoord); gl.vertexAttribPointer(texCoord, 2, gl.FLOAT, false, 16, 8);
    gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);
    const attributes: Array<[string, number, number]> = [
      ['i_center', 2, 0], ['i_size', 2, 2], ['i_rotation', 1, 4], ['i_uvRect', 4, 5],
      ['i_style', 2, 9], ['i_textureIndex', 1, 11], ['i_selected', 1, 12],
    ];
    attributes.forEach(([name, size, offset]) => {
      const location = gl.getAttribLocation(this.program, name);
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, size, gl.FLOAT, false, INSTANCE_FLOATS * 4, offset * 4);
      gl.vertexAttribDivisor(location, 1);
    });
    gl.bindVertexArray(null);

    this.contextLostHandler = (event) => {
      event.preventDefault(); this.lost = true;
      rendererWarn('webgl.context-lost', this.getStats());
      onContextLost?.();
    };
    this.contextRestoredHandler = () => {
      this.lost = false;
      rendererInfo('webgl.context-restored');
      onContextRestored?.();
    };
    canvas.addEventListener('webglcontextlost', this.contextLostHandler);
    canvas.addEventListener('webglcontextrestored', this.contextRestoredHandler);
  }

  resize(width: number, height: number, pixelRatio: number) {
    const nextWidth = Math.max(1, width); const nextHeight = Math.max(1, height); const nextPixelRatio = Math.max(1, pixelRatio);
    if (this.width === nextWidth && this.height === nextHeight && this.pixelRatio === nextPixelRatio) return;
    this.width = nextWidth; this.height = nextHeight; this.pixelRatio = nextPixelRatio;
    this.canvas.width = Math.max(1, Math.round(nextWidth * nextPixelRatio));
    this.canvas.height = Math.max(1, Math.round(nextHeight * nextPixelRatio));
    this.canvas.style.width = `${nextWidth}px`; this.canvas.style.height = `${nextHeight}px`;
  }

  private createPage() {
    if (this.pages.length >= MAX_ATLASES || (this.pages.length + 1) * this.atlasSize * this.atlasSize * 4 > GPU_BUDGET_BYTES) return undefined;
    const gl = this.gl; const texture = gl.createTexture();
    if (!texture) return undefined;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const uploadStartedAt = performance.now();
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, this.atlasSize, this.atlasSize, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    this.texImage2DCalls += 1;
    this.textureUploadMs += performance.now() - uploadStartedAt;
    const page = { texture };
    this.pages.push(page);
    this.allocator.addPage(this.pages.length - 1);
    return page;
  }

  private allocate(width: number, height: number) {
    let allocation = this.allocator.allocate(width, height);
    while (!allocation && this.createPage()) allocation = this.allocator.allocate(width, height);
    return allocation;
  }

  private evictOneInactiveTexture() {
    let candidate: [string, TextureEntry] | undefined;
    for (const entry of this.textures.entries()) {
      if (this.activeTextureIds.has(entry[0]) || entry[1].pinCount > 0) continue;
      if (!candidate || entry[1].lastUsed < candidate[1].lastUsed) candidate = entry;
    }
    if (!candidate) return false;
    this.removeImage(candidate[0]);
    this.syncEvictedIds.push(candidate[0]);
    return true;
  }

  private releaseReference(entry: TextureEntry) {
    entry.refs -= 1; entry.lastUsed = performance.now();
    if (entry.refs <= 0) {
      this.sharedTextures.delete(entry.key);
      this.allocator.free(entry.allocation);
    }
  }

  setImage(id: string, image: TexImageSource, width: number, height: number, allowUpload = true) {
    if (this.lost) return 'deferred' as const;
    const previous = this.textures.get(id);
    let imageKey = this.imageKeys.get(image as object);
    if (!imageKey) { imageKey = `image:${++this.nextImageKey}`; this.imageKeys.set(image as object, imageKey); }
    const key = `${imageKey}:${width}x${height}`;
    const existing = this.sharedTextures.get(key);
    if (previous && previous === existing) { previous.lastUsed = performance.now(); return 'resident' as const; }
    if (existing) {
      existing.refs += 1; existing.lastUsed = performance.now();
      if (previous) this.releaseReference(previous);
      this.textures.set(id, existing); return 'resident' as const;
    }
    // Never remove the currently displayed texture before its replacement has
    // an atlas slot. Keeping the old entry avoids a blank/wrong-image frame when
    // an upgraded LOD arrives while the atlas is full.
    if (!allowUpload) return 'deferred' as const;
    let slot = this.allocate(width, height);
    // LOD changes are reversible during wheel input. Keep recently inactive tile
    // IDs mapped to their atlas slots and evict them only when a new allocation
    // actually needs the space. This turns a zoom reversal into a camera-only
    // operation instead of uploading the same tiles again.
    while (!slot && this.evictOneInactiveTexture()) slot = this.allocate(width, height);
    if (!slot) {
      const now = performance.now();
      if (now - this.lastAllocationWarningAt >= 1000) {
        this.lastAllocationWarningAt = now;
        rendererWarn('webgl.atlas-allocation-deferred', {
          pages: this.pages.length, activeCommandIds: this.activeTextureIds.size,
          cachedCommandIds: this.textures.size, freeRects: this.allocator.stats().freeRectCount, width, height,
        });
      }
      return 'blocked' as const;
    }
    const page = this.pages[slot.page];
    const gl = this.gl; gl.bindTexture(gl.TEXTURE_2D, page.texture);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false); gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    if (typeof gl.UNPACK_COLORSPACE_CONVERSION_WEBGL === 'number' && typeof gl.BROWSER_DEFAULT_WEBGL === 'number') {
      gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.BROWSER_DEFAULT_WEBGL);
    }
    const uploadStartedAt = performance.now();
    gl.texSubImage2D(gl.TEXTURE_2D, 0, slot.x, slot.y, gl.RGBA, gl.UNSIGNED_BYTE, image);
    this.texSubImage2DCalls += 1;
    this.textureUploadMs += performance.now() - uploadStartedAt;
    const entry = {
      ...slot, key, width, height, refs: 1, pinCount: 0, estimatedBytes: width * height * 4,
      lastUsed: performance.now(), allocation: slot,
    };
    if (previous) this.releaseReference(previous);
    this.sharedTextures.set(key, entry); this.textures.set(id, entry); this.textureUploads += 1;
    return 'uploaded' as const;
  }

  removeImage(id: string) {
    const entry = this.textures.get(id);
    if (entry) this.releaseReference(entry);
    this.textures.delete(id);
  }

  syncImages(
    images: ReadonlyMap<string, HTMLImageElement>,
    activeIds: ReadonlySet<string>,
    protectedIds: ReadonlySet<string> = activeIds,
  ) {
    // Never evict another member of the same requested working set while this
    // sync pass is admitting resources. Doing so creates an upload/evict cycle
    // where pending never reaches zero. Resources disappear from this set as
    // soon as the planner no longer requests them, so the next pass can reclaim
    // them normally. protectedIds remains part of the public contract and is
    // included for callers that provide a drawable outside activeIds.
    this.activeTextureIds = new Set([...activeIds, ...protectedIds]);
    const uploadedIds: string[] = [];
    const blockedIds: string[] = [];
    this.syncEvictedIds = [];
    this.frameUploadBytes = 0;
    this.sharedTextures.forEach((entry) => { entry.pinCount = 0; });
    this.activeTextureIds.forEach((id) => {
      const entry = this.textures.get(id);
      if (entry) entry.pinCount += 1;
    });
    this.uploadQueue.cancel((id) => !activeIds.has(id));
    let priority = activeIds.size;
    for (const id of activeIds) {
      const image = images.get(id);
      if (!image) continue;
      const result = this.setImage(id, image, image.naturalWidth, image.naturalHeight, false);
      if (result === 'resident') {
        this.uploadQueue.cancel((key) => key === id);
        priority -= 1;
        continue;
      }
      this.uploadQueue.request({
        key: id,
        estimatedBytes: image.naturalWidth * image.naturalHeight * 4,
        priority: priority -= 1,
        upload: () => {
          const uploadResult = this.setImage(id, image, image.naturalWidth, image.naturalHeight, true);
          if (uploadResult === 'uploaded') {
            uploadedIds.push(id);
            this.frameUploadBytes += image.naturalWidth * image.naturalHeight * 4;
          } else if (uploadResult === 'blocked') blockedIds.push(id);
        },
      });
    }
    if (!this.uploadsPaused) this.uploadQueue.flush();
    const pendingIds = [...activeIds].filter((id) => images.has(id)
      && (this.uploadQueue.has(id) || !this.textures.has(id)) && !blockedIds.includes(id));
    return {
      uploadedIds, pendingIds, blockedIds, evictedIds: this.syncEvictedIds,
      needsRetry: pendingIds.length > 0 || blockedIds.length > 0,
    };
  }

  isImageResident(id: string) { return this.textures.has(id); }

  setUploadsPaused(paused: boolean) { this.uploadsPaused = paused; }

  setActiveResources(activeIds: ReadonlySet<string>) {
    this.activeTextureIds = new Set(activeIds);
    this.sharedTextures.forEach((entry) => { entry.pinCount = 0; });
    activeIds.forEach((id) => {
      const entry = this.textures.get(id);
      if (entry) entry.pinCount += 1;
    });
  }

  setSelection(selectedIds: ReadonlySet<string>) {
    if (selectedIds.size === this.selectedImageIds.size
      && [...selectedIds].every((id) => this.selectedImageIds.has(id))) return;
    this.selectedImageIds = new Set(selectedIds);
    if (!this.instances) return;
    for (let index = 0; index < this.instances; index += 1) {
      this.instanceData[index * INSTANCE_FLOATS + 12] = this.selectedImageIds.has(this.instanceImageIds[index]) ? 1 : 0;
    }
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.instanceData, 0, this.instances * INSTANCE_FLOATS);
    this.bufferSubDataCalls += 1;
    this.fullInstanceUploads += 1;
  }

  setGesture(matrix: readonly number[], opacity = -1) {
    if (matrix.length !== 9) throw new Error('GPU gesture matrix must contain 9 values');
    this.gestureMatrix.set(matrix);
    this.gestureOpacity = opacity;
    this.gestureUniformUpdates += 1;
  }

  clearGesture() {
    this.gestureMatrix.set([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    this.gestureOpacity = -1;
  }

  getResidentImageSize(id: string) {
    const entry = this.textures.get(id);
    return entry ? { width: entry.width, height: entry.height } : undefined;
  }

  private ensureInstanceCapacity(commandCount: number) {
    const required = commandCount * INSTANCE_FLOATS;
    if (required <= this.instanceData.length) return;
    let capacity = Math.max(INSTANCE_FLOATS * 64, this.instanceData.length || INSTANCE_FLOATS);
    while (capacity < required) capacity *= 2;
    this.instanceData = new Float32Array(capacity);
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.instanceBuffer);
    this.gl.bufferData(this.gl.ARRAY_BUFFER, capacity * Float32Array.BYTES_PER_ELEMENT, this.gl.DYNAMIC_DRAW);
    this.bufferDataCalls += 1;
  }

  private draw(viewport: Viewport) {
    if (this.lastViewport) {
      this.lastViewport.x = viewport.x; this.lastViewport.y = viewport.y; this.lastViewport.scale = viewport.scale;
    } else this.lastViewport = { ...viewport };
    const gl = this.gl;
    this.bindTextureCalls = 0;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); gl.useProgram(this.program);
    gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.uniform2f(this.resolutionLocation, this.width, this.height);
    gl.uniform3f(this.viewportLocation, viewport.x, viewport.y, viewport.scale);
    gl.uniformMatrix3fv(this.gestureLocation, false, this.gestureMatrix);
    gl.uniform1f(this.gestureOpacityLocation, this.gestureOpacity);
    this.pages.forEach((page, index) => {
      gl.activeTexture(gl.TEXTURE0 + index); gl.bindTexture(gl.TEXTURE_2D, page.texture); this.bindTextureCalls += 1;
      gl.uniform1i(this.textureLocations[index], index);
    });
    gl.bindVertexArray(this.vertexArray);
    if (this.instances) gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.instances);
    gl.bindVertexArray(null);
    this.drawCalls = this.instances ? 1 : 0;
  }

  render(commands: readonly ResolvedImageRenderCommand[], viewport: Viewport) {
    if (this.lost) return;
    this.bufferDataCalls = 0;
    this.bufferSubDataCalls = 0;
    this.ensureInstanceCapacity(commands.length);
    const instanceData = this.instanceData;
    let count = 0;
    this.instanceImageIds = [];
    for (const command of commands) {
      const entry = this.textures.get(command.id); if (!entry) continue;
      const normalizedLeft = command.sourceRect.x / Math.max(1, command.naturalWidth);
      const normalizedTop = command.sourceRect.y / Math.max(1, command.naturalHeight);
      const normalizedRight = (command.sourceRect.x + command.sourceRect.width) / Math.max(1, command.naturalWidth);
      const normalizedBottom = (command.sourceRect.y + command.sourceRect.height) / Math.max(1, command.naturalHeight);
      const left = (entry.x + 0.5 + normalizedLeft * Math.max(0, entry.width - 1)) / this.atlasSize;
      const top = (entry.y + 0.5 + normalizedTop * Math.max(0, entry.height - 1)) / this.atlasSize;
      const right = (entry.x + 0.5 + normalizedRight * Math.max(0, entry.width - 1)) / this.atlasSize;
      const bottom = (entry.y + 0.5 + normalizedBottom * Math.max(0, entry.height - 1)) / this.atlasSize;
      const offset = count * INSTANCE_FLOATS;
      instanceData[offset] = command.x + command.width / 2; instanceData[offset + 1] = command.y + command.height / 2;
      instanceData[offset + 2] = command.width * (command.flipX ? -1 : 1);
      instanceData[offset + 3] = command.height * (command.flipY ? -1 : 1);
      instanceData[offset + 4] = command.rotation * Math.PI / 180;
      instanceData[offset + 5] = left; instanceData[offset + 6] = top; instanceData[offset + 7] = right; instanceData[offset + 8] = bottom;
      instanceData[offset + 9] = command.opacity; instanceData[offset + 10] = command.grayscale ? 1 : 0; instanceData[offset + 11] = entry.page;
      const imageId = command.imageId ?? command.id;
      instanceData[offset + 12] = this.selectedImageIds.has(imageId) ? 1 : 0;
      this.instanceImageIds.push(imageId);
      count += 1;
    }
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    if (count) {
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, instanceData, 0, count * INSTANCE_FLOATS);
      this.bufferSubDataCalls += 1;
      this.fullInstanceUploads += 1;
    }
    this.instances = count;
    this.draw(viewport);
  }

  renderViewport(viewport: Viewport) {
    if (this.lost) return;
    this.bufferDataCalls = 0;
    this.bufferSubDataCalls = 0;
    this.draw(viewport);
  }

  getStats(): ImageRenderStats {
    const atlas = this.allocator.stats();
    return {
      drawCalls: this.drawCalls, instances: this.instances,
      gpuBytes: this.pages.length * this.atlasSize * this.atlasSize * 4,
      textureUploads: this.textureUploads,
      textureCount: this.pages.length,
      bindTextureCalls: this.bindTextureCalls,
      bufferDataCalls: this.bufferDataCalls,
      bufferSubDataCalls: this.bufferSubDataCalls,
      texImage2DCalls: this.texImage2DCalls,
      texSubImage2DCalls: this.texSubImage2DCalls,
      textureUploadMs: this.textureUploadMs,
      frameUploadBytes: this.frameUploadBytes,
      uploadQueueLength: this.uploadQueue.length,
      gestureUniformUpdates: this.gestureUniformUpdates,
      fullInstanceUploads: this.fullInstanceUploads,
      atlasFreeArea: atlas.freeArea,
      atlasUsedArea: atlas.usedArea,
      atlasLargestFreeRectArea: atlas.largestFreeRectArea,
      textureCommandCount: this.textures.size,
      activeTextureCount: [...this.activeTextureIds].reduce(
        (count, id) => count + (this.textures.has(id) ? 1 : 0),
        0,
      ),
      renderedViewportX: this.lastViewport?.x ?? 0,
      renderedViewportY: this.lastViewport?.y ?? 0,
      renderedViewportScale: this.lastViewport?.scale ?? 0,
    };
  }

  destroy() {
    this.canvas.removeEventListener('webglcontextlost', this.contextLostHandler);
    this.canvas.removeEventListener('webglcontextrestored', this.contextRestoredHandler);
    if (!this.lost) {
      this.pages.forEach((page) => this.gl.deleteTexture(page.texture));
      this.gl.deleteBuffer(this.quadBuffer); this.gl.deleteBuffer(this.instanceBuffer);
      this.gl.deleteVertexArray(this.vertexArray); this.gl.deleteProgram(this.program);
    }
    this.textures.clear(); this.sharedTextures.clear(); this.pages.length = 0;
    this.activeTextureIds.clear();
  }
}
