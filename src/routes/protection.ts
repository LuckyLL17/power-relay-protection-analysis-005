import { newId } from '../core/id.js';
import type { FastifyInstance } from 'fastify';
import { devices, lines, maintenanceTests, settingSnapshots, now, log } from '../domain/state.js';
import { SettingsValidationInputError, selectEffectiveSnapshot, validateLegacySettings, validateSettingsAt } from '../services/setting-validator.js';

export async function registerProtectionRoutes(app: FastifyInstance) {
  // 定值与装置清单（只读）
  app.get('/api/protection/settings', async () => ({ snapshots: settingSnapshots, devices }));

  // 查询指定线路在指定时刻生效的历史定值快照（只读）
  app.get('/api/protection/lines/:lineId/effective-settings', async (req: any, res: any) => {
    const lineId = (req.params as any).lineId;
    const line = lines.find(l => l.id === lineId);
    if (!line) return res.code(404).send({ error: 'line not found', lineId });

    const atRaw = (req.query as any)?.at;
    let atMs: number;
    if (atRaw == null || atRaw === '') {
      atMs = Date.now();
    } else {
      atMs = Date.parse(atRaw);
      if (!Number.isFinite(atMs)) return res.code(400).send({ error: `无法解析的时间: ${atRaw}` });
    }

    const lineDevices = devices.filter(d => d.lineId === lineId);
    const referenced = Array.from(new Set(lineDevices.map(d => d.settingsVersion)));
    const selection = selectEffectiveSnapshot(lineId, atMs, referenced);

    return {
      lineId,
      at: new Date(atMs).toISOString(),
      referencedVersions: referenced,
      selection,
      availableSnapshots: settingSnapshots
        .filter(s => s.lineId === lineId)
        .sort((a, b) => Date.parse(a.effectiveAt) - Date.parse(b.effectiveAt))
    };
  });

  // 定值校验：
  // - 旧调用（请求体不含 lineId）：保持原有逻辑与返回结构不变
  // - 扩展调用（含 lineId）：按时刻选择历史快照，校验区段/线路参数、装置状态、检修有效期，
  //   blockers 与 warnings 分开返回；历史快照缺失等原因明确区分，绝不以当前配置冒充成功。
  //   本接口为纯只读校验，不修改任何业务数据。
  app.post('/api/protection/settings/validate', async (req: any, res: any) => {
    const b = (req.body as any) || {};
    if (b.lineId == null) {
      return validateLegacySettings(b, now());
    }
    try {
      return validateSettingsAt({
        lineId: b.lineId,
        at: b.at,
        shortCircuitKa: b.shortCircuitKa,
        deviceIds: Array.isArray(b.deviceIds) ? b.deviceIds : undefined
      });
    } catch (e) {
      if (e instanceof SettingsValidationInputError) {
        return res.code(400).send({ error: e.message });
      }
      throw e;
    }
  });

  // 登记检修试验结果（原有写入接口，保持不变）
  app.post('/api/maintenance/tests', async (req: any, res: any) => {
    const b = req.body as any;
    if (!b.deviceId || !b.testType) return res.code(400).send({ error: 'deviceId 和 testType 必填' });
    const d = devices.find(x => x.id === b.deviceId);
    if (!d) return res.code(404).send({ error: 'device not found' });
    const result = {
      id: newId(), deviceId: d.id, testType: b.testType,
      measurements: b.measurements || {}, pass: Boolean(b.pass),
      testedAt: now(), nextDueAt: new Date(Date.now() + 90 * 86400000).toISOString()
    };
    maintenanceTests.push(result);
    log('maintenance.test', result.id, result);
    return result;
  });
}
