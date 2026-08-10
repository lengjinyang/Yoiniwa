# Group Header Auto-Hide Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make each canvas group title bar visible while the pointer is inside that group's visible bounds and hide it 140 ms after the pointer leaves.

**Architecture:** Keep the behavior in `CanvasBoard.tsx`, using the existing world-coordinate pointer conversion and `groupIndex` for candidate lookup. Add a small pure helper in `src/scene.ts` that chooses the topmost eligible group from queried candidates; `CanvasBoard` owns one hovered-group state and one hide timer. `GroupFrame` and `GroupCompactHeader` receive a visibility flag, while the group frame and its selection/drag hit area remain interactive.

**Tech Stack:** React 19 hooks, TypeScript 7, Konva/react-konva, Vitest 4.

## Global Constraints

- Do not read or use the `res` directory.
- Do not run `npm run smoke:real-images`.
- Do not generate an installer or run `npm run dist`.
- Use the existing `groupVisibleBounds()` behavior for expanded and collapsed groups.
- Preserve `.refcanvas` version 2 compatibility; add no scene fields.
- Preserve group selection, dragging, nesting, collapsed groups, pointer events, and the existing App-level floating group toolbar behavior.
- Avoid writing complete scene history on pointer-move paths.
- Finish with `npm test -- --run`, `npm run build`, `npm run smoke:dev`, and finally `npm run dev:test`; leave the test desktop app open.

---

### Task 1: Add deterministic group hover hit testing

**Files:**
- Modify: `src/scene.ts` near `groupVisibleBounds()`
- Test: `src/scene.test.ts`

**Interfaces:**
- Consumes: `ImageGroup`, `Bounds`, the pointer world point, the candidate group IDs returned by `SpatialIndex`, and a set of hidden group IDs.
- Produces: `topmostVisibleGroupAtPoint(groups, candidateIds, hiddenGroupIds, point): string | undefined`, which returns the last eligible group in scene render order whose `groupVisibleBounds()` contains the point.

- [ ] **Step 1: Write failing tests for expanded and collapsed bounds**

Add tests in `src/scene.test.ts` that construct minimal `ImageGroup` values and assert:

```ts
expect(topmostVisibleGroupAtPoint(
  [expandedGroup],
  [expandedGroup.id],
  new Set(),
  { x: 40, y: 40 },
)).toBe(expandedGroup.id);

expect(topmostVisibleGroupAtPoint(
  [collapsedGroup],
  [collapsedGroup.id],
  new Set(),
  { x: collapsedGroup.x + 10, y: collapsedGroup.y + GROUP_TITLE_HEIGHT / 2 },
)).toBe(collapsedGroup.id);

expect(topmostVisibleGroupAtPoint(
  [collapsedGroup],
  [collapsedGroup.id],
  new Set(),
  { x: collapsedGroup.x + 10, y: collapsedGroup.y + GROUP_TITLE_HEIGHT + 1 },
)).toBeUndefined();
```

Use the existing test factory/style for group objects; do not add image fixtures or assets.

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `npx vitest run src/scene.test.ts`
Expected: FAIL because `topmostVisibleGroupAtPoint` is not defined/exported yet.

- [ ] **Step 3: Add overlap, ordering, and hidden-group tests**

Add assertions covering the behavior needed by the canvas:

```ts
expect(topmostVisibleGroupAtPoint(
  [backGroup, frontGroup],
  [backGroup.id, frontGroup.id],
  new Set(),
  { x: 50, y: 50 },
)).toBe(frontGroup.id);

expect(topmostVisibleGroupAtPoint(
  [backGroup, frontGroup],
  [backGroup.id, frontGroup.id],
  new Set([frontGroup.id]),
  { x: 50, y: 50 },
)).toBe(backGroup.id);
```

Also assert that candidate IDs not present in the group list and points outside all bounds return `undefined`.

- [ ] **Step 4: Implement the pure helper**

In `src/scene.ts`, export a helper with this exact shape:

```ts
export function topmostVisibleGroupAtPoint(
  groups: ImageGroup[],
  candidateIds: string[],
  hiddenGroupIds: ReadonlySet<string>,
  point: { x: number; y: number },
): string | undefined
```

Build a candidate ID set, iterate `groups` from the final element to the first, skip hidden or non-candidate groups, calculate `groupVisibleBounds(group)`, and return the first group whose inclusive bounds contain `point.x` and `point.y`. Return `undefined` when no group matches.

- [ ] **Step 5: Run the focused test and verify it passes**

Run: `npx vitest run src/scene.test.ts`
Expected: PASS, including all existing scene tests.

---

### Task 2: Wire hover state and title visibility into CanvasBoard

**Files:**
- Modify: `src/CanvasBoard.tsx` around `GroupCompactHeader`, `GroupFrame`, hover refs/state, pointer handlers, and group render calls

**Interfaces:**
- Consumes: `topmostVisibleGroupAtPoint()`, `groupIndex`, `groupVisibility.hiddenGroups`, `renderedGroupIds`, `groupVisibleBounds()`, and the existing Stage pointer events.
- Produces: a single `hoveredGroupId?: string` render state and a 140 ms delayed hide behavior for canvas title bars only.

- [ ] **Step 1: Add state and timer cleanup**

Add `hoveredGroupId` state and `groupHeaderHideTimerRef`. Add local helpers that cancel the timer, show a group immediately, and schedule clearing after `140` ms. Clear the timer on component unmount and clear the hover state if the current group is no longer in `props.scene.groups` or is in `groupVisibility.hiddenGroups`.

- [ ] **Step 2: Add a pointer-position updater independent of gestures**

Create a helper that receives the Konva pointer event, obtains the stage pointer position, converts it using `props.scene.viewport`, queries `groupIndex`, filters to currently rendered and non-hidden groups, calls:

```ts
topmostVisibleGroupAtPoint(
  props.scene.groups,
  groupIndex.query(renderBounds),
  groupVisibility.hiddenGroups,
  worldPoint,
)
```

On a matching ID, show it immediately. On no match, schedule the 140 ms hide. Do not invoke this hover calculation from touch events; retain touch behavior for selection, panning, annotation, and erasing.

- [ ] **Step 3: Integrate with Stage mouse events without breaking gestures**

Call the updater at the beginning of `onPointerMove` for mouse events, before the existing `if (!gesture.current) return` guard. Keep all existing gesture branches unchanged. Add `onMouseLeave` to schedule the same delayed hide. Do not add a title-only listener that would stop the group frame from receiving clicks or drags.

- [ ] **Step 4: Pass visibility into both group header renderers**

Extend `GroupCompactHeader` and `GroupFrame` props with `headerVisible: boolean`.

In `GroupCompactHeader`, keep the existing scale/collapsed guard, and additionally return `null` when `headerVisible` is false.

In `GroupFrame`, keep the outer frame and drag/select group active. Wrap the title bar Rect, title Text, divider, and action buttons in a Konva group with `visible={headerVisible}`. Ensure the outer outline and frame hit area remain outside that hidden group, so hidden headers do not disable selection or dragging.

Pass `group.id === hoveredGroupId` at both render call sites. Keep the existing `scale >= COMPACT_GROUP_HEADER_SCALE || group.collapsed` visibility rule for the standard header; `headerVisible` is an additional condition, not a replacement for scale/collapsed behavior.

- [ ] **Step 5: Run typecheck and focused tests**

Run: `npx vitest run src/scene.test.ts && npm run build`
Expected: PASS with no TypeScript errors. The existing Vite bundle-size warning is acceptable.

---

### Task 3: Verify desktop behavior and regression coverage

**Files:**
- Modify: `electron/main.js` only if the existing `smoke:dev` assertion needs a narrowly scoped title-bar assertion
- Test: `src/scene.test.ts` remains the pure hit-testing regression suite

**Interfaces:**
- Consumes: the implemented `hoveredGroupId` state, title visibility props, existing dev smoke fixture and group interaction selectors.
- Produces: verified mouse-inside display and mouse-out delayed hiding without changing scene persistence.

- [ ] **Step 1: Run the full unit suite**

Run: `npm test -- --run`
Expected: all existing tests plus the new scene hit-testing tests pass.

- [ ] **Step 2: Run the production build**

Run: `npm run build`
Expected: TypeScript check and Vite production build pass; only the known large-bundle warning may appear.

- [ ] **Step 3: Run the generated-image desktop smoke test**

Run: `npm run smoke:dev`
Expected: the existing smoke completes successfully using runtime-generated lightweight PNG assets. If a selector/assertion is added, it must verify only the canvas group title behavior: pointer inside a group shows its title; moving outside and waiting longer than 140 ms hides it. Do not use `res` assets.

- [ ] **Step 4: Start the clean test desktop app last**

Run: `npm run dev:test`
Expected: Vite starts at `http://localhost:5173`, Electron opens the clean test session, and the window remains open for manual inspection. Do not run `npm run dist` or `npm run smoke:real-images`.

- [ ] **Step 5: Report verification results and residual warnings**

Record unit-test count, build result, smoke result, and the known Konva layer/bundle warnings. If desktop smoke cannot interact with a hidden Konva node, report that limitation and rely on the pure helper tests plus visible screenshot/manual verification rather than weakening pointer-event behavior.
