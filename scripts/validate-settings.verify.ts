/* eslint-disable no-console */
// 定值校验扩展验证脚本：通过 Fastify inject 在内存中发请求，不监听端口、不修改业务数据。
// 运行：npm run verify
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { audits, devices, lines, maintenanceTests, settingSnapshots } from '../src/domain/state.js';

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}`);
    console.error(e instanceof Error ? e.stack : e);
    process.exitCode = 1;
  }
}

const codes = (list: any[]) => (list || []).map((f: any) => f.code);
const snap = () => JSON.stringify({
  devices, lines, maintenanceTests, settingSnapshots, auditsLen: audits.length
});

const app = await buildApp({ logger: false });
const post = (url: string, body: any) => app.inject({ method: 'POST', url, payload: body });
const get = (url: string) => app.inject({ method: 'GET', url });

const before = snap();

console.log('1) 旧调用兼容性');
await test('无 lineId：返回结构保持 valid/errors/checkedAt，无 blockers/warnings', async () => {
  const r = await post('/api/protection/settings/validate', {});
  assert.equal(r.statusCode, 200);
  const j = r.json();
  assert.equal(j.valid, true);
  assert.deepEqual(j.errors, []);
  assert.ok(typeof j.checkedAt === 'string');
  assert.equal(j.mode, undefined);
  assert.equal(j.blockers, undefined);
});
await test('无 lineId + 小电流：保留旧英文错误文案', async () => {
  const r = await post('/api/protection/settings/validate', { shortCircuitKa: 0.5 });
  const j = r.json();
  assert.equal(j.valid, false);
  assert.ok(j.errors.includes('shortCircuitKa below engineering minimum'));
});

console.log('2) 当前时刻校验（2026-10，有效快照 set-2026.09）');
await test('R-A1：快照生效、装置启用、检修有效 => 无阻断无警告', async () => {
  const r = await post('/api/protection/settings/validate', { lineId: 'L-AB', deviceIds: ['R-A1'], shortCircuitKa: 20 });
  assert.equal(r.statusCode, 200, r.body);
  const j = r.json();
  assert.equal(j.mode, 'extended');
  assert.equal(j.snapshot.status, 'selected');
  assert.equal(j.snapshot.snapshot.id, 'set-2026.09');
  assert.equal(j.valid, true, JSON.stringify(j.blockers));
  assert.deepEqual(codes(j.blockers), []);
  assert.deepEqual(codes(j.warnings), []);
  const dev = j.devices[0];
  assert.equal(dev.deviceId, 'R-A1');
  assert.equal(dev.enabled, true);
  assert.equal(dev.versionMatchesSnapshot, true);
  assert.equal(dev.maintenance.status, 'valid');
  assert.ok(dev.maintenance.nextDueAt);
  // errors 兼容字段：阻断项为空
  assert.deepEqual(j.errors, []);
});
await test('全线路（含 R-B1 过期、R-A2 禁用）：阻断区分装置，整体 invalid', async () => {
  const r = await post('/api/protection/settings/validate', { lineId: 'L-AB', shortCircuitKa: 20 });
  const j = r.json();
  assert.equal(j.snapshot.snapshot.id, 'set-2026.09');
  assert.equal(j.valid, false);
  const rb1 = j.devices.find((d: any) => d.deviceId === 'R-B1');
  assert.equal(rb1.maintenance.status, 'expired');
  assert.ok(codes(rb1.blockers).includes('maintenance-test-expired'));
  const ra2 = j.devices.find((d: any) => d.deviceId === 'R-A2');
  assert.equal(ra2.enabled, false);
  assert.ok(codes(ra2.blockers).includes('device-disabled'));
  assert.ok(codes(ra2.blockers).includes('maintenance-test-failed'));
  // 整体阻断按原因可区分
  assert.ok(codes(j.blockers).includes('maintenance-test-expired'));
  assert.ok(codes(j.blockers).includes('device-disabled'));
  assert.ok(codes(j.blockers).includes('maintenance-test-failed'));
  // R-A1 依然干净，问题不扩散
  const ra1 = j.devices.find((d: any) => d.deviceId === 'R-A1');
  assert.deepEqual(codes(ra1.blockers), []);
});

console.log('3) 历史时刻校验（必须选历史快照，不能拿当前配置冒充）');
await test('2026-06：R-A1 选 set-2026.03 历史快照，装置版本漂移仅为警告，检修记录按当时有效', async () => {
  const r = await post('/api/protection/settings/validate', {
    lineId: 'L-AB', at: '2026-06-01T00:00:00.000Z', deviceIds: ['R-A1'], shortCircuitKa: 20
  });
  const j = r.json();
  assert.equal(j.snapshot.status, 'selected');
  assert.equal(j.snapshot.snapshot.id, 'set-2026.03');
  assert.equal(j.valid, true, JSON.stringify(j.blockers));
  const dev = j.devices[0];
  assert.equal(dev.versionMatchesSnapshot, false);
  assert.ok(codes(dev.warnings).includes('device-version-mismatch'));
  // R-A1 的试验 testedAt 为 60 天前，2026-06 之前不存在 => 维护记录缺失（警告，原因区分）
  assert.equal(dev.maintenance.status, 'record-missing');
  assert.ok(codes(dev.warnings).includes('maintenance-record-missing'));
});
await test('2026-08-31 23:59：set-2026.09 尚未生效，边界上仍取 03 版', async () => {
  const r = await post('/api/protection/settings/validate', {
    lineId: 'L-AB', at: '2026-08-31T23:59:59.999Z', deviceIds: ['R-A1']
  });
  const j = r.json();
  assert.equal(j.snapshot.snapshot.id, 'set-2026.03');
});
await test('2026-09-01 00:00：生效边界时刻取 09 版', async () => {
  const r = await post('/api/protection/settings/validate', {
    lineId: 'L-AB', at: '2026-09-01T00:00:00.000Z', deviceIds: ['R-A1']
  });
  const j = r.json();
  assert.equal(j.snapshot.snapshot.id, 'set-2026.09');
});
await test('2026-02（早于首版快照）：阻断 snapshot-not-effective-yet，且不回退当前定值', async () => {
  const r = await post('/api/protection/settings/validate', {
    lineId: 'L-AB', at: '2026-02-15T00:00:00.000Z', deviceIds: ['R-A1']
  });
  const j = r.json();
  assert.equal(j.valid, false);
  assert.equal(j.snapshot.status, 'missing');
  assert.equal(j.snapshot.code, 'snapshot-not-effective-yet');
  assert.ok(codes(j.blockers).includes('snapshot-not-effective-yet'));
  assert.equal(j.devices[0].versionMatchesSnapshot, null);
});

console.log('4) 历史快照缺失：不同原因必须区分');
await test('L-BC 引用的 set-2026.08 从未存在：snapshot-referenced-version-not-found + 维护记录缺失', async () => {
  const r = await post('/api/protection/settings/validate', { lineId: 'L-BC', shortCircuitKa: 15 });
  const j = r.json();
  assert.equal(j.valid, false);
  assert.equal(j.snapshot.status, 'missing');
  assert.equal(j.snapshot.code, 'snapshot-referenced-version-not-found');
  assert.ok(codes(j.blockers).includes('snapshot-referenced-version-not-found'));
  // 绝不以当前配置冒充成功：区段检查在快照缺失时不产生结论
  assert.ok(!codes(j.blockers).some(c => c.startsWith('zone')));
  assert.ok(!codes(j.warnings).some(c => c.startsWith('zone')));
  const dev = j.devices[0];
  assert.equal(dev.deviceId, 'R-BC');
  assert.equal(dev.maintenance.status, 'record-missing');
  assert.ok(codes(dev.warnings).includes('maintenance-record-missing'));
});
await test('无效线路 L-XX：line-not-found，且不选快照', async () => {
  const r = await post('/api/protection/settings/validate', { lineId: 'L-XX', at: '2026-10-01T00:00:00.000Z' });
  assert.equal(r.statusCode, 200);
  const j = r.json();
  assert.equal(j.valid, false);
  assert.ok(codes(j.blockers).includes('line-not-found'));
  assert.equal(j.snapshot.status, 'missing');
  assert.equal(j.snapshot.code, 'snapshot-not-evaluated');
  assert.deepEqual(j.devices, []);
});

console.log('5) 禁用装置与检修有效期');
await test('R-A2 当前时刻：device-disabled + maintenance-test-failed（不合格优先于临期）', async () => {
  const r = await post('/api/protection/settings/validate', { lineId: 'L-AB', deviceIds: ['R-A2'] });
  const j = r.json();
  const dev = j.devices[0];
  assert.equal(dev.maintenance.status, 'failed');
  assert.ok(codes(dev.blockers).includes('device-disabled'));
  assert.ok(codes(dev.blockers).includes('maintenance-test-failed'));
  assert.ok(!codes(dev.warnings).includes('maintenance-test-due-soon'));
});
await test('R-A2 历史时刻（试验之前）：维护记录缺失为警告', async () => {
  const r = await post('/api/protection/settings/validate', {
    lineId: 'L-AB', at: '2026-06-01T00:00:00.000Z', deviceIds: ['R-A2']
  });
  const j = r.json();
  assert.equal(j.devices[0].maintenance.status, 'record-missing');
});
await test('R-B1 当前时刻：试验过期为阻断 maintenance-test-expired', async () => {
  const r = await post('/api/protection/settings/validate', { lineId: 'L-AB', deviceIds: ['R-B1'], shortCircuitKa: 20 });
  const j = r.json();
  assert.equal(j.valid, false);
  assert.equal(j.devices[0].maintenance.status, 'expired');
  assert.ok(codes(j.devices[0].blockers).includes('maintenance-test-expired'));
});
await test('R-B1 历史时刻（试验当时有效）：无维护阻断', async () => {
  // testedAt ≈ 当前-110 天 ≈ 2026-06-16；2026-07-01 时下次到期日（当前-20天≈2026-09-14）仍在未来
  const r = await post('/api/protection/settings/validate', {
    lineId: 'L-AB', at: '2026-07-01T00:00:00.000Z', deviceIds: ['R-B1'], shortCircuitKa: 20
  });
  const j = r.json();
  assert.equal(j.devices[0].maintenance.status, 'valid', JSON.stringify(j.devices[0]));
  assert.ok(!codes(j.devices[0].blockers).includes('maintenance-test-expired'));
});

console.log('6) 边界电流（闭区间 [1, 80] kA）');
await test('电流 = 1（下界）合法；0.99 阻断；1.01 附近给警告', async () => {
  for (const ka of [1]) {
    const j = (await post('/api/protection/settings/validate', { lineId: 'L-AB', deviceIds: ['R-A1'], shortCircuitKa: ka })).json();
    assert.ok(!codes(j.blockers).includes('short-circuit-current-too-low'), `ka=${ka}`);
  }
  const low = (await post('/api/protection/settings/validate', { lineId: 'L-AB', deviceIds: ['R-A1'], shortCircuitKa: 0.99 })).json();
  assert.ok(codes(low.blockers).includes('short-circuit-current-too-low'));
  const near = (await post('/api/protection/settings/validate', { lineId: 'L-AB', deviceIds: ['R-A1'], shortCircuitKa: 1.01 })).json();
  assert.ok(codes(near.warnings).includes('short-circuit-current-near-min'));
  assert.equal(near.valid, true);
});
await test('电流 = 80（上界）合法；80.5 阻断；79 附近给警告', async () => {
  const j = (await post('/api/protection/settings/validate', { lineId: 'L-AB', deviceIds: ['R-A1'], shortCircuitKa: 80 })).json();
  assert.ok(!codes(j.blockers).includes('short-circuit-current-too-high'));
  const high = (await post('/api/protection/settings/validate', { lineId: 'L-AB', deviceIds: ['R-A1'], shortCircuitKa: 80.5 })).json();
  assert.ok(codes(high.blockers).includes('short-circuit-current-too-high'));
  const near = (await post('/api/protection/settings/validate', { lineId: 'L-AB', deviceIds: ['R-A1'], shortCircuitKa: 79 })).json();
  assert.ok(codes(near.warnings).includes('short-circuit-current-near-max'));
});
await test('非数值电流阻断 short-circuit-current-invalid', async () => {
  const j = (await post('/api/protection/settings/validate', { lineId: 'L-AB', deviceIds: ['R-A1'], shortCircuitKa: 'abc' })).json();
  assert.ok(codes(j.blockers).includes('short-circuit-current-invalid'));
});

console.log('7) 非法输入与快照查询接口');
await test('at 不可解析 => 400', async () => {
  const r = await post('/api/protection/settings/validate', { lineId: 'L-AB', at: 'not-a-time' });
  assert.equal(r.statusCode, 400);
  assert.match(r.json().error, /无法解析的时间/);
});
await test('deviceIds 指向其他线路/不存在 => 分别阻断', async () => {
  const wrongLine = (await post('/api/protection/settings/validate', { lineId: 'L-AB', deviceIds: ['R-BC'] })).json();
  assert.ok(codes(wrongLine.blockers).includes('device-not-on-line'));
  const missing = (await post('/api/protection/settings/validate', { lineId: 'L-AB', deviceIds: ['R-NONE'] })).json();
  assert.ok(codes(missing.blockers).includes('device-not-found'));
});
await test('GET 时点快照：当前=09 版，2026-05=03 版，L-BC 明确缺失原因', async () => {
  const cur = (await get('/api/protection/lines/L-AB/effective-settings')).json();
  assert.equal(cur.selection.status, 'selected');
  assert.equal(cur.selection.snapshot.id, 'set-2026.09');
  const old = (await get('/api/protection/lines/L-AB/effective-settings?at=2026-05-01T00:00:00.000Z')).json();
  assert.equal(old.selection.snapshot.id, 'set-2026.03');
  const bc = (await get('/api/protection/lines/L-BC/effective-settings')).json();
  assert.equal(bc.selection.status, 'missing');
  assert.equal(bc.selection.code, 'snapshot-referenced-version-not-found');
  const nf = await get('/api/protection/lines/L-XX/effective-settings');
  assert.equal(nf.statusCode, 404);
});

console.log('8) 只读保证：校验前后业务数据快照一致、无审计写入');
await test('全部校验调用未改动 devices/lines/snapshots/maintenance/audits', async () => {
  assert.equal(snap(), before);
});

console.log(`\nSUMMARY: ${passed} 个验证通过` + (process.exitCode ? '，存在失败' : '，全部成功'));
await app.close();
