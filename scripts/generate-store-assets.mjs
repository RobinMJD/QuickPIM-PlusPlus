import { chromium } from "@playwright/test";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const OUTPUT_DIR = resolve("store/assets");
const LOGO_DATA_URL = `data:image/png;base64,${readFileSync("public/img/QuickPim128.png").toString("base64")}`;

mkdirSync(OUTPUT_DIR, { recursive: true });
copyFileSync("docs/images/screenshot-02-access-setup-1280x800.png", resolve(OUTPUT_DIR, "screenshot-01-access-setup-1280x800.png"));
copyFileSync(
  "docs/images/screenshot-03-enabled-features-1280x800.png",
  resolve(OUTPUT_DIR, "screenshot-02-preferences-1280x800.png")
);

const browser = await chromium.launch({ headless: true });
try {
  await renderAsset(browser, "icon-300.png", 300, 300, `
    <main class="icon"><img src="${LOGO_DATA_URL}" alt=""></main>
  `);
  await renderAsset(browser, "small-promo-440x280.png", 440, 280, promoMarkup("small"));
  await renderAsset(browser, "large-promo-1400x560.png", 1400, 560, promoMarkup("large"));
} finally {
  await browser.close();
}

console.log(`Generated Microsoft Edge and Chrome listing assets in ${OUTPUT_DIR}.`);

function promoMarkup(size) {
  return `
    <main class="promo ${size}">
      <div class="brand"><img src="${LOGO_DATA_URL}" alt=""><span>QuickPIM++</span></div>
      <h1>Privileged access,<br>without the portal detour.</h1>
      <p>Entra roles, PIM groups, Azure roles, and bundles in one focused extension.</p>
      <div class="chips"><span>Local-first</span><span>Fast activation</span><span>MV3</span></div>
    </main>
  `;
}

async function renderAsset(browser, fileName, width, height, body) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  await page.setContent(`<!doctype html>
    <html><head><meta charset="utf-8"><style>
      *{box-sizing:border-box} html,body{margin:0;width:100%;height:100%;overflow:hidden}
      body{font-family:Arial,Helvetica,sans-serif;background:#f7f9fc;color:#101828}
      .icon{width:300px;height:300px;background:transparent}.icon img{width:300px;height:300px;display:block}
      .promo{position:relative;width:100%;height:100%;padding:34px 38px;background:#f7f9fc;overflow:hidden}
      .promo::after{content:"";position:absolute;right:0;top:0;width:16px;height:100%;background:#0aa6a6}
      .brand{display:flex;align-items:center;gap:14px;font-size:29px;font-weight:800;position:relative;z-index:1}
      .brand img{width:56px;height:56px}.promo h1{font-size:31px;line-height:1.08;margin:24px 0 12px;max-width:570px;position:relative;z-index:1}
      .promo p{font-size:16px;line-height:1.35;color:#4b5f7b;margin:0;max-width:640px;position:relative;z-index:1}
      .chips{display:flex;gap:10px;margin-top:22px;position:relative;z-index:1}.chips span{border:1px solid #bed1ea;background:#fff;border-radius:18px;padding:7px 12px;font-size:13px;font-weight:700;color:#274160}
      .large{padding:76px 90px}.large .brand{font-size:43px;gap:20px}.large .brand img{width:78px;height:78px}
      .large h1{font-size:58px;margin:38px 0 18px;max-width:850px}.large p{font-size:23px;max-width:850px}.large .chips{margin-top:28px}.large .chips span{font-size:17px;padding:9px 16px}
      .large::after{width:28px}
    </style></head><body>${body}</body></html>`);
  await page.screenshot({ path: resolve(OUTPUT_DIR, fileName), type: "png" });
  await page.close();
}
