import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createRecoveringQueue } from './persistence-queue.js';
import { LegacyZipProjectReader } from './legacy-zip-project-reader.js';
import { YoiRepository, isYoiStorageV4, type YoiBlobSource, type YoiCommitResult, type YoiStorageStats } from './yoi-repository.js';
import type { PhotoshopProjectMetadata, PhotoshopVersionRecord, ProjectStorageStats, Scene } from '../../src/types.js';
import { normalizePhotoshopProjectMetadata } from '../../src/shared/photoshopVersions.js';

type ProjectCommitReason = 'explicit' | 'autosave' | 'version-add' | 'version-delete';

export interface ProjectCommitPayload {
  sessionId?: string;
  scene: Scene;
  metadata?: PhotoshopProjectMetadata;
  revision?: number;
  preview?: Buffer;
  reason: ProjectCommitReason;
  blobSources?: readonly YoiBlobSource[];
}

export interface ProjectCommitResponse {
  skipped?: boolean;
  canceled?: boolean;
  path?: string;
  sessionId?: string;
  scene?: Scene;
  metadata?: PhotoshopProjectMetadata;
  generation?: number;
  committedRevision?: number;
  bytesAppended?: number;
  compactionScheduled?: boolean;
  recovered?: boolean;
  upgraded?: 'refcanvas' | 'legacy-yoi';
}

export interface ProjectOpenResponse {
  canceled: boolean;
  path?: string;
  sessionId?: string;
  scene?: Scene;
  metadata?: PhotoshopProjectMetadata;
  generation?: number;
  recovered?: boolean;
  recoverySource?: string;
  readOnly?: boolean;
  upgraded?: 'refcanvas' | 'legacy-yoi';
}

export interface ProjectPersistenceDependencies {
  legacyReader: LegacyZipProjectReader;
  ensureAssetFile(assetId: string): Promise<string>;
  registerV4Assets(scene: Scene, repository: YoiRepository): Promise<void> | void;
}

export type ProjectCompactResponse = ProjectStorageStats | { skipped: true; message?: string };

interface WriteLease {
  path: string;
  token: string;
}

function hideWindowsLockFile(filePath: string) {
  if (process.platform !== 'win32') return Promise.resolve();
  return new Promise<void>((resolve) => {
    execFile('attrib.exe', ['+H', filePath], { windowsHide: true }, () => resolve());
  });
}

export class ProjectSession {
  readonly sessionId = randomUUID();
  readonly queue = createRecoveringQueue();
  readonly openedAt = new Date().toISOString();
  private lease?: WriteLease;
  private compactionTimer?: NodeJS.Timeout;
  private compactionActive = false;

  constructor(
    readonly displayPath: string,
    readonly format: 'v4' | 'legacy-yoi' | 'legacy-refcanvas',
    readonly repository: YoiRepository | undefined,
    readonly legacyPath: string | undefined,
    metadata: PhotoshopProjectMetadata,
    readonly recovered: boolean,
    readonly recoverySource: string | undefined,
    readonly readOnly: boolean,
    private readonly compactAfter: (session: ProjectSession) => void,
    lease?: WriteLease,
  ) { this.metadata = metadata; this.lease = lease; }

  metadata: PhotoshopProjectMetadata;

  get generation() { return this.repository?.generation ?? 0; }
  get snapshot() { return this.repository?.snapshot; }

  scheduleCompaction() {
    if (!this.repository) return;
    if (this.compactionTimer) clearTimeout(this.compactionTimer);
    this.compactionTimer = setTimeout(() => {
      this.compactionTimer = undefined;
      this.compactAfter(this);
    }, 30_000);
    this.compactionTimer.unref?.();
  }

  cancelCompaction() {
    if (this.compactionTimer) clearTimeout(this.compactionTimer);
    this.compactionTimer = undefined;
  }

  beginCompaction() {
    if (this.compactionActive) return false;
    this.compactionActive = true;
    return true;
  }

  endCompaction() { this.compactionActive = false; }

  async close() {
    this.cancelCompaction();
    const lease = this.lease;
    this.lease = undefined;
    if (!lease) return;
    try {
      const value = JSON.parse(await fs.readFile(lease.path, 'utf8')) as { token?: string };
      if (value.token !== lease.token) return;
    } catch { return; }
    await fs.rm(lease.path, { force: true }).catch(() => undefined);
  }
}

export class ProjectPersistenceService {
  private current?: ProjectSession;
  private readonly controlQueue = createRecoveringQueue();

  constructor(private readonly dependencies: ProjectPersistenceDependencies) {}

  get session() { return this.current; }
  get currentPath() { return this.current?.displayPath; }

  async open(filePath: string): Promise<ProjectOpenResponse> {
    return this.controlQueue(async () => {
      await this.closeCurrent();
      const candidates = await this.findV4Candidates(filePath);
      if (candidates.length) return this.openV4(filePath, candidates);
      const legacy = await this.dependencies.legacyReader.open(filePath, { registerAssets: true });
      const format = /\.refcanvas$/i.test(filePath) ? 'legacy-refcanvas' : 'legacy-yoi';
      const session = new ProjectSession(filePath, format, undefined, filePath, legacy.metadata, false, undefined, false,
        (value) => { void this.compactBackground(value); });
      this.current = session;
      return {
        canceled: false, path: filePath, sessionId: session.sessionId,
        scene: legacy.scene, metadata: legacy.metadata, readOnly: false,
      };
    });
  }

  async commit(payload: ProjectCommitPayload): Promise<ProjectCommitResponse> {
    const session = this.current;
    if (!session) return payload.reason === 'autosave' ? { skipped: true } : { canceled: false, skipped: true };
    return session.queue(async () => {
      if (this.current !== session || (payload.sessionId && payload.sessionId !== session.sessionId)) {
        throw new Error('画板会话已切换，请重新打开后保存');
      }
      if (payload.reason === 'autosave' && session.format !== 'v4') return { skipped: true, sessionId: session.sessionId };
      if (session.readOnly) throw new Error('当前工程由其他实例打开，请另存为');
      const rawMetadata = normalizePhotoshopProjectMetadata(payload.metadata);
      const metadata = session.repository ? this.normalizeV4Metadata(rawMetadata) : rawMetadata;
      const prepared = this.prepareScene(payload.scene, metadata, session.displayPath);
      if (session.repository) {
        const result = await this.commitV4(session, prepared, metadata, payload);
        session.metadata = metadata;
        const scheduled = await this.maybeScheduleCompaction(session);
        return this.resultFromCommit(session, prepared, metadata, result, scheduled);
      }
      if (payload.reason === 'autosave') return { skipped: true, sessionId: session.sessionId };
      const upgraded = session.format === 'legacy-refcanvas' ? 'refcanvas' : 'legacy-yoi';
      const migrated = await this.migrateLegacy(session, prepared, metadata, payload);
      this.current = migrated.session;
      await session.close();
      const result = migrated.result;
      return {
        ...this.resultFromCommit(migrated.session, migrated.scene, migrated.metadata, result, false),
        upgraded,
      };
    });
  }

  async saveAs(payload: ProjectCommitPayload, targetPath: string): Promise<ProjectCommitResponse> {
    const session = this.current;
    const operation = async (): Promise<ProjectCommitResponse> => {
      if (session && this.current !== session) throw new Error('画板会话已切换，请重新打开后另存为');
      const sourceSession = session;
      const migrationRoot = sourceSession?.legacyPath
        ? await fs.mkdtemp(path.join(path.dirname(targetPath), `.yoiniwa-save-as-${process.pid}-`)) : undefined;
      const rawMetadata = sourceSession?.legacyPath
        ? await this.materializeLegacyMetadata(sourceSession, normalizePhotoshopProjectMetadata(payload.metadata), migrationRoot!)
        : normalizePhotoshopProjectMetadata(payload.metadata);
      const metadata = this.normalizeV4Metadata(rawMetadata);
      const prepared = this.prepareScene(payload.scene, metadata, targetPath);
      try {
        const sources = await this.collectBlobSources(prepared, metadata, sourceSession, payload.blobSources, migrationRoot);
        const lease = await this.acquireLease(targetPath);
        if (!lease) throw new Error('目标工程已被其他实例写入，请另存为其他文件');
        const temporaryPath = `${targetPath}.${process.pid}.${randomUUID()}.create.tmp`;
        try {
          await this.createProjectFile(temporaryPath, prepared, metadata, payload.revision, payload.preview, sources);
          await this.replaceProjectFile(temporaryPath, targetPath);
          const opened = await YoiRepository.open(targetPath);
          await this.dependencies.registerV4Assets(prepared, opened.repository);
          const next = new ProjectSession(targetPath, 'v4', opened.repository, undefined, metadata,
            false, undefined, false, (value) => { void this.compactBackground(value); }, lease);
          this.current = next;
          if (sourceSession && sourceSession !== next) await sourceSession.close();
          const stat = await fs.stat(targetPath);
          return {
            canceled: false, path: targetPath, sessionId: next.sessionId, scene: prepared, metadata,
            generation: next.generation, committedRevision: payload.revision, bytesAppended: stat.size,
          };
        } catch (error) {
          await this.releaseLease(lease);
          await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
          throw error;
        }
      } finally {
        if (migrationRoot) await fs.rm(migrationRoot, { recursive: true, force: true }).catch(() => undefined);
      }
    };
    return session ? session.queue(operation) : this.controlQueue(operation);
  }

  async close(sessionId?: string) {
    return this.controlQueue(async () => {
      if (!this.current || (sessionId && this.current.sessionId !== sessionId)) return;
      await this.closeCurrent();
    });
  }

  async stats(sessionId?: string): Promise<ProjectStorageStatsResponse> {
    const session = this.requireSession(sessionId);
    if (!session.repository) return { generation: 0, fileBytes: 0, liveBytes: 0, staleBytes: 0, staleRatio: 0, blobCount: 0, readOnly: session.readOnly };
    const stats = await session.repository.stats();
    return { ...stats, readOnly: session.readOnly, recovered: session.recovered, recoverySource: session.recoverySource };
  }

  async recover(sessionId?: string) {
    const session = this.requireSession(sessionId);
    if (!session.repository) return { recovered: false, sessionId: session.sessionId };
    if (session.readOnly) throw new Error('当前工程为只读，请先另存为');
    return session.queue(async () => ({ recovered: await session.repository!.recoverTail(), sessionId: session.sessionId }));
  }

  async compact(sessionId?: string): Promise<ProjectCompactResponse> {
    const session = this.requireSession(sessionId);
    return this.compactBackground(session, true);
  }

  async extractPhotoshopVersion(sessionId: string | undefined, version: PhotoshopVersionRecord, targetPath: string) {
    const session = this.requireSession(sessionId);
    if (session.repository) return session.repository.extractBlob(version.blobId ?? version.sha256, targetPath);
    if (!session.legacyPath) throw new Error('当前工程没有可读取的 Photoshop 版本');
    return this.dependencies.legacyReader.extractVersion(session.legacyPath, version, targetPath);
  }

  async importProject(filePath: string) {
    const candidates = await this.findV4Candidates(filePath);
    if (!candidates.length) return this.dependencies.legacyReader.open(filePath, { registerAssets: true });
    const opened = await YoiRepository.open(candidates[0].filePath);
    await this.dependencies.registerV4Assets(opened.snapshot.scene, opened.repository);
    return { scene: opened.snapshot.scene, metadata: opened.snapshot.photoshopProject };
  }

  async assetIds(filePath: string) {
    const candidates = await this.findV4Candidates(filePath);
    if (!candidates.length) return this.dependencies.legacyReader.assetIds(filePath);
    const opened = await YoiRepository.open(candidates[0].filePath);
    return Object.keys(opened.snapshot.scene.assets ?? {});
  }

  private async openV4(displayPath: string, candidates: Array<{ filePath: string; generation: number; mtimeMs: number }>) {
    const selected = candidates[0];
    let physicalPath = selected.filePath;
    let recoverySource: string | undefined;
    const lease = await this.acquireLease(displayPath);
    if (selected.filePath !== displayPath && lease) {
      const restore = `${displayPath}.${process.pid}.${randomUUID()}.recover.tmp`;
      const previous = `${displayPath}.bak`;
      try {
        await fs.copyFile(selected.filePath, restore);
        await YoiRepository.open(restore);
        await fs.rm(previous, { force: true }).catch(() => undefined);
        try { await fs.rename(displayPath, previous); } catch { /* Target may be absent. */ }
        await fs.rename(restore, displayPath);
        if (selected.filePath !== displayPath && selected.filePath !== previous) {
          await fs.rm(selected.filePath, { force: true }).catch(() => undefined);
        }
        physicalPath = displayPath;
        recoverySource = selected.filePath;
      } catch (error) {
        await fs.rm(restore, { force: true }).catch(() => undefined);
        await fs.rename(previous, displayPath).catch(() => undefined);
        await this.releaseLease(lease);
        throw error;
      }
    } else if (selected.filePath !== displayPath) {
      recoverySource = selected.filePath;
    }
    try {
      const opened = await YoiRepository.open(physicalPath);
      await this.dependencies.registerV4Assets(opened.snapshot.scene, opened.repository);
      const session = new ProjectSession(displayPath, 'v4', opened.repository, undefined, opened.snapshot.photoshopProject,
        opened.recovered || Boolean(recoverySource), recoverySource, !lease, (value) => { void this.compactBackground(value); }, lease);
      this.current = session;
      return {
        canceled: false, path: displayPath, sessionId: session.sessionId,
        scene: opened.snapshot.scene, metadata: opened.snapshot.photoshopProject,
        generation: opened.repository.generation, recovered: session.recovered,
        recoverySource, readOnly: session.readOnly,
      };
    } catch (error) {
      if (lease) await this.releaseLease(lease);
      throw error;
    }
  }

  private async commitV4(session: ProjectSession, scene: Scene, metadata: PhotoshopProjectMetadata, payload: ProjectCommitPayload) {
    const sources = await this.collectBlobSources(scene, metadata, session, payload.blobSources);
    return session.repository!.commit({ scene, metadata, revision: payload.revision, preview: payload.preview, blobSources: sources });
  }

  private async migrateLegacy(session: ProjectSession, scene: Scene, metadata: PhotoshopProjectMetadata, payload: ProjectCommitPayload) {
    const temporaryRoot = await fs.mkdtemp(path.join(path.dirname(session.displayPath), `.yoiniwa-migrate-${process.pid}-`));
    try {
      const migratedMetadata = this.normalizeV4Metadata(await this.materializeLegacyMetadata(session, metadata, temporaryRoot));
      const migratedScene = this.prepareScene(scene, migratedMetadata, session.displayPath);
      const sources = await this.collectBlobSources(migratedScene, migratedMetadata, session, payload.blobSources, temporaryRoot);
      const targetPath = /\.yoi$/i.test(session.displayPath) ? session.displayPath
        : `${session.displayPath.slice(0, -'.refcanvas'.length)}.yoi`;
      if (session.format === 'legacy-refcanvas') {
        try {
          await fs.access(targetPath);
          throw new Error(`迁移目标已存在，请使用另存为：${targetPath}`);
        } catch (error: any) { if (error?.code !== 'ENOENT') throw error; }
      }
      const temporaryPath = `${targetPath}.${process.pid}.${randomUUID()}.create.tmp`;
      const lease = await this.acquireLease(targetPath);
      if (!lease) throw new Error('迁移目标已被其他实例打开，请另存为其他文件');
      try {
        await this.createProjectFile(temporaryPath, migratedScene, migratedMetadata, payload.revision, payload.preview, sources);
        await this.installMigratedProject(temporaryPath, targetPath, session.format === 'legacy-yoi');
        const opened = await YoiRepository.open(targetPath);
        await this.dependencies.registerV4Assets(migratedScene, opened.repository);
        const next = new ProjectSession(targetPath, 'v4', opened.repository, undefined, migratedMetadata, false, undefined, false,
          (value) => { void this.compactBackground(value); }, lease);
        const bytes = (await fs.stat(targetPath)).size;
        return { session: next, scene: migratedScene, metadata: migratedMetadata, result: {
          generation: opened.repository.generation, bytesAppended: bytes,
          endOffset: bytes, snapshot: opened.snapshot,
        } as YoiCommitResult };
      } catch (error) {
        await this.releaseLease(lease);
        await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
        throw error;
      }
    } finally { await fs.rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined); }
  }

  private async materializeLegacyMetadata(session: ProjectSession, metadata: PhotoshopProjectMetadata, temporaryRoot: string) {
    const versions: PhotoshopVersionRecord[] = [];
    const sources = new Map<string, string>();
    for (const version of metadata.versions) {
      if (version.blobId) { versions.push(version); continue; }
      const blobId = version.sha256;
      let sourcePath = sources.get(blobId);
      if (!sourcePath) {
        sourcePath = path.join(temporaryRoot, `${blobId}.${version.format}`);
        await this.dependencies.legacyReader.extractVersion(session.legacyPath!, version, sourcePath);
        sources.set(blobId, sourcePath);
      }
      versions.push({ ...version, blobId });
    }
    return { versions };
  }

  private async collectBlobSources(
    scene: Scene,
    metadata: PhotoshopProjectMetadata,
    sourceSession?: ProjectSession,
    extraSources: readonly YoiBlobSource[] = [],
    temporaryRoot?: string,
  ) {
    const sources = new Map<string, YoiBlobSource>();
    for (const record of Object.values(scene.assets ?? {})) {
      if (sourceSession?.repository?.snapshot.blobs[record.id]) {
        sources.set(record.id, sourceSession.repository.blobSource(record.id));
        continue;
      }
      const sourcePath = await this.dependencies.ensureAssetFile(record.id);
      sources.set(record.id, { id: record.id, sourcePath, byteLength: record.byteLength, kind: 'asset', mimeType: record.mimeType });
    }
    for (const source of extraSources) sources.set(source.id, source);
    for (const version of metadata.versions) {
      const blobId = version.blobId ?? version.sha256;
      if (sources.has(blobId)) continue;
      if (sourceSession?.repository && sourceSession.repository.snapshot.blobs[blobId]) {
        sources.set(blobId, sourceSession.repository.blobSource(blobId));
        continue;
      }
      if (temporaryRoot && sourceSession?.legacyPath) {
        let sourcePath = path.join(temporaryRoot, `${blobId}.${version.format}`);
        try { await fs.access(sourcePath); } catch {
          const existing = (await fs.readdir(temporaryRoot)).find((name) => name.startsWith(`${blobId}.`));
          if (existing) sourcePath = path.join(temporaryRoot, existing);
          else if (version.archiveEntry) await this.dependencies.legacyReader.extractVersion(sourceSession.legacyPath, version, sourcePath);
          else continue;
        }
        sources.set(blobId, { id: blobId, sourcePath, byteLength: version.byteLength, kind: 'photoshop-version', mimeType: 'image/vnd.adobe.photoshop' });
      }
    }
    return [...sources.values()];
  }

  private prepareScene(scene: Scene, metadata: PhotoshopProjectMetadata, filePath: string): Scene {
    const available = { ...(scene.assets ?? {}) };
    metadata.versions.forEach((version) => { available[version.previewAssetId] = version.previewAsset; });
    const used = new Set<string>([
      ...(scene.items ?? []).flatMap((item) => item.assetId ? [item.assetId] : []),
      ...metadata.versions.map((version) => version.previewAssetId),
    ]);
    return {
      ...scene,
      version: 3,
      name: path.basename(filePath, path.extname(filePath)),
      savedAt: new Date().toISOString(),
      assets: Object.fromEntries(Object.entries(available).filter(([id]) => used.has(id))),
      items: scene.items.map(({ dataUrl: _dataUrl, ...item }) => item),
    } as Scene;
  }

  private resultFromCommit(session: ProjectSession, scene: Scene, metadata: PhotoshopProjectMetadata, result: YoiCommitResult, scheduled: boolean): ProjectCommitResponse {
    return {
      canceled: false, path: session.displayPath, sessionId: session.sessionId, scene, metadata,
      generation: result.generation, committedRevision: result.snapshot.revision,
      bytesAppended: result.bytesAppended, compactionScheduled: scheduled, recovered: session.recovered,
    };
  }

  private async maybeScheduleCompaction(session: ProjectSession) {
    if (!session.repository) return false;
    const stats = await session.repository.stats();
    const compactedAt = session.repository.snapshot.compactedAtGeneration ?? 0;
    const byBytes = stats.staleBytes >= 512 * 1024 * 1024 && stats.staleRatio >= 0.25;
    const byCommits = session.generation - compactedAt >= 200;
    if (byBytes || byCommits) { session.scheduleCompaction(); return true; }
    return false;
  }

  private async compactBackground(session: ProjectSession, explicit = false): Promise<ProjectCompactResponse> {
    if (!session.repository || session.readOnly || this.current !== session) return { skipped: true } as const;
    if (!session.beginCompaction()) return { skipped: true, message: '工程整理正在进行' } as const;
    let candidate;
    try {
      candidate = await session.repository.prepareCompaction();
      return await session.queue<ProjectCompactResponse>(async (): Promise<ProjectCompactResponse> => {
        if (this.current !== session) throw new Error('画板会话已切换');
        try { return await session.repository!.activateCompaction(candidate); }
        catch (error) { await fs.rm(candidate.temporaryPath, { force: true }).catch(() => undefined); if (explicit) throw error; return { skipped: true, message: String(error) } as const; }
      });
    } catch (error) {
      await fs.rm(candidate?.temporaryPath, { force: true }).catch(() => undefined);
      if (explicit) throw error;
      return { skipped: true, message: String(error) } as const;
    } finally {
      session.endCompaction();
    }
  }

  private requireSession(sessionId?: string) {
    if (!this.current || (sessionId && sessionId !== this.current.sessionId)) throw new Error('没有有效的工程会话');
    return this.current;
  }

  private async closeCurrent() {
    const session = this.current;
    this.current = undefined;
    if (session) {
      await session.queue(async () => undefined);
      await session.close();
    }
  }

  private normalizeV4Metadata(value: PhotoshopProjectMetadata | undefined) {
    const metadata = normalizePhotoshopProjectMetadata(value);
    return {
      versions: metadata.versions.map((version) => ({
        ...version,
        blobId: version.blobId ?? version.sha256,
        archiveEntry: undefined,
      })),
    } as PhotoshopProjectMetadata;
  }

  private async findV4Candidates(filePath: string) {
    const paths = [filePath, `${filePath}.bak`, `${filePath}.compact.tmp`];
    const values: Array<{ filePath: string; generation: number; mtimeMs: number }> = [];
    for (const candidatePath of paths) {
      if (!await isYoiStorageV4(candidatePath)) continue;
      try {
        const opened = await YoiRepository.open(candidatePath);
        values.push({ filePath: candidatePath, generation: opened.repository.generation, mtimeMs: (await fs.stat(candidatePath)).mtimeMs });
      } catch { /* Invalid candidates are ignored in favour of the last valid commit. */ }
    }
    return values.sort((a, b) => b.generation - a.generation || b.mtimeMs - a.mtimeMs);
  }

  private async acquireLease(filePath: string): Promise<WriteLease | undefined> {
    const lockPath = `${filePath}.lock`;
    const token = randomUUID();
    try {
      await fs.writeFile(lockPath, JSON.stringify({ pid: process.pid, token, openedAt: new Date().toISOString() }), { flag: 'wx' });
      await hideWindowsLockFile(lockPath);
      return { path: lockPath, token };
    } catch (error: any) {
      if (error?.code !== 'EEXIST') throw error;
      try {
        const value = JSON.parse(await fs.readFile(lockPath, 'utf8')) as { pid?: number };
        if (value.pid && value.pid !== process.pid) {
          try { process.kill(value.pid, 0); return undefined; } catch (probe: any) {
            if (probe?.code !== 'ESRCH') return undefined;
          }
        }
        await fs.rm(lockPath, { force: true });
        await fs.writeFile(lockPath, JSON.stringify({ pid: process.pid, token, openedAt: new Date().toISOString() }), { flag: 'wx' });
        await hideWindowsLockFile(lockPath);
        return { path: lockPath, token };
      } catch { return undefined; }
    }
  }

  private async releaseLease(lease: WriteLease) {
    try {
      const value = JSON.parse(await fs.readFile(lease.path, 'utf8')) as { token?: string };
      if (value.token === lease.token) await fs.rm(lease.path, { force: true });
    } catch { /* Another process owns the replacement lease. */ }
  }

  private async createProjectFile(filePath: string, scene: Scene, metadata: PhotoshopProjectMetadata, revision: number | undefined, preview: Buffer | undefined, sources: readonly YoiBlobSource[]) {
    await YoiRepository.create(filePath, { scene, metadata, revision, preview, blobSources: sources });
    await YoiRepository.open(filePath);
  }

  private async replaceProjectFile(temporaryPath: string, targetPath: string) {
    const backupPath = `${targetPath}.bak`;
    let hadOriginal = false;
    await fs.rm(backupPath, { force: true }).catch(() => undefined);
    try { await fs.rename(targetPath, backupPath); hadOriginal = true; } catch (error: any) { if (error?.code !== 'ENOENT') throw error; }
    try {
      await fs.rename(temporaryPath, targetPath);
    } catch (error) {
      if (hadOriginal) await fs.rename(backupPath, targetPath).catch(() => undefined);
      await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
    if (hadOriginal) await fs.rm(backupPath, { force: true }).catch(() => undefined);
  }

  private async installMigratedProject(temporaryPath: string, targetPath: string, keepLegacyBackup: boolean) {
    if (keepLegacyBackup) {
      const backupPath = `${targetPath.slice(0, -'.yoi'.length)}.legacy.yoi`;
      try { await fs.access(backupPath); throw new Error(`迁移备份已存在：${backupPath}`); } catch (error: any) { if (error?.code !== 'ENOENT') throw error; }
      await fs.rename(targetPath, backupPath);
      try { await fs.rename(temporaryPath, targetPath); }
      catch (error) { await fs.rename(backupPath, targetPath).catch(() => undefined); throw error; }
      return;
    }
    await this.replaceProjectFile(temporaryPath, targetPath);
  }
}

export interface ProjectStorageStatsResponse extends YoiStorageStats {
  readOnly?: boolean;
  recovered?: boolean;
  recoverySource?: string;
}
