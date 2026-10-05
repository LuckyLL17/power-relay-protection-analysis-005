import type { MaintenanceTest, ProtectionDevice, SettingSnapshot, SettingsZone } from '../domain/types.js';
import { devices, lines, maintenanceTests, settingSnapshots } from '../domain/state.js';

// ---------- 返回结构 ----------

export type Severity = 'blocker' | 'warning';

export type Finding = {
  code: string;
  severity: Severity;
  message: string;
  scope: 'line' | 'snapshot' | 'device' | 'maintenance' | 'section' | 'input';
  ref?: string;
};

export type SnapshotSelection =
  | { status: 'selected'; snapshot: SettingSnapshot }
  | { status: 'missing'; code: string; message: string; scope: Finding['scope']; ref?: string };

export type DeviceCheckResult = {
  deviceId: string;
  enabled: boolean;
  settingsVersion: string;
  versionMatchesSnapshot: boolean | null;
  maintenance: {
    status: 'valid' | 'due-soon' | 'expired' | 'record-missing' | 'failed';
    testId?: string;
    nextDueAt?: string;
    testedAt?: string;
  };
  blockers: Finding[];
  warnings: Finding[];
};

export type SettingsValidationResult = {
  mode: 'extended';
  lineId: string;
  checkedAt: string;
  effectiveAt: string;
  snapshot: SnapshotSelection;
  shortCircuitKa: number | null;
  blockers: Finding[];
  warnings: Finding[];
  devices: DeviceCheckResult[];
  valid: boolean;
  // 兼容旧字段：errors 仅包含阻断项文本
  errors: string[];
};

export class SettingsValidationInputError extends Error {}

// ---------- 常量 ----------

const DAY_MS = 86_400_000;
const MAINTENANCE_DUE_SOON_DAYS = 14;
const SHORT_CIRCUIT_MIN_KA = 1;
const SHORT_CIRCUIT_MAX_KA = 80;
const SHORT_CIRCUIT_BOUNDARY_TOLERANCE = 0.02; // 距边界 2% 以内给警告
// Z1 超越线路正序阻抗的容忍度：2% 以内给警告，超过给阻断
const Z1_OVERREACH_WARN_RATIO = 1.02;
const Z1_OVERREACH_BLOCK_RATIO = 1.2;
// 后备区段（Z2/Z3）最多覆盖线路全长的 120%，超过给警告
const BACKUP_OVERREACH_WARN_RATIO = 1.2;

// ---------- 时点 ----------

export function parseRequestedAt(raw: unknown, fallbackIso: string): { iso: string; ms: number } {
  if (raw == null || raw === '') {
    const ms = Date.parse(fallbackIso);
    return { iso: new Date(ms).toISOString(), ms };
  }
  if (typeof raw !== 'string' && typeof raw !== 'number') {
    throw new SettingsValidationInputError('at 必须是 ISO 时间字符串或毫秒时间戳');
  }
  const ms = typeof raw === 'number' ? raw : Date.parse(raw);
  if (!Number.isFinite(ms)) {
    throw new SettingsValidationInputError(`无法解析的时间: ${String(raw)}`);
  }
  return { iso: new Date(ms).toISOString(), ms };
}

// ---------- 历史定值快照选择 ----------
// 选择指定时刻"已经生效"的最新快照（effectiveAt <= at）。
// 若装置当前引用的版本号在任何时点都不存在，需要明确区分原因，绝不回退到当前配置冒充成功。
export function selectEffectiveSnapshot(lineId: string, atMs: number, referencedVersionIds: string[]): SnapshotSelection {
  const lineSnapshots = settingSnapshots
    .filter(s => s.lineId === lineId)
    .sort((a, b) => Date.parse(a.effectiveAt) - Date.parse(b.effectiveAt));

  // 1. 装置引用的版本在该线路快照清单里根本不存在
  const knownIds = new Set(lineSnapshots.map(s => s.id));
  const missingReferenced = referencedVersionIds.filter(v => !knownIds.has(v));
  if (missingReferenced.length > 0) {
    return {
      status: 'missing',
      code: 'snapshot-referenced-version-not-found',
      scope: 'snapshot',
      ref: missingReferenced.join(','),
      message: `装置引用的定值版本在快照记录中不存在: ${missingReferenced.join(', ')}，不能以当前配置冒充历史定值`
    };
  }

  // 2. 指定时刻之前没有任何已生效快照（历史早于首版定值）
  const effective = lineSnapshots.filter(s => Date.parse(s.effectiveAt) <= atMs);
  if (effective.length === 0) {
    const first = lineSnapshots[0];
    return {
      status: 'missing',
      code: first
        ? 'snapshot-not-effective-yet'
        : 'snapshot-history-missing',
      scope: 'snapshot',
      ref: first?.id,
      message: first
        ? `指定时刻尚无生效定值快照：最早快照 ${first.id} 生效于 ${first.effectiveAt}`
        : '该线路没有任何历史定值快照记录'
    };
  }

  // 3. 已生效快照中取生效时间最新的一版
  return { status: 'selected', snapshot: effective[effective.length - 1] };
}

// ---------- 检修试验 ----------

export type MaintenanceStatus = DeviceCheckResult['maintenance']['status'];

export function latestMaintenanceAt(deviceId: string, atMs: number): MaintenanceTest | null {
  const past = maintenanceTests
    .filter(m => m.deviceId === deviceId && Date.parse(m.testedAt) <= atMs)
    .sort((a, b) => Date.parse(b.testedAt) - Date.parse(a.testedAt));
  return past[0] ?? null;
}

export function evaluateMaintenance(device: ProtectionDevice, atMs: number): { status: MaintenanceStatus; test: MaintenanceTest | null; finding: Finding | null } {
  const test = latestMaintenanceAt(device.id, atMs);
  if (!test) {
    return {
      status: 'record-missing', test: null,
      finding: finding('maintenance-record-missing', 'warning', 'maintenance', device.id,
        `装置 ${device.id} 在指定时刻之前没有检修试验记录，故障分析结论需人工复核`)
    };
  }
  const dueMs = Date.parse(test.nextDueAt);
  if (!test.pass) {
    return {
      status: 'failed', test,
      finding: finding('maintenance-test-failed', 'blocker', 'maintenance', test.id,
        `装置 ${device.id} 最近一次检修试验 ${test.id} 结论不合格（${test.testedAt}），定值不可用于故障分析`)
    };
  }
  if (dueMs < atMs) {
    return {
      status: 'expired', test,
      finding: finding('maintenance-test-expired', 'blocker', 'maintenance', test.id,
        `装置 ${device.id} 的检修试验已于 ${test.nextDueAt} 过期，定值不可用于故障分析`)
    };
  }
  if (dueMs - atMs <= MAINTENANCE_DUE_SOON_DAYS * DAY_MS) {
    return {
      status: 'due-soon', test,
      finding: finding('maintenance-test-due-soon', 'warning', 'maintenance', test.id,
        `装置 ${device.id} 的检修试验有效期将于 ${test.nextDueAt} 届满（${MAINTENANCE_DUE_SOON_DAYS} 天内），请安排复试`)
    };
  }
  return { status: 'valid', test, finding: null };
}

// ---------- 区段（定值区）检查 ----------

export function checkSnapshotZones(snapshot: SettingSnapshot, lineOhms: number | null): Finding[] {
  const out: Finding[] = [];
  const zones = [...snapshot.zones].sort((a, b) => a.zone - b.zone);
  const seen = new Set<number>();

  for (const z of zones) {
    if (seen.has(z.zone)) {
      out.push(finding('zone-duplicate', 'blocker', 'section', `${snapshot.id}:z${z.zone}`,
        `快照 ${snapshot.id} 中段编号 ${z.zone} 重复`));
    }
    seen.add(z.zone);

    if (!Number.isFinite(z.reachOhm) || z.reachOhm <= 0) {
      out.push(finding('zone-reach-invalid', 'blocker', 'section', `${snapshot.id}:z${z.zone}`,
        `快照 ${snapshot.id} 段 ${z.zone} 整定阻抗必须为正数，实际为 ${z.reachOhm}`));
    }
    if (!Number.isFinite(z.delayMs) || z.delayMs < 0) {
      out.push(finding('zone-delay-invalid', 'blocker', 'section', `${snapshot.id}:z${z.zone}`,
        `快照 ${snapshot.id} 段 ${z.zone} 延时不能为负，实际为 ${z.delayMs}ms`));
    }
    if (z.zone === 1 && Number.isFinite(z.delayMs) && z.delayMs !== 0) {
      out.push(finding('zone1-not-instantaneous', 'blocker', 'section', `${snapshot.id}:z1`,
        `快照 ${snapshot.id} I 段必须瞬时动作，实际延时 ${z.delayMs}ms`));
    }
  }

  // 段间配合：阻抗与延时应随段号递增
  for (let i = 1; i < zones.length; i++) {
    const prev = zones[i - 1], cur = zones[i];
    if (prev.reachOhm > cur.reachOhm) {
      out.push(finding('zone-reach-not-coordinated', 'blocker', 'section', `${snapshot.id}:z${prev.zone}-z${cur.zone}`,
        `快照 ${snapshot.id} 段 ${cur.zone} 保护范围(${cur.reachOhm}Ω)小于段 ${prev.zone}(${prev.reachOhm}Ω)，失去配合`));
    }
    if (prev.delayMs > cur.delayMs) {
      out.push(finding('zone-delay-not-coordinated', 'blocker', 'section', `${snapshot.id}:z${prev.zone}-z${cur.zone}`,
        `快照 ${snapshot.id} 段 ${cur.zone} 延时(${cur.delayMs}ms)短于段 ${prev.zone}(${prev.delayMs}ms)，失去时限配合`));
    }
  }

  // 与线路全长（正序阻抗）核对
  if (lineOhms != null) {
    const z1 = zones.find(z => z.zone === 1);
    if (z1 && z1.reachOhm > 0) {
      const ratio = z1.reachOhm / lineOhms;
      if (ratio > Z1_OVERREACH_BLOCK_RATIO) {
        out.push(finding('zone1-overreach', 'blocker', 'section', `${snapshot.id}:z1`,
          `快照 ${snapshot.id} I 段保护范围 ${z1.reachOhm}Ω 为线路正序阻抗 ${lineOhms.toFixed(3)}Ω 的 ${ratio.toFixed(2)} 倍，严重超越`));
      } else if (ratio > Z1_OVERREACH_WARN_RATIO) {
        out.push(finding('zone1-overreach-marginal', 'warning', 'section', `${snapshot.id}:z1`,
          `快照 ${snapshot.id} I 段保护范围 ${z1.reachOhm}Ω 略超线路正序阻抗 ${lineOhms.toFixed(3)}Ω（${(ratio * 100).toFixed(1)}%），存在超越风险`));
      }
    }
    for (const z of zones.filter(z => z.zone >= 2)) {
      const ratio = z.reachOhm / lineOhms;
      if (ratio > BACKUP_OVERREACH_WARN_RATIO) {
        out.push(finding('backup-zone-overreach', 'warning', 'section', `${snapshot.id}:z${z.zone}`,
          `快照 ${snapshot.id} 段 ${z.zone} 保护范围 ${z.reachOhm}Ω 超过线路全长阻抗的 ${(ratio * 100).toFixed(0)}%，核对对侧配合`));
      }
    }
  }

  return out;
}

// ---------- 线路参数 ----------

export function checkLineParams(line: any): Finding[] {
  const out: Finding[] = [];
  const requirePositive = (field: string, label: string) => {
    const v = line[field];
    if (!Number.isFinite(v) || v <= 0) {
      out.push(finding('line-parameter-invalid', 'blocker', 'line', line.id,
        `线路 ${line.id} 的${label}必须为正数，实际为 ${v}`));
    }
  };
  requirePositive('lengthKm', '长度');
  requirePositive('positiveSequenceOhmPerKm', '正序阻抗参数');
  requirePositive('zeroSequenceOhmPerKm', '零序阻抗参数');
  if (Number.isFinite(line.zeroSequenceOhmPerKm) && Number.isFinite(line.positiveSequenceOhmPerKm)
    && line.zeroSequenceOhmPerKm < line.positiveSequenceOhmPerKm) {
    out.push(finding('line-sequence-ratio-invalid', 'blocker', 'line', line.id,
      `线路 ${line.id} 零序阻抗(${line.zeroSequenceOhmPerKm})小于正序阻抗(${line.positiveSequenceOhmPerKm})，参数异常`));
  }
  if (line.status && line.status !== 'energized') {
    out.push(finding('line-not-energized', 'warning', 'line', line.id,
      `线路 ${line.id} 当前状态为 ${line.status}，故障分析前确认运行方式`));
  }
  return out;
}

function linePositiveOhms(line: any): number | null {
  if (!Number.isFinite(line.lengthKm) || !Number.isFinite(line.positiveSequenceOhmPerKm)
    || line.lengthKm <= 0 || line.positiveSequenceOhmPerKm <= 0) return null;
  return line.lengthKm * line.positiveSequenceOhmPerKm;
}

// ---------- 边界电流 ----------

export function checkShortCircuitKa(raw: unknown): { value: number | null; findings: Finding[] } {
  if (raw == null || raw === '') return { value: null, findings: [] };
  const findings: Finding[] = [];
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    findings.push(finding('short-circuit-current-invalid', 'blocker', 'input', 'shortCircuitKa',
      `短路电流值无法解析: ${String(raw)}`));
    return { value: null, findings };
  }
  // 边界值本身合法：[min, max] 闭区间
  if (value < SHORT_CIRCUIT_MIN_KA) {
    findings.push(finding('short-circuit-current-too-low', 'blocker', 'input', 'shortCircuitKa',
      `短路电流 ${value}kA 低于工程最小值 ${SHORT_CIRCUIT_MIN_KA}kA`));
  } else if (value <= SHORT_CIRCUIT_MIN_KA * (1 + SHORT_CIRCUIT_BOUNDARY_TOLERANCE)) {
    findings.push(finding('short-circuit-current-near-min', 'warning', 'input', 'shortCircuitKa',
      `短路电流 ${value}kA 接近工程下限 ${SHORT_CIRCUIT_MIN_KA}kA，确认采样量程`));
  }
  if (value > SHORT_CIRCUIT_MAX_KA) {
    findings.push(finding('short-circuit-current-too-high', 'blocker', 'input', 'shortCircuitKa',
      `短路电流 ${value}kA 超过最大校验边界 ${SHORT_CIRCUIT_MAX_KA}kA`));
  } else if (value >= SHORT_CIRCUIT_MAX_KA * (1 - SHORT_CIRCUIT_BOUNDARY_TOLERANCE)) {
    findings.push(finding('short-circuit-current-near-max', 'warning', 'input', 'shortCircuitKa',
      `短路电流 ${value}kA 接近最大校验边界 ${SHORT_CIRCUIT_MAX_KA}kA，确认装置开断能力`));
  }
  return { value, findings };
}

// ---------- 装置 ----------

export function checkDevice(device: ProtectionDevice, selection: SnapshotSelection): Finding[] {
  const out: Finding[] = [];
  if (!device.enabled) {
    out.push(finding('device-disabled', 'blocker', 'device', device.id,
      `装置 ${device.id} 处于停用状态，其定值不能用于故障分析`));
  }
  if (selection.status === 'selected') {
    const snap = selection.snapshot;
    if (device.settingsVersion !== snap.id) {
      out.push(finding('device-version-mismatch', 'warning', 'device', device.id,
        `装置 ${device.id} 当前引用版本 ${device.settingsVersion}，与指定时刻有效快照 ${snap.id} 不一致，按装置当时实际版本另行核实`));
    }
  }
  return out;
}

// ---------- 主入口（扩展校验） ----------

export type ValidateSettingsInput = {
  lineId?: string;
  at?: string | number;
  shortCircuitKa?: number | string;
  deviceIds?: string[];
  nowIso?: string;
};

export function validateSettingsAt(input: ValidateSettingsInput = {}): SettingsValidationResult {
  const nowIso = input.nowIso ?? new Date().toISOString();
  const { iso: effectiveAt, ms: atMs } = parseRequestedAt(input.at, nowIso);
  const { value: shortCircuitKa, findings: currentFindings } = checkShortCircuitKa(input.shortCircuitKa);

  const blockers: Finding[] = [...currentFindings.filter(f => f.severity === 'blocker')];
  const warnings: Finding[] = [...currentFindings.filter(f => f.severity === 'warning')];
  const deviceResults: DeviceCheckResult[] = [];

  const line = lines.find(l => l.id === input.lineId);
  if (!line) {
    blockers.push(finding('line-not-found', 'blocker', 'line', String(input.lineId),
      `线路 ${String(input.lineId)} 不存在，无法进行定值校验`));
    return assemble({ lineId: String(input.lineId), effectiveAt, atMs, shortCircuitKa, selection: null, blockers, warnings, devices: deviceResults });
  }

  const lineFindings = checkLineParams(line);
  blockers.push(...lineFindings.filter(f => f.severity === 'blocker'));
  warnings.push(...lineFindings.filter(f => f.severity === 'warning'));

  // 目标装置范围
  let targetDevices: ProtectionDevice[] = devices.filter(d => d.lineId === line.id);
  if (input.deviceIds && input.deviceIds.length > 0) {
    for (const id of input.deviceIds) {
      const d = devices.find(x => x.id === id);
      if (!d) {
        blockers.push(finding('device-not-found', 'blocker', 'device', id,
          `装置 ${id} 不存在`));
      } else if (d.lineId !== line.id) {
        blockers.push(finding('device-not-on-line', 'blocker', 'device', id,
          `装置 ${id} 不属于线路 ${line.id}（归属 ${d.lineId}）`));
      }
    }
    targetDevices = targetDevices.filter(d => input.deviceIds!.includes(d.id));
  }
  if (targetDevices.length === 0 && blockers.every(f => f.code !== 'device-not-found' && f.code !== 'device-not-on-line')) {
    warnings.push(finding('protection-device-missing', 'warning', 'device', line.id,
      `线路 ${line.id} 上没有任何可校验的保护装置`));
  }

  // 历史快照选择（区分三种缺失原因）
  const referenced = Array.from(new Set(targetDevices.map(d => d.settingsVersion)));
  const selection = selectEffectiveSnapshot(line.id, atMs, referenced);

  if (selection.status === 'missing') {
    blockers.push(finding(selection.code, 'blocker', selection.scope, selection.ref, selection.message));
  } else {
    const lineOhms = linePositiveOhms(line);
    const zoneFindings = checkSnapshotZones(selection.snapshot, lineOhms);
    blockers.push(...zoneFindings.filter(f => f.severity === 'blocker'));
    warnings.push(...zoneFindings.filter(f => f.severity === 'warning'));
  }

  // 装置：启用状态、版本漂移、检修试验有效期
  for (const device of targetDevices) {
    const deviceFindings = checkDevice(device, selection);
    const dBlockers: Finding[] = deviceFindings.filter(f => f.severity === 'blocker');
    const dWarnings: Finding[] = deviceFindings.filter(f => f.severity === 'warning');

    const maint = evaluateMaintenance(device, atMs);
    if (maint.finding) {
      (maint.finding.severity === 'blocker' ? dBlockers : dWarnings).push(maint.finding);
    }

    blockers.push(...dBlockers);
    warnings.push(...dWarnings);

    deviceResults.push({
      deviceId: device.id,
      enabled: device.enabled,
      settingsVersion: device.settingsVersion,
      versionMatchesSnapshot: selection.status === 'selected' ? device.settingsVersion === selection.snapshot.id : null,
      maintenance: {
        status: maint.status,
        testId: maint.test?.id,
        testedAt: maint.test?.testedAt,
        nextDueAt: maint.test?.nextDueAt
      },
      blockers: dBlockers,
      warnings: dWarnings
    });
  }

  return assemble({ lineId: line.id, effectiveAt, atMs, shortCircuitKa, selection, blockers, warnings, devices: deviceResults });
}

function assemble(args: {
  lineId: string; effectiveAt: string; atMs: number; shortCircuitKa: number | null;
  selection: SnapshotSelection | null; blockers: Finding[]; warnings: Finding[]; devices: DeviceCheckResult[];
}): SettingsValidationResult {
  return {
    mode: 'extended',
    lineId: args.lineId,
    checkedAt: args.effectiveAt,
    effectiveAt: args.effectiveAt,
    snapshot: args.selection ?? {
      status: 'missing', code: 'snapshot-not-evaluated', scope: 'snapshot',
      message: '线路不存在，未进行快照选择'
    },
    shortCircuitKa: args.shortCircuitKa,
    blockers: args.blockers,
    warnings: args.warnings,
    devices: args.devices,
    valid: args.blockers.length === 0,
    errors: args.blockers.map(f => `${f.code}: ${f.message}`)
  };
}

// ---------- 旧逻辑（保持旧调用返回不变） ----------

export function validateLegacySettings(body: any, checkedAtIso: string): { valid: boolean; errors: string[]; checkedAt: string } {
  const errors: string[] = [];
  for (const d of devices) {
    for (const z of d.zones) {
      if (z.reachOhm <= 0) errors.push(`${d.id}: zone ${z.zone} reach must be positive`);
      if (z.zone === 1 && z.delayMs !== 0) errors.push(`${d.id}: zone 1 must be instantaneous`);
    }
  }
  if (body?.shortCircuitKa != null && Number(body.shortCircuitKa) < SHORT_CIRCUIT_MIN_KA) {
    errors.push('shortCircuitKa below engineering minimum');
  }
  return { valid: errors.length === 0, errors, checkedAt: checkedAtIso };
}

// ---------- 工具 ----------

function finding(code: string, severity: Severity, scope: Finding['scope'], ref: string | undefined, message: string): Finding {
  return { code, severity, scope, ...(ref != null ? { ref } : {}), message };
}
