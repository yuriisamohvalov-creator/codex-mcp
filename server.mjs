#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const execFileP = promisify(execFile);
const MAX_TEXT_CHARS = 12_000;
const MAX_TAIL_CHARS = 4_000;

function truncate(value, max = MAX_TEXT_CHARS) {
  const s = String(value ?? "");
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n...[truncated ${s.length - max} chars]`;
}

function tail(value, max = MAX_TAIL_CHARS) {
  const s = String(value ?? "");
  if (s.length <= max) return s;
  return `...[tail truncated]\n${s.slice(-max)}`;
}

async function git(cwd, args) {
  try {
    const { stdout } = await execFileP("git", args, { cwd, maxBuffer: 10 * 1024 * 1024 });
    return stdout.trim();
  } catch {
    return null;
  }
}

async function runCodex(input) {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "codex-mcp-"));
  const lastMessageFile = path.join(tmpDir, "last.txt");

  const args = ["exec", "--json", "--skip-git-repo-check", "-C", input.cwd, "-o", lastMessageFile];
  // --approve-for-me implies the workspace-write sandbox and cannot be
  // combined with an explicit -s/--sandbox flag (codex-cli 0.155.1 rejects
  // that combination outright).
  if (!input.dangerouslyBypassSandbox) args.push("--approve-for-me");
  else args.push("--dangerously-bypass-approvals-and-sandbox");
  if (input.model) args.push("-m", input.model);
  // `resume` is a subcommand of `exec`, so it (and the thread id) must come
  // after all the options above, immediately before the task prompt.
  if (input.resumeThreadId) args.push("resume", input.resumeThreadId);
  args.push(input.task);

  return await new Promise((resolve) => {
    const child = spawn("/home/ysamohvalov/.local/bin/codex", args, {
      cwd: input.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let killedByTimeout = false;
    let threadId = null;

    const timer = setTimeout(() => {
      killedByTimeout = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      }, 5_000).unref();
    }, input.timeoutMs);
    timer.unref?.();

    child.stdout.on("data", (chunk) => {
      const s = chunk.toString();
      stdout += s;
      for (const line of s.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const event = JSON.parse(trimmed);
          if (event.type === "thread.started" && event.thread_id) threadId = event.thread_id;
        } catch {
          // Non-JSON lines (e.g. "Reading additional input from stdin...") — ignore.
        }
      }
    });

    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-1_000_000);
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      resolve({
        ok: false,
        error: `Failed to spawn codex: ${error.message}`,
        args,
        cwd: input.cwd,
      });
    });

    child.on("close", async (code, signal) => {
      clearTimeout(timer);

      let lastMessage = "";
      try {
        lastMessage = (await readFile(lastMessageFile, "utf8")).trim();
      } catch {
        // codex didn't write a last-message file (e.g. it failed before producing one).
      }
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});

      const diffStat = await git(input.cwd, ["diff", "--stat"]);
      const statusShort = await git(input.cwd, ["status", "--short"]);

      resolve({
        ok: !killedByTimeout && code === 0,
        killedByTimeout,
        exitCode: code,
        signal,
        threadId,
        args,
        cwd: input.cwd,
        text: truncate(lastMessage),
        diffStat,
        statusShort,
        stderrTail: tail(stderr),
        stdoutTail: tail(stdout),
      });
    });
  });
}

const server = new McpServer({
  name: "codex-cli-mcp",
  version: "0.1.0",
});

server.tool(
  "codex_execute",
  "Execute one bounded coding task through Codex CLI (synchronous, blocks until done) and return a compact JSON report with diff/status context.",
  {
    task: z.string().min(10).describe("Bounded coding task with goal, constraints, files, acceptance criteria, and verification command."),
    cwd: z.string().describe("Absolute working directory/repository root."),
    model: z.string().optional().describe("Optional Codex model override, e.g. gpt-5.1-codex."),
    timeoutMs: z.number().int().min(1000).max(3600000).default(900000).describe("Internal timeout; must be below the MCP client's own per-call timeout."),
    resumeThreadId: z.string().optional().describe("Resume a specific Codex thread id instead of starting a new one."),
    dangerouslyBypassSandbox: z.boolean().default(false).describe("Use --dangerously-bypass-approvals-and-sandbox instead of --approve-for-me. Only for environments that are already externally sandboxed."),
  },
  async (input) => {
    const result = await runCodex(input);
    return {
      isError: !result.ok,
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
