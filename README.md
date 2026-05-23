# opencode-cache-proxy

Local proxy + OpenCode plugin for Alibaba Cloud Bailian / DashScope chat
completions. Adds explicit context-cache markers and provides a custom cached
provider for [OpenCode](https://opencode.ai).

## Repository layout

```
proxy/        Proxy server (bin/, src/, test/, scripts/)
plugins/      OpenCode plugin — starts the proxy and sends heartbeats
```

## Quick start

```bash
# 1. Copy the env template and fill in your key
cp proxy/.env.example proxy/.env

# 2. Run the proxy directly
node proxy/bin/bailian-cache-proxy.mjs

# 3. Run tests
(cd proxy && node --test)
```

## Using as a git submodule

```bash
git submodule add https://github.com/YOUR_ORG/opencode-cache-proxy.git vendor/opencode-cache-proxy
```

Then in your `init_opencode.sh` (or equivalent), point the custom provider at
`http://127.0.0.1:48761/compatible-mode/v1` and load the plugin from
`vendor/opencode-cache-proxy/plugins/bailian-cache-proxy.js`.

## See also

- [`proxy/README.md`](proxy/README.md) — full proxy documentation
  (lifecycle, environment variables, thinking-mode variants, usage observability)
