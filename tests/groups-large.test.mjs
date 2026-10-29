import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { renderPublicGroups } from "../tools/render-public-groups.mjs";
const require = createRequire(import.meta.url);
const groups = require("../data.js");
const result = await renderPublicGroups({
  outputDirectory: process.env.GROUPS_ARTIFACT_DIR,
  groupCodes: process.env.GROUPS_PREVIEW_ONLY ? ["G"] : undefined
});
const profiles = JSON.parse(await readFile(new URL("../data/_public-profiles.json", import.meta.url)));
for (const item of result.groups) {
  const group = groups.find(g => g.code === item.code);
  assert.equal(item.width, 1170);
  assert.equal(item.rows.length, group.members.length);
  assert.deepEqual(item.fonts, { name: 28, company: 20, position: 18 });
  assert.equal(item.scale, "1.00", "大字版不得用 fit 縮小文字");
  assert.equal(item.rows.map(r => r.name).join(","), group.members.map(m => m.name).join(","));
  group.members.forEach((member, i) => {
    assert.equal(item.rows[i].company, profiles[member.id].company);
    assert.equal(item.rows[i].position, profiles[member.id].position || "職位待確認");
  });
}
if (!process.env.GROUPS_PREVIEW_ONLY) {
  assert.equal(result.groups.length, groups.length);
  // 人數跟著 data.js 走:自動同步新增夥伴不該讓測試失效。
  assert.equal(result.groups.reduce((n, g) => n + g.rows.length, 0), groups.reduce((n, g) => n + g.members.length, 0));
  assert.equal(result.pdfPages, groups.length);
  assert.ok(result.regressions.missingPosition);
  assert.ok(result.regressions.correctedName);
  assert.ok(result.regressions.originalModes);
}
console.log(`groups-large: PASS (${result.groups.length} 組；完整公司／職位、固定字級、手機閱讀、JPG${result.pdfPages ? "、" + result.pdfPages + " 頁 PDF" : ""})`);
