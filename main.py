import asyncio
import sys

import qasync
from PyQt5.QtGui import QFont
from PyQt5.QtWidgets import QApplication

from gui import MainWindow
from worker import MatchWorker


def wire_worker_gui(worker: MatchWorker, window: MainWindow):
    tab = window.tab(worker.index)
    tab.nickname_input.setText(worker.config.nickname)
    tab.greeting_input.setText(worker.config.greeting)

    # ── worker → GUI ───────────────────────────────────────────
    worker.status_changed.connect(
        lambda i, t, tb=tab: tb.set_status(t)
    )

    # 真正 code=15 随机匹配成功
    worker.match_found.connect(_on_match_found(tab))

    # 仅注册/更新历史会话，不增加匹配次数，不强制切换窗口
    worker.peer_registered.connect(_on_peer_registered(tab))

    # 指定 peer_id 的消息，避免历史消息存错会话
    worker.chat_message.connect(
        lambda i, pid, mt, s, c, tb=tab: tb.add_chat_message_for_peer(pid, mt, s, c)
    )

    worker.worker_log.connect(
        lambda i, t, tb=tab: tb.add_system_message(t)
    )

    worker.conv_closed.connect(
        lambda i, pid, tb=tab: tb.mark_conv_closed(pid)
    )

    # ── GUI → worker ───────────────────────────────────────────
    tab.apply_btn.clicked.connect(
        lambda: worker.cmd_update_config(
            tab.nickname_input.text().strip() or worker.config.nickname,
            tab.greeting_input.text().strip() or "你好",
        )
    )

    tab.send_btn.clicked.connect(lambda: _send_message(worker, tab))
    tab.msg_input.returnPressed.connect(lambda: _send_message(worker, tab))
    tab.rematch_btn.clicked.connect(lambda: worker.cmd_rematch())
    tab.pause_btn.clicked.connect(lambda: _toggle_pause(worker, tab))

    # ── conversation list ─────────────────────────────────────
    tab.conv_list.currentItemChanged.connect(
        lambda cur, prev, tb=tab: _on_conv_selected(tb, cur)
    )

    tab.close_conv_btn.clicked.connect(
        lambda: _close_conversation(worker, tab)
    )


def _on_match_found(tab):
    """
    只处理真正 code=15 的随机匹配成功。
    会增加匹配次数，并切换当前会话到新匹配对象。
    """
    def handler(idx, data):
        peer_id = data.get("sel_userid", "")
        peer_name = data.get("sel_userNikename", "")
        peer_sex = data.get("sel_userSex", "")

        if not peer_id:
            return

        tab.inc_match_count()
        tab.register_peer(peer_id, peer_name, peer_sex)
        tab.set_current_peer(peer_id)

    return handler


def _on_peer_registered(tab):
    """
    只注册/更新历史会话。
    不增加匹配次数，不强制切换当前聊天对象。
    """
    def handler(idx, data):
        peer_id = data.get("sel_userid", "")
        peer_name = data.get("sel_userNikename", "")
        peer_sex = data.get("sel_userSex", "")

        if not peer_id:
            return

        tab.register_peer(peer_id, peer_name, peer_sex)

        # 如果当前没有选中任何会话，可以默认选中第一个
        if not tab.current_peer_id:
            tab.set_current_peer(peer_id)

    return handler


def _send_message(worker: MatchWorker, tab):
    text = tab.msg_input.text().strip()
    if not text:
        return

    # 优先发送给 GUI 当前选中的会话对象
    if tab.current_peer_id:
        info = tab.peer_history.get(tab.current_peer_id, {})
        peer_name = info.get("name", "")

        if not peer_name:
            tab.add_system_message("历史会话缺少昵称，无法发送")
            return

        worker.cmd_send_to_peer(
            tab.current_peer_id,
            peer_name,
            text,
        )
    else:
        # 没有 GUI 选中对象时，尝试发送给 worker 当前聊天对象
        worker.cmd_send_message(text)

    tab.msg_input.clear()


def _on_conv_selected(tab, current):
    if current is None:
        return

    peer_id = current.data(1)
    if peer_id:
        tab.set_current_peer(peer_id)


def _close_conversation(worker: MatchWorker, tab):
    if tab.current_peer_id:
        worker.cmd_close_conversation(tab.current_peer_id)


def _toggle_pause(worker: MatchWorker, tab):
    if worker.is_paused:
        worker.cmd_resume()
        tab.pause_btn.setText("暂停匹配")
    else:
        worker.cmd_pause()
        tab.pause_btn.setText("继续匹配")


def main():
    q_app = QApplication(sys.argv)
    q_app.setFont(QFont("Microsoft YaHei", 11))

    loop = qasync.QEventLoop(q_app)
    asyncio.set_event_loop(loop)

    window = MainWindow()

    workers = [MatchWorker(i) for i in range(5)]

    for w in workers:
        wire_worker_gui(w, window)

    tasks = [loop.create_task(w.run()) for w in workers]

    def on_close():
        for w in workers:
            w.stop()
        for t in tasks:
            t.cancel()

    q_app.aboutToQuit.connect(on_close)

    window.show()

    with loop:
        loop.run_forever()


if __name__ == "__main__":
    main()