import asyncio
import json
import random
import string
import time
from collections import deque
from dataclasses import dataclass

import websockets
from PyQt5.QtCore import QObject, pyqtSignal

WS_URL = "wss://xinghuo1v1.com/ws/"

# ── 行为开关 ─────────────────────────────────────────────────
AUTO_GREETING = True
AUTO_SKIP_MALE = False
AUTO_SKIP_DUPLICATE_PEER = True
ENABLE_SERVER_CLOSE_CONV = False

CITIES = [
    "北京市", "上海市", "保定市", "成都市",
    "广州市", "深圳市", "杭州市", "武汉市",
    "南京市", "重庆市", "西安市", "苏州市",
]


def gen_client_id(length=32):
    chars = string.ascii_lowercase + string.digits
    return "".join(random.choice(chars) for _ in range(length))


def random_city():
    return random.choice(CITIES)


@dataclass
class WorkerConfig:
    nickname: str = ""
    greeting: str = "你好"


class MatchWorker(QObject):
    status_changed = pyqtSignal(int, str)

    # index, peer_id, msg_type, sender, content
    chat_message = pyqtSignal(int, str, str, str, str)

    # 真正随机匹配成功 code=15
    match_found = pyqtSignal(int, dict)

    # 注册/更新历史会话，不代表新匹配
    peer_registered = pyqtSignal(int, dict)

    conv_closed = pyqtSignal(int, str)
    worker_log = pyqtSignal(int, str)

    def __init__(self, index: int):
        super().__init__()
        self.index = index
        self.config = WorkerConfig(
            nickname=f"用户{gen_client_id()[:6]}",
            greeting="你好",
        )

        self._cmd_deque = deque()
        self._running = False
        self._paused = False
        self._ws = None
        self._cid = ""

        # ── Layer 1: 随机匹配状态 ─────────────────────────────
        self._match_state = "idle"     # idle | matching | matched
        self._matched_peer = ""        # 当前随机匹配对象 peer_id，randomOut 后清空

        # ── Layer 2: 会话/聊天窗口状态 ────────────────────────
        self._peer_id = ""             # 当前聊天窗口选中的会话对象，不随 randomOut 清空
        self._peer_name = ""
        self._peer_left = False

        # conversations: peer_id → {name, sex, status: open/closed}
        self._conversations: dict[str, dict] = {}

        # 已经匹配过的 peer_id，用于重复匹配自动跳过
        self._seen_peers: set[str] = set()

        # 运行模式
        self._mode = "MATCHING"        # MATCHING | CHATTING | IDLE_CHAT
        self._chat_start = 0.0
        self._manual_mode = False

        # 服务端内部 ID。sign.id != code=7.fromuser.id
        self._server_user_id = ""

    # ── public readonly state ──────────────────────────────────

    @property
    def current_peer_id(self) -> str:
        return self._peer_id

    @property
    def is_paused(self) -> bool:
        return self._paused

    def stop(self):
        self.cmd_stop()

    # ── GUI → worker ───────────────────────────────────────────

    def cmd_stop(self):
        self._running = False
        self._cmd_deque.append({"type": "stop"})

    def cmd_pause(self):
        self._paused = True
        self._cmd_deque.append({"type": "pause"})

    def cmd_resume(self):
        self._paused = False
        self._cmd_deque.append({"type": "resume"})

    def cmd_send_message(self, text: str):
        self._cmd_deque.append({
            "type": "send_message",
            "text": text,
        })

    def cmd_send_to_peer(self, peer_id: str, peer_name: str, text: str):
        self._cmd_deque.append({
            "type": "send_to_peer",
            "peer_id": peer_id,
            "peer_name": peer_name,
            "text": text,
        })

    def cmd_rematch(self):
        self._cmd_deque.append({"type": "rematch"})

    def cmd_close_conversation(self, peer_id: str):
        self._cmd_deque.append({
            "type": "close_conversation",
            "peer_id": peer_id,
        })

    def cmd_update_config(self, nickname: str, greeting: str):
        self._cmd_deque.append({
            "type": "update_config",
            "nickname": nickname,
            "greeting": greeting,
        })

    # ── main async loop ────────────────────────────────────────

    async def run(self):
        self._cid = gen_client_id()
        self._running = True

        while self._running:
            try:
                async with websockets.connect(WS_URL) as ws:
                    self._ws = ws
                    self._log("[CONNECT] WebSocket 已连接")

                    await self._do_sign()

                    self._mode = "MATCHING"
                    self._match_state = "idle"
                    self._set_status("匹配中")

                    while self._running:
                        self._process_commands()

                        if self._paused:
                            await asyncio.sleep(0.5)
                            continue

                        if self._mode in ("CHATTING", "IDLE_CHAT"):
                            await self._chatting_loop()
                            continue

                        if self._mode == "MATCHING":
                            await self._matching_loop()
                            continue

                        await asyncio.sleep(0.2)

            except asyncio.CancelledError:
                break
            except (websockets.ConnectionClosed, ConnectionError, OSError) as e:
                self._log(f"[DISCONNECT] {e}, 3s后重连...")
                self._set_status("已断开")
                self._mode = "MATCHING"
                self._match_state = "idle"
                await asyncio.sleep(3)
            except Exception as e:
                self._log(f"[ERROR] {e}, 3s后重试...")
                self._set_status("异常")
                self._mode = "MATCHING"
                self._match_state = "idle"
                await asyncio.sleep(3)

    async def _matching_loop(self):
        delay = random.uniform(1, 3)
        await self._sleep_or_cmd(delay)

        if not self._running or self._paused:
            return

        if self._mode != "MATCHING":
            return

        await self._send_random()
        self._match_state = "matching"

        while self._running and self._mode == "MATCHING" and not self._paused:
            data = await self._recv_or_cmd()
            if data is None:
                continue

            code = data.get("code")

            if code == 13:
                self._log("[MATCHING] 已进入匹配队列")
                continue

            await self._handle_ws_message(data)

            if code == 15:
                break

    # ── protocol ───────────────────────────────────────────────

    async def _do_sign(self):
        payload = {
            "act": "sign",
            "id": self._cid,
            "name": self.config.nickname,
            "userSex": "男",
            "address_show": "false",
            "randomhealthmode": "0",
            "randomvipsex": "0",
            "randomvipaddress": "0",
            "userip": "",
            "useraddree": random_city(),
            "randomvipcode": "",
        }

        await self._ws.send(json.dumps(payload, ensure_ascii=False))

        raw = await self._ws.recv()
        resp = json.loads(raw)

        if resp.get("code") == 12:
            self._log(f"sign 成功 ({payload['useraddree']})")
        else:
            self._log(f"[SIGN] 非预期返回: {resp}")

    async def _send_random(self):
        payload = {
            "act": "random",
            "id": self._cid,
            "preferSex": None,
            "preferAddress": False,
            "preferTag": None,
        }

        await self._ws.send(json.dumps(payload, ensure_ascii=False))
        self._set_status("匹配中")

    async def _on_match(self, data: dict):
        peer_id = data.get("sel_userid", "")
        peer_name = data.get("sel_userNikename", "")
        peer_sex = data.get("sel_userSex", "")

        if not peer_id:
            self._log("[MATCH] code=15 缺少 sel_userid")
            return

        # 重复匹配对象：自动跳过，继续下一轮
        if AUTO_SKIP_DUPLICATE_PEER and peer_id in self._seen_peers:
            await self._skip_current_match(peer_id, "重复匹配对象，自动跳过")
            return

        # 第一次见到该 peer，记录
        self._seen_peers.add(peer_id)

        # 当前聊天窗口对象
        self._peer_id = peer_id
        self._peer_name = peer_name or peer_id[:8]
        self._peer_left = False

        # Layer 1: 随机匹配状态
        self._match_state = "matched"
        self._matched_peer = peer_id

        # Layer 2: 会话状态，创建或恢复 conversation
        self._ensure_conversation(peer_id, self._peer_name, peer_sex, reopen=True)

        self._log(
            f"[MATCH] {self._cid[:8]}... matched {self._peer_name} [{peer_sex}]"
        )

        # 通知 GUI：真正匹配成功
        self.match_found.emit(self.index, data)

        # 进入聊天状态
        self._mode = "CHATTING"
        self._chat_start = time.time()
        self._manual_mode = False
        self._set_status("对话中")

        # 只对 女 / 保密 自动打招呼
        if AUTO_GREETING and peer_sex in ("女", "保密"):
            delay = random.uniform(2, 4)
            await self._sleep_or_cmd(delay)

            # 延迟期间可能已经切换匹配/关闭/暂停，所以发送前再校验一次
            if (
                    self._running
                    and self._ws
                    and self._peer_id == peer_id
                    and self._matched_peer == peer_id
                    and self._conv_is_open(peer_id)
            ):
                greeting = (self.config.greeting or "你好").strip()
                if greeting:
                    await self._send_touser_to(peer_id, self._peer_name, greeting)
                    self._log(
                        f"[MESSAGE] 自动招呼语 → {self._peer_name}: {greeting[:20]}"
                    )

    async def _skip_current_match(self, peer_id: str, reason: str):
        """
        跳过当前随机匹配对象：
        - 发送 randomOut
        - 只解除随机匹配状态
        - 不关闭 conversation
        - 切回 MATCHING，继续下一轮
        """
        if not peer_id:
            return

        self._log(f"[SKIP] {reason}: {peer_id[:12]}...")

        if self._ws:
            await self._random_out(peer_id)

        if self._matched_peer == peer_id:
            self._matched_peer = ""

        self._match_state = "idle"
        self._mode = "MATCHING"
        self._peer_left = False

        self._set_status("匹配中")

    async def _random_out(self, peer_id: str):
        if not self._ws or not peer_id:
            return

        payload = {
            "act": "randomOut",
            "id": self._cid,
            "msg": peer_id,
        }

        await self._ws.send(json.dumps(payload, ensure_ascii=False))

    async def _send_touser(self, text: str):
        await self._send_touser_to(self._peer_id, self._peer_name, text)

    async def _send_touser_to(self, peer_id: str, peer_name: str, text: str):
        if not self._ws:
            self._chat_emit("", "system", "", "未连接，无法发送")
            return

        if not peer_id or not peer_name:
            self._chat_emit("", "system", "", "发送失败：目标对象信息不完整")
            return

        payload = {
            "act": f"touser_{peer_id}_{peer_name}",
            "id": self._cid,
            "msg": text,
        }

        await self._ws.send(json.dumps(payload, ensure_ascii=False))

        # 乐观显示；服务端回显会被识别为自己消息并忽略，避免重复显示
        self._chat_emit(peer_id, "sent", self.config.nickname, text)

    # ── unified message handler ────────────────────────────────

    async def _handle_ws_message(self, data: dict):
        code = data.get("code")

        if code == 3:
            self._handle_offline(data)

        elif code == 7:
            self._handle_code7(data)

        elif code == 15:
            await self._on_match(data)

        elif code in (18, 19):
            self._log(f"[STATE] code={code}, content={data.get('content')}")

        elif code == 12:
            self._log("[SIGN] code=12")

        else:
            self._log(f"[WS] 未处理消息: {data}")

    def _handle_offline(self, data: dict):
        offline_id = data.get("userIdMd5", "")

        info = self._conversations.get(offline_id, {})
        offline_name = info.get("name", offline_id[:8] if offline_id else "未知用户")

        self._log(
            f"[OFFLINE] {offline_name}({offline_id[:12]}...) 离线/离开，"
            f"当前聊天={self._peer_name}({self._peer_id[:12]}...), "
            f"匹配对象={self._matched_peer[:12]}..."
        )

        # code=3 不自动 randomOut，不关闭 conversation
        if offline_id and offline_id == self._peer_id:
            self._peer_left = True
            self._chat_emit(
                self._peer_id,
                "system",
                "",
                f"{offline_name} 已离开或离线 — 会话保持开放，可继续发送或点击「重新匹配」",
            )

            if self._mode == "CHATTING":
                self._mode = "IDLE_CHAT"

            self._set_status(f"{offline_name} 已离开")

        elif offline_id and offline_id == self._matched_peer:
            self._chat_emit(
                self._matched_peer,
                "system",
                "",
                "匹配对象已离开 — 会话保持开放",
            )

    def _handle_code7(self, data: dict):
        fromuser = data.get("fromuser", {})
        touser = data.get("touser", {})

        from_id = fromuser.get("id", "")
        from_name = fromuser.get("nickname", "")
        content = fromuser.get("content", "")

        to_id = touser.get("id", "")
        to_name = touser.get("nickname", "")

        if not from_id:
            return

        # 识别自己的服务端内部 ID，避免服务端回显造成重复显示
        if from_name == self.config.nickname:
            self._server_user_id = from_id
            self._log(f"[MESSAGE_ECHO] 自己消息回显 → {to_name}: {content[:20]}")
            return

        if self._server_user_id and from_id == self._server_user_id:
            self._log(f"[MESSAGE_ECHO] 自己消息回显 → {to_name}: {content[:20]}")
            return

        # 对方发来的消息
        peer_id = from_id
        peer_name = from_name or peer_id[:8]

        self._ensure_conversation(peer_id, peer_name, sex="", reopen=True)

        self._log(f"[MESSAGE] 收到 {peer_name}: {content[:20]}")

        self._chat_emit(peer_id, "received", peer_name, content)

        if peer_id == self._peer_id:
            self._manual_mode = True
            self._chat_start = time.time()
            self._set_status("对话中(对方已回复)")
        else:
            self._log(f"[MESSAGE] 非当前会话新消息 from={peer_name}")

    # ── chatting / idle_chat loop ──────────────────────────────

    async def _chatting_loop(self):
        while self._running and self._mode in ("CHATTING", "IDLE_CHAT"):
            self._process_commands()

            if self._mode not in ("CHATTING", "IDLE_CHAT"):
                break

            if self._paused:
                await asyncio.sleep(0.5)
                continue

            # timeout only in auto-CHATTING
            if self._mode == "CHATTING":
                elapsed = time.time() - self._chat_start
                if not self._manual_mode and not self._peer_left and elapsed > 60:
                    self._log("[TIMEOUT] 1分钟无回复，会话保持 open，切换 IDLE_CHAT")
                    self._chat_emit(
                        self._peer_id,
                        "system",
                        "",
                        "1分钟无回复 — 会话保持开放，可继续发送消息或点击「重新匹配」",
                    )
                    self._mode = "IDLE_CHAT"
                    self._set_status("对话中(无回复)")
                    continue

            try:
                raw = await asyncio.wait_for(self._ws.recv(), timeout=1.0)
            except asyncio.TimeoutError:
                continue

            try:
                data = json.loads(raw)
            except json.JSONDecodeError:
                continue

            await self._handle_ws_message(data)

    # ── command processing ─────────────────────────────────────

    def _process_commands(self):
        while self._cmd_deque:
            cmd = self._cmd_deque.popleft()
            t = cmd.get("type")

            if t == "stop":
                self._running = False

            elif t == "pause":
                self._paused = True
                self._set_status("已暂停")

            elif t == "resume":
                self._paused = False
                self._set_status("匹配中" if self._mode == "MATCHING" else "运行中")

            elif t == "update_config":
                self.config.nickname = cmd["nickname"]
                self.config.greeting = cmd["greeting"]
                self._log("配置已更新")

            elif t == "send_message":
                self._cmd_send_message(cmd["text"])

            elif t == "send_to_peer":
                self._cmd_send_to_peer(
                    cmd["peer_id"],
                    cmd["peer_name"],
                    cmd["text"],
                )

            elif t == "rematch":
                self._cmd_rematch()

            elif t == "close_conversation":
                self._cmd_close_conversation(cmd["peer_id"])

    def _cmd_send_message(self, text: str):
        if not self._ws:
            self._chat_emit("", "system", "", "未连接，无法发送")
            return

        if not self._peer_id:
            self._chat_emit("", "system", "", "没有当前聊天对象")
            return

        if not self._peer_name:
            self._chat_emit("", "system", "", "当前聊天对象缺少昵称，无法发送")
            return

        if not self._conv_is_open(self._peer_id):
            return

        self._log(f"[MESSAGE] → {self._peer_name}: {text[:20]}")
        asyncio.ensure_future(self._send_touser(text))

        if self._mode == "CHATTING":
            self._manual_mode = True

    def _cmd_send_to_peer(self, peer_id: str, peer_name: str, text: str):
        if not self._ws:
            self._chat_emit("", "system", "", "未连接，无法发送")
            return

        if not peer_id:
            self._chat_emit("", "system", "", "没有选择聊天对象")
            return

        conv = self._conversations.get(peer_id)
        if conv:
            peer_name = peer_name or conv.get("name", "")

        if not peer_name:
            self._chat_emit("", "system", "", "历史会话缺少昵称，无法发送")
            return

        if not self._conv_is_open(peer_id):
            return

        # 切换当前聊天窗口对象，但不影响 _matched_peer
        self._peer_id = peer_id
        self._peer_name = peer_name
        self._peer_left = True
        self._mode = "IDLE_CHAT"

        self._set_status(f"对话中({peer_name})")
        self._log(f"[MESSAGE] → history {peer_name}: {text[:20]}")

        asyncio.ensure_future(
            self._send_touser_to(peer_id, peer_name, text)
        )

    def _cmd_rematch(self):
        """
        重新匹配：
        - 只对 _matched_peer 发送 randomOut
        - 不关闭 conversation
        - 不清空 _peer_id/_peer_name
        - 允许历史聊天继续发送
        """
        if self._ws and self._matched_peer:
            asyncio.ensure_future(self._random_out(self._matched_peer))

        self._match_state = "idle"
        self._matched_peer = ""
        self._mode = "MATCHING"
        self._peer_left = False

        self._log("[RANDOM_OUT] 重新匹配，conv 保持 open，_peer_id 未清")
        self._set_status("匹配中")
        self._chat_emit(
            self._peer_id,
            "system",
            "",
            "已重新开始匹配（会话保持开放）",
        )

    def _cmd_close_conversation(self, peer_id: str):
        if not peer_id:
            return

        if peer_id in self._conversations:
            self._conversations[peer_id]["status"] = "closed"

        if ENABLE_SERVER_CLOSE_CONV and self._ws:
            asyncio.ensure_future(
                self._ws.send(json.dumps({
                    "act": "closeConversation",
                    "id": self._cid,
                    "msg": peer_id,
                }, ensure_ascii=False))
            )

        self._log(f"[CONV_CLOSE] 会话关闭 {self._cid[:8]}...:{peer_id[:8]}...")
        self._chat_emit(peer_id, "system", "", "会话已关闭")
        self.conv_closed.emit(self.index, peer_id)

        if self._peer_id == peer_id:
            self._peer_id = ""
            self._peer_name = ""

        if self._matched_peer == peer_id:
            self._matched_peer = ""
            self._match_state = "idle"

        if self._mode == "MATCHING":
            self._set_status("匹配中")
        elif self._peer_name:
            self._set_status(f"对话中({self._peer_name})")
        else:
            self._set_status("空闲")

    # ── conversation validation ────────────────────────────────

    def _ensure_conversation(self, peer_id: str, name: str, sex: str = "", reopen: bool = True):
        if not peer_id:
            return

        name = name or peer_id[:8]

        if peer_id not in self._conversations:
            self._conversations[peer_id] = {
                "name": name,
                "sex": sex or "",
                "status": "open",
            }
            self._log(f"[CONV] 创建会话 {self._cid[:8]}...:{peer_id[:8]}... status=open")
        else:
            self._conversations[peer_id]["name"] = name
            if sex:
                self._conversations[peer_id]["sex"] = sex
            if reopen:
                self._conversations[peer_id]["status"] = "open"
            self._log(f"[CONV] 恢复/更新会话 {self._cid[:8]}...:{peer_id[:8]}...")

        self.peer_registered.emit(self.index, {
            "sel_userid": peer_id,
            "sel_userNikename": name,
            "sel_userSex": self._conversations[peer_id].get("sex", ""),
        })

    def _conv_is_open(self, peer_id: str) -> bool:
        conv = self._conversations.get(peer_id)

        if conv is None:
            self._chat_emit("", "system", "", "[MESSAGE_DENY] 没有会话关系，无法发送")
            return False

        if conv.get("status") != "open":
            self._chat_emit(peer_id, "system", "", "[MESSAGE_DENY] 会话已关闭，无法发送")
            return False

        return True

    # ── async helpers ──────────────────────────────────────────

    async def _recv_or_cmd(self):
        while self._running:
            self._process_commands()

            if not self._running:
                return None

            if self._mode != "MATCHING":
                return None

            try:
                raw = await asyncio.wait_for(self._ws.recv(), timeout=0.5)
                return json.loads(raw)
            except asyncio.TimeoutError:
                continue
            except json.JSONDecodeError:
                continue

        return None

    async def _sleep_or_cmd(self, seconds: float):
        deadline = time.time() + seconds

        while time.time() < deadline and self._running:
            self._process_commands()
            await asyncio.sleep(0.2)

    # ── signal helpers ─────────────────────────────────────────

    def _set_status(self, text: str):
        self.status_changed.emit(self.index, text)

    def _chat_emit(self, peer_id: str, msg_type: str, sender: str, content: str):
        self.chat_message.emit(self.index, peer_id or "", msg_type, sender, content)

    def _log(self, text: str):
        self.worker_log.emit(self.index, text)