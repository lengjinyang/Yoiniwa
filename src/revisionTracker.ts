export interface RevisionTracker {
  current(): number;
  advance(): number;
  matches(revision: number | undefined): boolean;
}

export function createRevisionTracker(initial = 0): RevisionTracker {
  let revision = initial;
  return {
    current: () => revision,
    advance: () => {
      revision += 1;
      return revision;
    },
    matches: (savedRevision) => savedRevision === undefined || savedRevision === revision,
  };
}
