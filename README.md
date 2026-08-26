# 台球

一个可本地双人游玩、也可通过邀请链接进行在线双人对战的网页台球项目。前端主体在 `billiards.html`，后端使用 Node.js 原生 HTTP 服务和 WebSocket，为在线房间、邀请、回合同步、断线恢复和对局状态持久化提供支持。

## 项目概览

本项目包含两种使用方式：

- 本地模式：打开页面即可在同一台设备上进行双人台球对局。
- 在线模式：玩家 1 创建房间并分享邀请码或邀请链接，玩家 2 加入后通过 WebSocket 同步击球、自由球、重开、僵局重摆和再来一局等事件。

当前支持的玩法：

- 中式八球
- 斯诺克

## 核心功能

- 桌面端和移动端适配：支持鼠标、触摸操作、移动端专用击球力度控制和聚焦布局。
- 台球物理与规则处理：包含球桌绘制、碰撞、进袋、犯规、自由球、胜负判定等基础逻辑。
- 邀请制在线房间：创建房间后生成 8 位邀请码和邀请链接。
- 实时对战同步：通过 `/ws` WebSocket 转发击球事件和结算快照。
- 权威状态校验：服务端会校验回合、动作 ID、球局快照、球的位置、模式和自由球范围，避免非法状态写入。
- 断线暂停与重连：对局中玩家掉线后房间进入暂停状态，宽限期内重连会恢复对局。
- 房间持久化：服务端会把房间状态保存到 `DATA_DIR/rooms.json`，进程重启后可恢复可继续的房间。
- 双方确认流程：在线对局中的重新开局、僵局重摆、再来一局需要另一方确认。
- 安全与稳定性：包含 Origin 校验、请求限流、HttpOnly Cookie 身份、静态资源路径保护、CSP 响应头和 WebSocket 心跳。

## 技术栈

- Node.js 24+
- 原生 `node:http`
- `ws` WebSocket 库
- HTML Canvas 单页前端
- Node Test Runner
- Playwright UI 测试
- Docker 部署支持

## 目录结构

```text
.
├── billiards.html              # 游戏前端，包含界面、渲染、规则和在线客户端逻辑
├── server.js                   # HTTP/WebSocket 服务端，负责房间、邀请、同步和持久化
├── package.json                # npm 脚本、运行时要求和依赖声明
├── package-lock.json           # npm 锁定文件
├── Dockerfile                  # 生产镜像构建文件
├── game-proxy.conf             # Nginx 反向代理示例配置
├── test/
│   ├── billiards-ui.test.js    # 前端静态/UI 行为测试
│   └── server.test.js          # 服务端接口、房间状态和 WebSocket 流程测试
├── .dockerignore
└── .gitignore
```

## 快速开始

安装依赖：

```bash
npm install
```

启动服务：

```bash
npm start
```

默认监听地址：

```text
http://localhost:8088
```

浏览器打开该地址即可进入游戏。在线对局也使用同一个页面，不需要单独启动前端开发服务器。

## 常用脚本

```bash
npm start
```

启动 Node.js 服务，默认运行 `server.js`。

```bash
npm test
```

运行全部测试，包括服务端流程测试和前端 UI 静态行为测试。

```bash
npm run test:ui
```

只运行 `test/billiards-ui.test.js`。

## 环境变量

服务端支持以下环境变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8088` | HTTP 和 WebSocket 服务监听端口 |
| `PUBLIC_DIR` | 项目根目录 | 静态页面和资源目录，根路径 `/` 会返回 `billiards.html` |
| `DATA_DIR` | `./data` | 房间持久化目录，默认写入 `rooms.json` |
| `TRUST_PROXY` | `false` | 是否信任 `X-Forwarded-*` 请求头，反向代理 HTTPS 部署时建议开启 |
| `ALLOWED_ORIGINS` | 空 | 允许的 Origin 列表，多个值用英文逗号分隔；为空时只允许同源 |

示例：

```bash
PORT=8088 DATA_DIR=/var/lib/billiards TRUST_PROXY=true npm start
```

## HTTP 接口

服务端主要接口如下：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/` | 返回游戏页面 |
| `GET` | `/healthz` | 健康检查，返回运行状态、运行时长和房间数量 |
| `GET` | `/api/session` | 获取当前匿名身份和已加入房间 |
| `POST` | `/api/rooms` | 创建在线房间，需要 `nickname` 和 `mode` |
| `POST` | `/api/rooms/join` | 通过 `invite_token` 或 `invite_code` 加入房间 |
| `GET` | `/api/rooms/:room_id` | 获取当前成员可见的房间状态 |
| `POST` | `/api/rooms/:room_id/leave` | 退出房间 |
| `POST` | `/api/rooms/:room_id/cancel` | 房主取消等待中的邀请 |
| `POST` | `/api/rooms/:room_id/invite` | 房主重新生成邀请 |

用户身份通过 `user_id` Cookie 维护。该 Cookie 使用 `HttpOnly`、`SameSite=Lax`，在 HTTPS 或可信代理场景下会带上 `Secure`。

## WebSocket 协议

WebSocket 入口：

```text
/ws?room_id=<room_id>
```

连接成功后，服务端会发送：

- `CONNECTED`：当前房间状态。
- `ROOM_STATE`：房间状态更新。
- `PRESENCE`：玩家在线或离线状态变化。
- `PEER_EVENT`：对手动作或房间决策事件。
- `ACK`：当前客户端动作确认。
- `ERROR`：动作被拒绝时的错误信息。

客户端可发送的主要事件：

- `SHOT`：提交击球角度和力度。
- `PLACEMENT`：提交自由球摆放位置。
- `SNAPSHOT`：提交击球后的权威结算快照。
- `RESTART_REQUEST`、`RESTART_ACCEPT`、`RESTART_DECLINE`、`RESTART_CANCEL`：重新开局流程。
- `STALEMATE_REQUEST`、`STALEMATE_ACCEPT`、`STALEMATE_DECLINE`、`STALEMATE_CANCEL`：僵局重摆流程。
- `REMATCH_REQUEST`、`REMATCH_ACCEPT`、`REMATCH_DECLINE`、`REMATCH_CANCEL`：再来一局流程。

每个客户端事件都需要携带 `action_id`。服务端会用它进行幂等处理，避免网络重试导致同一动作重复生效。

## 在线对局流程

1. 玩家 1 在页面中选择玩法并创建在线房间。
2. 服务端生成房间、邀请码、邀请链接和匿名身份 Cookie。
3. 玩家 2 通过邀请码或邀请链接加入房间。
4. 双方建立 WebSocket 连接，房间进入 `PLAYING`。
5. 当前回合玩家发送 `SHOT` 或 `PLACEMENT`。
6. 服务端校验回合和动作合法性，广播给双方。
7. 击球发起方在本地完成物理结算后发送 `SNAPSHOT`。
8. 服务端校验快照并更新房间权威状态。
9. 如果玩家断线，房间进入 `PAUSED`；宽限期内重连会恢复为 `PLAYING`。
10. 对局结束后可发起 `REMATCH_REQUEST`，双方确认后开启新一局。

## 部署说明

### 直接部署

在服务器上安装 Node.js 24+，拉取代码后执行：

```bash
npm ci --omit=dev
PORT=8088 NODE_ENV=production npm start
```

建议把 `DATA_DIR` 指向持久化磁盘目录，例如：

```bash
DATA_DIR=/var/lib/billiards
```

### Docker 部署

构建镜像：

```bash
docker build -t billiards .
```

运行容器：

```bash
docker run -d \
  --name billiards \
  -p 8088:8088 \
  -v billiards-data:/app/data \
  billiards
```

`Dockerfile` 中默认：

- 服务端口为 `8088`
- 页面目录为 `/app/public`
- 持久化目录为 `/app/data`
- 使用非 root 用户运行服务

### Nginx 反向代理

`game-proxy.conf` 提供了反向代理示例，配置中已包含 WebSocket 升级请求所需的 `Upgrade`、`Connection` 和 `proxy_http_version 1.1`。

如果部署在 HTTPS 域名后面，建议设置：

```bash
TRUST_PROXY=true
ALLOWED_ORIGINS=https://your-domain.example
```

## 测试说明

运行完整测试：

```bash
npm test
```

测试覆盖内容包括：

- 匿名身份 Cookie 和代理 HTTPS 场景
- 创建房间、加入房间、自加入拒绝、满房竞争
- 模式校验
- 成员权限与隐私字段保护
- WebSocket 回合校验、动作幂等和事件广播
- 断线暂停、重连恢复和超时清理
- 严格快照校验
- 自由球摆放权限和范围校验
- 离开房间、重新开局、僵局重摆、再来一局
- 服务重启后的房间恢复
- 前端自由球确认和 UI 静态行为

## 二次开发提示

- 前端渲染、规则、交互和在线客户端逻辑集中在 `billiards.html`，适合先拆分为模块后再扩展。
- 服务端通过 `createGameServer(options)` 导出可测试实例，测试中可以关闭持久化、缩短邀请有效期和重连宽限期。
- 房间对外状态由 `publicRoom()` 生成，不会暴露 `userId`、邀请 token 等敏感字段给无权限玩家。
- 在线同步采用“动作转发 + 快照结算”模型：服务端不计算所有物理细节，但会严格校验结算快照的结构、范围和回合一致性。
- 持久化文件是 `rooms.json`，写入时使用临时文件加重命名，降低进程中断时的数据损坏风险。

## 注意事项

- 本项目要求 Node.js 24 或更高版本。
- 生产环境不要提交 `node_modules/`、`.env` 和 `data/`。
- 公开部署时建议启用 HTTPS，并正确配置 `TRUST_PROXY` 与 `ALLOWED_ORIGINS`。
- 在线玩法依赖 WebSocket，反向代理和防火墙需要允许连接升级。
