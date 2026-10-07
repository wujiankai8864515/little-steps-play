/* Presentation-only host preboot; all game pages and interactions are Godot nodes. */
(function (root, factory) {
'use strict';
const api = factory();
if (typeof module === 'object' && module.exports) module.exports = api;
else if (!root.TravelHostPreboot) {
root.TravelHostPreboot = api.create(root, root.document, root.TRAVEL_HOST_CONFIG);
root.TravelHostPreboot.start().catch(root.TravelHostPreboot.fail);
}
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
'use strict';
const MANIFEST_LIMIT = 256 * 1024;
function afterPaint(window) {
return new Promise(resolve => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve)));
}
async function readManifest(response) {
if (!response.ok) throw new Error('资源目录请求失败：HTTP ' + response.status);
if (!response.body || !response.body.getReader) throw new Error('浏览器不支持资源流读取。');
const reader = response.body.getReader();
const buffer = new Uint8Array(MANIFEST_LIMIT);
let offset = 0;
try {
for (;;) {
const part = await reader.read();
if (part.done) break;
if (offset + part.value.length > MANIFEST_LIMIT) throw new Error('资源目录超过安全大小限制。');
buffer.set(part.value, offset); offset += part.value.length;
}
return JSON.parse(new TextDecoder().decode(buffer.subarray(0, offset)));
} catch (error) { await reader.cancel().catch(() => {}); throw error; }
finally { reader.releaseLock(); }
}
function startupLedger(manifest, config, packs) {
const selected = new Set(); const visiting = new Set(); const visited = new Set();
function visit(id, table, callback) {
const key = (table === manifest.groups ? 'group:' : 'pack:') + id;
if (visited.has(key)) return;
if (visiting.has(key) || !table || !Object.hasOwn(table,id)) throw new Error('启动资源依赖目录无效。');
visiting.add(key);
const deps = table[id].depends_on || [];
if (!Array.isArray(deps)) throw new Error('启动资源依赖目录无效。');
deps.forEach(dep => visit(dep,table,callback));
callback(id); visiting.delete(key); visited.add(key);
}
const addPack = id => visit(id,manifest.packs,key => selected.add(key));
visit('login',manifest.groups,id => addPack((manifest.group_to_pack || {})[id]));
for (const pack of packs.values()) if (pack.startup) selected.add(pack.id);
const wasm = (config.godot.fileSizes || {})[config.godot.executable + '.wasm'];
if (!Number.isSafeInteger(wasm) || wasm <= 0) throw new Error('引擎下载大小缺失。');
const core = Array.from(packs.values()).find(pack => pack.startup);
const login = Array.from(selected).filter(id => id !== core.id);
const loginTotal = login.reduce((sum,id) => sum + packs.get(id).bytes,0);
return {pack_ids:Array.from(selected).sort(), engine_total:wasm+core.bytes, login_total:loginTotal,
total:wasm+core.bytes+loginTotal, engine_loaded:0, login_loaded:0, observed_high_water:0, retries:0, complete:false};
}
function create(window, document, config) {
const overlay = document.getElementById('host-preboot');
const progress = document.getElementById('host-progress');
const progressFrame = document.getElementById('host-progress-frame');
const status = document.getElementById('host-status');
const retry = document.getElementById('host-retry');
const canvas = document.getElementById('canvas');
const poster = document.getElementById('host-first-frame');
const actorCanvas = document.getElementById('host-poster');
const now = () => (window.performance || performance).now();
const metrics = {shell_initialized_ms: now(), shell_paint_opportunity_ms:null, poster_decode_settled_ms: null, actor_decode_settled_ms: null, actor_first_draw_ms: null, paint_opportunity_ms: null,
engine_script_start_ms: null, engine_script_ready_ms: null, engine_start_begin_ms: null,
engine_started_ms: null, godot_ready_signal_ms: null, preboot_hidden_ms: null,
first_contentful_paint_ms: null, status: 'preboot', stage: 'shell', stages: [], progress: null};
let engineStarted = false;
let gameReady = false;
let revealing = false;
let failed = false;
let startPromise = null;
let rejectBoot = null;
let resolveFirstDraw = null;
let rejectFirstDraw = null;
let failure = null;
let watchdog = null;
let transport = null;
let rejectEngineReady = null;
let bootAbort = null;
let activeEngine = null;
let activeScript = null;
let removeStartupListener = null;
let ledger = null;
let loginReady = false;
let nativeRank = 0;
let actor = null;
let actorMetrics = null;
let closeListener = null;
let nativeStage = false;
const pendingPaints = new Map();
function stage(name, label) {
if (failed || metrics.status === 'godot') return;
if (metrics.stage !== name) metrics.stages.push({stage: name, at_ms: now()});
metrics.stage = name;
const current = ledger ? ledger.engine_loaded + ledger.login_loaded : 0;
const total = ledger ? ledger.total : 0;
if(ledger && current>ledger.observed_high_water)ledger.observed_high_water=current;
const high=ledger ? ledger.observed_high_water : 0, paused=current<high;
const fraction = ledger && ledger.complete ? 1 : total ? Math.min(0.99, Math.floor(high / total * 100) / 100) : 0;
if(paused)label='进度等待，正在重试…\n当前已接收 '+current+'/'+total+' B';
metrics.progress = {current,total,observed_high_water:high,paused,display_fraction:fraction,mode:'determinate',fraction,
downloads_complete:total > 0 && current === total, complete:!!(ledger && ledger.complete)};
status.textContent = label;
progress.setAttribute('aria-valuetext',label);
if (progressFrame) {
progressFrame.setAttribute('data-mode', 'determinate');
progressFrame.setAttribute('data-empty', fraction === 0 ? 'true' : 'false');
if (progressFrame.style && progressFrame.style.setProperty) progressFrame.style.setProperty('--fraction',String(fraction));
}
progress.max = 1; progress.value = fraction;
}
function downloadLabel() {
const current = ledger.engine_loaded + ledger.login_loaded;
return '正在下载启动资源… ' + Math.floor(current / ledger.total * 100) + '%';
}
function getLoadingElapsedMsec() {
return metrics.shell_paint_opportunity_ms === null ? 0 : Math.max(0,now()-metrics.shell_paint_opportunity_ms);
}
function reportGameStage(name, current=-1, total=-1) {
const labels = {engine_boot:'正在打开游戏画面…', login_download:'正在加载资源…', login_retry:'下载中断，正在重试…', resource_prewarm:'正在准备资源…', login_scene:'正在打开小屋…', login_ready:'准备完成', login_failed:'准备小屋失败，请重新加载。'};
const ranks = {engine_boot:1,login_download:2,login_retry:2,resource_prewarm:3,login_scene:4,login_ready:5,login_failed:6};
if (failed || loginReady || !Object.hasOwn(labels,name) || ranks[name] < nativeRank) return false;
if (name === 'login_failed') {fail(new Error(labels[name]));return true;}
nativeStage = true; nativeRank = ranks[name];
let label = labels[name];
if (name === 'login_download' || name === 'login_retry') {
if (ledger && Number.isSafeInteger(current) && total === ledger.login_total && current >= 0 && current <= total) {
if (current < ledger.login_loaded) ledger.retries++;
ledger.login_loaded=current;
label=current === total ? '资源已下载，正在校验和挂载…' : downloadLabel();
}
}
if (name === 'resource_prewarm' && Number.isSafeInteger(total) && total > 0 && current >= 0 && current <= total) label += ' ' + current + '/' + total;
if (name === 'login_ready') {
if (!ledger || ledger.login_loaded !== ledger.login_total) {fail(new Error('登录已报告就绪，但启动资源下载记录尚不完整。'));return false;}
loginReady = true; metrics.login_ready_signal_ms=now();
}
stage(name,label);
if (loginReady) void revealIfReady().catch(fail);
return true;
}
function stopPresentation() {
if (poster) poster.hidden = false;
if (actorCanvas && actorCanvas.style) actorCanvas.style.visibility = 'hidden';
if (actor) {actor.dispose();actorMetrics=actor.getMetrics();actor=null;}
if (closeListener) {window.removeEventListener('pagehide',closeListener);closeListener=null;}
for (const [id,reject] of pendingPaints) {if(window.cancelAnimationFrame)window.cancelAnimationFrame(id);reject(failure || new Error('启动已关闭。'));}
pendingPaints.clear();
}
function paintFrame() {
return new Promise((resolve,reject)=>{
const id=window.requestAnimationFrame(()=>{
pendingPaints.delete(id);
if(failed)reject(failure);else resolve();
});
pendingPaints.set(id,reject);
});
}
async function waitForPaint() {await paintFrame();await paintFrame();}
function clearWatchdog() {
if (watchdog !== null) window.clearTimeout(watchdog);
watchdog = null;
}
function fail(error, closing=false) {
if (failed) return;
failure = error instanceof Error ? error : new Error(String(error));
failed = true;
metrics.status = closing ? 'closed' : 'failed';
metrics.failure_reason = failure.message;
clearWatchdog();
stopPresentation();
if (removeStartupListener) removeStartupListener();
if (bootAbort) bootAbort.abort();
if (activeScript) {
activeScript.onload = null; activeScript.onerror = null;
if (activeScript.remove) activeScript.remove();
activeScript = null;
}
if (transport) transport.close();
if (activeEngine) { try { activeEngine.requestQuit(); } catch (_) { /* Failure notice stays visible. */ } }
if (rejectEngineReady) rejectEngineReady(error instanceof Error ? error : new Error(String(error)));
if (rejectBoot) rejectBoot(failure);
if (rejectFirstDraw) rejectFirstDraw(failure);
overlay.hidden = closing;
overlay.setAttribute('data-state', closing ? 'closed' : 'failed');
overlay.setAttribute('aria-busy', 'false');
progress.hidden = true;
if (progressFrame) progressFrame.hidden = true;
status.textContent = '游戏启动失败。\n' + (error && error.message ? error.message : String(error));
retry.hidden = closing;
if (!closing) window.console.error('[Travel host preboot]', error);
}
function close() {fail(new Error('启动页面已关闭。'),true);}
async function revealIfReady() {
if (!engineStarted || !gameReady || !loginReady || failed || revealing || overlay.hidden) return;
revealing = true;
while (getLoadingElapsedMsec() < 1000) {await paintFrame();if(failed)return;}
ledger.complete = true;
metrics.minimum_loading_visible_msec = getLoadingElapsedMsec();
stage('login_ready','准备完成');
await waitForPaint();
if (failed) return;
clearWatchdog();
stopPresentation();
overlay.hidden = true;
metrics.preboot_hidden_ms = now();
metrics.status = 'godot';
overlay.setAttribute('aria-busy', 'false');
canvas.focus();
if (resolveFirstDraw) resolveFirstDraw();
}
function markGameReady() {
if (failed) return;
gameReady = true;
if (metrics.godot_ready_signal_ms === null) metrics.godot_ready_signal_ms = now();
void revealIfReady().catch(fail);
}
function onProgress(current, total) {
if (failed || overlay.hidden || engineStarted || nativeStage || !ledger) return;
if (Number.isSafeInteger(current) && current >= 0 && current <= ledger.engine_total) {
if (current < ledger.engine_loaded) {ledger.retries++;}
ledger.engine_loaded=current;
}
if (ledger.engine_loaded === ledger.engine_total) stage('engine_init','启动资源已下载，正在初始化引擎…');
else stage('download',downloadLabel());
}
function loadEngineScript(url) {
return new Promise((resolve, reject) => {
const script = document.createElement('script');
activeScript = script;
script.src = url; script.async = true;
script.onload = () => { activeScript = null; resolve(); };
script.onerror = () => { activeScript = null; reject(new Error('引擎启动脚本下载失败，请检查网络后重试。')); };
document.body.appendChild(script);
});
}
function observeStartupFailures(engineURL) {
if (!window.addEventListener) return;
const listener = event => {
const error = event.reason;
if (engineStarted || failed || !error || typeof error.stack !== 'string') return;
const wasm = window.WebAssembly;
const isWasmError = wasm && ((wasm.CompileError && error instanceof wasm.CompileError)
|| (wasm.LinkError && error instanceof wasm.LinkError));
if (isWasmError && error.stack.includes(engineURL)) fail(error);
};
window.addEventListener('unhandledrejection', listener);
removeStartupListener = () => {
window.removeEventListener('unhandledrejection', listener);
removeStartupListener = null;
};
}
function onPrintError(...args) {
window.console.error(...args);
if (failed || engineStarted) return;
const message = args.map(String).join(' ');
if (/failed to asynchronously prepare wasm|Aborted\([^\n]*(?:CompileError|LinkError)|wasm streaming compile failed[^\n]*(?:CompileError|expected magic)|WebAssembly[^\n]*expected magic/i.test(message)) {
fail(new Error('WASM 引擎初始化失败：' + message));
}
}
async function run() {
if (failed) throw failure;
if (window.TRAVEL_HOST_SCRIPT_FAILED) throw new Error('启动文件加载失败，请检查网络后重试。');
if (!config || !config.godot || !window.TravelResourceTransport) throw new Error('启动配置或资源传输脚本缺失。');
if (!window.TravelHostActor) throw new Error('启动动效脚本缺失。');
actor = window.TravelHostActor.create(window,document,document.getElementById('host-poster'));
await actor.start();
if (failed) return;
metrics.actor_decode_settled_ms = now();
metrics.actor_first_draw_ms = actor.getMetrics().first_draw_ms;
if (actorCanvas && actorCanvas.style) actorCanvas.style.visibility = 'visible';
if (poster) poster.hidden = true;
await waitForPaint();
metrics.paint_opportunity_ms = now();
if (failed) return;
stage('manifest', '正在读取资源目录…');
bootAbort = new window.AbortController();
const base = new URL(document.baseURI);
const manifestURL = new URL(config.manifestURL, base);
if (manifestURL.origin !== base.origin) throw new Error('资源目录必须与游戏同源。');
const manifest = await readManifest(await window.fetch(manifestURL.href, {
cache: 'no-cache', credentials: 'same-origin', redirect: 'error', signal: bootAbort.signal
}));
if (failed) return;
const groups = window.TravelResourceTransport.validateManifest(manifest);
const core = Array.from(groups.values()).find(pack => pack.startup);
ledger = startupLedger(manifest,config,groups);
if (!window.crypto || !window.crypto.subtle) throw new Error('资源完整性校验需要安全上下文中的 Web Crypto。');
const engineConfig = Object.assign({}, config.godot, {
mainPack: core.path, canvas,
fileSizes: Object.assign({}, config.godot.fileSizes || {}, {[core.path]: core.bytes}),
onProgress, onPrintError,
onExit: code => fail(new Error('游戏运行已结束（代码 ' + code + '）。'))
});
stage('engine_script', '正在加载引擎脚本…');
metrics.engine_script_start_ms = now();
const engineURL = new URL(config.engineURL, base);
if (engineURL.origin !== base.origin) throw new Error('引擎脚本必须与游戏同源。');
if (config.cacheRevision) engineURL.searchParams.set('host_revision', config.cacheRevision);
await loadEngineScript(engineURL.href);
metrics.engine_script_ready_ms = now();
if (failed) return;
if (typeof window.Engine !== 'function') throw new Error('引擎脚本缺少官方 Engine 接口。');
const missing = window.Engine.getMissingFeatures({threads: config.threads});
if (missing.length) throw new Error('当前浏览器缺少运行能力：' + missing.join(', '));
const engine = new window.Engine(engineConfig);
activeEngine = engine;
let resolveEngineReady;
const engineReady = new Promise((resolve, reject) => { resolveEngineReady = resolve; rejectEngineReady = reject; });
engineReady.catch(() => {});
transport = window.TravelResourceTransport.createTransport({manifest, engine, engineReady,
baseURL: manifestURL.href, fetch: window.fetch.bind(window), crypto: window.crypto,
AbortController: window.AbortController, onCallbackError: error => window.console.error(error)});
window.TravelResourceHost = transport;
stage('download', '正在下载启动资源…');
metrics.engine_start_begin_ms = now();
observeStartupFailures(engineURL.href);
const firstDraw = new Promise((resolve, reject) => { resolveFirstDraw = resolve; rejectFirstDraw = reject; });
firstDraw.catch(() => {});
await engine.startGame();
metrics.engine_started_ms = now();
if (failed) return;
engineStarted = true;
ledger.engine_loaded = ledger.engine_total;
stage(metrics.stage,status.textContent);
if (removeStartupListener) removeStartupListener();
resolveEngineReady();
clearWatchdog();
watchdog = window.setTimeout(() => fail(new Error('引擎已启动，但登录首帧尚未就绪。')), 60000);
if (!nativeStage) stage('engine_boot', '正在打开游戏画面…');
await revealIfReady();
await firstDraw;
}
function start() {
if (startPromise) return startPromise;
if (failed) { startPromise = Promise.reject(failure); return startPromise; }
startPromise = new Promise((resolve, reject) => {
rejectBoot = reject;
if(window.addEventListener){closeListener=close;window.addEventListener('pagehide',closeListener);}
watchdog = window.setTimeout(() => fail(new Error('启动资源或引擎初始化超时，请检查网络后重新加载。')), 120000);
waitForPaint().then(()=>{metrics.shell_paint_opportunity_ms=now();},()=>{});
Promise.resolve().then(run).then(resolve, error => { fail(error); reject(error); });
});
return startPromise;
}
return Object.freeze({start, fail, close, markGameReady, reportGameStage, getLoadingElapsedMsec, getMetrics: () => Object.assign({}, metrics, {ledger:ledger ? Object.assign({},ledger,{pack_ids:ledger.pack_ids.slice()}) : null, stages:metrics.stages.map(value=>Object.assign({},value)), progress:metrics.progress ? Object.assign({},metrics.progress) : null, actor:actor ? actor.getMetrics() : actorMetrics})});
}
return Object.freeze({create, startupLedger, afterPaint, readManifest, MANIFEST_LIMIT});
}));
