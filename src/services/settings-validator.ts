export type Finding = { code: string; message: string; deviceId?: string };
export type ValidateInput = { lineId?: string; asOf?: string; shortCircuitKa?: number };
export type ValidateDeps = { lines: any[]; devices: any[]; settingSnapshots: any[]; maintenanceTests: any[] };

const MIN_SHORT_CIRCUIT_KA = 1;

// 选择 asOf 时刻已生效（effectiveAt <= asOf）的最新快照；没有则返回 null，绝不回退到当前配置
export function selectEffectiveSnapshot(snapshots: any[], asOfMs: number) {
  let best: any = null;
  for (const s of snapshots) {
    const t = Date.parse(s?.effectiveAt);
    if (!Number.isFinite(t) || t > asOfMs) continue;
    if (!best || t > Date.parse(best.effectiveAt)) best = s;
  }
  return best;
}

function checkZoneBasics(device: any, blockers: Finding[]) {
  for (const z of device.zones) {
    if (z.reachOhm <= 0) blockers.push({ code: 'zone-reach-invalid', deviceId: device.id, message: `${device.id}: zone ${z.zone} reach must be positive` });
    if (z.zone === 1 && z.delayMs !== 0) blockers.push({ code: 'zone-1-not-instantaneous', deviceId: device.id, message: `${device.id}: zone 1 must be instantaneous` });
  }
}

function checkZoneOrdering(device: any, blockers: Finding[]) {
  const ordered = [...device.zones].sort((a: any, b: any) => a.zone - b.zone);
  for (let i = 1; i < ordered.length; i++) {
    if (ordered[i].reachOhm <= ordered[i - 1].reachOhm) blockers.push({ code: 'zone-reach-order', deviceId: device.id, message: `${device.id}: zone ${ordered[i].zone} reach must exceed zone ${ordered[i - 1].zone}` });
  }
}

function checkZoneVsLine(device: any, line: any, warnings: Finding[]) {
  const lineZ = line.lengthKm * line.positiveSequenceOhmPerKm;
  const z1 = device.zones.find((z: any) => z.zone === 1);
  if (z1 && z1.reachOhm >= lineZ) warnings.push({ code: 'zone-1-overreach-risk', deviceId: device.id, message: `${device.id}: zone 1 reach ${z1.reachOhm}Ω not below line impedance ${lineZ.toFixed(3)}Ω` });
  const z2 = device.zones.find((z: any) => z.zone === 2);
  if (z2 && z2.reachOhm < lineZ) warnings.push({ code: 'zone-2-undercover', deviceId: device.id, message: `${device.id}: zone 2 reach ${z2.reachOhm}Ω does not cover line impedance ${lineZ.toFixed(3)}Ω` });
}

// 只读校验：不修改任何业务状态。无 lineId 时保持旧行为（检查全部装置区段 + 短路电流边界）
export function validateSettings(input: ValidateInput, deps: ValidateDeps) {
  const { lines, devices, settingSnapshots, maintenanceTests } = deps;
  const asOfMs = input.asOf != null ? Date.parse(input.asOf) : Date.now();
  const asOf = new Date(asOfMs).toISOString();
  const blockers: Finding[] = [];
  const warnings: Finding[] = [];

  if (input.shortCircuitKa != null && Number(input.shortCircuitKa) < MIN_SHORT_CIRCUIT_KA) blockers.push({ code: 'short-circuit-below-minimum', message: 'shortCircuitKa below engineering minimum' });

  const finish = (lineId: string | null, snapshot: any, deviceIds: string[]) => ({ valid: blockers.length === 0, errors: blockers.map(b => b.message), blockers, warnings, lineId, asOf, snapshot, devices: deviceIds, checkedAt: new Date().toISOString() });

  if (input.lineId == null) {
    for (const d of devices) checkZoneBasics(d, blockers);
    return finish(null, null, []);
  }

  const line = lines.find(l => l.id === input.lineId);
  if (!line) {
    blockers.push({ code: 'line-not-found', message: `line ${input.lineId} not found` });
    return finish(input.lineId, null, []);
  }

  const lineDevices = devices.filter(d => d.lineId === line.id);
  if (lineDevices.length === 0) blockers.push({ code: 'device-missing', message: `line ${line.id} has no protection device` });

  const snapshot = selectEffectiveSnapshot(settingSnapshots, asOfMs);
  if (!snapshot) blockers.push({ code: 'snapshot-missing', message: `no setting snapshot effective at ${asOf}` });

  for (const d of lineDevices) {
    if (!d.enabled) blockers.push({ code: 'device-disabled', deviceId: d.id, message: `${d.id} is disabled` });
    const settingsEffective = snapshot != null && d.settingsVersion === snapshot.id;
    if (snapshot && !settingsEffective) blockers.push({ code: 'settings-version-mismatch', deviceId: d.id, message: `${d.id}: settings ${d.settingsVersion} not effective at ${asOf}; snapshot ${snapshot.id} governs` });

    const tests = maintenanceTests.filter(t => t.deviceId === d.id && Number.isFinite(Date.parse(t.testedAt))).sort((a, b) => Date.parse(b.testedAt) - Date.parse(a.testedAt));
    if (tests.length === 0) {
      warnings.push({ code: 'maintenance-missing', deviceId: d.id, message: `${d.id}: no maintenance test record` });
    } else {
      const due = Date.parse(tests[0].nextDueAt);
      if (Number.isFinite(due) && due < asOfMs) warnings.push({ code: 'test-expired', deviceId: d.id, message: `${d.id}: maintenance test expired at ${tests[0].nextDueAt}` });
    }

    // 只有确认该装置在 asOf 时刻生效的定值就是当前这套时，才检查区段参数，避免用当前配置冒充历史结论
    if (settingsEffective) {
      checkZoneBasics(d, blockers);
      checkZoneOrdering(d, blockers);
      checkZoneVsLine(d, line, warnings);
    }
  }

  return finish(input.lineId, snapshot, lineDevices.map(d => d.id));
}
