import fs from 'node:fs';
import path from 'node:path';
import { getDb, nowIso } from '../db.js';
import { config } from '../config.js';
import { errors } from '../http/errors.js';

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export interface BackupInfo {
  name: string;
  path: string;
  createdAt: string;
  bytes: number;
}

function dirSize(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += dirSize(full);
    else total += fs.statSync(full).size;
  }
  return total;
}

/** 备份 = SQLite 快照（WAL 安全）+ 图片目录拷贝 */
export async function createBackup(): Promise<BackupInfo> {
  const name = stamp();
  const target = path.join(config.backupDir, name);
  fs.mkdirSync(target, { recursive: true });

  await getDb().backup(path.join(target, 'app.db'));

  for (const [sub, dir] of Object.entries({
    uploads: config.uploadDir,
    thumbs: config.thumbDir,
    share: config.shareDir,
  })) {
    if (fs.existsSync(dir)) fs.cpSync(dir, path.join(target, sub), { recursive: true });
  }

  fs.writeFileSync(
    path.join(target, 'manifest.json'),
    JSON.stringify({ createdAt: nowIso(), version: 1, dirs: ['uploads', 'thumbs', 'share'] }, null, 2),
  );

  pruneBackups();
  return { name, path: target, createdAt: nowIso(), bytes: dirSize(target) };
}

export function listBackups(): BackupInfo[] {
  if (!fs.existsSync(config.backupDir)) return [];
  return fs
    .readdirSync(config.backupDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      const full = path.join(config.backupDir, e.name);
      return {
        name: e.name,
        path: full,
        createdAt: fs.statSync(full).birthtime.toISOString(),
        bytes: dirSize(full),
      };
    })
    .sort((a, b) => (a.name < b.name ? 1 : -1));
}

function pruneBackups(): void {
  for (const old of listBackups().slice(config.backupKeep)) {
    fs.rmSync(old.path, { recursive: true, force: true });
  }
}

/** 还原：**先把当前状态自动备份一份**，再覆盖；需 confirm=true 二次确认 */
export async function restoreBackup(name: string, confirm: boolean): Promise<{ safetyBackup: string }> {
  if (!confirm) throw errors.badRequest('还原是破坏性操作，需要 confirm=true 二次确认');
  const source = path.join(config.backupDir, name);
  if (!fs.existsSync(source)) throw errors.notFound('备份');

  const safety = await createBackup();
  const db = getDb();
  db.close();

  fs.copyFileSync(path.join(source, 'app.db'), config.databaseFile);
  for (const [sub, dir] of Object.entries({
    uploads: config.uploadDir,
    thumbs: config.thumbDir,
    share: config.shareDir,
  })) {
    const from = path.join(source, sub);
    if (!fs.existsSync(from)) continue;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.cpSync(from, dir, { recursive: true });
  }

  return { safetyBackup: safety.name };
}

/**
 * 全量导出（含精确坐标，仅 owner，用于数据自持；文档 13.3 允许）
 *
 * 隔离原则（fail-closed）：每张表必须显式声明"如何限定在当前库"——
 * 有 library_id 的表直接过滤；没有 library_id 的关联表按父表归属过滤，
 * 且双外键的关联行两端都必须落在本库内（不允许越界引用其他库的记录）。
 * 未在此声明的表一律不导出，宁可漏导，不可带出其他库的数据。
 */
const EXPORT_SCOPED_QUERIES: Record<string, string> = {
  inspiration: 'SELECT * FROM inspiration WHERE library_id = ?',
  asset: 'SELECT * FROM asset WHERE library_id = ?',
  tag: 'SELECT * FROM tag WHERE library_id = ?',
  inspiration_tag: `SELECT * FROM inspiration_tag
    WHERE inspiration_id IN (SELECT id FROM inspiration WHERE library_id = ?)
      AND tag_id IN (SELECT id FROM tag WHERE library_id = ?)`,
  composition_note: 'SELECT * FROM composition_note WHERE library_id = ?',
  timing: 'SELECT * FROM timing WHERE library_id = ?',
  repro_window: 'SELECT * FROM repro_window WHERE library_id = ?',
  reminder: 'SELECT * FROM reminder WHERE library_id = ?',
  shoot_plan: 'SELECT * FROM shoot_plan WHERE library_id = ?',
  shoot_result: 'SELECT * FROM shoot_result WHERE library_id = ?',
  calibration_log: 'SELECT * FROM calibration_log WHERE library_id = ?',
  album: 'SELECT * FROM album WHERE library_id = ?',
  album_item: `SELECT * FROM album_item
    WHERE album_id IN (SELECT id FROM album WHERE library_id = ?)
      AND inspiration_id IN (SELECT id FROM inspiration WHERE library_id = ?)`,
  album_gap: 'SELECT * FROM album_gap WHERE album_id IN (SELECT id FROM album WHERE library_id = ?)',
  album_snapshot: 'SELECT * FROM album_snapshot WHERE album_id IN (SELECT id FROM album WHERE library_id = ?)',
  share_link: 'SELECT * FROM share_link WHERE library_id = ?',
  place: 'SELECT * FROM place WHERE library_id = ?',
  spot: 'SELECT * FROM spot WHERE library_id = ?',
};

export function exportAll(libraryId: string): Record<string, unknown> {
  const db = getDb();
  const out: Record<string, unknown> = { exportedAt: nowIso(), libraryId };
  for (const [table, sql] of Object.entries(EXPORT_SCOPED_QUERIES)) {
    const paramCount = (sql.match(/\?/g) ?? []).length;
    out[table] = db.prepare(sql).all(...Array<string>(paramCount).fill(libraryId));
  }
  return out;
}
