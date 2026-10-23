#!/usr/bin/env node
// Reviewed private input -> existing members only. Never imports numbers, groups, services or contact data.
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, relative, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const FIELDS = ['name', 'company', 'companyPosition'];
const value = v => typeof v === 'string' ? v : '';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const inside = (parent, child) => { const p = relative(parent, child); return !p || (!p.startsWith('..') && !/^[A-Za-z]:/.test(p)); };

export function planMerge(groups, input) {
  if (input.schemaVersion !== 1 || !Array.isArray(input.rows)) throw Error('Unsupported reviewed input');
  const next = structuredClone(groups), changes = [], conflicts = [], relatedChanges = [], missingPositions = [];
  const members = next.flatMap(g => g.members.map(m => ({ m, g })));
  if (new Set(members.map(x => x.m.id)).size !== members.length) throw Error('Duplicate member IDs in master data');
  const seen = new Set();
  for (const row of input.rows) {
    if (!row.memberId || seen.has(row.memberId)) throw Error('Missing or duplicate input member ID');
    seen.add(row.memberId);
    if (!row.values || Object.keys(row.values).some(k => !FIELDS.includes(k)) || FIELDS.some(k => typeof row.values[k] !== 'string'))
      throw Error('Only explicit name, company and companyPosition strings may be merged');
    if (!row.expected || !row.identity || !row.evidence) throw Error('Reviewed identity, baseline and evidence are required');
    const found = members.find(x => x.m.id === row.memberId);
    const conflict = (reason, field, current) => conflicts.push({ memberId: row.memberId, name: row.values.name, reason, field, current });
    if (!found) { conflict('member_id_missing_review_remap'); continue; }
    const { m, g } = found;
    if (![row.identity.name, row.values.name].includes(m.name) || value(m.number) !== row.identity.number ||
        g.code !== row.identity.groupCode || g.id !== row.identity.groupId) {
      conflict('identity_changed_review_remap'); continue;
    }
    if (!row.values.name || !row.values.company) { conflict('required_name_or_company_missing'); continue; }
    if (!row.values.companyPosition) missingPositions.push({ memberId: m.id, name: m.name });
    if (members.some(x => x.m.id !== m.id && x.m.name === row.values.name)) {
      conflict('duplicate_target_name'); continue;
    }
    for (const field of FIELDS) {
      const current = value(m[field]), wanted = row.values[field];
      // Empty source is missing information, never an instruction to clear a newer value.
      if (!wanted || current === wanted) continue;
      if (!row.evidence[field]) { conflict('source_evidence_missing', field, current); continue; }
      if (current !== value(row.expected[field])) { conflict('field_changed_since_review', field, current); continue; }
      changes.push({ memberId: m.id, name: row.values.name, groupCode: g.code, field, before: current, after: wanted,
        sourceRow: row.sourceRow, evidence: row.evidence[field] });
      if (field === 'name' && g.leader === current) {
        relatedChanges.push({ groupCode: g.code, field: 'leader', before: current, after: wanted });
        g.leader = wanted;
      }
      m[field] = wanted;
    }
  }
  return { next, changes, relatedChanges, conflicts, missingPositions,
    summary: { members: members.length, reviewed: input.rows.length, changedMembers: new Set(changes.map(x => x.memberId)).size,
      changedFields: changes.length, nameChanges: changes.filter(x => x.field === 'name').length,
      companyChanges: changes.filter(x => x.field === 'company').length,
      positionChanges: changes.filter(x => x.field === 'companyPosition').length, conflicts: conflicts.length } };
}

export function runMerge(options) {
  const root = resolve(options.root || fileURLToPath(new URL('../', import.meta.url)));
  const inputPath = resolve(options.input), reportPath = resolve(options.report);
  for (const p of [inputPath, reportPath, ...(options.plan ? [resolve(options.plan)] : [])])
    if (inside(root, p)) throw Error('Private inputs, plans and audit reports must be outside the public repository');
  if (inputPath === reportPath || (options.plan && resolve(options.plan) === reportPath)) throw Error('Do not overwrite the reviewed input or dry-run plan');
  const bytes = readFileSync(inputPath), input = JSON.parse(bytes);
  const head = execFileSync(process.env.GIT_EXECUTABLE || 'git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  if (!input.baseCommit || head !== input.baseCommit) throw Error('HEAD changed; review the current checkout before regenerating input');
  const indexPath = resolve(root, 'data/_index.json'), indexBytes = readFileSync(indexPath), index = JSON.parse(indexBytes);
  const bodies = new Map(), hashes = { 'data/_index.json': digest(indexBytes) };
  const groups = index.map(entry => {
    if (!/^[A-Za-z0-9-]+$/.test(entry.code)) throw Error('Invalid group filename');
    const filename = 'data/' + entry.code.toLowerCase() + '.json', data = readFileSync(resolve(root, filename));
    if (bodies.has(filename)) throw Error('Duplicate group filename');
    const body = JSON.parse(data); bodies.set(filename, body); hashes[filename] = digest(data);
    return { ...body, ...entry };
  });
  const planned = planMerge(groups, input), { next, ...report } = planned;
  Object.assign(report, { schemaVersion: 1, baseCommit: head, sourceDigest: digest(bytes), fileHashes: hashes, applied: false });
  const saveReport = () => { mkdirSync(dirname(reportPath), { recursive: true }); writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n'); };
  if (options.apply) {
    if (!options.plan) throw Error('--apply requires a reviewed --plan from --dry-run');
    const prior = JSON.parse(readFileSync(resolve(options.plan)));
    if (prior.schemaVersion !== 1 || prior.baseCommit !== head || prior.sourceDigest !== report.sourceDigest || prior.summary?.conflicts)
      throw Error('Plan/input mismatch or unresolved conflicts');
    if (report.conflicts.length) { saveReport(); throw Error('Conflicts found; nothing was written to master data'); }
    if (report.changes.length && JSON.stringify(prior.fileHashes) !== JSON.stringify(hashes))
      throw Error('Master data changed after dry-run; create and review a fresh plan');
    // Prepare all bytes before any write. Recheck every source hash immediately before applying.
    const writes = next.flatMap(g => {
      const filename = 'data/' + g.code.toLowerCase() + '.json', body = bodies.get(filename);
      if (JSON.stringify(body.members) === JSON.stringify(g.members) && body.leader === g.leader) return [];
      return [{ filename, content: JSON.stringify({ ...body, leader: g.leader, members: g.members }, null, 2) + '\n' }];
    });
    for (const [filename, hash] of Object.entries(hashes))
      if (digest(readFileSync(resolve(root, filename))) !== hash) throw Error('Concurrent local edit; nothing was written');
    for (const write of writes) {
      const path = resolve(root, write.filename), temp = path + '.merge-' + process.pid + '.tmp';
      if (existsSync(temp)) throw Error('Unexpected staging file; inspect before retrying');
      writeFileSync(temp, write.content); renameSync(temp, path);
    }
    report.applied = true; report.writtenFiles = writes.map(x => x.filename);
  }
  saveReport();
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2), options = {};
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === '--apply') options.apply = true;
      else if (arg === '--dry-run') options.dryRun = true;
      else if (['--input', '--report', '--plan', '--root'].includes(arg) && args[i + 1]) options[arg.slice(2)] = args[++i];
      else throw Error('Unknown or incomplete argument: ' + arg);
    }
    if (!options.input || !options.report || (options.apply && options.dryRun))
      throw Error('Usage: --input PRIVATE_JSON --report PRIVATE_REPORT [--dry-run | --apply --plan PRIVATE_PLAN]');
    const report = runMerge(options); console.log(JSON.stringify({ ...report.summary, applied: report.applied }));
    if (report.conflicts.length) process.exitCode = 2;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
