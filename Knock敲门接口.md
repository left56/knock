# Knock 接口协议

本文档描述当前 `Cloudflare Worker` 对外接口，以及 OpenWrt/客户端如何对接。

## 认证与分组模型

- 所有请求都使用“`key`/`secret` 非空即有效”的模式。
- 同一个 `key` 对应一个独立分组（独立 IP 列表、独立更新时间、独立长轮询通知）。
- 路由器使用请求头 `X-Router-Secret` 传递分组 key。
- 浏览器/客户端使用查询参数 `key` 传递分组 key。

---

## 1) 客户端上报接口（HTML）

- **Method**: `GET`
- **Path**: `/`
- **Query**:
  - `key` (required): 分组 key，非空
  - `ip` (optional): 手动指定上报 IP（IPv4/IPv6）
  - `action` (optional): `add` / `remove`，默认 `add`

### 行为

- `ip` 未提供时，默认读取 `CF-Connecting-IP`。
- 当本次是 IPv6 上报（且未手动指定 `ip`），结果页会显示“使用 IPv4 认证”按钮（前端触发获取 IPv4，并需用户确认后跳转）。
- 返回一个 HTML 页面，包含当前分组白名单与 TTL 信息。

### 常见错误

- `401`: `key` 缺失或为空
- `400`: `ip` 非法 / 无法识别客户端 IP

---

## 2) 客户端上报接口（JSON）

- **Method**: `GET`
- **Path**: `/api/report`
- **Query**:
  - `key` (required): 分组 key，非空
  - `ip` (optional): 手动指定上报 IP
  - `action` (optional): `add` / `remove`，默认 `add`

### 成功响应示例

```json
{
  "status": "added_or_refreshed",
  "ips": ["203.0.113.10", "2001:db8::1"],
  "ips_with_ttl": [
    {
      "ip": "203.0.113.10",
      "location": "City, Country (ISP)",
      "ttl_ms": 598000,
      "ttl_formatted": "9m 58s"
    }
  ],
  "last_updated": 1776764761505
}
```

### `status` 含义

- `added_or_refreshed`: 新增或刷新成功
- `removed`: 删除成功
- `not_found`: 删除目标不存在
- `not_changed`: 无变化

---

## 3) 路由器快照拉取

- **Method**: `GET`
- **Path**: `/get_current_ips`
- **Headers**:
  - `X-Router-Secret` (required): 分组 key，非空

### 成功响应

```json
{
  "ips": ["203.0.113.10", "2001:db8::1"],
  "last_updated": 1776764761505,
  "status": "current"
}
```

### 失败响应

- `401`: 头部缺失或为空

---

## 4) 路由器长轮询

- **Method**: `GET`
- **Path**: `/long_poll_for_ip_updates`
- **Query**:
  - `since` (optional): 上次已知 `last_updated`，默认 `0`
- **Headers**:
  - `X-Router-Secret` (required): 分组 key，非空

### 成功响应

```json
{
  "ips": ["203.0.113.10"],
  "last_updated": 1776764761505,
  "status": "updated"
}
```

### `status` 含义

- `updated`: 分组列表发生更新
- `cleaned`: 过期清理导致列表变化
- `timeout`: 长轮询超时，无变化

### 失败响应

- `401`: 头部缺失或为空

---

## 5) IP 生命周期

- 单个 IP 默认有效期：`10 分钟`
- 每次 `add` 会刷新 TTL
- 后台定时清理过期项（默认每 `5 分钟` 一次）

---

## 6) OpenWrt 对接约定

- Go 同步器当前写入 **fw4 nft set**：
  - IPv4 -> `knock_ipv4`
  - IPv6 -> `knock_ipv6`
- 防火墙转发规则可使用集合条件：
  - `ipset='knock_ipv4 src'`（UCI 写法）
- 长轮询建议超时大于 Worker 长轮询时间（推荐 `long_poll_timeout_sec + 10s` 缓冲）。
