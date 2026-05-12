import html

from PyQt5.QtGui import QColor, QFont
from PyQt5.QtWidgets import (
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QListWidget,
    QListWidgetItem,
    QMainWindow,
    QPushButton,
    QSplitter,
    QTabWidget,
    QTextEdit,
    QVBoxLayout,
    QWidget,
)

FONT = QFont("Microsoft YaHei", 11)
FONT_BOLD = QFont("Microsoft YaHei", 12, QFont.Bold)


class ChatTab(QWidget):
    def __init__(self, index: int, parent=None):
        super().__init__(parent)
        self.index = index
        self.match_count = 0
        self.current_peer_id = ""

        # peer_history:
        # peer_id → {
        #   name,
        #   sex,
        #   status: open/closed,
        #   unread: bool,
        #   messages: [{type,sender,content}]
        # }
        self.peer_history = {}

        self._init_ui()

    def _init_ui(self):
        self.setFont(FONT)
        layout = QVBoxLayout(self)
        layout.setSpacing(4)

        # ── top bar ────────────────────────────────────────────
        top_row = QHBoxLayout()
        self.status_label = QLabel("就绪")
        self.status_label.setFont(FONT_BOLD)
        self.match_label = QLabel("已匹配: 0 次")
        top_row.addWidget(self.status_label)
        top_row.addStretch()
        top_row.addWidget(self.match_label)
        layout.addLayout(top_row)

        # ── config row ─────────────────────────────────────────
        cfg_row = QHBoxLayout()
        cfg_row.addWidget(QLabel("昵称:"))

        self.nickname_input = QLineEdit()
        self.nickname_input.setPlaceholderText("输入昵称")
        self.nickname_input.setMaximumWidth(120)
        cfg_row.addWidget(self.nickname_input)

        cfg_row.addWidget(QLabel("招呼语:"))

        self.greeting_input = QLineEdit()
        self.greeting_input.setPlaceholderText("你好")
        self.greeting_input.setMaximumWidth(140)
        cfg_row.addWidget(self.greeting_input)

        self.apply_btn = QPushButton("应用配置")
        self.apply_btn.setFixedWidth(85)
        cfg_row.addWidget(self.apply_btn)

        cfg_row.addStretch()
        layout.addLayout(cfg_row)

        # ── main area: conv list + chat log ────────────────────
        splitter = QSplitter()
        splitter.setChildrenCollapsible(False)

        # left: conversation list
        left_widget = QWidget()
        left_layout = QVBoxLayout(left_widget)
        left_layout.setContentsMargins(0, 0, 0, 0)
        left_layout.setSpacing(2)

        left_layout.addWidget(QLabel("会话列表"))

        self.conv_list = QListWidget()
        self.conv_list.setFont(QFont("Microsoft YaHei", 10))
        self.conv_list.setMinimumWidth(140)
        left_layout.addWidget(self.conv_list)

        self.close_conv_btn = QPushButton("关闭会话")
        left_layout.addWidget(self.close_conv_btn)

        splitter.addWidget(left_widget)

        # right: chat log
        self.chat_log = QTextEdit()
        self.chat_log.setReadOnly(True)
        self.chat_log.setFont(QFont("Microsoft YaHei", 11))
        self.chat_log.setStyleSheet(
            "QTextEdit { background: #f8f8f8; border: 1px solid #ddd; "
            "border-radius: 4px; }"
        )
        splitter.addWidget(self.chat_log)

        splitter.setSizes([180, 600])
        layout.addWidget(splitter, stretch=1)

        # ── input row ──────────────────────────────────────────
        input_row = QHBoxLayout()
        self.msg_input = QLineEdit()
        self.msg_input.setPlaceholderText("输入消息，回车发送...")

        self.send_btn = QPushButton("发送")
        self.send_btn.setFixedWidth(70)

        input_row.addWidget(self.msg_input)
        input_row.addWidget(self.send_btn)
        layout.addLayout(input_row)

        # ── action buttons ─────────────────────────────────────
        btn_row = QHBoxLayout()

        self.rematch_btn = QPushButton("重新匹配")
        self.pause_btn = QPushButton("暂停匹配")

        btn_row.addWidget(self.rematch_btn)
        btn_row.addWidget(self.pause_btn)
        btn_row.addStretch()

        layout.addLayout(btn_row)

    # ── public helpers ─────────────────────────────────────────

    def set_status(self, text: str):
        self.status_label.setText(text)

    def inc_match_count(self):
        self.match_count += 1
        self.match_label.setText(f"已匹配: {self.match_count} 次")

    def add_system_message(self, content: str):
        """
        全局系统日志：只显示，不写入某个会话，避免污染历史聊天记录。
        """
        safe = html.escape(content)
        self.chat_log.append(f'<i style="color:#888">[{safe}]</i>')

    def add_chat_message(self, msg_type: str, sender: str, content: str, save: bool = True):
        """
        兼容旧调用：默认写入当前会话。
        新逻辑优先使用 add_chat_message_for_peer。
        """
        if save and self.current_peer_id:
            self.add_chat_message_for_peer(self.current_peer_id, msg_type, sender, content)
        else:
            self._append_message_to_view(msg_type, sender, content)

    def add_chat_message_for_peer(self, peer_id: str, msg_type: str, sender: str, content: str):
        """
        指定 peer_id 写入消息，避免历史消息存到当前窗口。
        如果 peer_id 是当前会话，则同时显示。
        如果 peer_id 不是当前会话，则只保存并标记未读。
        """
        if not peer_id:
            # 没有归属会话的系统消息，只显示
            self._append_message_to_view(msg_type, sender, content)
            return

        if peer_id not in self.peer_history:
            # 占位注册，后续 peer_registered / match_found 会更新昵称
            fallback_name = sender or peer_id[:8]
            self.register_peer(peer_id, fallback_name, "")

        self.peer_history[peer_id]["messages"].append({
            "type": msg_type,
            "sender": sender,
            "content": content,
        })

        if peer_id == self.current_peer_id:
            self._append_message_to_view(msg_type, sender, content)
        else:
            self.peer_history[peer_id]["unread"] = True
            self._update_conv_item(
                peer_id,
                self.peer_history[peer_id].get("name", peer_id[:8]),
                self.peer_history[peer_id].get("sex", ""),
            )

    def _append_message_to_view(self, msg_type: str, sender: str, content: str):
        sender_safe = html.escape(sender or "")
        content_safe = html.escape(content or "")

        color_map = {
            "sent": "#1565C0",
            "received": "#2E7D32",
            "system": "#888888",
        }
        color = color_map.get(msg_type, "#333")

        if msg_type == "sent":
            prefix = f'<b style="color:{color}">你:</b> '
            self.chat_log.append(f"{prefix}{content_safe}")
        elif msg_type == "received":
            prefix = f'<b style="color:{color}">{sender_safe}:</b> '
            self.chat_log.append(f"{prefix}{content_safe}")
        else:
            self.chat_log.append(f'<i style="color:{color}">[{content_safe}]</i>')

    # ── conversation list ──────────────────────────────────────

    def register_peer(self, peer_id: str, peer_name: str, peer_sex: str):
        if not peer_id:
            return

        peer_name = peer_name or peer_id[:8]
        peer_sex = peer_sex or ""

        if peer_id not in self.peer_history:
            self.peer_history[peer_id] = {
                "name": peer_name,
                "sex": peer_sex,
                "status": "open",
                "unread": False,
                "messages": [],
            }
            self._add_conv_item(peer_id, peer_name, peer_sex)
        else:
            self.peer_history[peer_id]["name"] = peer_name
            self.peer_history[peer_id]["sex"] = peer_sex
            if "status" not in self.peer_history[peer_id]:
                self.peer_history[peer_id]["status"] = "open"
            if "unread" not in self.peer_history[peer_id]:
                self.peer_history[peer_id]["unread"] = False
            self._update_conv_item(peer_id, peer_name, peer_sex)

    def _add_conv_item(self, peer_id: str, peer_name: str, peer_sex: str):
        item = QListWidgetItem(self._build_conv_text(peer_id, peer_name, peer_sex))
        item.setData(1, peer_id)
        self.conv_list.addItem(item)

    def _update_conv_item(self, peer_id: str, peer_name: str, peer_sex: str):
        for i in range(self.conv_list.count()):
            item = self.conv_list.item(i)
            if item.data(1) == peer_id:
                item.setText(self._build_conv_text(peer_id, peer_name, peer_sex))

                status = self.peer_history.get(peer_id, {}).get("status", "open")
                unread = self.peer_history.get(peer_id, {}).get("unread", False)

                if status == "closed":
                    item.setForeground(QColor("gray"))
                elif unread:
                    item.setForeground(QColor("#D84315"))
                else:
                    item.setForeground(QColor("black"))
                break

    def _build_conv_text(self, peer_id: str, peer_name: str, peer_sex: str) -> str:
        info = self.peer_history.get(peer_id, {})
        status = info.get("status", "open")
        unread = info.get("unread", False)

        text = f"{peer_name} [{peer_sex}]" if peer_sex else f"{peer_name}"

        if status == "closed":
            text += " (已关闭)"
        elif unread:
            text += " (新消息)"

        return text

    def mark_conv_closed(self, peer_id: str):
        if peer_id in self.peer_history:
            self.peer_history[peer_id]["status"] = "closed"
            self.peer_history[peer_id]["unread"] = False
            info = self.peer_history[peer_id]
            self._update_conv_item(peer_id, info.get("name", ""), info.get("sex", ""))

    def set_current_peer(self, peer_id: str):
        if not peer_id:
            return

        self.current_peer_id = peer_id

        if peer_id in self.peer_history:
            self.peer_history[peer_id]["unread"] = False
            info = self.peer_history[peer_id]
            self._update_conv_item(peer_id, info.get("name", ""), info.get("sex", ""))

        self.chat_log.clear()

        if peer_id and peer_id in self.peer_history:
            info = self.peer_history[peer_id]
            name = html.escape(info.get("name", peer_id[:8]))
            self.chat_log.append(
                f'<i style="color:#888">--- 与 {name} 的聊天记录 ---</i>'
            )

            if info.get("status") == "closed":
                self.chat_log.append(
                    '<i style="color:#888">[该会话已关闭，不能继续发送]</i>'
                )

            for msg in info["messages"]:
                self._append_message_to_view(
                    msg["type"], msg["sender"], msg["content"]
                )


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("星火随机匹配")
        self.setMinimumSize(1000, 700)
        self.setFont(FONT)

        self.tabs = QTabWidget()
        self.setCentralWidget(self.tabs)

        self.chat_tabs: list[ChatTab] = []
        for i in range(5):
            tab = ChatTab(i)
            self.chat_tabs.append(tab)
            self.tabs.addTab(tab, f"线程 {i + 1}")

    def tab(self, index: int) -> ChatTab:
        return self.chat_tabs[index]