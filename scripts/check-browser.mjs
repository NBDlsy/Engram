import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// 用独立浏览器配置加载实际发布文件，不连接用户会话或真实酒馆接口。
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
const browserPath = [
    process.env.ENGRAM_BROWSER_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
].find(candidate => candidate && existsSync(candidate));
assert.ok(browserPath, '请安装 Chrome/Chromium，或用 ENGRAM_BROWSER_PATH 指定浏览器路径');

const assetBase = '/scripts/extensions/third-party/Engram/';
const assets = new Map([manifest.js, manifest.css].map(file => [assetBase + file, file]));
const hostMarkup = nested => `<div id="top-settings-holder">${nested ? '<div>' : ''}<div id="WI-SP-button"></div>${nested ? '</div>' : ''}</div><div id="leftSendForm"></div>`;
const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/') {
        const delayed = url.searchParams.has('delayed');
        const nested = url.searchParams.has('nested');
        const stalled = url.searchParams.has('stalled');
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(`<!doctype html><html><head><link rel="stylesheet" href="${assetBase + manifest.css}"></head><body>
            <div id="host-ui">${delayed ? '' : hostMarkup(nested)}</div>
            <script>
            window.__errors = [];
            window.__browserRun = ${JSON.stringify(url.searchParams.get('run'))};
            addEventListener('error', event => window.__errors.push(event.error?.stack || event.message));
            addEventListener('unhandledrejection', event => window.__errors.push(event.reason?.stack || String(event.reason)));
            const eventSource = { on(){}, once(){}, off(){}, removeListener(){}, emit(){}, makeLast(){}, makeFirst(){} };
            const context = {
                chat: [], characters: [], characterId: null, chatId: null, name1: 'User', name2: 'Character',
                extensionSettings: {}, eventSource, event_types: {}, saveSettingsDebounced(){},
                getRequestHeaders(){return {'Content-Type': 'application/json'};}
            };
            window.SillyTavern = { getContext: () => context };
            window.toastr = { info(){}, error(){}, warning(){}, success(){} };
            window.$ = window.jQuery = () => ({ on(){}, off(){}, trigger(){} });
            ${stalled ? `window.TavernHelper = {
                getGlobalWorldbookNames: () => ['[Engram] Global'],
                getWorldbookNames: () => ['[Engram] Global'],
                getWorldbook: () => { window.__worldbookRequested = true; return new Promise(() => {}); }
            };` : ''}
            ${delayed ? `setTimeout(() => document.getElementById('host-ui').innerHTML = ${JSON.stringify(hostMarkup(nested))}, 1500);` : ''}
            </script>
            <script type="module" src="${assetBase + manifest.js}"></script>
            </body></html>`);
        return;
    }
    const file = assets.get(url.pathname);
    if (file) {
        res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : 'text/css');
        res.end(readFileSync(join(root, file)));
        return;
    }
    res.writeHead(404).end();
});

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const profile = mkdtempSync(join(tmpdir(), 'engram-browser-'));
let browser;
let socket;
const pending = new Map();
try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    browser = spawn(browserPath, [
        '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
        '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
    ], { windowsHide: true, stdio: 'ignore' });
    let launchError;
    browser.on('error', error => { launchError = error; });
    const portFile = join(profile, 'DevToolsActivePort');
    for (let i = 0; i < 100 && !existsSync(portFile) && !launchError; i++) {await pause(100);}
    if (launchError) {throw launchError;}
    assert.ok(existsSync(portFile), '浏览器未在 10 秒内启动');
    const debugPort = readFileSync(portFile, 'utf8').split('\n')[0];
    const target = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, {
        method: 'PUT', signal: AbortSignal.timeout(10000),
    })).json();
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('CDP 连接超时')), 10000);
        socket.onopen = () => { clearTimeout(timer); resolve(); };
        socket.onerror = () => { clearTimeout(timer); reject(new Error('CDP 连接失败')); };
    });
    socket.onmessage = event => {
        const data = JSON.parse(event.data);
        const request = pending.get(data.id);
        if (!request) {return;}
        pending.delete(data.id);
        clearTimeout(request.timer);
        if (data.error) {request.reject(new Error(data.error.message));}
        else {request.resolve(data.result);}
    };
    let sequence = 0;
    const call = (method, params = {}) => new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP 超时: ${method}`)); }, 10000);
        pending.set(id, { resolve, reject, timer });
        socket.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async expression => {
        const { result, exceptionDetails } = await call('Runtime.evaluate', { expression, returnByValue: true });
        if (exceptionDetails) {throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);}
        return result.value;
    };
    const waitFor = async expression => {
        for (let i = 0; i < 50; i++) {
            if (await evaluate(expression)) {return;}
            await pause(100);
        }
        throw new Error(`界面等待超时: ${expression}`);
    };
    const assertEntrances = async () => {
        await waitFor("document.querySelectorAll('#engram-drawer').length === 1 && document.querySelectorAll('#engram-quick-panel-trigger').length === 1 && !!document.getElementById('engram-global-overlay')");
        assert.deepEqual(await evaluate('window.__errors'), [], '发布脚本执行时发生异常');
    };
    await call('Runtime.enable');
    await call('Page.enable');
    const scenarios = [
        { name: '宿主界面已就绪', query: '' },
        { name: '宿主界面延迟出现', query: '?delayed=1' },
        { name: '世界书按钮嵌套', query: '?nested=1' },
        { name: '世界书请求持续等待', query: '?stalled=1' },
        { name: '延迟界面与世界书等待同时发生', query: '?delayed=1&stalled=1' },
        { name: '宿主界面重绘', query: '', redraw: true },
    ];
    let failures = 0;
    for (const [index, scenario] of scenarios.entries()) {
        try {
            const run = String(index);
            const separator = scenario.query ? '&' : '?';
            await call('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/${scenario.query}${separator}run=${run}` });
            await waitFor(`document.readyState === 'complete' && window.__browserRun === ${JSON.stringify(run)}`);
            await assertEntrances();
            if (scenario.query.includes('stalled')) {await waitFor('window.__worldbookRequested === true');}
            if (scenario.redraw) {
                await evaluate(`document.getElementById('host-ui').innerHTML = ${JSON.stringify(hostMarkup(false))}`);
                await assertEntrances();
            }
            await evaluate("document.getElementById('engram-drawer-icon').click()");
            await waitFor("!!document.getElementById('engram-panel-root')");
            console.log(`PASS ${scenario.name}`);
        } catch (error) {
            failures++;
            console.error(`FAIL ${scenario.name}: ${error.message}`);
            console.error(await evaluate('JSON.stringify(window.__errors)').catch(() => '无法读取浏览器错误'));
        }
    }
    assert.equal(failures, 0, `${failures} 个浏览器场景失败`);
    console.log(`Engram ${manifest.version} 浏览器入口检查通过（${scenarios.length} 个场景）`);
} finally {
    for (const request of pending.values()) {clearTimeout(request.timer);}
    socket?.close();
    // 只终止本脚本以独立 profile 启动的无头浏览器。
    browser?.kill();
    server.closeAllConnections();
    server.close();
}
