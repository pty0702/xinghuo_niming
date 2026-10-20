# 星火匿名聊天（xinghuo.chat）协议实测笔记

- 采集时间：2026-10-20
- 页面：`https://xinghuo.chat/nmchat_index.html`
- 端点：`wss://xinghuo.chat/ws/`（同源，无 token，无鉴权头）
- 客户端脚本：`/nmchat/rdk3.ws-chat.js?v202609281021`（93,948 字节）、`/nmchat/rdk3.common.js`、`/nmchat/rdk3.boot.js`、`/js/common.js?v39`
- 说明：本文件取代旧版 `readme,md`（旧文档只覆盖到 `xinghuo1v1.com` 时代的 sign/random/touser/randomOut 四个动作，且开头残缺）

---

## 一、连接与身份

| 项 | 值 |
|---|---|
| WS 地址 | `wss://xinghuo.chat/ws/`（页面内 `ws_addr` 变量） |
| 鉴权 | 无。不校验来源、不带 Authorization |
| 身份 | `sign` 时自带 32 位小写字母数字串，客户端生成，保存在 `localStorage`/cookie，`getSocketUserId()` 读取 |
| 心跳 | 每 25s 发一次 `{"act":"heart","id":uid,"t":毫秒时间戳}` |
| 重连 | 失败后 2s 起重连，每次 +2s，上限 15s，最多 8 次，之后停止自愈 |

身份相关变量：
- `sign.id`（客户端自生成 32 位）
- `code=12` 返回的 `userId`（服务端内部 ID，`code=7` 里的 `fromuser.id` 就是它）

**两者不是同一个东西**，`sign.id != code=7.fromuser.id`。发消息时 `id` 字段要填 `sign.id`。

---

## 二、上行动作（act）全表

| act | 载荷 | 说明 |
|---|---|---|
| `sign` | `id, name, userSex, address_show, randomhealthmode, randomvipsex, randomvipaddress, userip, useraddree, randomvipcode, chatToken?` | 注册身份，回 `code=12` |
| `random` | `id, preferSex, preferAddress, preferTag` | 进入随机匹配队列，回 `code=13`，命中给 `code=15` |
| `randomCancel` | `id` | 退出排队，回 `code=14` |
| `randomOut` | `id, msg`（msg=对方 `sel_userid`） | 断开当前匹配，**服务端无专用回执** |
| `touser_{对方id}_{对方昵称}` | `id, msg` | 发私信，回 `code=7`（含回显） |
| `heart` | `id, t` | 心跳 |
| `modinfo` | `id, userSex, address_show, randomhealthmode, randomvipsex, randomvipaddress` | 改资料/开关 |
| `chgname` | `id, msg` | 改昵称 |
| `settags` | `id, tags` | 设置标签 |
| `inputStatusOn` / `inputStatusOff` | `id` | 输入中提示（对应 `code=18/19`） |
| `blockuser` | `id, msg` | 拉黑 |
| `warningreport` | `id, msg` | 举报 |
| `randomVIPinfoBind` | `id, randomvipcode, randomvipsex:1` | VIP 激活码绑定 |
| `getprivmsg` | `id, msg` | 拉历史私信（代码里已注释，未启用） |
| `closeConversation` | — | 旧仓库 worker.py 里有，当前网页版未使用 |

### sign 最小样例（实测通过）

```json
{
  "act": "sign",
  "id": "avbjiFfMFVLXsg9QzTUL4HC5qN9UPVOe",
  "name": "想要",
  "userSex": "男",
  "address_show": "false",
  "randomhealthmode": "0",
  "randomvipsex": "0",
  "randomvipaddress": "0",
  "userip": "",
  "useraddree": "河北省保定市",
  "randomvipcode": ""
}
```
→ `{"code":12,"content":"连接服务器成功！","userId":"...","isVip":false,...}`

### random / 匹配样例（实测）

```json
{"act":"random","id":"avbjiFfMFVLXsg9QzTUL4HC5qN9UPVOe","preferSex":null,"preferAddress":false,"preferTag":null}
```
→ `{"code":13,"content":"已进入匹配队列"}`
→ 命中：
```json
{"code":15,"sel_userid":"1cb06d65151cdead0e5a2cf7d4e2c42d","sel_userNikename":"风暴的召唤师","sel_userSex":"男","sel_userAge":0,"sel_userAddress":"河南省郑州","sel_userTag":"已婚","isFirstMatch":1}
```

`isFirstMatch`：服务端判定双方从未联系过时为 1，前端据此开一段 30 秒的「图片/链接禁发」窗口（不是离开限制）。

### 发消息

```json
{"act":"touser_1cb06d65151cdead0e5a2cf7d4e2c42d_风暴的召唤师","id":"avbjiFfMFVLXsg9QzTUL4HC5qN9UPVOe","msg":"1"}
```
对方 id 和昵称直接拼在 act 里，昵称里有下划线会串味，注意编码。

### 离开

```json
{"act":"randomOut","id":"avbjiFfMFVLXsg9QzTUL4HC5qN9UPVOe","msg":"1cb06d65151cdead0e5a2cf7d4e2c42d"}
```
**无任何回执**，成功与否靠后续是否收到新 `code=15` 判断。

---

## 三、下行 code 全表（从 onmessage 分发反推）

| code | 含义 | 前端处理 |
|---|---|---|
| 3 | 用户离线 | `fun_userlogout`，`userIdMd5` |
| 4 | 用户改昵称 | `fun_userchgname` |
| 5 | 广播消息 | `fun_recbrodata` |
| 6 | 绑定所有广播 | `fun_bindtoallmsg` |
| 7 | 私信（收+回显） | `fun_fromusermsg` |
| 9 | 消息撤回 | `fun_msgrevoke` |
| 11 | 全站公告 | `fun_NoticeShow` |
| 12 | 连接成功 | `Con_Succ`，携带 `userId/isVip/vipExpireTime/isWhitelist/tag/userAge` |
| 13 | 已进队列 | — |
| 14 | 退出队列成功 | — |
| 15 | 匹配成功 | `random_queue_get_random_getID` |
| 16 | 对方离开 | `random_queue_get_random_Out` |
| 17 | 对方改性别/地址开关 | — |
| 18 | 对方正在输入 | — |
| 19 | 对方停止输入 | — |
| 20 | 弹幕 | — |
| 21 | 违规禁止访问 | `limitTips` |
| 22 | 举报成功 | — |
| 23 | （多行条件判断，IP/违规相关） | — |
| 24 | 消息被拦截（拉黑/IP 封禁） | 弹提示 |
| 25 | 身份/凭证被拒 | `onIdentityRejected`，走自愈 |
| 30 | 查看用户登录信息 | — |
| 31 | VIP 激活码无效/过期 | — |
| 32 | VIP 激活码已被别的账号绑定 | — |
| 40 | 联系人已离开（服务端清理推送） | `fun_contactLeft` |
| 42 | 被「精确匹配」命中 | `onAddedByMatchById`，静默加好友，不弹窗 |
| 130 | 激活码已过期 | `random_queue_get_viprandom` |
| 131 | 激活码不存在 | 同上 |
| 132 | 激活码已激活 | 同上 |
| 133 | 已进入 VIP 匹配队列 | 同上 |
| 134 | 已进入 VIP 队列（额外情况） | 同上 |
| 135 | 激活码防止多人同时使用 | 同上 |
| 136 | 暂无 | 同上 |
| 137/138/139 | 激活码不能为空 / 首次激活并入队 / 已入队 | 同上 |

---

## 四、「匹配后 3 秒内无法离开」的真相

### 实现位置

`rdk3.ws-chat.js` 第 1557–1613 行，绑定在 `#btn_random_break` 上：

```js
$("#btn_random_break").click(function() {
    var temp = timeDiff(randomGetIDTime, new Date());
    if (temp.indexOf('秒') == -1 || temp.split('秒')[0] > 3 || isVip()) {
        // 弹「是否断开本次对话？确定/取消」，点确定才 sendJson('randomOut', sel_userid, true)
    } else {
        layer.msg("匹配后3秒内无法离开<br/>vip不受此限制", { time: 3000 });
    }
});
```

三要素：

1. `randomGetIDTime` — 全局变量，在 `random_queue_get_random_getID(json)`（即 `code=15` 处理函数）里赋值为 `new Date()`。
2. `timeDiff(a, b)` — 返回中文时长串；不足 1 分钟时返回 `"N秒前"`，`N = Math.floor(毫秒/1000)`。
3. `isVip()` — **完全靠 cookie**：
   ```js
   function isVip() { return !!($.cookie('randomVipCode') || $.cookie('isVipUser')); }
   ```

### 结论

**这是纯前端 UI 限制，服务端零校验。**

实测证据（2026-10-20，真实站点）：
- 收到 `code=15` 后 **0ms** 直接 `ws.send(randomOut)` → 服务端不报错、不回任何拒绝码，立即又收到新 `code=15`，说明离开生效并重新入队。
- 匹配成功后 **241ms** 点击离开按钮时，注入 `document.cookie="isVipUser=1;path=/"` → 直接弹出确认框，没有拦截提示。

### 另一套 30 秒限制（别搞混）

`matchBlockUntil = Date.now() + 30000` 只在 `json.isFirstMatch` 为真时设置，作用点是 `randomGetIDTimeLimit()`，用于**禁止发图片和链接**，与能不能离开无关。

---

## 五、绕过方案

### 方案 0：自己写 WS 客户端（最彻底）

限制只存在于网页 JS 里。照第二节自己发 `sign → random → randomOut`，压根没有 3 秒这回事。旧仓库的 `worker.py` 就是这个路子。

### 方案 1：控制台一行（在点离开前执行）

```js
randomGetIDTime = new Date(Date.now() - 4000);
```
`timeDiff` 立刻变成 `"4秒前"`，`temp.split('秒')[0] > 3` 成立，按钮放行。

### 方案 2：伪造 VIP cookie（体验最顺）

```js
document.cookie = "isVipUser=1;path=/";
```
`isVip()` 变 true。副作用：页面会按 VIP 渲染开关，点「VIP 匹配」会走服务端校验（大概率回 130/131）。普通随机匹配不受影响。

### 方案 3：跳过按钮，直接发协议帧

```js
ws.send(JSON.stringify({ act: "randomOut", id: getSocketUserId(), msg: sel_userid }));
```
实测服务端照单全收。

### 方案 4：走另一条完全没加检查的 UI

`#btn_random_break_AD`（带广告图的离开按钮）第 1618 行起**没有任何时间判断**，点开广告层再点确定就直接 `randomOut`。等于官方自己留的后门入口。

### 方案 5：油猴脚本常驻（推荐）

见同目录 `xinghuo-bypass-3s.user.js`，自动 hook 匹配成功回调，把计时起点往前推 4 秒，同时给 `isVip()` 打一个只在 5 秒窗口内生效的补丁。

---

## 六、与旧仓库（xinghuo1v1.com）的差异

| 项 | 旧版 | 现版 |
|---|---|---|
| 端点 | `wss://xinghuo1v1.com/ws/` | `wss://xinghuo.chat/ws/` |
| 心跳 | 不明确 | 25s 一次，带 `t` |
| 匹配回执 | `sel_userid` 等 5 字段 | 多一个 `isFirstMatch` |
| 队列取消 | 无 | `randomCancel` → `code=14` |
| VIP | 只认 `randomVipCode` | `randomVipCode` 或 `isVipUser` cookie |
| 新动作 | — | `modinfo`、`settags`、`blockuser`、`warningreport`、`inputStatusOn/Off`、`randomVIPinfoBind` |
| 新 code | — | 16(对方离开)、17~25、30~32、40、42、130~139 |
