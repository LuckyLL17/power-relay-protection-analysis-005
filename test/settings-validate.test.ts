import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { audits, devices, maintenanceTests, settingSnapshots } from '../src/domain/state.js';

const app = await buildApp({ logger: false });

async function validate(body: any) {
  const res = await app.inject({ method: 'POST', url: '/api/protection/settings/validate', payload: body });
  assert.equal(res.statusCode, 200);
  return res.json();
}

test('旧调用兼容：无 lineId 时保持原有规则与字段', async () => {
  const ok = await validate({});
  assert.equal(ok.valid, true);
  assert.deepEqual(ok.errors, []);
  assert.ok(ok.checkedAt);
  const low = await validate({ shortCircuitKa: 0.5 });
  assert.equal(low.valid, false);
  assert.ok(low.errors.includes('shortCircuitKa below engineering minimum'));
});

test('边界电流：shortCircuitKa=1 通过，低于 1 阻断', async () => {
  const at = await validate({ lineId: 'L-AB', shortCircuitKa: 1 });
  assert.equal(at.valid, true);
  assert.ok(!at.blockers.some((b: any) => b.code === 'short-circuit-below-minimum'));
  const below = await validate({ lineId: 'L-AB', shortCircuitKa: 0.99 });
  assert.equal(below.valid, false);
  assert.ok(below.blockers.some((b: any) => b.code === 'short-circuit-below-minimum'));
  assert.ok(below.errors.includes('shortCircuitKa below engineering minimum'));
});

test('无效线路：阻断并标明 line-not-found，不能冒充成功', async () => {
  const r = await validate({ lineId: 'L-NOPE' });
  assert.equal(r.valid, false);
  assert.ok(r.blockers.some((b: any) => b.code === 'line-not-found'));
  assert.equal(r.snapshot, null);
  assert.ok(r.errors.length > 0);
});

test('历史时刻无快照：阻断并标明 snapshot-missing，不用当前配置冒充', async () => {
  const r = await validate({ lineId: 'L-AB', asOf: '2026-08-01T00:00:00.000Z' });
  assert.equal(r.valid, false);
  assert.ok(r.blockers.some((b: any) => b.code === 'snapshot-missing'));
  assert.equal(r.snapshot, null);
});

test('按 asOf 选择生效快照，装置版本不匹配时阻断', async () => {
  const older = { id: 'set-2026.06', effectiveAt: '2026-06-01T00:00:00.000Z', author: 'test', reason: 'fixture', checksum: 'sha256:test' };
  settingSnapshots.push(older);
  try {
    const r = await validate({ lineId: 'L-AB', asOf: '2026-07-01T00:00:00.000Z' });
    assert.equal(r.snapshot?.id, 'set-2026.06');
    assert.equal(r.valid, false);
    assert.ok(r.blockers.some((b: any) => b.code === 'settings-version-mismatch' && b.deviceId === 'R-A1'));
  } finally {
    settingSnapshots.splice(settingSnapshots.indexOf(older), 1);
  }
});

test('历史时刻被快照覆盖：按该快照校验通过', async () => {
  const r = await validate({ lineId: 'L-AB', asOf: '2026-09-15T00:00:00.000Z' });
  assert.equal(r.snapshot?.id, 'set-2026.09');
  assert.equal(r.valid, true);
  assert.deepEqual(r.blockers, []);
});

test('维护记录缺失：警告 maintenance-missing，不阻断', async () => {
  const r = await validate({ lineId: 'L-AB' });
  assert.ok(r.warnings.some((w: any) => w.code === 'maintenance-missing' && w.deviceId === 'R-A1'));
  assert.equal(r.valid, true);
});

test('有效维护与过期维护区分：过期给 test-expired 警告，有效不给', async () => {
  const future = new Date(Date.now() + 30 * 86400000).toISOString();
  const valid = { id: 'mt-valid', deviceId: 'R-A1', testType: 'routine', measurements: {}, pass: true, testedAt: new Date().toISOString(), nextDueAt: future };
  const expired = { id: 'mt-expired', deviceId: 'R-B1', testType: 'routine', measurements: {}, pass: true, testedAt: '2026-01-01T00:00:00.000Z', nextDueAt: '2026-04-01T00:00:00.000Z' };
  maintenanceTests.push(valid, expired);
  try {
    const r = await validate({ lineId: 'L-AB' });
    assert.equal(r.valid, true);
    assert.ok(r.warnings.some((w: any) => w.code === 'test-expired' && w.deviceId === 'R-B1'));
    assert.ok(!r.warnings.some((w: any) => (w.code === 'test-expired' || w.code === 'maintenance-missing') && w.deviceId === 'R-A1'));
  } finally {
    maintenanceTests.splice(maintenanceTests.indexOf(valid), 1);
    maintenanceTests.splice(maintenanceTests.indexOf(expired), 1);
  }
});

test('禁用装置：阻断并标明 device-disabled', async () => {
  const dev = devices.find(d => d.id === 'R-A1')!;
  dev.enabled = false;
  try {
    const r = await validate({ lineId: 'L-AB' });
    assert.equal(r.valid, false);
    assert.ok(r.blockers.some((b: any) => b.code === 'device-disabled' && b.deviceId === 'R-A1'));
  } finally {
    dev.enabled = true;
  }
});

test('区段与线路参数核对：I 段达到全线阻抗给警告', async () => {
  const r = await validate({ lineId: 'L-AB' });
  assert.ok(r.warnings.some((w: any) => w.code === 'zone-1-overreach-risk' && w.deviceId === 'R-A1'));
});

test('asOf 无法解析时返回 400', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/protection/settings/validate', payload: { lineId: 'L-AB', asOf: 'not-a-date' } });
  assert.equal(res.statusCode, 400);
});

test('校验只读：不修改业务数据', async () => {
  const before = { snapshots: settingSnapshots.length, devices: devices.length, tests: maintenanceTests.length, audits: audits.length };
  await validate({ lineId: 'L-AB' });
  await validate({ lineId: 'L-NOPE', asOf: '2026-07-01T00:00:00.000Z' });
  await validate({});
  assert.equal(settingSnapshots.length, before.snapshots);
  assert.equal(devices.length, before.devices);
  assert.equal(maintenanceTests.length, before.tests);
  assert.equal(audits.length, before.audits);
});
