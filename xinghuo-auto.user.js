// ==UserScript==
// @name         星火匿名聊 · 自动匹配 + 3秒离开 + 30秒禁发 全套
// @namespace    local.xinghuo
// @version      2.1
// @description  自动匹配（只聊女/保密，男的自动跳过）、自动开场文案、绕过匹配后3秒禁止离开、绕过匹配后30秒禁止发链接/图片
// @match        https://xinghuo.chat/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

/*
 * 协议依据见仓库 PROTOCOL.md。三条实测结论：
 *   1) 3 秒离开限制 = 纯前端（btn_random_break 里比 randomGetIDTime），服务端不校验
 *   2) 30 秒链接/图片限制 = 前端提示 + 服务端兜底（code=24 直接丢弃消息）
 *   3) 服务端只按半角 "." 识别链接，中文句号 "。" 能过；空格/零宽都会被它归一化掉
 *      → 文本框内链接把 "." 换成 "。" 即可立刻发出；图片/文件消息（[...]）服务端硬拦，只能排队等窗口结束
 */

(function () {
    'use strict';
    if (window.__xhAutoLoaded) return;
    window.__xhAutoLoaded = true;

    /* ------------------------------------------------------------------ 配置 */

    var CFG_KEY = 'xh_auto_cfg_v2';
    var DEFAULT_CFG = {
        enabled: false,
        targetSex: ['女', '保密'],       // 只和这些性别聊
        greetings: ['你好呀，一个人吗？'],
        greetDelayMs: 1200,              // 匹配成功后多久发开场白
        skipDelayMs: 600,                // 匹配到非目标性别后多久踢掉
        matchIntervalMs: 2000,           // 匹配节奏：两次发起 random 的最小间隔（毫秒）
        queueTimeoutMs: 20000,           // 排队多久没结果就重发 random
        bypass3s: true,                  // 匹配成功立即允许离开
        bypass30s: true,                 // 处理 30 秒禁发
        linkMode: 'obfuscate',           // obfuscate=点换句号立即发 | queue=排队等窗口结束
        fileMode: 'queue'                // queue=排队 | drop=直接丢掉不提示
    };

    var cfg = loadCfg();
    var stat = { match: 0, skip: 0, greet: 0, queued: 0 };

    function loadCfg() {
        try {
            var raw = localStorage.getItem(CFG_KEY);
            if (!raw) return JSON.parse(JSON.stringify(DEFAULT_CFG));
            var o = JSON.parse(raw);
            for (var k in DEFAULT_CFG) if (!(k in o)) o[k] = DEFAULT_CFG[k];
            return o;
        } catch (e) { return JSON.parse(JSON.stringify(DEFAULT_CFG)); }
    }
    function saveCfg() { try { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); } catch (e) { } }

    /* -------------------------------------------------------------- 基础工具 */

    function log() {
        try { console.log.apply(console, ['[xh]'].concat([].slice.call(arguments))); } catch (e) { }
        pushPanelLog([].slice.call(arguments).join(' '));
    }

    function wsReady() { return window.ws && window.ws.readyState === 1; }
    function uid() { try { return window.getSocketUserId(); } catch (e) { return null; } }

    // 是否处在「匹配成功后 30 秒」窗口内（页面自己维护的变量）
    function inFirstWindow() {
        try {
            if (!window.matchBlockTargetMd5 || !window.matchBlockUntil) return false;
            if (window.sel_userid !== window.matchBlockTargetMd5) return false;
            return Date.now() < window.matchBlockUntil;
        } catch (e) { return false; }
    }

    // "[...]" 形式的图片/语音/文件消息
    function isMediaMsg(text) {
        if (typeof text !== 'string') return false;
        return /^\s*\[[^\[\]]{4,}\]\s*$/.test(text);
    }

    function pageContainsLink(text) {
        try {
            if (typeof window.containsLink === 'function') return window.containsLink(text);
        } catch (e) { }
        return /(https?:)?\/\/|www\.|[a-z0-9-]+\.(com|cn|net|org|io|top|xyz|cc|tv|vip)\b/i.test(text);
    }

    // 服务端只认半角点：把域名里的 "." 换成中文句号
    function obfuscateLink(text) {
        return String(text).replace(/\./g, '\u3002');
    }

    function pickGreeting(d) {
        var list = (cfg.greetings || []).filter(function (s) { return String(s).trim(); });
        if (!list.length) return '';
        var t = list[Math.floor(Math.random() * list.length)];
        return t.replace(/\{name\}/g, d.sel_userNikename || '')
                .replace(/\{city\}/g, d.sel_userAddress || '')
                .replace(/\{sex\}/g, d.sel_userSex || '');
    }

    /* ------------------------------------------------------- hook：30 秒禁发 */

    function installSendHook() {
        if (typeof window.sendJson !== 'function') return false;
        if (window.sendJson.__xhHooked) return true;

        var rawSend = window.sendJson;

        var patched = function (act, msg, self) {
            try {
                if (cfg.bypass30s && typeof act === 'string' && act.indexOf('touser_') === 0 &&
                    typeof msg === 'string' && inFirstWindow()) {

                    // 图片 / 文件：服务端硬拦，只能排队
                    if (isMediaMsg(msg)) {
                        if (cfg.fileMode === 'queue') {
                            enqueue(act, msg);
                            return;
                        }
                        if (cfg.fileMode === 'drop') {
                            log('窗口内丢弃媒体消息');
                            return;
                        }
                    }
                    // 文本链接：变形立即发，或排队
                    else if (pageContainsLink(msg)) {
                        if (cfg.linkMode === 'queue') {
                            enqueue(act, msg);
                            return;
                        }
                        msg = obfuscateLink(msg);
                        log('链接已变形：' + msg);
                    }
                }
            } catch (e) { /* 任何异常都放行，别把页面搞死 */ }
            return rawSend.call(this, act, msg, self);
        };

        patched.__xhHooked = true;
        patched.__raw = rawSend;
        window.sendJson = patched;
        return true;
    }

    // 排队：窗口结束后自动补发
    var pendingQueue = [];
    function enqueue(act, msg) {
        stat.queued++;
        var wait = Math.max(0, (window.matchBlockUntil || 0) - Date.now()) + 250;
        log('消息排队 ' + Math.round(wait / 1000) + 's 后补发：' + msg.slice(0, 30));
        var timer = setTimeout(function () {
            try {
                if (wsReady()) {
                    var raw = window.sendJson.__raw || window.sendJson;
                    raw.call(window, act, msg, true);
                    log('补发完成：' + msg.slice(0, 30));
                }
            } catch (e) { log('补发失败：' + e); }
            pendingQueue = pendingQueue.filter(function (x) { return x !== timer; });
        }, wait);
        pendingQueue.push(timer);
    }

    // 前端 30 秒拦截直接关掉（图片粘贴/点发送不再被拦）
    function installLimitHook() {
        if (typeof window.randomGetIDTimeLimit === 'function' && !window.randomGetIDTimeLimit.__xhOff) {
            var off = function () { return false; };
            off.__xhOff = true;
            window.randomGetIDTimeLimit = off;
        }
        if (cfg.bypass3s) {
            var _g = window.random_queue_get_random_getID;
            if (typeof _g === 'function' && !_g.__xhPatched) {
                var p = function () {
                    var r = _g.apply(this, arguments);
                    try { window.randomGetIDTime = new Date(Date.now() - 4000); } catch (e) { }
                    return r;
                };
                p.__xhPatched = true;
                window.random_queue_get_random_getID = p;
            }
        }
    }

    /* ------------------------------------------------------------ 自动匹配 */

    var lastRandomAt = 0;
    var randomPending = null;

    // 发起匹配。所有调用都会被 matchIntervalMs 统一节流：
    // 来早了不丢弃，排到点自动发，保证「N 秒一个」的节奏稳定
    function doRandom() {
        if (!wsReady()) {
            if (cfg.enabled) log('ws 未就绪，等重连');
            return;
        }
        var wait = (cfg.matchIntervalMs || 2000) - (Date.now() - lastRandomAt);
        if (wait > 0) {
            if (randomPending) return;
            randomPending = setTimeout(function () {
                randomPending = null;
                doRandom();
            }, wait);
            return;
        }
        if (randomPending) { clearTimeout(randomPending); randomPending = null; }

        lastRandomAt = Date.now();
        try {
            window.sendJson('random', '', true);    // 直接发协议帧，不依赖按钮和页面状态
            resetUiIdle();
            log('进入匹配队列');
        } catch (e) { log('random 失败 ' + e); }
    }

    // 匹配中把聊天输入区收起来（等价于点「开始匹配」时的 UI 表现）
    function resetUiIdle() {
        try {
            if (!window.jQuery) return;
            jQuery('.input-main').hide();
            jQuery('#btn_random').show();
            jQuery('#btn_random_break,#btn_random_return').hide();
        } catch (e) { }
    }

    function onMatch(d) {
        var sex = d.sel_userSex || '';
        var isTarget = (cfg.targetSex || []).indexOf(sex) >= 0;

        if (!isTarget) {
            stat.skip++;
            log('跳过 ' + sex + ' / ' + (d.sel_userNikename || '') + '（累计跳过 ' + stat.skip + '）');
            setTimeout(function () {
                try {
                    if (wsReady()) {
                        var raw = window.sendJson.__raw || window.sendJson;
                        raw.call(window, 'randomOut', d.sel_userid, true);
                    }
                } catch (e) { }
                // 页面不会自己清，手动清掉，否则 tick 会把我们当成"正在聊天"
                try { if (window.sel_userid === d.sel_userid) window.sel_userid = ''; } catch (e) { }
                doRandom();
            }, cfg.skipDelayMs);
            return;
        }

        stat.match++;
        log('命中 ' + sex + ' / ' + (d.sel_userNikename || '') + ' / ' + (d.sel_userAddress || '') +
            '（累计命中 ' + stat.match + '）');

        var text = pickGreeting(d);
        if (!text) return;
        setTimeout(function () {
            if (window.sel_userid !== d.sel_userid) return;      // 期间换人了就别发
            if (!wsReady()) return;
            try {
                window.sendJson('touser_' + d.sel_userid + '_' + (d.sel_userNikename || ''), text, true);
                stat.greet++;
                log('已发开场白：' + text);
            } catch (e) { log('开场白发送失败 ' + e); }
        }, cfg.greetDelayMs);
    }

    function onSocketMessage(ev) {
        var data;
        try { data = JSON.parse(ev.data); } catch (e) { return; }
        if (!cfg.enabled) return;

        if (data.code === 15) { onMatch(data); return; }
        if (data.code === 16 || data.code === 3 || data.code === 40) {
            // 对方走了 / 离线 / 被清理：清掉残留会话，按节奏继续匹配
            setTimeout(function () {
                if (!cfg.enabled) return;
                if (window.sel_userid) { try { window.sel_userid = ''; } catch (e) { } }
                doRandom();
            }, 800);
        }
    }

    // 页面重连会换掉 ws 对象，定期检查重新挂监听
    var hookedWs = null;
    function keepSocketHooked() {
        if (window.ws && window.ws !== hookedWs && window.ws.readyState <= 1) {
            if (hookedWs) log('连接已重建，重新挂监听');
            hookedWs = window.ws;
            try { hookedWs.addEventListener('message', onSocketMessage); } catch (e) { }
        }
    }

    function tick() {
        keepSocketHooked();
        installLimitHook();
        installSendHook();
        if (!cfg.enabled || !wsReady()) return;
        if (window.sel_userid) return;                       // 正在聊
        if (Date.now() - lastRandomAt < (cfg.matchIntervalMs || 2000)) return;
        doRandom();                                          // 到点了，继续摇人
    }

    /* ------------------------------------------------------------- 面板 UI */

    var panelEl = null, logEl = null, logLines = [];

    function pushPanelLog(line) {
        if (!logEl) return;
        logLines.push(new Date().toTimeString().slice(0, 8) + '  ' + line);
        if (logLines.length > 60) logLines.shift();
        logEl.textContent = logLines.join('\n');
        logEl.scrollTop = logEl.scrollHeight;
    }

    function buildPanel() {
        if (panelEl) return;
        var wrap = document.createElement('div');
        wrap.id = 'xh_auto_panel';
        wrap.style.cssText = 'position:fixed;right:12px;bottom:12px;width:270px;z-index:999999;' +
            'font:12px/1.5 Consolas,Menlo,monospace;color:#eee;background:#1b1d22;border:1px solid #3a3f47;' +
            'border-radius:8px;box-shadow:0 6px 20px rgba(0,0,0,.45);overflow:hidden';

        var bar = document.createElement('div');
        bar.style.cssText = 'padding:6px 10px;background:#262a31;display:flex;justify-content:space-between;' +
            'align-items:center;cursor:move;user-select:none';
        bar.innerHTML = '<b style="color:#4caf50">星火自动</b>';

        var body = document.createElement('div');
        body.style.cssText = 'padding:8px 10px;max-height:70vh;overflow:auto';

        var toggleBtn = document.createElement('button');
        toggleBtn.textContent = '收起';
        toggleBtn.style.cssText = 'background:none;border:1px solid #555;color:#ccc;border-radius:4px;cursor:pointer;font-size:11px;padding:1px 6px';
        toggleBtn.onclick = function () {
            body.style.display = body.style.display === 'none' ? '' : 'none';
            toggleBtn.textContent = body.style.display === 'none' ? '展开' : '收起';
        };
        bar.appendChild(toggleBtn);

        // 启用开关
        var row1 = document.createElement('label');
        row1.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:6px';
        var chkEnable = document.createElement('input');
        chkEnable.type = 'checkbox';
        chkEnable.checked = !!cfg.enabled;
        chkEnable.onchange = function () { cfg.enabled = chkEnable.checked; saveCfg(); log('自动匹配 ' + (cfg.enabled ? '开' : '关')); };
        row1.appendChild(chkEnable);
        row1.appendChild(document.createTextNode('启用自动匹配'));
        body.appendChild(row1);

        // 目标性别
        var row2 = document.createElement('div');
        row2.style.cssText = 'display:flex;gap:10px;margin-bottom:6px;align-items:center';
        row2.appendChild(document.createTextNode('只聊：'));
        ['女', '保密', '男'].forEach(function (s) {
            var lb = document.createElement('label');
            lb.style.cssText = 'display:flex;align-items:center;gap:2px';
            var c = document.createElement('input');
            c.type = 'checkbox';
            c.checked = (cfg.targetSex || []).indexOf(s) >= 0;
            c.onchange = function () {
                var arr = (cfg.targetSex || []).filter(function (x) { return x !== s; });
                if (c.checked) arr.push(s);
                cfg.targetSex = arr;
                saveCfg();
                log('目标性别：' + (arr.join('/') || '无'));
            };
            lb.appendChild(c);
            lb.appendChild(document.createTextNode(s));
            row2.appendChild(lb);
        });
        body.appendChild(row2);

        // 匹配节奏
        var rowSpeed = document.createElement('div');
        rowSpeed.style.cssText = 'display:flex;align-items:center;gap:6px;margin:4px 0 2px';
        rowSpeed.appendChild(document.createTextNode('匹配间隔'));
        var inpSpeed = document.createElement('input');
        inpSpeed.type = 'number';
        inpSpeed.min = '500';
        inpSpeed.max = '20000';
        inpSpeed.step = '100';
        inpSpeed.value = cfg.matchIntervalMs;
        inpSpeed.style.cssText = 'width:72px;background:#111;color:#ddd;border:1px solid #3a3f47;' +
            'border-radius:4px;padding:2px 4px;font:12px inherit';
        inpSpeed.onchange = function () {
            var v = parseInt(inpSpeed.value, 10);
            if (isNaN(v) || v < 500) v = 500;
            if (v > 20000) v = 20000;
            cfg.matchIntervalMs = v;
            inpSpeed.value = v;
            saveCfg();
            log('匹配间隔 ' + v + 'ms（约 ' + (1000 / v).toFixed(1) + ' 个/秒）');
        };
        rowSpeed.appendChild(inpSpeed);
        rowSpeed.appendChild(document.createTextNode('ms / 个'));
        body.appendChild(rowSpeed);

        // 文案
        var lbl3 = document.createElement('div');
        lbl3.textContent = '开场文案（一行一条，随机挑）：';
        lbl3.style.cssText = 'margin:6px 0 3px;color:#9aa';
        body.appendChild(lbl3);
        var ta = document.createElement('textarea');
        ta.value = (cfg.greetings || []).join('\n');
        ta.style.cssText = 'width:100%;box-sizing:border-box;height:64px;background:#111;color:#ddd;' +
            'border:1px solid #3a3f47;border-radius:4px;padding:4px;font:12px/1.4 inherit;resize:vertical';
        ta.oninput = function () {
            cfg.greetings = ta.value.split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
            saveCfg();
        };
        body.appendChild(ta);

        // 30 秒选项
        var row4 = document.createElement('label');
        row4.style.cssText = 'display:flex;align-items:center;gap:6px;margin:8px 0 4px';
        var chk30 = document.createElement('input');
        chk30.type = 'checkbox';
        chk30.checked = !!cfg.bypass30s;
        chk30.onchange = function () { cfg.bypass30s = chk30.checked; saveCfg(); };
        row4.appendChild(chk30);
        row4.appendChild(document.createTextNode('绕过30秒禁发'));
        body.appendChild(row4);

        var sel = document.createElement('select');
        sel.style.cssText = 'width:100%;margin:2px 0;background:#111;color:#ddd;border:1px solid #3a3f47;border-radius:4px;padding:2px';
        [['obfuscate', '链接：点换句号，立即发'], ['queue', '链接：排队等30秒，原样发']].forEach(function (o) {
            var op = document.createElement('option');
            op.value = o[0]; op.textContent = o[1];
            if (cfg.linkMode === o[0]) op.selected = true;
            sel.appendChild(op);
        });
        sel.onchange = function () { cfg.linkMode = sel.value; saveCfg(); };
        body.appendChild(sel);

        var sel2 = document.createElement('select');
        sel2.style.cssText = sel.style.cssText;
        [['queue', '图片/文件：排队等30秒后补发'], ['drop', '图片/文件：窗口内直接丢弃']].forEach(function (o) {
            var op = document.createElement('option');
            op.value = o[0]; op.textContent = o[1];
            if (cfg.fileMode === o[0]) op.selected = true;
            sel2.appendChild(op);
        });
        sel2.onchange = function () { cfg.fileMode = sel2.value; saveCfg(); };
        body.appendChild(sel2);

        // 日志
        logEl = document.createElement('pre');
        logEl.style.cssText = 'margin:8px 0 0;height:96px;overflow:auto;background:#0e1013;color:#8bc34a;' +
            'border:1px solid #2a2e35;border-radius:4px;padding:4px;font-size:11px;white-space:pre-wrap;word-break:break-all';
        body.appendChild(logEl);

        wrap.appendChild(bar);
        wrap.appendChild(body);
        document.body.appendChild(wrap);
        panelEl = wrap;
        dragify(wrap, bar);
        pushPanelLog('面板就绪，协议依据见 PROTOCOL.md');
    }

    function dragify(el, handle) {
        var sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
        handle.addEventListener('mousedown', function (e) {
            dragging = true;
            sx = e.clientX; sy = e.clientY;
            var r = el.getBoundingClientRect();
            ox = r.left; oy = r.top;
            el.style.right = 'auto'; el.style.bottom = 'auto';
            el.style.left = ox + 'px'; el.style.top = oy + 'px';
            e.preventDefault();
        });
        document.addEventListener('mousemove', function (e) {
            if (!dragging) return;
            el.style.left = (ox + e.clientX - sx) + 'px';
            el.style.top = (oy + e.clientY - sy) + 'px';
        });
        document.addEventListener('mouseup', function () { dragging = false; });
    }

    // 后台标签页的 setInterval 会被浏览器节流（最低 1s，挂久了更慢），
    // 用 Web Worker 计时器兜住，保证「N 秒一个」在挂后台时也准
    function startTicker() {
        try {
            var src = 'setInterval(function(){postMessage(0)},400)';
            var url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
            var w = new Worker(url);
            w.onmessage = function () { tick(); };
            return;
        } catch (e) { }
        setInterval(tick, 500);   // CSP 挡住 Worker 时退回普通计时器
    }

    /* --------------------------------------------------------------- 启动 */

    var bootTries = 0;
    function boot() {
        // 只等页面核心函数就绪，不等 ws：WS 可能还没连上，面板要尽早出来
        if (typeof window.sendJson !== 'function') {
            if (bootTries++ < 600) return setTimeout(boot, 100);
            return;
        }
        installLimitHook();
        installSendHook();
        keepSocketHooked();
        buildPanel();
        startTicker();
        log('已加载 v2.1');
    }
    boot();

})();
