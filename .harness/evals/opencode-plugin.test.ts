import { afterEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { HarnessGuards } from "../adapters/opencode/plugin/harness"
import { normalizeStopEvent, normalizeToolEvent } from "../adapters/opencode/normalize"

const temporary: string[] = []
afterEach(() => {
  delete process.env.HARNESS_TRACE_FILE
  delete process.env.FORMAT_LOG
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe("OpenCode adapter normalization", () => {
  test("normalizes write content", () => {
    const event = normalizeToolEvent(
      "pre_edit",
      { tool: "write", sessionID: "s1", callID: "c1" },
      { filePath: "src/a.ts", content: "export const a = 1" },
      "/work",
    )
    expect(event.event).toBe("pre_edit")
    expect(event.runtime.name).toBe("opencode")
    expect(event.paths).toEqual([{ path: "src/a.ts", action: "add" }])
    expect(event.added_content?.[0].content).toBe("export const a = 1")
  })

  test("normalizes multi-file patches and renames", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/old.ts",
      "*** Move to: src/new.ts",
      "@@",
      "-old",
      "+new",
      "*** Add File: src/b.ts",
      "+second",
      "*** End Patch",
    ].join("\n")
    const event = normalizeToolEvent(
      "pre_edit",
      { tool: "apply_patch", sessionID: "s1", callID: "c1" },
      { patchText: patch },
      "/work",
    )
    expect(event.paths).toEqual([
      { path: "src/new.ts", action: "rename", from: "src/old.ts" },
      { path: "src/b.ts", action: "add" },
    ])
    expect(event.added_content?.map((item) => item.content)).toEqual(["new", "second"])
  })

  test("rejects orphan patch renames", () => {
    const patch = "*** Begin Patch\n*** Move to: src/new.ts\n+content\n*** End Patch"
    expect(() =>
      normalizeToolEvent(
        "pre_edit",
        { tool: "apply_patch", sessionID: "s1", callID: "c1" },
        { patchText: patch },
        "/work",
      ),
    ).toThrow("no source or destination")
  })

  test("normalizes command and stop loop state", () => {
    const command = normalizeToolEvent(
      "pre_command",
      { tool: "bash", sessionID: "s1", callID: "c1" },
      { command: "git status" },
      "/work",
    )
    expect(command.command).toBe("git status")
    expect(normalizeStopEvent("/work", "s1", true).stop?.verification_loop_active).toBe(true)
  })

  test("fails closed on malformed edits", () => {
    expect(() =>
      normalizeToolEvent(
        "pre_edit",
        { tool: "write", sessionID: "s1", callID: "c1" },
        {},
        "/work",
      ),
    ).toThrow("no path")
  })

  test("chat.message appends one routing pointer to the last text part", async () => {
    const root = resolve(import.meta.dir, "..")
    const workspace = mkdtempSync(join(tmpdir(), "harness-opencode-"))
    temporary.push(workspace)
    const plugin = await HarnessGuards({
      client: { session: { promptAsync: async () => ({}) } },
      directory: workspace,
      worktree: root,
    } as never)
    const parts = [
      { id: "prt_1", type: "text", text: "please debug this failing test" },
    ]
    await plugin["chat.message"]?.(
      { sessionID: "s1", messageID: "m1" } as never,
      { message: { id: "m1" }, parts } as never,
    )
    expect(parts).toHaveLength(1) // appended to the existing part, never pushed
    expect(parts[0].text).toContain("systematic-debugging")
    expect(parts[0].text).toContain("<!-- aios-skill-route:systematic-debugging -->")
    expect(parts[0].text).toContain(`${root}/skills/systematic-debugging/SKILL.md`)
  })

  test("chat.message is a no-op on no match, no text parts, and marker dedupe", async () => {
    const root = resolve(import.meta.dir, "..")
    const workspace = mkdtempSync(join(tmpdir(), "harness-opencode-"))
    temporary.push(workspace)
    const plugin = await HarnessGuards({
      client: { session: { promptAsync: async () => ({}) } },
      directory: workspace,
      worktree: root,
    } as never)

    const noMatch = [{ id: "prt_1", type: "text", text: "hello there, nothing special" }]
    await plugin["chat.message"]?.(
      { sessionID: "s1", messageID: "m1" } as never,
      { message: { id: "m1" }, parts: noMatch } as never,
    )
    expect(noMatch[0].text).toBe("hello there, nothing special")

    const noText: Array<{ id: string; type: string }> = [{ id: "prt_2", type: "file" }]
    await expect(
      plugin["chat.message"]?.(
        { sessionID: "s1", messageID: "m2" } as never,
        { message: { id: "m2" }, parts: noText } as never,
      ),
    ).resolves.toBeUndefined()

    const deduped = [
      {
        id: "prt_3",
        type: "text",
        text: "debug this <!-- aios-skill-route:systematic-debugging --> again",
      },
    ]
    await plugin["chat.message"]?.(
      { sessionID: "s1", messageID: "m3" } as never,
      { message: { id: "m3" }, parts: deduped } as never,
    )
    expect(deduped[0].text).toBe(
      "debug this <!-- aios-skill-route:systematic-debugging --> again",
    )
  })

  test("native pre-tool hook blocks a secret addition", async () => {
    const root = resolve(import.meta.dir, "..")
    const workspace = mkdtempSync(join(tmpdir(), "harness-opencode-"))
    temporary.push(workspace)
    const plugin = await HarnessGuards({
      client: { session: { promptAsync: async () => ({}) } },
      directory: workspace,
      worktree: root,
    } as never)
    const key = "AKIA" + "ABCDEFGHIJKLMNOP"
    await expect(
      plugin["tool.execute.before"]?.(
        { tool: "write", sessionID: "s1", callID: "c1" },
        { args: { filePath: "src/config.ts", content: `key=${key}` } },
      ),
    ).rejects.toThrow("guard-secrets")
  })

  test("native pre-tool hook allows secret removal and blocks protected renames", async () => {
    const root = resolve(import.meta.dir, "..")
    const workspace = mkdtempSync(join(tmpdir(), "harness-opencode-"))
    temporary.push(workspace)
    const plugin = await HarnessGuards({
      client: { session: { promptAsync: async () => ({}) } },
      directory: workspace,
      worktree: root,
    } as never)
    const key = "AKIA" + "ABCDEFGHIJKLMNOP"
    await expect(
      plugin["tool.execute.before"]?.(
        { tool: "edit", sessionID: "s1", callID: "c1" },
        { args: { filePath: "src/config.ts", oldString: key, newString: "$API_KEY" } },
      ),
    ).resolves.toBeUndefined()
    const rename = "*** Begin Patch\n*** Update File: src/a.ts\n*** Move to: package-lock.json\n+clean\n*** End Patch"
    await expect(
      plugin["tool.execute.before"]?.(
        { tool: "apply_patch", sessionID: "s1", callID: "c2" },
        { args: { patchText: rename } },
      ),
    ).rejects.toThrow("guard-protected-paths")
  })

  test("native pre-tool hook allows safe and blocks destructive commands", async () => {
    const root = resolve(import.meta.dir, "..")
    const workspace = mkdtempSync(join(tmpdir(), "harness-opencode-"))
    temporary.push(workspace)
    const plugin = await HarnessGuards({
      client: { session: { promptAsync: async () => ({}) } },
      directory: workspace,
      worktree: root,
    } as never)
    await expect(
      plugin["tool.execute.before"]?.(
        { tool: "bash", sessionID: "s1", callID: "c1" },
        { args: { command: "git status" } },
      ),
    ).resolves.toBeUndefined()
    await expect(
      plugin["tool.execute.before"]?.(
        { tool: "bash", sessionID: "s1", callID: "c2" },
        { args: { command: "rm -rf /" } },
      ),
    ).rejects.toThrow("guard-destructive")
  })

  test("native post-tool hook formats every edited path without blocking", async () => {
    const root = resolve(import.meta.dir, "..")
    const workspace = mkdtempSync(join(tmpdir(), "harness-opencode-"))
    temporary.push(workspace)
    execFileSync("git", ["init", "-q", workspace])
    mkdirSync(join(workspace, "src"), { recursive: true })
    mkdirSync(join(workspace, "node_modules", ".bin"), { recursive: true })
    writeFileSync(join(workspace, "src", "a.ts"), "const a=1\n")
    writeFileSync(join(workspace, "src", "b.ts"), "const b=2\n")
    const formatter = join(workspace, "node_modules", ".bin", "prettier")
    writeFileSync(formatter, '#!/bin/sh\nprintf "%s\\n" "$2" >> "$FORMAT_LOG"\n')
    execFileSync("chmod", ["+x", formatter])
    const log = join(workspace, "format.log")
    process.env.FORMAT_LOG = log
    const plugin = await HarnessGuards({
      client: { session: { promptAsync: async () => ({}) } },
      directory: workspace,
      worktree: root,
    } as never)
    const patch = "*** Begin Patch\n*** Update File: src/a.ts\n+const a = 1\n*** Update File: src/b.ts\n+const b = 2\n*** End Patch"
    await expect(
      plugin["tool.execute.after"]?.(
        { tool: "apply_patch", sessionID: "s1", callID: "c1", args: { patchText: patch } },
        {} as never,
      ),
    ).resolves.toBeUndefined()
    await expect(Bun.file(log).text()).resolves.toContain("src/a.ts")
    await expect(Bun.file(log).text()).resolves.toContain("src/b.ts")
  })

  test("session.idle injects one continuation and fails closed if the retry stays red", async () => {
    const root = resolve(import.meta.dir, "..")
    const workspace = mkdtempSync(join(tmpdir(), "harness-opencode-"))
    temporary.push(workspace)
    execFileSync("git", ["init", "-q", workspace])
    mkdirSync(join(workspace, ".harness"))
    writeFileSync(join(workspace, ".harness", "check"), "false\n")
    let prompts = 0
    const plugin = await HarnessGuards({
      client: { session: { promptAsync: async () => void prompts++ } },
      directory: workspace,
      worktree: root,
    } as never)
    const idle = { event: { type: "session.idle", properties: { sessionID: "s1" } } } as never
    await plugin.event?.(idle)
    // Second idle at the cap: the gate allows the stop with an honest still-red
    // note, which the plugin surfaces terminally (and clears the counter).
    await expect(plugin.event?.(idle)).rejects.toThrow("still failing")
    expect(prompts).toBe(1)
  })

  test("session.idle continuation counter clears on session.deleted", async () => {
    const root = resolve(import.meta.dir, "..")
    const workspace = mkdtempSync(join(tmpdir(), "harness-opencode-"))
    temporary.push(workspace)
    execFileSync("git", ["init", "-q", workspace])
    mkdirSync(join(workspace, ".harness"))
    writeFileSync(join(workspace, ".harness", "check"), "false\n")
    let prompts = 0
    const plugin = await HarnessGuards({
      client: { session: { promptAsync: async () => void prompts++ } },
      directory: workspace,
      worktree: root,
    } as never)
    const idle = { event: { type: "session.idle", properties: { sessionID: "s1" } } } as never
    await plugin.event?.(idle) // count -> 1
    await plugin.event?.({
      event: { type: "session.deleted", properties: { info: { id: "s1" } } },
    } as never) // counter cleared
    await plugin.event?.(idle) // fresh session state: continues again, no throw
    expect(prompts).toBe(2)
  })

  test("session.idle continuation names both anchor skills and the digest", async () => {
    const root = resolve(import.meta.dir, "..")
    const workspace = mkdtempSync(join(tmpdir(), "harness-opencode-"))
    temporary.push(workspace)
    execFileSync("git", ["init", "-q", workspace])
    mkdirSync(join(workspace, ".harness"))
    writeFileSync(join(workspace, ".harness", "check"), "false\n")
    let captured = ""
    const plugin = await HarnessGuards({
      client: {
        session: {
          promptAsync: async (options: { body: { parts: Array<{ text: string }> } }) => {
            captured = options.body.parts[0].text
          },
        },
      },
      directory: workspace,
      worktree: root,
    } as never)
    await plugin.event?.({
      event: { type: "session.idle", properties: { sessionID: "s2" } },
    } as never)
    expect(captured).toContain(`${root}/skills/verify-change/SKILL.md`)
    expect(captured).toContain(`${root}/skills/systematic-debugging/SKILL.md`)
    expect(captured).toContain("Spec before code")
    expect(captured).toContain("Check command:")
  })
})
