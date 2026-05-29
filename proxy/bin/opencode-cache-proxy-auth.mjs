#!/usr/bin/env node

import { defaultOpenCodeConfigPath } from "../src/client-config.mjs"
import {
  defaultOpenCodeAuthPath,
  runOpenCodeAuthBootstrap,
} from "../src/opencode-auth.mjs"

const usage = () => `Usage:
  opencode-cache-proxy-auth [options]

Options:
  --opencode-config <path>  OpenCode config path. Defaults to ~/.config/opencode/opencode.json
  --auth-path <path>        OpenCode auth path. Defaults to ~/.local/share/opencode/auth.json
  --provider <id>           Skip the provider menu and use this provider id.
  -h, --help                Show this help.
`

const parseArgs = (argv) => {
  const options = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === "-h" || arg === "--help") {
      options.help = true
      continue
    }
    if (arg === "--opencode-config" || arg === "--auth-path" || arg === "--provider") {
      const value = argv[i + 1]
      if (!value || value.startsWith("--")) {
        throw new Error(`${arg} requires a value`)
      }
      options[arg.slice(2)] = value
      i += 1
      continue
    }
    throw new Error(`unknown option: ${arg}`)
  }
  return options
}

const main = async () => {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    process.stdout.write(usage())
    return
  }

  await runOpenCodeAuthBootstrap({
    configPath: options["opencode-config"] || defaultOpenCodeConfigPath(),
    authPath: options["auth-path"] || defaultOpenCodeAuthPath(),
    providerId: options.provider || "",
  })
}

main().catch((err) => {
  process.stderr.write(`opencode-cache-proxy-auth: ${err.message || err}\n`)
  process.exitCode = 1
})
