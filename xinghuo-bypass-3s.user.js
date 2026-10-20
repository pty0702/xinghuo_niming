// ==UserScript==
// @name         星火匿名聊 - 绕过「匹配后3秒内无法离开」
// @namespace    local.xinghuo
// @version      1.1
// @description  把匹配计时起点提前，使离开按钮不再被 3 秒窗口拦住；同时保留 VIP 语义不被整体伪造
// @match        https://xinghuo.chat/nmchat_index.html*
// @match        https://xinghuo.chat/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

/*
 * 原理（见 PROTOCOL.md 第四节）：
 *   btn_random_break 的点击回调判断
 *     temp = timeDiff(randomGetIDTime, now)
 *     temp.split('秒')[0] > 3 || isVip()   → 才放行
 *   randomGetIDTime 在 code=15 处理函数 random_queue_get_random_getID() 里被设成 new Date()。
 *
 * 做法：包装这个处理函数，执行完立刻把 randomGetIDTime 往前推 4 秒。
 *   不伪造 cookie，不动 VIP 匹配队列，副作用最小。
 *
 * 附加：isVip() 补丁只在「刚匹配完 5 秒内」返回 true，
 *   防止页面上还有其他地方直接读 isVip() 做判断时偶发被拦。
 */

(function () {
    'use strict';

    // 提前量(ms)：必须 > 3000，留一点余量防止 timeDiff 取整后仍算 3 秒
    var SHIFT_MS = 4000;
    // isVip 补丁的生效窗口(ms)
    var VIP_PATCH_WINDOW = 5000;

    var retry = 0;

    function hook() {
        var fn = window.random_queue_get_random_getID;
        if (typeof fn !== 'function') {
            if (retry++ < 600) setTimeout(hook, 100);   // 最多等 60 秒
            return;
        }
        if (fn.__xh_patched) return;

        var patched = function () {
            var ret = fn.apply(this, arguments);
            try {
                window.randomGetIDTime = new Date(Date.now() - SHIFT_MS);
                window.__xh_lastMatchAt = Date.now();
            } catch (e) { /* 忽略 */ }
            return ret;
        };
        patched.__xh_patched = true;
        window.random_queue_get_random_getID = patched;

        patchIsVip();
        installHotkey();
        console.log('[xh] 3秒离开限制补丁已装');
    }

    function patchIsVip() {
        var _isVip = window.isVip;
        if (typeof _isVip !== 'function' || _isVip.__xh_patched) return;

        var wrapped = function () {
            try {
                if (_isVip.apply(this, arguments)) return true;
                if (window.__xh_lastMatchAt &&
                    Date.now() - window.__xh_lastMatchAt < VIP_PATCH_WINDOW) {
                    return true;
                }
            } catch (e) { /* 忽略 */ }
            return false;
        };
        wrapped.__xh_patched = true;
        window.isVip = wrapped;
    }

    // 顺手加个热键：Ctrl+Shift+X ＝ 立刻用协议帧离开（跳过所有 UI 校验）
    function installHotkey() {
        if (window.__xh_hotkey) return;
        window.__xh_hotkey = true;
        document.addEventListener('keydown', function (ev) {
            if (ev.ctrlKey && ev.shiftKey && (ev.key === 'X' || ev.key === 'x')) {
                try {
                    if (window.sel_userid && window.ws && window.ws.readyState === 1) {
                        window.ws.send(JSON.stringify({
                            act: 'randomOut',
                            id: window.getSocketUserId(),
                            msg: window.sel_userid
                        }));
                        console.log('[xh] 已发 randomOut:', window.sel_userid);
                    }
                } catch (e) { console.warn('[xh] randomOut 失败', e); }
            }
        }, true);
    }

    hook();
})();

/*
 * ---- 可选：全自动「见人就踢」 ----
 * 打开下面注释后，每匹配成功一次就立即按协议帧离开，不弹确认框。
 * 注意：这是高频进出队列，可能触发服务端风控，自行承担。
 *
 * (function(){
 *     var t = setInterval(function(){
 *         if (window.__xh_lastMatchAt && Date.now() - window.__xh_lastMatchAt < 300) {
 *             try {
 *                 window.ws.send(JSON.stringify({
 *                     act: 'randomOut',
 *                     id: window.getSocketUserId(),
 *                     msg: window.sel_userid
 *                 }));
 *             } catch(e){}
 *         }
 *     }, 200);
 * })();
 */
