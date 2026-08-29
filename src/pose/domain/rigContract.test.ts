import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseBjdRigV1 } from './rigContract';
import { createPoseRigAdapter } from './rigAdapter';

const assetPath = new URL('../../../public/pose/chambersu-bjd-female-v1/bjd-rig-v1.json', import.meta.url);

describe('BJD rig contract', () => {
  it('accepts the shipped rig after validating joint limits', () => {
    expect(parseBjdRigV1(JSON.parse(readFileSync(assetPath, 'utf8'))).ikChains.legL.end).toBe('ankleL');
  });

  it('rejects inverted joint limits', () => {
    const rig = JSON.parse(readFileSync(assetPath, 'utf8')) as { jointLimits: Record<string, { min: { z: number }; max: { z: number } }> };
    rig.jointLimits.hipL.max.z = -2;
    expect(() => parseBjdRigV1(rig)).toThrow('关节限位无效');
  });

  it('keeps semantic solver names independent from model node names', () => {
    const rawRig = JSON.parse(readFileSync(assetPath, 'utf8')) as {
      handPresets: { fist: { left: Record<string, { x: number; y: number; z: number }>; right: Record<string, { x: number; y: number; z: number }> } };
    };
    const rig = parseBjdRigV1(rawRig);
    const adapter = createPoseRigAdapter(rig);
    expect(adapter.jointNode('wristL')).toBe('joint_wristL');
    expect(adapter.ikChain('armL').end).toBe('wristL');
    expect(adapter.semanticIkChain('armL')).toMatchObject({ root: 'shoulderL', middle: 'elbowL', end: 'wristL' });
    expect(adapter.authoredJoint('elbowL')).toBe(rig.ikChains.armL.middle[1]);
    expect(adapter.authoredJoint('toeL')).toBe('toeBaseL');
    expect(adapter.authoredJoint('indexDistalL')).toBe('indexDistalL');
    expect(adapter.segmentNode('thumbMetacarpalL')).toBe('segment_thumbMetacarpalL');
    expect(Math.abs(rig.axisBasis.indexProximalL.x)).toBeGreaterThan(.9);
    expect(Math.abs(rig.axisBasis.indexProximalR.w)).toBeGreaterThan(.9);
    expect(rig.jointLimits.indexProximalL!.max.z).toBeGreaterThan(rig.jointLimits.indexProximalL!.max.x);
    expect(rig.jointLimits.indexProximalR!.max.z).toBeGreaterThan(rig.jointLimits.indexProximalR!.max.x);
    expect(rig.jointLimits.thumbMetacarpalL!.min.x).toBeLessThan(-1.3);
    expect(rig.jointLimits.thumbMetacarpalL!.min.y).toBeLessThan(-.8);
    expect(rig.jointLimits.thumbMetacarpalL!.min.z).toBeLessThan(-.9);
    expect(rig.jointLimits.thumbProximalL!.max.z).toBeGreaterThan(1.2);
    expect(rig.jointLimits.thumbDistalL!.max.z).toBeGreaterThan(.4);
    expect(rig.thumbPoseCurve.map(({ id }) => id)).toEqual(['open', 'relaxed', 'halfCurl', 'opposition', 'fist']);
    const fistKey = rig.thumbPoseCurve.at(-1)!;
    expect(fistKey.left.thumbMetacarpalL?.y).toBeCloseTo(-fistKey.right.thumbMetacarpalR!.y);
    expect(fistKey.left.thumbProximalL?.z).toBeCloseTo(-fistKey.right.thumbProximalR!.z);
    const fistThumb = rawRig.handPresets.fist.left;
    expect(Math.abs(fistThumb.thumbMetacarpalL.x)).toBeGreaterThan(.1);
    expect(Math.abs(fistThumb.thumbMetacarpalL.y)).toBeGreaterThan(.05);
    expect(Math.abs(fistThumb.thumbMetacarpalL.z)).toBeGreaterThan(.01);
    expect(fistThumb.thumbMetacarpalL.y).toBeGreaterThan(.2);
    expect(rawRig.handPresets.fist.right.thumbMetacarpalR.y).toBeLessThan(-.2);
    expect(Math.abs(fistThumb.thumbProximalL.z)).toBeGreaterThan(.45);
    expect(Math.abs(fistThumb.thumbDistalL.z)).toBeGreaterThan(.05);
    expect(Math.abs(rawRig.handPresets.fist.right.thumbDistalR.z)).toBeGreaterThan(.05);
    expect(adapter.rotationDeltasFor({ joint: 'bigToeR', rotationDelta: { x: .2, y: 0, z: 0, w: .98 } }, () => ({ x: 0, y: 0, z: 0, w: 1 })))
      .toEqual({ bigToeR: { x: .2, y: 0, z: 0, w: .98 } });
    const bend = adapter.rotationDeltasFor({ joint: 'elbowL', bendAngle: 1 }, (_jointId, angle) => ({ x: angle, y: 0, z: 0, w: 1 }));
    expect(Object.keys(bend).sort()).toEqual([...rig.ikChains.armL.middle].sort());
    expect(bend[rig.ikChains.armL.middle[0]]!.x + bend[rig.ikChains.armL.middle[1]]!.x).toBeCloseTo(1 - rig.ikChains.armL.restBend);
  });
});
