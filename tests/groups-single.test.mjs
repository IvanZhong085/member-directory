import { renderSingleOverview } from "../tools/render-single-overview.mjs";
const result = await renderSingleOverview();
console.log(`groups-single: PASS (${result.members} 人、完整公司、空白職稱、字級比較、手機匯出、單頁 PDF)`);
