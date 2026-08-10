import type { ProjectCommitRequest, ProjectCommitResult } from '../types';

interface ProjectSaveApi {
  chooseProjectSavePath(suggestedName: string): Promise<{ canceled: boolean; token?: string }>;
  saveProjectAs(request: ProjectCommitRequest, pathToken: string): Promise<ProjectCommitResult>;
  commitProject(request: ProjectCommitRequest): Promise<ProjectCommitResult>;
}

interface ProjectSaveFlowOptions {
  api: ProjectSaveApi;
  useSaveAs: boolean;
  suggestedName: string;
  createRequest(): Promise<ProjectCommitRequest>;
}

export async function runProjectSaveFlow({
  api,
  useSaveAs,
  suggestedName,
  createRequest,
}: ProjectSaveFlowOptions): Promise<ProjectCommitResult> {
  if (!useSaveAs) return api.commitProject(await createRequest());
  const choice = await api.chooseProjectSavePath(suggestedName);
  if (choice.canceled || !choice.token) return { canceled: true };
  return api.saveProjectAs(await createRequest(), choice.token);
}
