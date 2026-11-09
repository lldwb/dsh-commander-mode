/**
 * `skills/file-location-alignment` 的校验（2.3.0）。
 *
 * 这个 skill 是「用缺失否定用户」这类事故的沉淀（2026-11-09：用户说文件在
 * 「我的 iPhone > test」，模型按 App 容器去找，拿 0 个去反推用户没导出）。
 *
 * 守三件事：
 * 1. DSH 技能格式合法（frontmatter 只有 name/description/whenToUse/metadata，
 *    name 与目录名一致，description/whenToUse 非空）；
 * 2. 内容真的覆盖"列候选位置 / 说清读不到什么 / 没有必须带范围"这三条判断，
 *    并且带那条真实反例（否则以后有人"精简"文案会把要点删掉）；
 * 3. 工作流索引与阶段表都点到了它。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');
const SKILL_DIR = path.join(PACKAGE_ROOT, 'skills', 'file-location-alignment');
const SKILL_PATH = path.join(SKILL_DIR, 'SKILL.md');

/** 读技能正文并拆出 frontmatter（简易 YAML：只处理本文件用到的键）。 */
function readSkill() {
  const raw = fs.readFileSync(SKILL_PATH, 'utf8');
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/u);
  assert.ok(match, 'SKILL.md 必须有 frontmatter');
  const [, frontmatter, body] = match;
  const fields = {};
  for (const line of frontmatter.split('\n')) {
    const kv = line.match(/^([A-Za-z_-]+):\s*(.*)$/u);
    if (!kv) continue;
    fields[kv[1]] = kv[2].replace(/^['"]|['"]$/gu, '');
  }
  return { raw, fields, body };
}

test('技能目录存在，frontmatter 合法（name 与目录名一致）', () => {
  assert.ok(fs.existsSync(SKILL_PATH), `缺少 ${SKILL_PATH}`);
  const { fields } = readSkill();
  assert.equal(fields.name, 'file-location-alignment', 'name 必须等于目录名');
  assert.ok(fields.description.length > 80, 'description 要写清触发条件');
  assert.ok(fields.whenToUse.length > 10, 'whenToUse 不能为空');
  // 只允许 DSH 认识的键：多出来的键在 skill-filesystem 里会被整条丢弃。
  for (const key of Object.keys(fields)) {
    assert.ok(['name', 'description', 'whenToUse', 'metadata'].includes(key), `非法 frontmatter 键：${key}`);
  }
});

test('正文覆盖三条判断：候选位置 / 能力边界 / "没有"必须带范围', () => {
  const { body } = readSkill();
  assert.match(body, /候选位置/u);
  assert.match(body, /读不到/u);
  assert.match(body, /devicectl/u, '必须写清 iOS devicectl 的能力边界（这是事故的核心误解）');
  assert.match(body, /文件.*App|「文件」App/u, '必须点名「文件」App 与 App 容器不是一回事');
  // "没有"的写法：不允许与必须两种都要有（只写"要说清"不够）。
  assert.match(body, /0 个/u);
  assert.match(body, /查了哪些位置|查过哪些位置/u);
});

test('正文保留真实反例（事故可回查）', () => {
  const { body } = readSkill();
  assert.match(body, /2026-11-09/u);
  assert.match(body, /LiDAR诊断/u);
  assert.match(body, /diagnostics_test_output/u);
});

test('工作流索引与阶段表都点到它', () => {
  const workflow = fs.readFileSync(path.join(PACKAGE_ROOT, 'lib', 'workflow.js'), 'utf8');
  assert.match(workflow, /'file-location-alignment'/u, 'WORKFLOW_SKILLS 缺少它');
  assert.match(workflow, /file-location-alignment.*位置歧义/u, '阶段表要点到它');
});
