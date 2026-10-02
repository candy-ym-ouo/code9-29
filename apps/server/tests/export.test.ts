import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import request from 'supertest';

/**
 * 导出边界回归测试：
 * 导出结果只能包含当前库的数据及其直接关系——
 * 没有 library_id 列的关系表（inspiration_tag / album_item / album_gap / album_snapshot）
 * 不得整表泄出别库记录，也不得保留指向他库记录的越界引用。
 */

let app: Express;
let tmpDir = '';
let tokenA = '';
let tokenB = '';
let libraryA = '';
let libraryB = '';

// A 库实体
let inspA = '';
let tagA = '';
let albumA = '';
let placeA = '';
let spotA = '';
// B 库实体
let inspB = '';
let tagB = '';
let albumB = '';
let placeB = '';
let spotB = '';

function call(method: 'get' | 'post', url: string, token: string, body?: unknown) {
  let req = request(app)[method](url).set('authorization', `Bearer ${token}`);
  if (body !== undefined) req = req.send(body as object);
  return req;
}

/** 造一个库内的完整小数据集：灵感卡 + 标签 + 地点/机位 + 画册（含条目、缺口、发布快照） */
async function seedLibrary(token: string, title: string) {
  const insp = await call('post', '/api/inspirations', token, { title });
  expect(insp.status).toBe(201);

  const tags = await call('get', '/api/tags', token);
  const flat = (tags.body.items as { children?: { id: string }[] }[]).flatMap((g) => g.children ?? []);
  const tagId = flat[0].id;
  await call('post', '/api/inspirations/bulk-tag', token, { ids: [insp.body.id], addTagIds: [tagId] });

  const place = await call('post', '/api/places', token, { name: `${title}-地点`, city: '上海' });
  const spot = await call('post', '/api/spots', token, {
    placeId: place.body.id,
    lat: 31.2,
    lng: 121.4,
    cameraBearing: 90,
  });

  const album = await call('post', '/api/albums', token, { title: `${title}-画册`, rules: { totalMin: 1 } });
  expect(album.status).toBe(201);
  const addItem = await call('post', `/api/albums/${album.body.id}/items`, token, { inspirationId: insp.body.id });
  expect(addItem.status).toBe(201);
  const publish = await call('post', `/api/albums/${album.body.id}/publish`, token, {});
  expect(publish.status).toBe(201);

  return { inspId: insp.body.id as string, tagId, placeId: place.body.id as string, spotId: spot.body.id as string, albumId: album.body.id as string };
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flil-export-test-'));
  process.env.DATABASE_URL = path.join(tmpDir, 'app.db');
  process.env.UPLOAD_DIR = path.join(tmpDir, 'uploads');
  process.env.THUMB_DIR = path.join(tmpDir, 'thumbs');
  process.env.SHARE_DIR = path.join(tmpDir, 'share');
  process.env.BACKUP_DIR = path.join(tmpDir, 'backups');
  process.env.JWT_SECRET = 'test-secret';
  process.env.WEATHER_PROVIDER = 'fixture';
  process.env.ENABLE_CLIMATE_BASELINE = 'false';

  const { createApp } = await import('../src/app.js');
  const { migrate } = await import('../src/db.js');
  migrate();
  app = createApp();

  const regA = await request(app).post('/api/auth/register').send({
    email: 'owner-a@test.local',
    password: 'password123',
    displayName: '库A所有者',
  });
  const regB = await request(app).post('/api/auth/register').send({
    email: 'owner-b@test.local',
    password: 'password123',
    displayName: '库B所有者',
  });
  tokenA = regA.body.token;
  tokenB = regB.body.token;
  libraryA = regA.body.user.libraryId;
  libraryB = regB.body.user.libraryId;
  expect(libraryA).not.toBe(libraryB);

  const a = await seedLibrary(tokenA, 'A库卡片');
  inspA = a.inspId; tagA = a.tagId; placeA = a.placeId; spotA = a.spotId; albumA = a.albumId;
  const b = await seedLibrary(tokenB, 'B库卡片');
  inspB = b.inspId; tagB = b.tagId; placeB = b.placeId; spotB = b.spotId; albumB = b.albumId;

  // 直接落库两条"越界引用"（写入侧历史遗留/异常数据）：
  // A 库画册指向 B 库卡片、A 库卡片绑了 B 库标签。导出时必须被边界规则排除。
  const { getDb, newId, nowIso } = await import('../src/db.js');
  const db = getDb();
  db.prepare(
    "INSERT INTO album_item (id, album_id, inspiration_id, sort_order, added_by, created_at) VALUES (?,?,?,999,'manual',?)",
  ).run(newId(), albumA, inspB, nowIso());
  db.prepare(
    "INSERT INTO inspiration_tag (inspiration_id, tag_id, source, created_at) VALUES (?,?,'manual',?)",
  ).run(inspA, tagB, nowIso());
});

afterAll(async () => {
  const { closeDb } = await import('../src/db.js');
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('数据导出的库边界', () => {
  it('A 库导出只含 A 库数据，不带出 B 库任何记录', async () => {
    const res = await call('get', '/api/export/inspirations.json', tokenA);
    expect(res.status).toBe(200);
    const data = res.body as Record<string, unknown>;
    expect(data.libraryId).toBe(libraryA);

    // 有 library_id 列的表：每一行都必须属于 A 库
    const scopedTables = [
      'inspiration', 'asset', 'tag', 'composition_note', 'timing', 'repro_window',
      'reminder', 'shoot_plan', 'shoot_result', 'calibration_log', 'album',
      'share_link', 'place', 'spot',
    ];
    for (const table of scopedTables) {
      const rows = data[table] as { library_id: string }[];
      expect(Array.isArray(rows), `${table} 应为数组`).toBe(true);
      for (const row of rows) expect(row.library_id).toBe(libraryA);
    }

    // 关系表：只允许出现 A 库的引用
    const inspTagRows = data.inspiration_tag as { inspiration_id: string; tag_id: string }[];
    expect(inspTagRows.length).toBeGreaterThan(0);
    for (const row of inspTagRows) {
      expect(row.inspiration_id).toBe(inspA);
      expect(row.tag_id).toBe(tagA);
    }

    const itemRows = data.album_item as { album_id: string; inspiration_id: string }[];
    expect(itemRows).toEqual([expect.objectContaining({ album_id: albumA, inspiration_id: inspA })]);

    for (const row of data.album_gap as { album_id: string }[]) expect(row.album_id).toBe(albumA);
    const snapshots = data.album_snapshot as { album_id: string }[];
    expect(snapshots.length).toBeGreaterThan(0);
    for (const row of snapshots) expect(row.album_id).toBe(albumA);

    // 本库数据确实导出来了（ sanity check ）
    expect(data.inspiration).toEqual([expect.objectContaining({ id: inspA })]);
    expect(data.place).toEqual([expect.objectContaining({ id: placeA })]);
    expect(data.spot).toEqual([expect.objectContaining({ id: spotA })]);
    expect(data.album).toEqual([expect.objectContaining({ id: albumA })]);

    // 整份导出里不得出现 B 库的任何标识（含越界引用指向的 B 库记录）
    const raw = JSON.stringify(data);
    for (const bId of [libraryB, inspB, tagB, albumB, placeB, spotB]) {
      expect(raw.includes(bId), `导出不应包含 B 库标识 ${bId}`).toBe(false);
    }
  });

  it('B 库导出同样看不到 A 库（对称验证）', async () => {
    const res = await call('get', '/api/export/inspirations.json', tokenB);
    expect(res.status).toBe(200);
    const data = res.body as Record<string, unknown>;
    expect(data.libraryId).toBe(libraryB);

    const raw = JSON.stringify(data);
    for (const aId of [libraryA, inspA, tagA, albumA, placeA, spotA]) {
      expect(raw.includes(aId), `导出不应包含 A 库标识 ${aId}`).toBe(false);
    }
    expect(data.inspiration).toEqual([expect.objectContaining({ id: inspB })]);
    expect(data.album_item).toEqual([expect.objectContaining({ album_id: albumB, inspiration_id: inspB })]);
  });

  it('非 owner 不能导出', async () => {
    const res = await request(app).get('/api/export/inspirations.json');
    expect(res.status).toBe(401);
  });
});
