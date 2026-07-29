export interface DirtyRevisionState {
  latestRevision: number;
  savedRevision: number;
  dirty: boolean;
}

export function createDirtyRevisionState(revision = 0): DirtyRevisionState {
  return { latestRevision: revision, savedRevision: revision, dirty: false };
}

export function updateDirtyRevision(
  state: DirtyRevisionState,
  dirty: boolean,
  revision?: number,
): DirtyRevisionState {
  const latestRevision = revision === undefined
    ? state.latestRevision
    : Math.max(state.latestRevision, revision);
  return {
    latestRevision,
    savedRevision: state.savedRevision,
    dirty: dirty || latestRevision !== state.savedRevision,
  };
}

export function markRevisionSaved(state: DirtyRevisionState, revision?: number): DirtyRevisionState {
  const savedRevision = revision ?? state.latestRevision;
  const latestRevision = Math.max(state.latestRevision, savedRevision);
  return { latestRevision, savedRevision, dirty: latestRevision !== savedRevision };
}

