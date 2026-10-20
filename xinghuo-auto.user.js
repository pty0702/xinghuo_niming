// ==UserScript==
// @name         星火匿名聊 · 自动匹配 + 3秒离开 + 30秒禁发 全套
// @namespace    local.xinghuo
// @version      2.0
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
    var busy = false;

    function doRandom(force) {
        if (!wsReady()) return;
        var now = Date.now();
        if (!force && now - lastRandomAt < 1500) return;
        lastRandomAt = now;
        try {
            var $btn = window.jQuery ? window.jQuery('#btn_random') : null;
            if ($btn && $btn.length) $btn.trigger('click');   // 复用页面逻辑，顺便复位 UI
            else window.sendJson('random', '', true);
            log('进入匹配队列');
        } catch (e) { log('random 失败 ' + e); }
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
                setTimeout(function () { doRandom(true); }, cfg.skipDelayMs);
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
            // 对方走了 / 离线，回到队列
            setTimeout(function () { if (!window.sel_userid) doRandom(true); }, 800);
        }
    }

    // 页面重连会换掉 ws 对象，定期检查重新挂监听
    var hookedWs = null;
    function keepSocketHooked() {
        if (window.ws && window.ws !== hookedWs && window.ws.readyState <= 1) {
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
        if (Date.now() - lastRandomAt < cfg.queueTimeoutMs) return;
        doRandom(true);                                      // 排队超时，重新入队
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

    /* --------------------------------------------------------------- 启动 */

    var bootTries = 0;
    function boot() {
        if (typeof window.sendJson !== 'function' || typeof window.ws === 'undefined') {
            if (bootTries++ < 300) return setTimeout(boot, 100);
            return;
        }
        installLimitHook();
        installSendHook();
        keepSocketHooked();
        buildPanel();
        setInterval(tick, 800);
        log('已加载 v2.0');
    }
    boot();

})();
