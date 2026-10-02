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
 * 边界规则：只导出当前库的数据及其直接关系，绝不带出其他库的记录。
 * - 有 library_id 列的表：直接按当前库过滤；
 * - 没有 library_id 列的关系表：经父表 JOIN 限定到当前库，且关系两端都必须
 *   落在本库内（例如 album_item 指向他库卡片的越界引用不导出），保证导出文件自洽。
 *
 * 注意：这里必须逐表显式登记口径，不允许"没有 library_id 就全表导出"的回退——
 * 新表漏登记的结果是不导出（安全方向），而不是泄出别库数据。
 */
const EXPORT_QUERIES: Record<string, string> = {
  inspiration: 'SELECT * FROM inspiration WHERE library_id = @libraryId',
  asset: 'SELECT * FROM asset WHERE library_id = @libraryId',
  tag: 'SELECT * FROM tag WHERE library_id = @libraryId',
  inspiration_tag: `SELECT it.* FROM inspiration_tag it
    JOIN inspiration i ON i.id = it.inspiration_id AND i.library_id = @libraryId
    JOIN tag t ON t.id = it.tag_id AND t.library_id = @libraryId`,
  composition_note: 'SELECT * FROM composition_note WHERE library_id = @libraryId',
  timing: 'SELECT * FROM timing WHERE library_id = @libraryId',
  repro_window: 'SELECT * FROM repro_window WHERE library_id = @libraryId',
  reminder: 'SELECT * FROM reminder WHERE library_id = @libraryId',
  shoot_plan: 'SELECT * FROM shoot_plan WHERE library_id = @libraryId',
  shoot_result: 'SELECT * FROM shoot_result WHERE library_id = @libraryId',
  calibration_log: 'SELECT * FROM calibration_log WHERE library_id = @libraryId',
  album: 'SELECT * FROM album WHERE library_id = @libraryId',
  album_item: `SELECT ai.* FROM album_item ai
    JOIN album a ON a.id = ai.album_id AND a.library_id = @libraryId
    JOIN inspiration i ON i.id = ai.inspiration_id AND i.library_id = @libraryId`,
  album_gap: `SELECT g.* FROM album_gap g
    JOIN album a ON a.id = g.album_id AND a.library_id = @libraryId`,
  album_snapshot: `SELECT s.* FROM album_snapshot s
    JOIN album a ON a.id = s.album_id AND a.library_id = @libraryId`,
  share_link: 'SELECT * FROM share_link WHERE library_id = @libraryId',
  place: 'SELECT * FROM place WHERE library_id = @libraryId',
  spot: 'SELECT * FROM spot WHERE library_id = @libraryId',
};

export function exportAll(libraryId: string): Record<string, unknown> {
  const db = getDb();
  const out: Record<string, unknown> = { exportedAt: nowIso(), libraryId };
  for (const [table, sql] of Object.entries(EXPORT_QUERIES)) {
    out[table] = db.prepare(sql).all({ libraryId });
  }
  return out;
}
