import { useCallback, useEffect, useRef, useState } from 'react';
import type { BjdJointId, PoseDocumentV1 } from '../../domain/sceneTypes';
import type { PosePivotDebugAxis, PosePivotDebugState, PoseRuntime, PoseSelection } from '../runtime/PoseRuntime';
import { blendPosePreset, parsePosePresetPack, type PosePresetPackV1, type PosePresetV1 } from '../domain/posePresets';

const CORE_PRESETS: ReadonlyArray<{ id: PosePresetV1['id']; label: string }> = [
  { id: 'natural-standing', label: 'Standing' },
  { id: 'sit', label: 'Sitting' },
  { id: 'squat', label: 'Crouching' },
  { id: 'run', label: 'Running' },
  { id: 'jump', label: 'Jumping' },
  { id: 'weight-shift', label: 'Combat Ready' },
];

const PIVOT_DEBUG_JOINTS: ReadonlyArray<{ id: BjdJointId; label: string }> = [
  { id: 'spineUpper', label: 'Chest / 胸部' },
  { id: 'shoulderL', label: 'Shoulder L / 左肩' }, { id: 'shoulderR', label: 'Shoulder R / 右肩' },
  { id: 'elbowUpperL', label: 'Elbow L / 左肘' }, { id: 'elbowUpperR', label: 'Elbow R / 右肘' },
  { id: 'hipL', label: 'Hip L / 左髋' }, { id: 'hipR', label: 'Hip R / 右髋' },
  { id: 'kneeUpperL', label: 'Knee L / 左膝' }, { id: 'kneeUpperR', label: 'Knee R / 右膝' },
];

function millimeters(value?: number): string { return value === undefined ? '—' : `${(value * 1000).toFixed(2)} mm`; }
function point(value?: { x: number; y: number; z: number }): string {
  return value ? `(${value.x.toFixed(5)}, ${value.y.toFixed(5)}, ${value.z.toFixed(5)})` : '—';
}

function selectionLabel(selection?: PoseSelection): string | undefined {
  if (!selection?.branch) return undefined;
  if (selection.branch === 'cog') return '重心 / COG';
  if (selection.branch === 'head') return '头部';
  if (selection.branch === 'chest') return '胸部';
  if (selection.branch === 'waist') return '腰部';
  if (selection.branch === 'pelvis') return '骨盆';
  const side = selection.branch.endsWith('L') ? '左' : '右';
  if (selection.jointId?.startsWith('shoulder')) return `${side}肩`;
  if (selection.jointId?.startsWith('elbow')) return `${side}肘`;
  if (selection.jointId?.startsWith('knee')) return `${side}膝`;
  return selection.branch.startsWith('hand') ? `${side}手腕` : `${side}脚踝`;
}

function selectionHint(selection?: PoseSelection): string {
  if (!selection?.branch) return '拖动控制点摆姿势；拖空白处旋转视角';
  if (selection.branch === 'cog') return '向下拖动下蹲，向上拖动站起；左右或前后移动重心';
  if (selection.branch.startsWith('hand')) return selection.jointId?.startsWith('elbow')
    ? '拖动肘部改变手臂弯曲方向，手腕目标保持不变'
    : selection.jointId?.startsWith('shoulder') ? '选中肩部后拖动圆环，微调肩部朝向'
    : '拖圆点移动整条手臂；拖前方菱形点调整手掌朝向，Alt 拖微调拧腕';
  if (selection.branch.startsWith('foot')) return selection.jointId?.startsWith('knee')
    ? '拖动膝盖改变腿部弯曲方向，脚踝目标保持不变'
    : '拖圆点移动整条腿；拖前方菱形点调整脚尖方向，Alt 拖微调脚掌翻转';
  if (selection.branch === 'chest') return '拖动胸部调整上半身倾斜、侧弯和扭转';
  if (selection.branch === 'waist') return '拖动腰部形成平滑脊柱曲线；胸部再做上半身精修';
  if (selection.branch === 'pelvis') return '拖动骨盆调整胯部局部姿态；圆环做旋转微调';
  return '拖动头部调整方向，颈部会自然跟随';
}

export function PoseStudio({ initial, isNew, readOnly, submitting, onCancel, onApply }: {
  initial: PoseDocumentV1; isNew: boolean; readOnly: boolean; submitting: boolean;
  onCancel(): void; onApply(document: PoseDocumentV1, png: Blob): Promise<void>;
}) {
  const [document, setDocument] = useState(() => structuredClone(initial));
  const [runtime, setRuntime] = useState<PoseRuntime>();
  const [presetPack, setPresetPack] = useState<PosePresetPackV1>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [selection, setSelection] = useState<PoseSelection>();
  const [hoverMessage, setHoverMessage] = useState<string>();
  const [previewing, setPreviewing] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [pivotDebugOpen, setPivotDebugOpen] = useState(false);
  const [pivotDebugJoint, setPivotDebugJoint] = useState<BjdJointId>('spineUpper');
  const [pivotDebugAxis, setPivotDebugAxis] = useState<PosePivotDebugAxis>('x');
  const [pivotDebugState, setPivotDebugState] = useState<PosePivotDebugState>();
  const [manipulatorMode, setManipulatorMode] = useState<'move' | 'rotate'>('move');
  const [handMode, setHandMode] = useState(false);
  const [toePose, setToePose] = useState({ curl: 0, spread: 0, bigToe: 0 });
  const [sideMiniView, setSideMiniView] = useState(false);
  const [selectedPresetId, setSelectedPresetId] = useState<PosePresetV1['id']>();
  const [presetBlend, setPresetBlend] = useState(1);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const documentRef = useRef(document); documentRef.current = document;
  const pastRef = useRef<PoseDocumentV1[]>([]);
  const futureRef = useRef<PoseDocumentV1[]>([]);
  const interactionStartRef = useRef<PoseDocumentV1 | undefined>(undefined);
  const presetBaseRef = useRef<PoseDocumentV1 | undefined>(undefined);
  const cleanJsonRef = useRef(JSON.stringify(initial));
  const dirty = JSON.stringify(document) !== cleanJsonRef.current;
  const leftFootLocked = Boolean(document.ikState?.legL?.pinned);
  const rightFootLocked = Boolean(document.ikState?.legR?.pinned);
  const bothFeetLocked = leftFootLocked && rightFootLocked;
  const hasFootLocks = leftFootLocked || rightFootLocked;
  const currentSelectionLabel = selectionLabel(selection);
  const selectedFootLocked = selection?.branch === 'footL' ? leftFootLocked : selection?.branch === 'footR' ? rightFootLocked : false;
  const selectedHand = selection?.jointId?.startsWith('wrist')
    ? selection.branch === 'handL' ? 'L' : selection.branch === 'handR' ? 'R' : undefined : undefined;
  const selectedFoot = selection?.jointId?.startsWith('ankle')
    ? selection.branch === 'footL' ? 'L' : selection.branch === 'footR' ? 'R' : undefined : undefined;
  const selectedBranchLocked = Boolean(selection?.locked);
  const selectedLimb = selection?.branch?.startsWith('hand') || selection?.branch?.startsWith('foot');

  const updateDocument = (updater: (current: PoseDocumentV1) => PoseDocumentV1) => {
    setDocument((current) => {
      if (readOnly) return current;
      const next = updater(current);
      if (JSON.stringify(next) === JSON.stringify(current)) return current;
      pastRef.current.push(structuredClone(current));
      if (pastRef.current.length > 100) pastRef.current.shift();
      futureRef.current = [];
      return next;
    });
  };
  const undo = useCallback(() => {
    if (readOnly) return;
    setSelectedPresetId(undefined);
    setDocument((current) => {
      const previous = pastRef.current.pop(); if (!previous) return current;
      futureRef.current.push(structuredClone(current)); return previous;
    });
  }, [readOnly]);
  const redo = useCallback(() => {
    if (readOnly) return;
    setSelectedPresetId(undefined);
    setDocument((current) => {
      const next = futureRef.current.pop(); if (!next) return current;
      pastRef.current.push(structuredClone(current)); return next;
    });
  }, [readOnly]);

  useEffect(() => {
    const canvas = canvasRef.current; if (!canvas) return;
    let current: PoseRuntime | undefined; let canceled = false;
    setLoading(true); setError(undefined);
    void import('../runtime/PoseRuntime').then(({ createPoseRuntime }) => createPoseRuntime(canvas, documentRef.current, {
      editable: !readOnly, centerOnLoad: isNew,
      onInitialDocument: (next) => { documentRef.current = next; cleanJsonRef.current = JSON.stringify(next); setDocument(next); },
      onDocumentChange: (next) => { documentRef.current = next; setDocument(next); },
      onSelectionChange: setSelection,
      onHoverChange: setHoverMessage,
      onSideMiniViewChange: setSideMiniView,
      onPivotDebugChange: (next) => { setPivotDebugState(next); setPivotDebugOpen(next.enabled); setPivotDebugJoint(next.jointId); setPivotDebugAxis(next.axis); },
      onInteractionStart: () => { interactionStartRef.current = structuredClone(documentRef.current); },
      onInteractionEnd: () => {
        const start = interactionStartRef.current; interactionStartRef.current = undefined;
        if (!start || JSON.stringify(start) === JSON.stringify(documentRef.current) || readOnly) return;
        pastRef.current.push(start); if (pastRef.current.length > 100) pastRef.current.shift(); futureRef.current = [];
      },
    })).then((value) => {
      if (canceled) { value.dispose(); return; }
      current = value; setRuntime(value); setLoading(false);
    }).catch((reason: unknown) => {
      if (!canceled) { setError(reason instanceof Error ? reason.message : String(reason)); setLoading(false); }
    });
    return () => { canceled = true; current?.dispose(); setRuntime(undefined); };
  }, [attempt, isNew, readOnly, initial]);

  useEffect(() => {
    let canceled = false;
    void fetch('/pose/chambersu-bjd-female-v1/pose-presets-v1.json', { cache: 'no-cache' })
      .then((response) => { if (!response.ok) throw new Error('姿势预设资产缺失'); return response.json(); })
      .then(parsePosePresetPack).then((pack) => { if (!canceled) setPresetPack(pack); })
      .catch(() => { if (!canceled) setPresetPack(undefined); });
    return () => { canceled = true; };
  }, [attempt]);
  useEffect(() => runtime?.setDocument(document), [document, runtime]);
  useEffect(() => runtime?.setPreviewMode(previewing), [previewing, runtime]);
  useEffect(() => runtime?.setManipulatorMode(manipulatorMode), [manipulatorMode, runtime]);
  useEffect(() => runtime?.setHandMode(handMode), [handMode, runtime]);
  useEffect(() => { if (!selectedHand) setHandMode(false); }, [selectedHand]);
  useEffect(() => runtime?.setPivotDebugMode(pivotDebugOpen), [pivotDebugOpen, runtime]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      event.stopPropagation();
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault(); if (event.shiftKey) redo(); else undo(); return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') {
        event.preventDefault(); redo(); return;
      }
      if (event.key === 'Escape') { event.preventDefault(); runtime?.cancelInteraction(); }
    };
    window.addEventListener('keydown', onKey, true); return () => window.removeEventListener('keydown', onKey, true);
  }, [redo, runtime, readOnly, undo]);

  const cancel = () => { if (!dirty || window.confirm('放弃未应用的姿势更改？')) onCancel(); };
  const apply = async () => {
    if (!runtime || readOnly || submitting) return;
    try { setError(undefined); await onApply(document, await runtime.renderPng(document)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };
  const choosePreset = (id: PosePresetV1['id']) => {
    const preset = presetPack?.presets.find((value) => value.id === id); if (!preset || readOnly || hasFootLocks) return;
    const base = structuredClone(document); presetBaseRef.current = base; setSelectedPresetId(id); setPresetBlend(1);
    updateDocument(() => blendPosePreset(base, preset, 1));
  };
  const blendPreset = (amount: number) => {
    const preset = presetPack?.presets.find((value) => value.id === selectedPresetId); const base = presetBaseRef.current;
    if (!preset || !base || readOnly || hasFootLocks) return;
    const value = Math.max(0, Math.min(1, amount)); setPresetBlend(value); updateDocument(() => blendPosePreset(base, preset, value));
  };
  const updatePad = (element: HTMLElement, clientX: number, clientY: number) => {
    const bounds = element.getBoundingClientRect(); return {
      x: Math.max(-1, Math.min(1, (clientX - bounds.left) / Math.max(1, bounds.width) * 2 - 1)),
      y: Math.max(-1, Math.min(1, (clientY - bounds.top) / Math.max(1, bounds.height) * 2 - 1)),
    };
  };
  const updateToeGroup = (element: HTMLElement, clientX: number, clientY: number) => {
    const point = updatePad(element, clientX, clientY); const next = { ...toePose, curl: point.y, spread: point.x };
    setToePose(next); runtime?.setToePose(next.curl, next.spread, next.bigToe);
  };
  const updateBigToe = (bigToe: number) => { const next = { ...toePose, bigToe }; setToePose(next); runtime?.setToePose(next.curl, next.spread, next.bigToe); };
  const choosePivotDebugJoint = (jointId: BjdJointId) => {
    setPivotDebugJoint(jointId); runtime?.setPivotDebugJoint(jointId);
  };
  const choosePivotDebugAxis = (axis: PosePivotDebugAxis) => { setPivotDebugAxis(axis); runtime?.setPivotDebugRotation(axis, pivotDebugState?.angle ?? 0); };
  const choosePivotDebugAngle = (angle: number) => runtime?.setPivotDebugRotation(pivotDebugAxis, angle);
  const resetLimb = () => { if (!selection?.branch || selection.branch === 'cog' || selection.locked) return; runtime?.resetSelectedLimb(); };
  const hasLegacyLocks = Object.values(document.lockedBranches ?? {}).some(Boolean);

  return <section className={`pose-studio${previewing ? ' previewing' : ''}${toolsOpen ? ' tools-open' : ''}`} role="dialog" aria-modal="true" aria-label="3D Pose Studio 人体动作参考">
    <header className="pose-studio-toolbar">
      <div className="pose-studio-brand"><strong>3D Pose Studio</strong><small>人体动作参考</small></div>
      <span className="pose-studio-status">{readOnly ? '只读预览' : dirty ? '有未应用更改' : '拖动身体开始摆姿势'}</span>
      <div className="pose-toolbar-actions">
        <button type="button" className={toolsOpen ? 'active' : ''} onClick={() => setToolsOpen((value) => !value)}>{toolsOpen ? '收起工具' : '工具'}</button>
        <button type="button" onClick={undo} disabled={readOnly || pastRef.current.length === 0} title="Ctrl+Z">Undo</button>
        <button type="button" onClick={redo} disabled={readOnly || futureRef.current.length === 0} title="Ctrl+Y">Redo</button>
        <button type="button" className={manipulatorMode === 'move' ? 'active' : ''} disabled={readOnly} onClick={() => setManipulatorMode('move')}>拖动</button>
        <button type="button" className={manipulatorMode === 'rotate' ? 'active' : ''} disabled={readOnly} onClick={() => setManipulatorMode('rotate')}>旋转</button>
        <button type="button" disabled={!selection?.branch || readOnly} onClick={() => runtime?.toggleSelectedLock()}>{selectedBranchLocked ? '解锁部位' : '锁定部位'}</button>
        <button type="button" disabled={!selection?.jointId || selection.locked || readOnly} onClick={() => runtime?.resetSelectedJoint()}>重置关节</button>
        <button type="button" onClick={() => runtime?.resetWholePose()} disabled={readOnly} title="Reset Pose">重置姿势</button>
        <button type="button" className={previewing ? 'active' : ''} onClick={() => setPreviewing((value) => !value)}>{previewing ? '返回编辑' : '预览'}</button>
        <button type="button" onClick={cancel} disabled={submitting}>取消</button>
        <button type="button" className="primary" onClick={() => { void apply(); }} disabled={!runtime || readOnly || submitting}>{submitting ? '正在生成…' : '应用到画布'}</button>
      </div>
    </header>

    <aside className="pose-studio-quickbar">
      <section className="pose-studio-intro">
        <strong>用身体摆 Pose</strong>
        <p>先调重心，再拖手脚。肘膝只负责改变弯曲方向。</p>
      </section>
      <section className="pose-quick-section pose-pivot-debug-section">
        <h2>Pivot Debug</h2>
        <button type="button" className={pivotDebugOpen ? 'active' : ''} disabled={!runtime}
          onClick={() => setPivotDebugOpen((value) => !value)}>{pivotDebugOpen ? '关闭 Pivot Debug' : '打开 Pivot Debug'}</button>
        {pivotDebugOpen && <>
          <label className="pose-range-control"><span>检查关节</span>
            <select value={pivotDebugJoint} disabled={!runtime} onChange={(event) => choosePivotDebugJoint(event.currentTarget.value as BjdJointId)}>
              {PIVOT_DEBUG_JOINTS.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}
            </select>
          </label>
          <div className="pose-segmented">
            {(['x', 'y', 'z'] as PosePivotDebugAxis[]).map((axis) => <button type="button" key={axis} className={pivotDebugAxis === axis ? 'active' : ''}
              onClick={() => choosePivotDebugAxis(axis)}>{`${axis.toUpperCase()} 轴`}</button>)}
          </div>
          <div className="pose-segmented">
            <button type="button" onClick={() => choosePivotDebugAngle(-90)}>−90°</button>
            <button type="button" className={pivotDebugState?.angle === 0 ? 'active' : ''} onClick={() => choosePivotDebugAngle(0)}>0°</button>
            <button type="button" onClick={() => choosePivotDebugAngle(90)}>+90°</button>
          </div>
          <label className="pose-range-control"><span>单关节旋转 <output>{pivotDebugState?.angle ?? 0}°</output></span>
            <input type="range" min="-90" max="90" step="1" value={pivotDebugState?.angle ?? 0}
              onChange={(event) => choosePivotDebugAngle(Number(event.currentTarget.value))} />
          </label>
          <small>红点 Bone Origin · 蓝点 Runtime Pivot · 绿点 BJD 球体几何中心</small>
          {pivotDebugState && <small>
            Geometry Joint Center：{point(pivotDebugState.geometryJointCenter)}<br />
            Bone Origin：{point(pivotDebugState.boneOrigin)}<br />
            Runtime Pivot：{point(pivotDebugState.runtimePivot)}<br />
            Origin↔Pivot：{millimeters(pivotDebugState.originPivotDistance)}<br />
            球心↔Pivot：{pivotDebugState.geometryAvailable ? millimeters(pivotDebugState.geometryPivotDistance) : '无独立球体几何'}<br />
            球心漂移：{pivotDebugState.geometryAvailable ? millimeters(pivotDebugState.geometryDrift) : '无法测量'}
          </small>}
        </>}
      </section>
      <section className="pose-quick-section">
        <h2>快速姿势</h2>
        <div className="pose-preset-grid">
          {CORE_PRESETS.map(({ id, label }) => <button type="button" key={id} disabled={!presetPack || !runtime || readOnly || hasFootLocks}
            className={selectedPresetId === id ? 'active' : ''} onClick={() => choosePreset(id)}>{label}</button>)}
        </div>
        {!presetPack && <small>正在加载姿势预设…</small>}
        {hasFootLocks && <small>解锁脚后才能套用快速姿势。</small>}
        <label className="pose-range-control"><span>Blend Strength <output>{Math.round(presetBlend * 100)}%</output></span>
          <input type="range" min="0" max="1" step="0.01" value={presetBlend} disabled={!selectedPresetId || readOnly || hasFootLocks}
            onChange={(event) => blendPreset(Number(event.currentTarget.value))} />
        </label>
      </section>
      <section className="pose-quick-section pose-foot-locks">
        <h2>脚部锁定</h2>
        <button type="button" disabled={readOnly} onClick={() => runtime?.setFootLock('L', !leftFootLocked)}>{leftFootLocked ? '解锁左脚' : '锁定左脚'}</button>
        <button type="button" disabled={readOnly} onClick={() => runtime?.setFootLock('R', !rightFootLocked)}>{rightFootLocked ? '解锁右脚' : '锁定右脚'}</button>
        <button type="button" className={bothFeetLocked ? 'active' : ''} disabled={readOnly} onClick={() => runtime?.setBothFootLocks(!bothFeetLocked)}>{bothFeetLocked ? '解锁双脚' : '锁定双脚'}</button>
        <small>{bothFeetLocked ? '移动 COG 时双脚保持原位。' : '移动 COG 时系统会优先保持当前脚部接触；锁脚后更稳定。'}</small>
      </section>
      <section className="pose-quick-section pose-quick-actions">
        <h2>辅助</h2>
        <button type="button" disabled={readOnly || hasFootLocks || hasLegacyLocks} onClick={() => runtime?.mirrorPose()}>Mirror Pose</button>
        <button type="button" disabled={!selectedLimb || selectedBranchLocked || selectedFootLocked || readOnly} onClick={() => runtime?.mirrorSelectedLimb()}>镜像当前侧</button>
        <button type="button" disabled={!selectedLimb || selectedBranchLocked || selectedFootLocked || readOnly} onClick={() => runtime?.flipSelectedLimbs()}>交换左右</button>
        <button type="button" disabled={!selection?.branch || selection.branch === 'cog' || selection.locked || selectedFootLocked || readOnly} onClick={resetLimb}>Reset Limb</button>
      </section>
      <section className="pose-quick-section pose-camera-section">
        <h2>相机</h2>
        <div className="pose-segmented">
          <button type="button" className={document.camera.projection === 'perspective' ? 'active' : ''} onClick={() => runtime?.setProjection('perspective')}>透视</button>
          <button type="button" className={document.camera.projection === 'orthographic' ? 'active' : ''} onClick={() => runtime?.setProjection('orthographic')}>正交</button>
        </div>
        <label className="pose-range-control"><span>焦距 / FOV <output>{Math.round(document.camera.focalLengthMm)}mm</output></span>
          <input type="range" min="18" max="120" step="1" value={document.camera.focalLengthMm} disabled={readOnly}
            onChange={(event) => runtime?.setFocalLength(Number(event.currentTarget.value))} />
        </label>
        <div className="pose-segmented">
          <button type="button" onClick={() => runtime?.setCameraView('low')}>低角度</button>
          <button type="button" onClick={() => runtime?.setCameraView('high')}>高角度</button>
          <button type="button" disabled={readOnly} onClick={() => runtime?.centerPerson()}>居中人物</button>
        </div>
      </section>
      <small className="pose-studio-shortcuts">拖空白旋转视角 · 滚轮缩放 · ESC 取消当前拖动</small>
    </aside>

    <main className="pose-studio-viewport">
      <canvas ref={canvasRef} />
      {sideMiniView && !previewing && <div className="pose-side-mini-label">Side Mini View · 深度辅助</div>}
      {handMode && selectedHand && !previewing && <div className="pose-hand-mini-label">Hand Detail · 拖动 5 个指尖点</div>}
      {!previewing && selectedHand && <section className="pose-end-controls pose-hand-controls" aria-label={`${selectedHand === 'L' ? '左' : '右'}手控制`}>
        <header><strong>{selectedHand === 'L' ? '左' : '右'}手</strong><button type="button" className={handMode ? 'active' : ''} disabled={readOnly}
          onClick={() => setHandMode((value) => !value)}>{handMode ? '收起指尖' : '指尖精调'}</button></header>
        {selectedHand && <div className="pose-direction-help"><span aria-hidden="true">◆</span><div><b>手掌方向</b><small>拖菱形调 Pitch / Yaw · Alt 拖调 Roll</small></div></div>}
        <small>{handMode ? '哪根手指不对，就直接拖它的指尖。拇指靠近掌心会自动对掌并弯曲，向外拖会张开伸直。' : '打开指尖精调后，每根手指只显示一个指尖控制点。'}</small>
      </section>}
      {!previewing && selectedFoot && <section className="pose-end-controls pose-toe-controls" aria-label={`${selectedFoot === 'L' ? '左' : '右'}脚趾控制`}>
        <header><strong>{selectedFoot === 'L' ? '左' : '右'}脚</strong><span>Toe Controls</span></header>
        {selectedFoot && <div className="pose-direction-help"><span aria-hidden="true">◆</span><div><b>脚掌方向</b><small>拖菱形调 Pitch / Yaw · Alt 拖调 Roll</small></div></div>}
        <div className="pose-control-caption"><b>◇ Toe Group</b><small>整体上翘 / 下弯 / 张开</small></div>
        <div className="pose-gesture-pad pose-toe-pad" role="slider" tabIndex={readOnly ? -1 : 0} aria-label="Toe Group：上下控制脚趾屈伸，左右控制张合"
          aria-valuetext={`屈伸 ${Math.round(toePose.curl * 100)}%，张合 ${Math.round(toePose.spread * 100)}%`}
          onPointerDown={(event) => { runtime?.beginInteraction(); event.currentTarget.setPointerCapture(event.pointerId); updateToeGroup(event.currentTarget, event.clientX, event.clientY); }}
          onPointerMove={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) updateToeGroup(event.currentTarget, event.clientX, event.clientY); }}
          onPointerUp={() => runtime?.endInteraction()} onPointerCancel={() => runtime?.endInteraction()}>
          <span className="top">上翘</span><span className="left">并拢</span><span className="right">张开</span><span className="bottom">下弯</span>
          <i className="diamond" style={{ left: `${(toePose.spread + 1) * 50}%`, top: `${(toePose.curl + 1) * 50}%` }} />
        </div>
        <label className="pose-range-control"><span>● 大脚趾 <output>{Math.round(toePose.bigToe * 100)}%</output></span>
          <input type="range" min="-1" max="1" step=".01" value={toePose.bigToe} disabled={readOnly}
            onPointerDown={() => runtime?.beginInteraction()} onPointerUp={() => runtime?.endInteraction()} onPointerCancel={() => runtime?.endInteraction()}
            onFocus={() => runtime?.beginInteraction()} onBlur={() => runtime?.endInteraction()}
            onChange={(event) => updateBigToe(Number(event.currentTarget.value))} />
        </label>
        <small>其余四趾跟随 Toe Group 与大脚趾；踮脚时自动加入自然背屈。</small>
      </section>}
      {!previewing && currentSelectionLabel && <div className="pose-selection-card">
        <div><strong>{currentSelectionLabel}</strong><small>{selectionHint(selection)}</small></div>
        <button type="button" disabled={readOnly || selection?.locked || selectedFootLocked || selection?.branch === 'cog'} onClick={resetLimb}>重置部位</button>
      </div>}
      {!previewing && hoverMessage && <div className="pose-hover-hint">{hoverMessage}</div>}
      {loading && <div className="pose-studio-state">正在加载人体姿势模型…</div>}
      {error && <div className="pose-studio-state error"><strong>无法进入姿势工作室</strong><p>{error}</p><button type="button" onClick={() => setAttempt((value) => value + 1)}>重试</button></div>}
    </main>
  </section>;
}
