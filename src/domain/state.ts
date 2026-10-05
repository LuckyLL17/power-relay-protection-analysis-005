import { newId } from '../core/id.js';
import type { AuditEntry, Breaker, FaultEvent, MaintenanceTest, ProtectionDevice, Recording, SettingSnapshot } from './types.js';

export const substations = [
  { id: 'SS-A', name: '北郊变电站', voltageKv: 220 },
  { id: 'SS-B', name: '东城变电站', voltageKv: 220 },
  { id: 'SS-C', name: '工业园变电站', voltageKv: 110 }
];

export const lines = [
  { id: 'L-AB', from: 'SS-A', to: 'SS-B', lengthKm: 42.6, positiveSequenceOhmPerKm: .19, zeroSequenceOhmPerKm: .58, status: 'energized' },
  { id: 'L-BC', from: 'SS-B', to: 'SS-C', lengthKm: 18.4, positiveSequenceOhmPerKm: .24, zeroSequenceOhmPerKm: .71, status: 'energized' }
];

export const breakers: Breaker[] = [
  { id: 'BR-A1', name: '北郊侧断路器', substation: 'SS-A', state: 'closed' },
  { id: 'BR-B1', name: '东城侧断路器', substation: 'SS-B', state: 'closed' },
  { id: 'BR-C1', name: '工业园侧断路器', substation: 'SS-C', state: 'closed' }
];

export const devices: ProtectionDevice[] = [
  {
    id: 'R-A1', name: 'L-AB 北郊侧保护', type: 'distance', lineId: 'L-AB', settingsVersion: 'set-2026.09', enabled: true,
    zones: [{ zone: 1, reachOhm: 6.8, delayMs: 0 }, { zone: 2, reachOhm: 7.6, delayMs: 350 }, { zone: 3, reachOhm: 8.1, delayMs: 900 }]
  },
  {
    id: 'R-B1', name: 'L-AB 东城侧保护', type: 'distance', lineId: 'L-AB', settingsVersion: 'set-2026.09', enabled: true,
    zones: [{ zone: 1, reachOhm: 6.8, delayMs: 0 }, { zone: 2, reachOhm: 7.6, delayMs: 350 }, { zone: 3, reachOhm: 8.1, delayMs: 900 }]
  },
  {
    id: 'R-BC', name: 'L-BC 差动保护', type: 'differential', lineId: 'L-BC', settingsVersion: 'set-2026.08', enabled: true,
    zones: [{ zone: 1, reachOhm: 4.0, delayMs: 0 }]
  },
  {
    id: 'R-A2', name: 'L-AB 北郊侧后备保护', type: 'overcurrent', lineId: 'L-AB', settingsVersion: 'set-2026.09', enabled: false,
    zones: [{ zone: 1, reachOhm: 6.8, delayMs: 0 }, { zone: 2, reachOhm: 7.6, delayMs: 350 }]
  }
];

export const settingSnapshots: SettingSnapshot[] = [
  {
    id: 'set-2026.03', lineId: 'L-AB', effectiveAt: '2026-03-01T00:00:00.000Z', author: 'protection-engineering',
    reason: '春季检修定值', checksum: 'sha256:relay-202603',
    zones: [{ zone: 1, reachOhm: 6.2, delayMs: 0 }, { zone: 2, reachOhm: 7.0, delayMs: 300 }, { zone: 3, reachOhm: 7.6, delayMs: 900 }]
  },
  {
    id: 'set-2026.09', lineId: 'L-AB', effectiveAt: '2026-09-01T00:00:00.000Z', author: 'protection-engineering',
    reason: '季节运行方式调整', checksum: 'sha256:relay-202609',
    zones: [{ zone: 1, reachOhm: 6.8, delayMs: 0 }, { zone: 2, reachOhm: 7.6, delayMs: 350 }, { zone: 3, reachOhm: 8.1, delayMs: 900 }]
  }
];

export const recordings: Recording[] = [];
export const events: FaultEvent[] = [];
export const analyses: any[] = [];
export const topologyChanges: any[] = [];
export const audits: AuditEntry[] = [];

const DAY_MS = 86_400_000;
function daysAgoIso(days: number): string { return new Date(Date.now() - days * DAY_MS).toISOString(); }
function daysAheadIso(days: number): string { return new Date(Date.now() + days * DAY_MS).toISOString(); }

export const maintenanceTests: MaintenanceTest[] = [
  // R-A1：已做试验，有效期 30 天后（当前有效）
  { id: 'mt-ra1-ok', deviceId: 'R-A1', testType: 'periodic', measurements: { pickupA: 1.02, tripMs: 38 }, pass: true, testedAt: daysAgoIso(60), nextDueAt: daysAheadIso(30) },
  // R-B1：试验已过期 20 天
  { id: 'mt-rb1-expired', deviceId: 'R-B1', testType: 'periodic', measurements: { pickupA: 1.05, tripMs: 41 }, pass: true, testedAt: daysAgoIso(110), nextDueAt: daysAgoIso(20) },
  // R-A2：上次试验不合格；按当前时刻看下次到期日还有 7 天（临期），但不合格优先
  { id: 'mt-ra2-failed', deviceId: 'R-A2', testType: 'periodic', measurements: { pickupA: 1.31, tripMs: 66 }, pass: false, testedAt: daysAgoIso(83), nextDueAt: daysAheadIso(7) },
  // R-BC：无任何检修试验记录（维护记录缺失）
];

export const now = () => new Date().toISOString();
export function log(action: string, entity: string, payload: any) { audits.push({ id: newId(), time: now(), action, entity, payload }); }
