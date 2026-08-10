import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { promisify } from 'node:util';
import { brotliCompress, brotliDecompress, constants as zlibConstants } from 'node:zlib';
import type { FileHandle } from 'node:fs/promises';
import type { PhotoshopProjectMetadata, Scene } from '../../src/types.js';

const YOI_STORAGE_VERSION = 4;
const YOI_HEADER_SIZE = 8192;
const YOI_SUPERBLOCK_SIZE = 256;
const YOI_SUPERBLOCK_OFFSETS = [512, 768] as const;
const YOI_MAXIMUM_PREVIEW_BYTES = 4 * 1024 * 1024;
const YOI_SEGMENT_HEADER_SIZE = 96;
const MAXIMUM_SNAPSHOT_BYTES = 64 * 1024 * 1024;
const FILE_MAGIC = Buffer.from('YOINIWA\0', 'ascii');
const SLOT_MAGIC = Buffer.from('YOISLOT\0', 'ascii');
const SEGMENT_MAGIC = Buffer.from('YOISEG4\0', 'ascii');
const brotliCompressAsync = promisify(brotliCompress);
const brotliDecompressAsync = promisify(brotliDecompress);

enum SegmentType {
  Blob = 1,
  Snapshot = 2,
  Preview = 3,
}

export interface YoiStoredBlobRef {
  payloadOffset: number;
  byteLength: number;
  sha256: string;
  kind: 'asset' | 'photoshop-version';
  mimeType?: string;
}

export interface YoiBlobSource {
  id: string;
  sourcePath: string;
  byteLength: number;
  kind: YoiStoredBlobRef['kind'];
  mimeType?: string;
  sourceOffset?: number;
}

export interface YoiSnapshotEnvelope {
  storageVersion: 4;
  revision?: number;
  committedAt: string;
  compactedAtGeneration?: number;
  scene: Scene;
  photoshopProject: PhotoshopProjectMetadata;
  blobs: Record<string, YoiStoredBlobRef>;
}

interface Superblock {
  generation: number;
  snapshotOffset: number;
  snapshotLength: number;
  previewOffset: number;
  previewLength: number;
  endOffset: number;
  committedAt: number;
}

export interface YoiOpenResult {
  repository: YoiRepository;
  snapshot: YoiSnapshotEnvelope;
  recovered: boolean;
}

export interface YoiCommitInput {
  scene: Scene;
  metadata: PhotoshopProjectMetadata;
  revision?: number;
  compactedAtGeneration?: number;
  preview?: Buffer;
  blobSources?: readonly YoiBlobSource[];
}

export interface YoiCommitResult {
  generation: number;
  bytesAppended: number;
  endOffset: number;
  snapshot: YoiSnapshotEnvelope;
}

export interface YoiStorageStats {
  generation: number;
  fileBytes: number;
  liveBytes: number;
  staleBytes: number;
  staleRatio: number;
  blobCount: number;
}

export interface YoiCompactionCandidate {
  temporaryPath: string;
  generation: number;
}

function crc32(value: Buffer) {
  let crc = 0xffffffff;
  for (const byte of value) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function safeNumber(value: bigint, label: string) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new Error(`${label}超出支持范围`);
  return result;
}

async function readExact(handle: FileHandle, length: number, position: number) {
  const value = Buffer.alloc(length);
  let total = 0;
  while (total < length) {
    const { bytesRead } = await handle.read(value, total, length - total, position + total);
    if (!bytesRead) throw new Error('Yoi 文件意外结束');
    total += bytesRead;
  }
  return value;
}

async function writeExact(handle: FileHandle, value: Buffer, position: number) {
  let total = 0;
  while (total < value.length) {
    const { bytesWritten } = await handle.write(value, total, value.length - total, position + total);
    if (!bytesWritten) throw new Error('Yoi 文件写入未完成');
    total += bytesWritten;
  }
}

function parseSuperblock(value: Buffer): Superblock | undefined {
  try {
    if (value.length !== YOI_SUPERBLOCK_SIZE || !value.subarray(0, FILE_MAGIC.length).equals(SLOT_MAGIC)) return undefined;
    if (crc32(value.subarray(0, 64)) !== value.readUInt32LE(64)) return undefined;
    const generation = safeNumber(value.readBigUInt64LE(8), '提交序号');
    const snapshotOffset = safeNumber(value.readBigUInt64LE(16), '快照偏移');
    const snapshotLength = safeNumber(value.readBigUInt64LE(24), '快照大小');
    const previewOffset = safeNumber(value.readBigUInt64LE(32), '预览偏移');
    const previewLength = safeNumber(value.readBigUInt64LE(40), '预览大小');
    const endOffset = safeNumber(value.readBigUInt64LE(48), '提交尾部');
    const committedAt = safeNumber(value.readBigUInt64LE(56), '提交时间');
    if (generation < 1 || snapshotOffset < YOI_HEADER_SIZE + YOI_SEGMENT_HEADER_SIZE
      || snapshotLength < 1 || snapshotLength > MAXIMUM_SNAPSHOT_BYTES
      || snapshotOffset > endOffset || snapshotLength > endOffset - snapshotOffset
      || previewLength > YOI_MAXIMUM_PREVIEW_BYTES || (previewLength > 0 && (
        previewOffset < YOI_HEADER_SIZE + YOI_SEGMENT_HEADER_SIZE
        || previewOffset > endOffset || previewLength > endOffset - previewOffset))) return undefined;
    return { generation, snapshotOffset, snapshotLength, previewOffset, previewLength, endOffset, committedAt };
  } catch {
    // A torn or corrupt slot must not prevent the other slot from recovering the project.
    return undefined;
  }
}

function serializeSuperblock(value: Superblock) {
  const slot = Buffer.alloc(YOI_SUPERBLOCK_SIZE);
  SLOT_MAGIC.copy(slot, 0);
  slot.writeBigUInt64LE(BigInt(value.generation), 8);
  slot.writeBigUInt64LE(BigInt(value.snapshotOffset), 16);
  slot.writeBigUInt64LE(BigInt(value.snapshotLength), 24);
  slot.writeBigUInt64LE(BigInt(value.previewOffset), 32);
  slot.writeBigUInt64LE(BigInt(value.previewLength), 40);
  slot.writeBigUInt64LE(BigInt(value.endOffset), 48);
  slot.writeBigUInt64LE(BigInt(value.committedAt), 56);
  slot.writeUInt32LE(crc32(slot.subarray(0, 64)), 64);
  return slot;
}

function serializeSegmentHeader(type: SegmentType, payloadLength: number, generation: number, sha256: string, blobId?: string) {
  const header = Buffer.alloc(YOI_SEGMENT_HEADER_SIZE);
  SEGMENT_MAGIC.copy(header, 0);
  header.writeUInt32LE(type, 8);
  header.writeUInt32LE(YOI_SEGMENT_HEADER_SIZE, 12);
  header.writeBigUInt64LE(BigInt(payloadLength), 16);
  header.writeBigUInt64LE(BigInt(generation), 24);
  Buffer.from(sha256, 'hex').copy(header, 32);
  if (blobId) Buffer.from(blobId, 'hex').copy(header, 64);
  return header;
}

function validPng(value: Buffer | undefined): value is Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Boolean(value && value.length >= signature.length && value.length <= YOI_MAXIMUM_PREVIEW_BYTES
    && value.subarray(0, signature.length).equals(signature));
}

async function initializeFile(filePath: string) {
  const fileId = randomUUID();
  const handle = await fs.open(filePath, 'wx+');
  try {
    const header = Buffer.alloc(YOI_HEADER_SIZE);
    FILE_MAGIC.copy(header, 0);
    header.writeUInt32LE(YOI_STORAGE_VERSION, 8);
    header.writeUInt32LE(YOI_HEADER_SIZE, 12);
    header.write(fileId, 32, 36, 'ascii');
    await writeExact(handle, header, 0);
    await handle.sync();
  } finally { await handle.close(); }
  return fileId;
}

async function readHead(filePath: string) {
  const handle = await fs.open(filePath, 'r');
  try {
    const stat = await handle.stat();
    const header = await readExact(handle, YOI_HEADER_SIZE, 0);
    if (!header.subarray(0, FILE_MAGIC.length).equals(FILE_MAGIC)
      || header.readUInt32LE(8) !== YOI_STORAGE_VERSION || header.readUInt32LE(12) !== YOI_HEADER_SIZE) {
      throw new Error('该文件不是 YoiStorage v4 工程');
    }
    const fileId = header.subarray(32, 68).toString('ascii');
    if (!/^[a-f0-9-]{36}$/i.test(fileId)) throw new Error('YoiStorage 文件标识无效');
    const slots = await Promise.all(YOI_SUPERBLOCK_OFFSETS.map(async (offset) => parseSuperblock(
      header.subarray(offset, offset + YOI_SUPERBLOCK_SIZE),
    )));
    const valid = slots.filter((slot): slot is Superblock => Boolean(slot) && slot.endOffset <= stat.size)
      .sort((a, b) => b.generation - a.generation);
    if (!valid.length) throw new Error('YoiStorage 没有有效提交');
    return { heads: valid, fileId };
  } finally { await handle.close(); }
}

export async function isYoiStorageV4(filePath: string) {
  try {
    const handle = await fs.open(filePath, 'r');
    try {
      const prefix = await readExact(handle, 16, 0);
      return prefix.subarray(0, FILE_MAGIC.length).equals(FILE_MAGIC)
        && prefix.readUInt32LE(8) === YOI_STORAGE_VERSION;
    } finally { await handle.close(); }
  } catch { return false; }
}

export class YoiRepository {
  private constructor(
    readonly filePath: string,
    private head: Superblock,
    private snapshotValue: YoiSnapshotEnvelope,
    private fileId: string,
    readonly recovered: boolean,
    private initializedWithoutCommit = false,
  ) {}

  static async open(filePath: string): Promise<YoiOpenResult> {
    const { heads, fileId } = await readHead(filePath);
    const stat = await fs.stat(filePath);
    const handle = await fs.open(filePath, 'r');
    try {
      let lastError: unknown;
      for (const head of heads) {
        try {
          const compressed = await YoiRepository.readSegment(handle, head.snapshotOffset, head.snapshotLength, SegmentType.Snapshot);
          const decoded = await brotliDecompressAsync(compressed);
          const snapshot = JSON.parse(decoded.toString('utf8')) as YoiSnapshotEnvelope;
          if (snapshot?.storageVersion !== YOI_STORAGE_VERSION || !snapshot.scene || !snapshot.photoshopProject
            || !snapshot.blobs || typeof snapshot.blobs !== 'object') throw new Error('YoiStorage 快照无效');
          for (const blobId of YoiRepository.reachableBlobIds(snapshot.scene, snapshot.photoshopProject)) {
            const reference = snapshot.blobs[blobId];
            if (!reference || reference.sha256 !== blobId || !Number.isSafeInteger(reference.payloadOffset)
              || !Number.isSafeInteger(reference.byteLength) || reference.byteLength < 1) {
              throw new Error(`YoiStorage 快照缺少内容块：${blobId}`);
            }
          }
          const recovered = stat.size > head.endOffset || head !== heads[0];
          const repository = new YoiRepository(filePath, head, snapshot, fileId, recovered);
          return { repository, snapshot, recovered };
        } catch (error) { lastError = error; }
      }
      throw lastError ?? new Error('YoiStorage 没有可恢复的完整提交');
    } finally { await handle.close(); }
  }

  static async create(filePath: string, input: YoiCommitInput, initialGeneration = 1) {
    if (!Number.isSafeInteger(initialGeneration) || initialGeneration < 1) throw new Error('初始提交序号无效');
    const fileId = await initializeFile(filePath);
    const empty: YoiSnapshotEnvelope = {
      storageVersion: YOI_STORAGE_VERSION,
      committedAt: new Date(0).toISOString(),
      scene: input.scene,
      photoshopProject: input.metadata,
      blobs: {},
    };
    const repository = new YoiRepository(filePath, {
      generation: initialGeneration - 1, snapshotOffset: 0, snapshotLength: 0, previewOffset: 0, previewLength: 0,
      endOffset: YOI_HEADER_SIZE, committedAt: 0,
    }, empty, fileId, false, true);
    await repository.commit(input);
    return repository;
  }

  get snapshot() { return this.snapshotValue; }
  get generation() { return this.head.generation; }

  async commit(input: YoiCommitInput): Promise<YoiCommitResult> {
    if (this.head.generation > 0 && !this.initializedWithoutCommit) {
      const current = (await YoiRepository.open(this.filePath)).repository;
      if (current.fileId !== this.fileId || current.head.generation !== this.head.generation
        || current.head.endOffset !== this.head.endOffset) {
        throw new Error('工程已被其他会话修改，请另存为后继续');
      }
    }
    const handle = await fs.open(this.filePath, 'r+');
    const originalEnd = this.head.endOffset;
    let position = originalEnd;
    const generation = this.head.generation + 1;
    const reachableBlobIds = YoiRepository.reachableBlobIds(input.scene, input.metadata);
    const nextBlobs = Object.fromEntries(Object.entries(this.snapshotValue.blobs)
      .filter(([id]) => reachableBlobIds.has(id)));
    try {
      const stat = await handle.stat();
      if (stat.size !== originalEnd) await handle.truncate(originalEnd);
      for (const source of input.blobSources ?? []) {
        if (!reachableBlobIds.has(source.id) || nextBlobs[source.id]) continue;
        if (!/^[a-f0-9]{64}$/i.test(source.id) || !Number.isSafeInteger(source.byteLength) || source.byteLength < 1) {
          throw new Error('待写入内容块无效');
        }
        const headerOffset = position;
        const payloadOffset = headerOffset + YOI_SEGMENT_HEADER_SIZE;
        const header = serializeSegmentHeader(SegmentType.Blob, source.byteLength, generation, source.id, source.id);
        await writeExact(handle, header, headerOffset);
        position = payloadOffset;
        const digest = createHash('sha256');
        let bytes = 0;
        const start = source.sourceOffset ?? 0;
        const end = start + source.byteLength - 1;
        for await (const chunk of createReadStream(source.sourcePath, { start, end })) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          if (bytes + buffer.length > source.byteLength) throw new Error(`内容块超过声明大小：${source.id}`);
          await writeExact(handle, buffer, position);
          position += buffer.length; bytes += buffer.length; digest.update(buffer);
        }
        if (bytes !== source.byteLength || digest.digest('hex') !== source.id) throw new Error(`内容块校验失败：${source.id}`);
        nextBlobs[source.id] = {
          payloadOffset, byteLength: source.byteLength, sha256: source.id,
          kind: source.kind, mimeType: source.mimeType,
        };
      }
      for (const blobId of reachableBlobIds) {
        if (!nextBlobs[blobId]) throw new Error(`工程缺少被引用的内容块：${blobId}`);
      }
      const snapshot: YoiSnapshotEnvelope = {
        storageVersion: YOI_STORAGE_VERSION,
        revision: input.revision,
        committedAt: new Date().toISOString(),
        compactedAtGeneration: input.compactedAtGeneration ?? this.snapshotValue.compactedAtGeneration,
        scene: input.scene,
        photoshopProject: input.metadata,
        blobs: nextBlobs,
      };
      const encoded = Buffer.from(JSON.stringify(snapshot), 'utf8');
      const compressed = await brotliCompressAsync(encoded, {
        params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 4 },
      });
      if (compressed.length > MAXIMUM_SNAPSHOT_BYTES) throw new Error('工程快照超过大小限制');
      const snapshotSegment = await YoiRepository.writeBufferSegment(handle, position, SegmentType.Snapshot, generation, compressed);
      position = snapshotSegment.endOffset;
      let previewOffset = this.head.previewOffset;
      let previewLength = this.head.previewLength;
      if (validPng(input.preview)) {
        const previewSegment = await YoiRepository.writeBufferSegment(handle, position, SegmentType.Preview, generation, input.preview);
        position = previewSegment.endOffset;
        previewOffset = previewSegment.payloadOffset;
        previewLength = input.preview.length;
      }
      await handle.sync();
      const head: Superblock = {
        generation,
        snapshotOffset: snapshotSegment.payloadOffset,
        snapshotLength: compressed.length,
        previewOffset,
        previewLength,
        endOffset: position,
        committedAt: Date.now(),
      };
      const slot = serializeSuperblock(head);
      const slotOffset = YOI_SUPERBLOCK_OFFSETS[(generation - 1) % YOI_SUPERBLOCK_OFFSETS.length];
      await writeExact(handle, slot, slotOffset);
      await handle.sync();
      this.head = head;
      this.snapshotValue = snapshot;
      this.initializedWithoutCommit = false;
      return { generation, bytesAppended: position - originalEnd, endOffset: position, snapshot };
    } catch (error) {
      await handle.truncate(originalEnd).catch(() => undefined);
      await handle.sync().catch(() => undefined);
      throw error;
    } finally { await handle.close(); }
  }

  async extractBlob(blobId: string, targetPath: string) {
    const reference = this.snapshotValue.blobs[blobId];
    if (!reference || reference.sha256 !== blobId) throw new Error(`工程缺少内容块：${blobId}`);
    const source = await fs.open(this.filePath, 'r');
    try {
      await YoiRepository.readBlobHeader(source, reference, blobId);
    } finally { await source.close(); }
    const digest = createHash('sha256');
    let bytes = 0;
    const verify = new Transform({ transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > reference.byteLength) { callback(new Error(`内容块超过记录大小：${blobId}`)); return; }
      digest.update(chunk); callback(undefined, chunk);
    } });
    try {
      await pipeline(createReadStream(this.filePath, {
        start: reference.payloadOffset,
        end: reference.payloadOffset + reference.byteLength - 1,
      }), verify, createWriteStream(targetPath, { flags: 'wx' }));
      if (bytes !== reference.byteLength || digest.digest('hex') !== blobId) throw new Error(`内容块校验失败：${blobId}`);
      return targetPath;
    } catch (error) {
      await fs.rm(targetPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async readPreview() {
    const { previewOffset, previewLength } = this.head;
    if (!previewLength) return undefined;
    const handle = await fs.open(this.filePath, 'r');
    try { return await YoiRepository.readSegment(handle, previewOffset, previewLength, SegmentType.Preview); }
    finally { await handle.close(); }
  }

  async recoverTail() {
    const current = (await YoiRepository.open(this.filePath)).repository;
    if (current.fileId !== this.fileId || current.head.generation !== this.head.generation
      || current.head.endOffset !== this.head.endOffset) throw new Error('工程已被其他会话修改，请另存为后继续');
    const stat = await fs.stat(this.filePath);
    if (stat.size <= this.head.endOffset) return false;
    const handle = await fs.open(this.filePath, 'r+');
    try {
      await handle.truncate(this.head.endOffset);
      await handle.sync();
      return true;
    } finally { await handle.close(); }
  }

  blobSource(blobId: string): YoiBlobSource {
    const reference = this.snapshotValue.blobs[blobId];
    if (!reference) throw new Error(`工程缺少内容块：${blobId}`);
    return {
      id: blobId,
      sourcePath: this.filePath,
      sourceOffset: reference.payloadOffset,
      byteLength: reference.byteLength,
      kind: reference.kind,
      mimeType: reference.mimeType,
    };
  }

  async stats(): Promise<YoiStorageStats> {
    const stat = await fs.stat(this.filePath);
    const blobBytes = Object.values(this.snapshotValue.blobs)
      .reduce((total, value) => total + YOI_SEGMENT_HEADER_SIZE + value.byteLength, 0);
    const liveBytes = Math.min(stat.size, YOI_HEADER_SIZE + blobBytes
      + YOI_SEGMENT_HEADER_SIZE + this.head.snapshotLength
      + (this.head.previewLength ? YOI_SEGMENT_HEADER_SIZE + this.head.previewLength : 0));
    const staleBytes = Math.max(0, stat.size - liveBytes);
    return {
      generation: this.head.generation,
      fileBytes: stat.size,
      liveBytes,
      staleBytes,
      staleRatio: stat.size ? staleBytes / stat.size : 0,
      blobCount: Object.keys(this.snapshotValue.blobs).length,
    };
  }

  async compact() {
    const temporaryPath = `${this.filePath}.compact.tmp`;
    const candidate = await this.prepareCompaction(temporaryPath);
    try {
      return await this.activateCompaction(candidate);
    } catch (error) {
      await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async prepareCompaction(temporaryPath = `${this.filePath}.compact.tmp`): Promise<YoiCompactionCandidate> {
    const generation = this.head.generation;
    const snapshot = this.snapshotValue;
    const preview = await this.readPreview();
    const sources = Object.entries(snapshot.blobs).map(([id, reference]) => ({
      id,
      sourcePath: this.filePath,
      sourceOffset: reference.payloadOffset,
      byteLength: reference.byteLength,
      kind: reference.kind,
      mimeType: reference.mimeType,
    }));
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    try {
      await YoiRepository.create(temporaryPath, {
        scene: snapshot.scene,
        metadata: snapshot.photoshopProject,
        revision: snapshot.revision,
        compactedAtGeneration: generation,
        preview,
        blobSources: sources,
      }, generation);
      const validated = await YoiRepository.open(temporaryPath);
      if (validated.repository.generation !== generation) throw new Error('整理文件提交序号无效');
      return { temporaryPath, generation };
    } catch (error) {
      await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async activateCompaction(candidate: YoiCompactionCandidate) {
    if (candidate.generation !== this.head.generation) throw new Error('工程在整理期间已更新');
    const current = (await YoiRepository.open(this.filePath)).repository;
    if (current.fileId !== this.fileId || current.head.generation !== candidate.generation
      || current.head.endOffset !== this.head.endOffset) {
      throw new Error('工程在整理期间已被其他会话修改');
    }
    const backupPath = `${this.filePath}.bak`;
    const validated = await YoiRepository.open(candidate.temporaryPath);
    await fs.rm(backupPath, { force: true }).catch(() => undefined);
    await fs.rename(this.filePath, backupPath);
    try {
      await fs.rename(candidate.temporaryPath, this.filePath);
    } catch (error) {
      await fs.rename(backupPath, this.filePath).catch(() => undefined);
      throw error;
    }
    await fs.rm(backupPath, { force: true }).catch(() => undefined);
    this.head = validated.repository.head;
    this.snapshotValue = validated.snapshot;
    this.fileId = validated.repository.fileId;
    return await this.stats();
  }

  private static async writeBufferSegment(handle: FileHandle, position: number, type: SegmentType, generation: number, payload: Buffer) {
    const sha256 = createHash('sha256').update(payload).digest('hex');
    const header = serializeSegmentHeader(type, payload.length, generation, sha256);
    await writeExact(handle, header, position);
    const payloadOffset = position + header.length;
    await writeExact(handle, payload, payloadOffset);
    return { payloadOffset, endOffset: payloadOffset + payload.length };
  }

  private static async readSegment(handle: FileHandle, payloadOffset: number, payloadLength: number, expectedType: SegmentType) {
    const headerOffset = payloadOffset - YOI_SEGMENT_HEADER_SIZE;
    if (headerOffset < YOI_HEADER_SIZE) throw new Error('YoiStorage 段偏移无效');
    const header = await readExact(handle, YOI_SEGMENT_HEADER_SIZE, headerOffset);
    if (!header.subarray(0, SEGMENT_MAGIC.length).equals(SEGMENT_MAGIC)
      || header.readUInt32LE(8) !== expectedType || header.readUInt32LE(12) !== YOI_SEGMENT_HEADER_SIZE
      || safeNumber(header.readBigUInt64LE(16), '段大小') !== payloadLength) throw new Error('YoiStorage 段头无效');
    const payload = await readExact(handle, payloadLength, payloadOffset);
    const expectedHash = header.subarray(32, 64).toString('hex');
    if (createHash('sha256').update(payload).digest('hex') !== expectedHash) throw new Error('YoiStorage 段校验失败');
    return payload;
  }

  private static reachableBlobIds(scene: Scene, metadata: PhotoshopProjectMetadata) {
    const ids = new Set<string>();
    for (const item of scene.items ?? []) if (typeof item.assetId === 'string') ids.add(item.assetId);
    for (const version of metadata.versions ?? []) {
      if (typeof version.previewAssetId === 'string') ids.add(version.previewAssetId);
      const blobId = version.blobId ?? version.sha256;
      if (typeof blobId === 'string') ids.add(blobId);
    }
    return ids;
  }

  private static async readBlobHeader(handle: FileHandle, reference: YoiStoredBlobRef, blobId: string) {
    const headerOffset = reference.payloadOffset - YOI_SEGMENT_HEADER_SIZE;
    if (headerOffset < YOI_HEADER_SIZE) throw new Error(`内容块偏移无效：${blobId}`);
    const header = await readExact(handle, YOI_SEGMENT_HEADER_SIZE, headerOffset);
    if (!header.subarray(0, SEGMENT_MAGIC.length).equals(SEGMENT_MAGIC)
      || header.readUInt32LE(8) !== SegmentType.Blob || header.readUInt32LE(12) !== YOI_SEGMENT_HEADER_SIZE
      || safeNumber(header.readBigUInt64LE(16), '内容块大小') !== reference.byteLength
      || header.subarray(32, 64).toString('hex') !== blobId
      || header.subarray(64, 96).toString('hex') !== blobId) throw new Error(`内容块段头无效：${blobId}`);
  }
}
