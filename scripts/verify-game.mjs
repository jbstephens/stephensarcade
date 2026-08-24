#!/usr/bin/env node
// Stephens Arcade — per-game headless verification (the house-rules standard).
//
//   node --experimental-websocket scripts/verify-game.mjs <slug>
//   node --experimental-websocket scripts/verify-game.mjs all
//
// For games/<slug>/index.html it:
//   (a) node --check's every inline <script> block (syntax gate);
//   (b) boots it in headless Chrome with a stubbed standard-mapping pad;
//   (c) drives it generically — first paint, Enter/South past the title, ~3s of
//       play, a pause/resume START toggle — asserting ZERO real console errors
//       (offline controller.js / analytics / favicon 404s are filtered);
//   (d) reports peak drawImage / path-ops per frame vs the <150 / ~0 budget;
//   (e) writes verify-shots/<slug>.png.
// Exit non-zero if any game fails. `all` prints a summary table.
//
// Built on lib/harness.mjs — needs node --experimental-websocket (built-in WS).

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  ROOT, sleep, serveRepo, launchChrome, openPage, extractInlineScripts,
} from '../lib/harness.mjs';

const HTTP_PORT = 8972, CDP_PORT = 9372;
const SHOTS = path.join(ROOT, 'verify-shots');
const DRAW_BUDGET = 150;   // house rule: <150 drawImage/frame
const PATH_WARN = 40;      // ~0 is aspirational; flag conspicuous per-frame path work

// ── inline-JS syntax gate ────────────────────────────────────────────────────
function checkSyntax(slug) {
  const file = path.join(ROOT, 'games', slug, 'index.html');
  if (!fs.existsSync(file)) return { ok: false, detail: 'no games/' + slug + '/index.html' };
  const html = fs.readFileSync(file, 'utf8');
  const blocks = extractInlineScripts(html);
  if (!blocks.length) return { ok: true, detail: 'no inline scripts' };
  const tmp = fs.mkdtempSync('/tmp/ses-check-');
  let checked = 0;
  try {
    for (const b of blocks) {
      const f = path.join(tmp, `s${b.index}.${b.module ? 'mjs' : 'js'}`);
      fs.writeFileSync(f, b.code);
      const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
      if (r.status !== 0) return { ok: false, detail: `inline script #${b.index} syntax: ` + (r.stderr || '').trim().split('\n').slice(-3).join(' ') };
      checked++;
    }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  return { ok: true, detail: `${checked} inline script(s) OK` };
}

// ── generic runtime drive ────────────────────────────────────────────────────
async function driveGame(slug) {
  const page = await openPage(CDP_PORT, { width: 1280, height: 720 });
  try {
    await page.nav(`http://localhost:${HTTP_PORT}/games/${slug}/`);
    await page.connectPad(0);
    // Get past the title generically: keyboard Enter/Space + pad South, twice.
    for (let i = 0; i < 2; i++) {
      await page.key('Enter', 'Enter', 13);
      await page.pressPad('south');
      await sleep(120);
      await page.key(' ', 'Space', 32);
      await sleep(500);
    }
    // Did it ever render? (event-driven games — e.g. match-3 — idle between
    // moves, so a quiet steady window is legit as long as boot rendered.)
    const bootFrames = ((await page.opcounts()) || {}).frames || 0;
    // Zero the op-counters so the measured peak reflects the STEADY play window,
    // not boot / title / scene-transition transients.
    await page.eval('window.__opReset && window.__opReset()');
    // Drive ~3s of input: continuous games keep rendering; event-driven games
    // redraw on these directional/confirm nudges. (Never SELECT+START together
    // / never home — the shell reserves those for quit-to-menu.)
    const dirs = ['left', 'right', 'up', 'down'];
    for (let i = 0; i < 6; i++) {
      await page.pressPad(dirs[i % 4], 90);
      if (i % 2) await page.key('ArrowRight', 'ArrowRight', 39);
      await sleep(360);
    }
    // Best-effort pause/resume: START toggles pause in every conforming game.
    await page.pressPad('start'); await sleep(500);
    await page.pressPad('start'); await sleep(500);

    const oc = await page.opcounts();
    if (oc) oc.bootFrames = bootFrames;
    fs.mkdirSync(SHOTS, { recursive: true });
    await page.screenshot(path.join(SHOTS, `${slug}.png`));
    return { errors: page.errors.slice(), rawErrors: page.rawErrors.slice(), oc };
  } finally { await page.close(); }
}

// Sustained peak = the 5th-highest per-frame count (topX[4]); ignores up to 4
// transient spikes so a lone transition frame doesn't fail an otherwise-clean
// 60fps game. Falls back to the absolute peak when fewer frames were seen.
function sustained(top, peak) {
  if (!Array.isArray(top)) return peak || 0;
  return top[4] || 0;
}

function judge(slug, syntax, run) {
  const problems = [];
  if (!syntax.ok) problems.push('SYNTAX: ' + syntax.detail);
  if (run.errors.length) problems.push(`${run.errors.length} console error(s): ` + run.errors.slice(0, 3).join(' | '));
  const oc = run.oc || {};
  const frames = oc.frames || 0;
  // "never ran" only if nothing rendered the WHOLE session (boot included);
  // an event-driven game that idles in the steady window is fine.
  if (!frames && !(oc.bootFrames > 0)) problems.push('no animation frames observed the whole session (game never ran?)');
  const susDraw = sustained(oc.topDraw, oc.peakDraw);
  if (susDraw > DRAW_BUDGET) problems.push(`drawImage sustained ${susDraw} (peak ${oc.peakDraw}) > ${DRAW_BUDGET} budget`);
  return { slug, ok: problems.length === 0, problems, oc, frames, syntax: syntax.detail };
}

function fmtOc(oc) {
  if (!oc) return 'no frames';
  if (!oc.frames) return oc.bootFrames > 0 ? `idle in play window (${oc.bootFrames}f at boot)` : 'no frames';
  const susDraw = sustained(oc.topDraw, oc.peakDraw);
  const susPath = sustained(oc.topPath, oc.peakPath);
  const warn = susPath > PATH_WARN ? ' (!)' : '';
  return `draw=${susDraw}/${oc.peakDraw} path=${susPath}${warn}/${oc.peakPath} text=${oc.peakText} grad=${oc.peakGrad} over ${oc.frames}f`;
}

async function verifyOne(slug) {
  const syntax = checkSyntax(slug);
  let run;
  try {
    run = await driveGame(slug);
  } catch (e) {
    return { slug, ok: false, problems: ['drive threw: ' + e.message], oc: null, frames: 0, syntax: syntax.detail };
  }
  return judge(slug, syntax, run);
}

async function main() {
  const arg = process.argv[2];
  if (!arg) { console.error('usage: verify-game.mjs <slug>|all'); process.exit(2); }
  const games = JSON.parse(fs.readFileSync(path.join(ROOT, 'games.json'), 'utf8'));
  const slugs = arg === 'all' ? games.map(g => g.slug) : [arg];
  if (arg !== 'all' && !games.some(g => g.slug === arg) && !fs.existsSync(path.join(ROOT, 'games', arg, 'index.html'))) {
    console.error(`unknown game "${arg}" — not in games.json or games/`); process.exit(2);
  }

  const srv = await serveRepo({ port: HTTP_PORT });
  const chrome = await launchChrome({ port: CDP_PORT });
  const results = [];
  try {
    for (const slug of slugs) {
      process.stdout.write(`\n── verifying ${slug} …\n`);
      const r = await verifyOne(slug);
      results.push(r);
      const tag = r.ok ? 'PASS' : 'FAIL';
      console.log(`   ${tag}  ${slug}  [${fmtOc(r.oc)}]  ${r.syntax}`);
      for (const p of r.problems) console.log(`        - ${p}`);
    }
  } finally {
    chrome.kill();
    await srv.close();
  }

  console.log('\n' + '='.repeat(64));
  const pad = s => s + ' '.repeat(Math.max(0, 18 - s.length));
  console.log(pad('GAME') + pad('RESULT') + 'OP-COUNTS (peak/frame)');
  console.log('-'.repeat(64));
  for (const r of results) {
    console.log(pad(r.slug) + pad(r.ok ? 'PASS' : 'FAIL') + fmtOc(r.oc));
  }
  const fails = results.filter(r => !r.ok);
  console.log('-'.repeat(64));
  console.log(`${results.length - fails.length}/${results.length} passed`);
  if (fails.length) {
    console.log('\nFAILURES:');
    for (const f of fails) console.log(`  ${f.slug}: ${f.problems.join(' ; ')}`);
  }
  process.exit(fails.length ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
