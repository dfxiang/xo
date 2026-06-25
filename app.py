#!/usr/bin/env python3
"""
xo Term - 网页版终端
在浏览器中获得一个完整的 Linux 终端，用于服务器维护。

用法:
    python app.py --user admin --pwd MyPassword
    python app.py --port 80 --user root --pwd secret --shell /bin/zsh

然后浏览器打开 http://服务器IP:端口
"""

import os
import sys
import pty
import json
import re
import time
import signal
import struct
import fcntl
import termios
import argparse
import asyncio
import datetime
from pathlib import Path

import docker
docker_client = docker.from_env()

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, UploadFile, File
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

# ── CLI 参数 ───────────────────────────────────────────────────

parser = argparse.ArgumentParser(
    description="xo Term - 网页版终端",
    formatter_class=argparse.RawDescriptionHelpFormatter,
    epilog="""
示例:
    python app.py --user admin --pwd MyPassword
    python app.py --port 80 --user root --pwd secret --shell /bin/zsh
    """,
)
parser.add_argument("--port", type=int, default=8080, help="监听端口 (默认: 8080)")
parser.add_argument("--host", type=str, default="0.0.0.0", help="监听地址 (默认: 0.0.0.0)")
parser.add_argument("--user", type=str, required=True, help="登录用户名")
parser.add_argument("--pwd", type=str, required=True, help="登录密码")
parser.add_argument("--shell", type=str, default="/bin/bash", help="Shell 路径 (默认: /bin/bash)")
ARGS = parser.parse_args()

# ── FastAPI 应用 ───────────────────────────────────────────────

app = FastAPI(title="xo Term", docs_url=None, redoc_url=None)
shell_pid = None  # 当前 shell 进程 PID，用于读取 CWD

# ── 登录 API ───────────────────────────────────────────────────

@app.post("/api/login")
async def login(data: dict):
    if data.get("user") == ARGS.user and data.get("pwd") == ARGS.pwd:
        return {"ok": True}
    raise HTTPException(status_code=401, detail="用户名或密码错误")

# ── WebSocket 终端端点 ─────────────────────────────────────────

@app.websocket("/ws")
async def terminal_ws(ws: WebSocket):
    global shell_pid
    await ws.accept()

    # 分配 PTY，fork 子进程运行 shell
    pid, fd = pty.fork()
    if pid == 0:
        # 子进程
        env = os.environ.copy()
        env["TERM"] = "xterm-256color"
        os.execve(ARGS.shell, [ARGS.shell], env)
        # 不会执行到这里

    shell_pid = pid

    loop = asyncio.get_event_loop()
    alive = True

    async def pty_to_ws():
        """读取 PTY 输出 → 推送到 WebSocket"""
        while alive:
            try:
                data = await loop.run_in_executor(None, os.read, fd, 4096)
            except OSError:
                break
            if not data:
                break
            await ws.send_bytes(data)

    async def ws_to_pty():
        """接收 WebSocket 消息 → 写入 PTY"""
        nonlocal alive
        while True:
            try:
                text = await ws.receive_text()
            except WebSocketDisconnect:
                break
            try:
                cmd = json.loads(text)
            except json.JSONDecodeError:
                continue
            if cmd.get("type") == "input":
                os.write(fd, cmd["data"].encode())
            elif cmd.get("type") == "resize":
                rows, cols = cmd["rows"], cmd["cols"]
                size = struct.pack("HHHH", rows, cols, 0, 0)
                fcntl.ioctl(fd, termios.TIOCSWINSZ, size)

    try:
        await asyncio.gather(pty_to_ws(), ws_to_pty())
    finally:
        alive = False
        try:
            os.kill(pid, signal.SIGTERM)
        except OSError:
            pass
        try:
            os.close(fd)
        except OSError:
            pass

# ── 文件浏览器 API ─────────────────────────────────────────────

TEXT_EXTENSIONS = {
    ".sh", ".bash", ".zsh", ".txt", ".log", ".md", ".py", ".js", ".ts",
    ".jsx", ".tsx", ".css", ".html", ".htm", ".json", ".xml", ".yaml",
    ".yml", ".ini", ".cfg", ".conf", ".toml", ".env", ".gitignore",
    ".dockerignore", ".rb", ".php", ".sql", ".csv", ".java", ".c",
    ".cpp", ".h", ".hpp", ".rs", ".go", ".swift", ".kt", ".scala",
    ".r", ".lua", ".pl", ".vim", ".makefile", ".cmake", ".editorconfig",
    ".bash_history", ".bashrc", ".bash_logout",
}

MAX_OPEN_SIZE = 1 * 1024 * 1024  # 1 MB


def _is_openable(path: Path) -> bool:
    """判断文件是否可以在线打开（文本类型 + 大小不超过 1MB）"""
    if not path.is_file():
        return False
    if path.stat().st_size > MAX_OPEN_SIZE:
        return False
    return path.suffix.lower() in TEXT_EXTENSIONS or path.name.lower() in TEXT_EXTENSIONS


def _get_cwd():
    """读取 shell 进程的当前工作目录"""
    if shell_pid:
        try:
            return os.readlink(f"/proc/{shell_pid}/cwd")
        except OSError:
            pass
    return os.path.expanduser("~")


def _safe_path(path: str) -> Path:
    """解析并校验路径，防止目录穿越"""
    if not path:
        path = _get_cwd()
    p = Path(path).resolve()
    blocked = {"/proc", "/sys", "/dev"}
    if str(p) in blocked or any(str(p).startswith(b + "/") for b in blocked):
        raise HTTPException(403, "禁止访问系统目录")
    if not p.is_dir():
        raise HTTPException(404, "目录不存在")
    return p


@app.get("/api/files")
async def list_files(path: str = ""):
    p = _safe_path(path)
    entries = []
    try:
        for item in sorted(p.iterdir(), key=lambda x: (not x.is_dir(), x.name.lower())):
            stat = item.stat()
            entries.append({
                "name": item.name,
                "type": "dir" if item.is_dir() else "file",
                "size": stat.st_size,
                "mtime": time.strftime("%Y-%m-%d %H:%M", time.localtime(stat.st_mtime)),
                "openable": _is_openable(item),
            })
    except PermissionError:
        raise HTTPException(403, "无权限访问该目录")
    return {"path": str(p), "entries": entries}


@app.post("/api/upload")
async def upload_file(cwd: str = "", file: UploadFile = File(...)):
    p = _safe_path(cwd) if cwd else Path(_get_cwd()).resolve()
    safe_name = Path(file.filename).name  # 防止路径穿越
    file_path = p / safe_name
    content = await file.read()
    file_path.write_bytes(content)
    return {"ok": True, "name": file.filename, "size": len(content)}


@app.get("/api/download")
async def download_file(path: str):
    p = Path(path).resolve()
    if not p.is_file():
        raise HTTPException(404, "文件不存在")
    return FileResponse(str(p), filename=p.name)


@app.get("/api/file-content")
async def get_file_content(path: str):
    p = Path(path).resolve()
    if not p.is_file():
        raise HTTPException(404, "文件不存在")
    try:
        return {"content": p.read_text()}
    except UnicodeDecodeError:
        raise HTTPException(400, "无法以文本方式读取该文件")


@app.post("/api/file-save")
async def save_file(data: dict):
    path = data.get("path", "")
    content = data.get("content", "")
    p = Path(path).resolve()
    if not p.is_file():
        raise HTTPException(404, "文件不存在")
    try:
        p.write_text(content)
        return {"ok": True}
    except Exception as e:
        raise HTTPException(500, f"保存失败: {e}")

# ── Docker 管理 API ────────────────────────────────────────────

def _dk_ok(data=None):
    return {"ok": True, "data": data}

def _dk_err(msg, code=500):
    raise HTTPException(code, msg)

def _dk_container_status(c):
    """生成类似 docker ps 的 human-readable 状态字符串"""
    s = c.attrs.get("State", {})
    state = s.get("Status", "unknown")
    started = s.get("StartedAt", "")
    finished = s.get("FinishedAt", "")
    exit_code = s.get("ExitCode", 0)
    health = s.get("Health", {}).get("Status", "")

    now = datetime.datetime.now(datetime.timezone.utc)

    def _parse_ts(ts):
        """解析 Docker 时间戳"""
        ts = (ts or "").strip()
        if not ts:
            return None
        # Docker 返回格式: "2025-06-15T08:30:00.123456789Z" 或带时区
        ts = re.sub(r'\.\d+', '', ts)  # 去掉纳秒
        for fmt in ("%Y-%m-%dT%H:%M:%SZ", "%Y-%m-%dT%H:%M:%S%z"):
            try:
                return datetime.datetime.strptime(ts, fmt).replace(tzinfo=datetime.timezone.utc)
            except ValueError:
                continue
        return None

    def _human_duration(delta):
        """将 timedelta 转为类似 '2 hours' / '5 days' 的文本"""
        total_secs = int(delta.total_seconds())
        if total_secs < 60:
            return f"{total_secs} seconds"
        mins = total_secs // 60
        if mins < 60:
            return f"{mins} minute{'s' if mins != 1 else ''}"
        hours = mins // 60
        if hours < 24:
            return f"{hours} hour{'s' if hours != 1 else ''}"
        days = hours // 24
        if days < 30:
            return f"{days} day{'s' if days != 1 else ''}"
        months = days // 30
        if months < 12:
            return f"{months} month{'s' if months != 1 else ''}"
        years = days // 365
        return f"{years} year{'s' if years != 1 else ''}"

    def _time_ago(ts):
        """返回 'X ago' 文本"""
        if ts is None:
            return ""
        delta = now - ts
        if delta.total_seconds() < 0:
            return "0 seconds ago"
        return f"{_human_duration(delta)} ago"

    if state == "running":
        started_ts = _parse_ts(started)
        if started_ts:
            delta = now - started_ts
            if delta.total_seconds() < 0:
                text = "Up Less than a second"
            else:
                text = f"Up {_human_duration(delta)}"
        else:
            text = "Up"
        if health and health not in ("", "unknown"):
            text += f" ({health})"
        return text
    elif state == "exited":
        text = f"Exited ({exit_code})"
        finished_ts = _parse_ts(finished)
        if finished_ts:
            text += f" {_time_ago(finished_ts)}"
        return text
    elif state == "paused":
        return "Paused"
    elif state == "created":
        return "Created"
    elif state == "restarting":
        return "Restarting"
    elif state == "removing":
        return "Removing"
    elif state == "dead":
        return "Dead"
    else:
        return state


def _dk_container_info(c):
    """将 docker Container 对象转为前端需要的 dict"""
    ports = []
    if c.ports:
        for private, mappings in c.ports.items():
            if mappings:
                for m in mappings:
                    host_ip = m.get('HostIp', '0.0.0.0') or '0.0.0.0'
                    ports.append(f"{host_ip}:{m['HostPort']}->{private}")
            else:
                ports.append(private)
    state = c.attrs.get("State", {}).get("Status", c.status)
    return {
        "id": c.short_id,
        "name": c.name,
        "image": ', '.join(c.image.tags) if c.image.tags else c.image.short_id,
        "status": _dk_container_status(c),
        "state": state,
        "ports": ', '.join(ports) if ports else '',
        "created": c.attrs.get("Created", ""),
    }


@app.get("/api/docker/containers")
async def dk_containers():
    try:
        containers = docker_client.containers.list(all=True)
        return _dk_ok([_dk_container_info(c) for c in containers])
    except Exception as e:
        _dk_err(f"Docker 不可用: {e}", 503)


@app.post("/api/docker/containers/{cid}/start")
async def dk_container_start(cid: str):
    try:
        c = docker_client.containers.get(cid)
        c.start()
        return _dk_ok()
    except Exception as e:
        _dk_err(str(e))


@app.post("/api/docker/containers/{cid}/stop")
async def dk_container_stop(cid: str):
    try:
        c = docker_client.containers.get(cid)
        c.stop()
        return _dk_ok()
    except Exception as e:
        _dk_err(str(e))


@app.post("/api/docker/containers/{cid}/restart")
async def dk_container_restart(cid: str):
    try:
        c = docker_client.containers.get(cid)
        c.restart()
        return _dk_ok()
    except Exception as e:
        _dk_err(str(e))


@app.get("/api/docker/containers/{cid}/logs")
async def dk_container_logs(cid: str, tail: int = 500):
    try:
        c = docker_client.containers.get(cid)
        logs = c.logs(tail=tail, timestamps=True).decode("utf-8", errors="replace")
        return _dk_ok(logs)
    except Exception as e:
        _dk_err(str(e))


@app.get("/api/docker/containers/{cid}/inspect")
async def dk_container_inspect(cid: str):
    try:
        c = docker_client.containers.get(cid)
        return _dk_ok(json.dumps(c.attrs, indent=2, ensure_ascii=False, default=str))
    except Exception as e:
        _dk_err(str(e))


@app.get("/api/docker/images")
async def dk_images():
    try:
        images = docker_client.images.list(all=True)
        result = []
        for img in images:
            tags = img.tags if img.tags else ["<none>:<none>"]
            for tag in tags:
                repo, _, tag_name = tag.partition(":")
                created = img.attrs.get("Created", "")
                result.append({
                    "id": img.short_id.replace("sha256:", ""),
                    "full_id": img.id,
                    "repo": repo or "<none>",
                    "tag": tag_name or "latest",
                    "full_tag": tag,
                    "size": img.attrs.get("Size", 0),
                    "created": created,
                })
        return _dk_ok(result)
    except Exception as e:
        _dk_err(f"Docker 不可用: {e}", 503)


@app.get("/api/docker/images/{img_id}/inspect")
async def dk_image_inspect(img_id: str):
    try:
        img = docker_client.images.get(img_id)
        return _dk_ok(json.dumps(img.attrs, indent=2, ensure_ascii=False, default=str))
    except Exception as e:
        _dk_err(str(e))


@app.post("/api/docker/images/delete")
async def dk_images_delete(data: dict):
    ids = data.get("ids", [])
    if not ids:
        _dk_err("请指定要删除的镜像", 400)
    errors = []
    for img_id in ids:
        try:
            docker_client.images.remove(img_id, force=True)
        except Exception as e:
            errors.append(f"{img_id}: {e}")
    if errors:
        _dk_err("; ".join(errors))
    return _dk_ok()


# ── 静态文件 ───────────────────────────────────────────────────

# PyInstaller 打包后资源在 sys._MEIPASS，开发时用当前目录
if getattr(sys, 'frozen', False):
    STATIC_DIR = os.path.join(sys._MEIPASS, "static")
else:
    STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")

if os.path.isdir(STATIC_DIR):
    app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")

# ── 入口 ────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn

    print(f"*xo Term(Powered By Danfeng Xiang) 启动")
    print(f"*地址: http://{ARGS.host}:{ARGS.port}")
    print(f"*Shell: {ARGS.shell}")
    print()
    uvicorn.run(app, host=ARGS.host, port=ARGS.port, log_level="info")
