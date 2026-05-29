import { randomUUID } from "node:crypto"
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { emitKeypressEvents } from "node:readline"
import { createInterface as createPromisesInterface } from "node:readline/promises"
import { setTimeout as sleep } from "node:timers/promises"

import { defaultOpenCodeConfigPath } from "./client-config.mjs"

export const defaultOpenCodeAuthPath = (env = process.env) =>
  join(env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "opencode", "auth.json")

const readJsonIfExists = async (filePath) => {
  try {
    return JSON.parse(await readFile(filePath, "utf8"))
  } catch (err) {
    if (err?.code === "ENOENT") return {}
    throw new Error(`${filePath} is not valid JSON: ${err.message || err}`)
  }
}

const writeJsonAtomic0600 = async (filePath, value) => {
  await mkdir(dirname(filePath), { recursive: true })
  const tempPath = join(dirname(filePath), `.tmp-${process.pid}-${Date.now()}-${randomUUID()}.json`)
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  })
  await rename(tempPath, filePath)
  try {
    await chmod(filePath, 0o600)
  } catch (err) {
    if (process.platform !== "win32") throw err
  }
}

const acquireAuthLock = async (authPath, { timeoutMs = 5000 } = {}) => {
  const lockPath = `${authPath}.lock`
  const startedAt = Date.now()
  while (true) {
    try {
      await mkdir(lockPath, { mode: 0o700 })
      return async () => {
        await rm(lockPath, { recursive: true, force: true })
      }
    } catch (err) {
      if (err?.code !== "EEXIST") throw err
      if (Date.now() - startedAt > timeoutMs) {
        throw new Error(`timed out waiting for ${lockPath}`)
      }
      await sleep(25)
    }
  }
}

const readAllInput = (input) => new Promise((resolve, reject) => {
  let data = ""
  input.setEncoding?.("utf8")
  input.on("data", (chunk) => { data += chunk })
  input.once("end", () => { resolve(data) })
  input.once("error", reject)
  input.resume?.()
})

const createBufferedQuestion = (input, output) => {
  let lines
  let linesPromise
  return async (prompt) => {
    output.write(prompt)
    if (!linesPromise) {
      linesPromise = readAllInput(input).then((data) => data.split(/\r?\n/))
    }
    lines ||= await linesPromise
    return lines.length > 0 ? lines.shift() : ""
  }
}

export const listOpenCodeProviderChoices = async ({
  configPath = defaultOpenCodeConfigPath(),
} = {}) => {
  const config = await readJsonIfExists(configPath)
  const providers = config.provider && typeof config.provider === "object" && !Array.isArray(config.provider)
    ? config.provider
    : {}

  return Object.entries(providers)
    .map(([id, provider]) => ({
      id,
      name: provider?.name || id,
      npm: provider?.npm || "",
    }))
    .sort((left, right) => left.id.localeCompare(right.id))
}

export const writeOpenCodeCredential = async ({
  authPath = defaultOpenCodeAuthPath(),
  providerId,
  apiKey,
} = {}) => {
  const normalizedProviderId = String(providerId || "").trim()
  const normalizedApiKey = String(apiKey || "").trim()
  if (!normalizedProviderId) throw new Error("providerId is required")
  if (!normalizedApiKey) throw new Error("apiKey is required")

  await mkdir(dirname(authPath), { recursive: true })
  const release = await acquireAuthLock(authPath)
  try {
    const auth = await readJsonIfExists(authPath)
    auth[normalizedProviderId] = {
      type: "api",
      key: normalizedApiKey,
    }
    await writeJsonAtomic0600(authPath, auth)
  } finally {
    await release()
  }
  return { authPath, providerId: normalizedProviderId }
}

export const selectOpenCodeProvider = async ({
  providers,
  input = process.stdin,
  output = process.stdout,
  question,
} = {}) => {
  if (!Array.isArray(providers) || providers.length === 0) {
    throw new Error("no OpenCode providers found in opencode.json")
  }

  output.write("OpenCode providers:\n")
  providers.forEach((provider, index) => {
    const label = provider.name && provider.name !== provider.id ? ` - ${provider.name}` : ""
    output.write(`  ${index + 1}. ${provider.id}${label}\n`)
  })

  if (question) {
    while (true) {
      const answer = (await question(`Select provider [1-${providers.length}]: `)).trim()
      const index = Number(answer)
      if (Number.isInteger(index) && index >= 1 && index <= providers.length) {
        return providers[index - 1].id
      }
      output.write(`Please enter a number from 1 to ${providers.length}.\n`)
    }
  }

  const rl = createPromisesInterface({ input, output })
  try {
    while (true) {
      const answer = (await rl.question(`Select provider [1-${providers.length}]: `)).trim()
      const index = Number(answer)
      if (Number.isInteger(index) && index >= 1 && index <= providers.length) {
        return providers[index - 1].id
      }
      output.write(`Please enter a number from 1 to ${providers.length}.\n`)
    }
  } finally {
    rl.close()
  }
}

export const readApiKey = async ({
  providerId,
  input = process.stdin,
  output = process.stdout,
  question,
} = {}) => {
  const prompt = `API key for ${providerId}: `
  if (question) return (await question(prompt)).trim()

  if (!input.isTTY || typeof input.setRawMode !== "function") {
    const rl = createPromisesInterface({ input, output })
    try {
      return (await rl.question(prompt)).trim()
    } finally {
      rl.close()
    }
  }

  return new Promise((resolve, reject) => {
    emitKeypressEvents(input)
    const wasRaw = input.isRaw
    const wasPaused = input.isPaused?.() === true
    let value = ""
    const cleanup = () => {
      input.off("keypress", onKeypress)
      input.setRawMode(wasRaw)
      if (wasPaused) input.pause?.()
      output.write("\n")
    }
    const onKeypress = (str, key = {}) => {
      if (key.name === "return" || key.name === "enter") {
        cleanup()
        resolve(value.trim())
        return
      }
      if (key.ctrl && key.name === "c") {
        cleanup()
        reject(new Error("cancelled"))
        return
      }
      if (key.name === "backspace" || key.name === "delete") {
        value = value.slice(0, -1)
        return
      }
      if (str && !key.ctrl && !key.meta) value += str
    }

    output.write(prompt)
    input.setRawMode(true)
    input.on("keypress", onKeypress)
    input.resume?.()
  })
}

export const runOpenCodeAuthBootstrap = async ({
  configPath = defaultOpenCodeConfigPath(),
  authPath = defaultOpenCodeAuthPath(),
  providerId = "",
  input = process.stdin,
  output = process.stdout,
} = {}) => {
  const providers = await listOpenCodeProviderChoices({ configPath })
  const providerIds = new Set(providers.map((provider) => provider.id))
  const question = !input.isTTY ? createBufferedQuestion(input, output) : null
  const selectedProviderId = providerId
    ? String(providerId).trim()
    : await selectOpenCodeProvider({ providers, input, output, question })

  if (!providerIds.has(selectedProviderId)) {
    throw new Error(`provider ${selectedProviderId} not found in ${configPath}`)
  }

  const apiKey = await readApiKey({ providerId: selectedProviderId, input, output, question })
  const result = await writeOpenCodeCredential({ authPath, providerId: selectedProviderId, apiKey })
  output.write(`[credential] credential stored for ${selectedProviderId}\n`)
  output.write(`[write] ${result.authPath}\n`)
  return result
}
