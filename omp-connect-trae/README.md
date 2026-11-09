# omp-connect-trae

把本机已登录的 Trae（国内版 / 国际版）账号接入 **OMP（oh-my-pi）** 的适配包。协议、凭据、
模型目录与回环 shim 全部复用同仓库的 [`pi-connect-trae`](../pi-connect-trae/)，本包只负责
把 Pi 的 provider 注册接口翻译成 OMP 的接口。

## 为什么需要适配层

| 宿主 | 注册接口 |
| --- | --- |
| Pi | `pi.registerProvider(providerObject)` |
| OMP | `pi.registerProvider(name, config)` |

直接把 `pi-connect-trae` 加载进 OMP：Pi 的 provider 对象被当成 OMP 的 `name`，`config` 为
`undefined`，OMP 读取 `config.streamSimple` 时抛
`TypeError: undefined is not an object (evaluating 'p.streamSimple')`。

`index.js` 用 Proxy 运行 Pi 工厂并捕获 provider 对象，再对每个已登录区域调用
`auth.apiKey.resolve()`（启动回环 shim，拿到 baseUrl 与 bearer token），最后按 OMP 的
`registerProvider(name, { baseUrl, apiKey, api: "openai-completions", models })` 重新注册。
`/trae-usage`、`/trae-checkin` 也随代理一并注册。

## 安装

```powershell
omp plugin install ~/.pi/packages/pi-connect/omp-connect-trae
# 或写进 ~/.omp/agent/config.yml：
# extensions:
#   - ~/.pi/packages/pi-connect/omp-connect-trae
```

## 验证

```powershell
omp plugin list
omp models                                  # trae (N)，N = 已登录区域的模型数
omp -p "Reply with exactly: ok" --model trae/DeepSeek-V4.1-Flash
```

## 注意

- OMP 的静态 provider 配置没有按请求注入 baseUrl/token 的钩子，因此注册前必须解析区域并启动
  shim：每次启动都有一次解析（缓存命中约 2–3 秒，首次模型目录发现可能更久）。
- 只注册已登录的区域；未登录的 `trae-global` 不会出现，登录国际版后自动出现。
- 本包通过相对路径引用 `../pi-connect-trae/index.js`，升级只需更新本仓库克隆。
- 不要同时启用其他 trae 适配扩展，否则 provider 会注册两次。
