# xo Term - 网页版终端

在浏览器中操作 Linux 服务器的命令行终端。基于 Python + Vue3 + xterm.js，无构建工具，开箱即用。内建文件浏览器，支持上传/下载和目录浏览, 支持Docker 镜像和容器管理。

## 快速开始

### 1. 安装依赖

```bash
pip install -r requirements.txt
```

### 2. 启动

```bash
python app.py --user admin --pwd MyPassword
```

### 3. 打开浏览器

```
http://服务器IP:8080
```

输入用户名 `admin`，密码 `MyPassword`，回车即可进入终端。

## 功能

**终端**: 完整 Linux 终端，支持深色/浅色主题切换。

**文件浏览器**: 登录后点击右上角 `文件` 按钮打开。面板悬浮在终端上方，可浏览、上传、下载文件。路径自动跟随终端当前工作目录（通过 `/proc/<pid>/cwd` 实时同步），也可在面板中自由导航。

## 命令行参数

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `--port` | 监听端口 | `8080` |
| `--host` | 监听地址 | `0.0.0.0` |
| `--user` | 登录用户名 | 必填 |
| `--pwd` | 登录密码 | 必填 |
| `--shell` | Shell 路径 | `/bin/bash` |

示例：

```bash
# 使用 80 端口 + zsh
python app.py --port 80 --user root --pwd secret123 --shell /bin/zsh

# 只监听本地（配合 Nginx 反代）
python app.py --host 127.0.0.1 --port 8080 --user ops --pwd MyPwd
```

## 部署

### 方式〇：打包为单个可执行文件

PyInstaller 可以将项目打包成一个独立的二进制文件，复制到目标服务器即可运行，不需要安装 Python 和依赖。

**打包（在开发机上）：**

```bash
pip install pyinstaller
pyinstaller \
  --onefile \
  --name xo \
  --add-data "static:static" \
  --hidden-import docker \
  --hidden-import docker.errors \
  --hidden-import docker.types \
  --hidden-import packaging.specifiers \
  --hidden-import packaging.version \
  --hidden-import packaging.requirements \
  --collect-all docker \
  app.py
```

生成的文件在 `dist/xo`，约 30-50MB。

**在目标服务器上运行：**

```bash
# 1. 复制到服务器
scp dist/xo user@server:/usr/local/bin/

# 2. 在服务器上直接运行
chmod +x /usr/local/bin/xo
xo --user admin --pwd MyPassword --port 8080
```

**注意事项：**

- 必须在**相同 OS + 相同架构**的机器上打包（如 Ubuntu 22.04 x86_64 打包 → Ubuntu 22.04 x86_64 运行）。glibc 版本差异过大也会导致运行失败。
- Docker 管理功能需要服务器上有 Docker daemon 运行，且执行用户有 `/var/run/docker.sock` 访问权限。
- PTY 终端功能依赖 Linux `pty` 模块，打包产物只能在 Linux 上运行，不支持交叉平台。
- 建议用 `--user` 和 `--pwd` 传参，或将密码存环境变量 `XO_PWD`，避免 `ps aux` 泄露。
- 打包后的文件不含系统 Python，`docker` SDK 等 C 扩展已静态链接进二进制。

**systemd 服务（配合打包版本）：**

```ini
[Unit]
Description=xo Term
After=network.target

[Service]
Type=simple
User=danny
WorkingDirectory=/home/danny
Environment=XO_PWD=pass01!
ExecStart=/usr/bin/xo --user admin --pwd ${XO_PWD} --port 9080
Restart=always
RestartSec=10
TimeoutStopSec=5
KillSignal=SIGINT
KillMode=mixed

[Install]
WantedBy=multi-user.target

```

### 方式一：离线环境部署（pip）

在有网的机器上（**必须和离线服务器相同的 OS + Python 版本**）：

```bash
# 1. 下载依赖包
pip download -r requirements.txt -d pip-pkgs

# 2. 把整个项目目录拷贝到离线服务器
scp -r xo/ user@offline-server:/opt/xo
```

在离线服务器上：

```bash
cd /opt/xo
# 从本地目录安装，不联网
pip install --no-index --find-links=pip-pkgs -r requirements.txt
# 启动
python app.py --user admin --pwd MyPassword
```

> 注意：`pip-pkgs/` 目录约 9MB，包含所有依赖的 `.whl` 文件。如果离线服务器 Python 版本不同，需要用相同版本在有网机器上重新下载。

### 方式二：直接运行（测试用）

```bash
python app.py --user admin --pwd test123
```

### 方式三：systemd 服务（推荐）

创建 `/etc/systemd/system/xo.service`：

```ini
[Unit]
Description=xo Term
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/xo
Environment=XO_PWD=MySecretPassword
ExecStart=/usr/bin/python3 /opt/xo/app.py --user admin --pwd ${XO_PWD} --port 8080
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

启动：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now xo
```

### 方式四：配合 Nginx 反代（有域名/HTTPS）

Nginx 配置示例：

```nginx
server {
    listen 443 ssl;
    server_name term.example.com;

    ssl_certificate     /etc/ssl/certs/term.pem;
    ssl_certificate_key /etc/ssl/private/term.key;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

## 文件结构

```
xo/
├── app.py                 # Python 后端（FastAPI + WebSocket + PTY）
├── requirements.txt       # Python 依赖
├── static/                # 前端静态文件
│   ├── index.html         # 主页面
│   ├── app.js             # Vue3 + xterm.js 业务逻辑
│   ├── vue.esm-browser.prod.js   # Vue 3 浏览器版
│   ├── xterm.js           # xterm.js 终端渲染
│   ├── xterm-addon-fit.js # 自适应插件
│   ├── xterm.css          # xterm 样式
│   └── process.mjs        # xterm.js 浏览器 polyfill
└── README.md
```

## 技术栈

- **后端**: Python 3.8+ / FastAPI / uvicorn
- **前端**: Vue 3 (浏览器版) / xterm.js 5.x
- **通信**: WebSocket（终端 IO）+ HTTP（登录）
- **终端**: Python `pty` 标准库，`fork()` + `/bin/bash`

## 安全建议

- **密码保护**: 建议通过环境变量传密码，避免 `ps aux` 暴露
  ```bash
  export XO_PWD=MySecretPassword
  python app.py --user admin --pwd "$XO_PWD"
  ```
- **HTTPS**: 生产环境务必配合 Nginx + TLS 使用
- **IP 白名单**: 可在 Nginx 层限制访问来源 IP
- **防火墙**: 限制端口仅内网可访问 `ufw allow from 192.168.0.0/24 to any port 8080`
- **审计**: 如需操作日志，可将 PTY 输出写到文件，修改 `app.py` 中 `pty_to_ws()` 函数

## 常见问题

**Q: 支持多用户同时登录吗？**

A: 当前版本每个 WebSocket 连接分配一个独立 bash 进程，但登录认证是单用户的。如需多用户，可自行扩展 `app.py` 中的登录逻辑。

**Q: 怎么支持 SSH 到其他服务器？**

A: 登录后在终端里直接 `ssh user@host` 即可。xo Term 运行在服务器上，终端里的所有命令都是原生 bash 执行。

**Q: 怎么修改终端字体/颜色？**

A: 编辑 `static/app.js` 中 `Terminal` 构造函数的 `theme` 和 `fontFamily` 参数。

**Q: 前端文件能放 CDN 吗？**

A: 可以。在 `index.html` 的 importmap 中把路径改为 CDN 地址，然后删除 `static/` 下对应的 JS 文件即可。
